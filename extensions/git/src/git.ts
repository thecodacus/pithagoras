import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import type { GitHandle, GitRan, GitStepOptions } from "@pithagoras/extension-api/server";

/**
 * Git, and GitHub through `gh` where it is installed, for the Git panel.
 *
 * The same thing somebody would type in the terminal beside it, run for them:
 * what changed, staging and committing, the history, branches, pushing and
 * pulling, and pull requests. Nothing here decides what may be done (the
 * portal's login already hands out a shell in the same folder), so what is
 * here is about doing it well.
 *
 * Every step is run by the portal's own runner (`portal.git.at`): no prompt
 * nobody can answer, no pager, no lock that trips up the agent working in the
 * same repo, and nothing the repo's config would run while it is only looked
 * at. Kept apart from the routes so each step can be tried on a real repo in a
 * test, with a stand-in `gh`.
 */

export class GitError extends Error {
  constructor(
    /** The HTTP status it answers with. */
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A failure that says how to answer it: one of these, or one of the portal's runner's, which has a `status` of its
 * own (409 with git's words, 504 stopped, 501 not installed) but is not this class.
 */
export const isGitError = (e: unknown): e is { status: number; message: string } =>
  e instanceof Error && typeof (e as { status?: unknown }).status === "number";

/** Where `p` really is, links followed; null when it is not there. */
function realPath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** Above this a diff is cut off, and says so: a lockfile rewrite is megabytes nobody reads. */
export const MAX_DIFF_BYTES = 2 * 1024 * 1024;
/** A pull request's whole diff may be larger, but not without end. */
export const MAX_PR_DIFF_BYTES = 8 * 1024 * 1024;
/** More changed files than this are cut off, and the page says so. */
export const MAX_FILES = 2000;

/** What a failed command said, without git's own prefixes and hints. */
function said(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^(error|fatal): /, "").trimEnd())
    .filter((line) => line && !line.startsWith("hint:"))
    .join("\n")
    .slice(0, 2000);
}

/** Where git and gh run: the portal's own runner (`portal.git.at`), handed over as the server half starts. */
let at: (folder: string) => GitHandle = () => {
  throw new GitError(503, "Git is not ready: the extension's server half has not started");
};

export function useGit(given: (folder: string) => GitHandle): void {
  at = given;
}

/** git in a repository, or in a folder: one handle for each Repo, which is made for each request. */
const git = (where: string | Repo, args: string[], opts?: GitStepOptions) => (typeof where === "string" ? at(where) : (where.handle ??= at(where.root))).run(args, opts);
const gh = (cwd: string, args: string[], opts?: GitStepOptions) => at(cwd).gh(args, opts);

/** A path as git should take it: exactly that path, not a pattern. */
const literal = (p: string) => `:(literal)${p}`;

/** A path from the page: relative, inside, and not an option. */
export function checkPath(p: unknown): string {
  if (typeof p !== "string" || !p || p.length > 4096 || p.includes("\0")) throw new GitError(400, "A path is needed");
  const clean = path.posix.normalize(p);
  if (clean.startsWith("/") || clean === ".." || clean.startsWith("../")) throw new GitError(400, "That path is outside the repository");
  return clean;
}

const checkPaths = (paths: unknown): string[] => {
  if (!Array.isArray(paths) || !paths.length) throw new GitError(400, "Which files?");
  return paths.map(checkPath);
};

/** A commit, as the page names one: hex, nothing else. */
export function checkSha(sha: unknown): string {
  if (typeof sha !== "string" || !/^[0-9a-f]{4,64}$/i.test(sha)) throw new GitError(400, "Not a commit");
  return sha;
}

/** A branch or ref name: what git itself would accept, and never an option. */
export async function checkRef(cwd: string | Repo, name: unknown, kind: "branch" | "ref" = "ref"): Promise<string> {
  if (typeof name !== "string" || !name.trim() || name.startsWith("-") || name.length > 255 || /[\0\s]/.test(name)) {
    throw new GitError(400, kind === "branch" ? "Not a branch name" : "Not a ref");
  }
  if (kind === "branch") {
    await git(cwd, ["check-ref-format", "--branch", name]).catch(() => {
      throw new GitError(400, `"${name}" is not a valid branch name`);
    });
  }
  return name;
}

// --- where the repo is ------------------------------------------------------

export interface Repo {
  /** The repository's top folder. */
  root: string;
  /** Its .git folder, where a merge or a rebase in progress leaves its marks. */
  gitDir: string;
  /** The chat's folder inside it, "" when it is the top. */
  prefix: string;
  /** The portal's runner for it, made the first time it is needed (see git()). */
  handle?: GitHandle;
}

/** The repository `folder` is in, or null when it is in none. */
export async function findRepo(folder: string): Promise<Repo | null> {
  try {
    const { stdout } = await git(folder, ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--show-prefix"]);
    const [root, gitDir, prefix = ""] = stdout.split("\n");
    if (!root || !gitDir) return null;
    return { root, gitDir, prefix: prefix.replace(/\/$/, "") };
  } catch (e) {
    // Only "there is none" is none. Anything else — git refusing a repository
    // somebody else owns ("dubious ownership"), a broken one — is said as it
    // is: taken for none, the panel offered to make one inside it.
    if (isGitError(e) && e.status !== 501 && /not a git repository/i.test(e.message)) return null;
    throw e;
  }
}

/** A repository the panel can show: where it is, as a path from the chat's folder ("" for the one around it). */
export interface RepoEntry {
  path: string;
  name: string;
}

/** How far below the chat's folder a clone is looked for, and how much of the tree is looked at for it. */
const SCAN_DEPTH = 4;
const SCAN_FOLDERS = 4000;
const SCAN_REPOS = 50;
/** Folders no clone the agent works in is kept in, and that are the most of what a scan would walk. */
const SCAN_SKIP = new Set(["node_modules", "__pycache__", "dist", "build", "target", "vendor"]);

/**
 * The repositories the chat's folder has: the one it is in, if any ("" in
 * `path`), and the clones below it — a project that holds a repository of its
 * own, or several. A repository is a folder with a `.git` (a file there is a
 * worktree or a submodule); one is not looked into any further, and neither is
 * a link, which may lead out of the folder. Bounded in depth, folders and
 * repositories, since it runs on the machine that serves every other request.
 */
export async function findRepos(folder: string): Promise<{ repos: RepoEntry[]; truncated: boolean }> {
  const repos: RepoEntry[] = [];
  const around = await findRepo(folder);
  if (around) repos.push({ path: "", name: path.basename(around.root) });
  let truncated = false;
  let seen = 0;
  let level: string[] = [""];
  for (let depth = 0; level.length && depth <= SCAN_DEPTH; depth++) {
    const next: string[] = [];
    for (const rel of level) {
      if (++seen > SCAN_FOLDERS) return { repos: sorted(repos), truncated: true };
      let names;
      try {
        names = await readdir(path.join(folder, rel), { withFileTypes: true });
      } catch {
        // Gone since it was listed, or not ours to read.
        continue;
      }
      // The folder itself having a .git is the repository around it, listed above.
      const dotGit = rel ? names.find((d) => d.name === ".git") : undefined;
      if (dotGit && (await looksLikeRepo(path.join(folder, rel, ".git"), dotGit.isDirectory()))) {
        if (repos.length >= SCAN_REPOS) truncated = true;
        else repos.push({ path: rel, name: path.posix.basename(rel) });
        continue;
      }
      for (const d of names) {
        if (!d.isDirectory() || d.name.startsWith(".") || SCAN_SKIP.has(d.name)) continue;
        next.push(rel ? `${rel}/${d.name}` : d.name);
      }
    }
    level = next;
  }
  return { repos: sorted(repos), truncated };
}

/**
 * Whether a `.git` is one git takes for a repository: a folder that is a git dir, or a file naming one, as a
 * worktree's or a submodule's does. An empty or half-made one, as an interrupted clone or a deleted main
 * clone leaves, is skipped by git, which then works in the repository around it — so listing it would offer one
 * repository and act on another.
 */
async function looksLikeRepo(dotGit: string, isDir: boolean): Promise<boolean> {
  if (isDir) return isGitDir(dotGit);
  try {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dotGit, "utf8"));
    return m ? await isGitDir(path.resolve(path.dirname(dotGit), m[1])) : false;
  } catch {
    return false;
  }
}

/** Whether `dir` has what git needs of a git dir: a HEAD, and the refs and objects, or the `commondir` of a worktree's. */
async function isGitDir(dir: string): Promise<boolean> {
  const is = async (name: string, dirOk: boolean) => {
    try {
      const st = await stat(path.join(dir, name));
      return dirOk ? st.isDirectory() : st.isFile();
    } catch {
      return false;
    }
  };
  if (!(await is("HEAD", false))) return false;
  return (await is("commondir", false)) || ((await is("objects", true)) && (await is("refs", true)));
}

/** Whether `dir` is the top of the repository git works in there, not a folder in a bigger one. */
export async function isRepoRoot(dir: string): Promise<boolean> {
  const repo = await findRepo(dir);
  if (!repo) return false;
  const root = realPath(repo.root);
  return root !== null && root === realPath(dir);
}

/** The one around first, then the clones by path. */
const sorted = (repos: RepoEntry[]) => repos.sort((a, b) => (a.path === "" ? -1 : b.path === "" ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

/** Make the chat's folder a repository. */
export async function initRepo(folder: string): Promise<void> {
  await git(folder, ["init"], { writes: true });
}

// --- what changed -------------------------------------------------------------

export interface Counts {
  added: number;
  removed: number;
  binary: boolean;
}

export interface ChangedFile {
  path: string;
  /** Where a renamed or copied file came from. */
  from?: string;
  /** The index against HEAD, and the working tree against the index: git's two letters, "." for unchanged. */
  x: string;
  y: string;
  kind: "changed" | "renamed" | "conflict" | "untracked";
  staged?: Counts;
  unstaged?: Counts;
}

export interface Status {
  branch: string | null;
  /** The commit checked out, null before the first. */
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  stashes: number;
  /** A merge, rebase, cherry-pick or revert that is under way and waiting. */
  operation: "merge" | "rebase" | "am" | "cherry-pick" | "revert" | null;
  files: ChangedFile[];
  truncated: boolean;
  remotes: Remote[];
}

/** `git status --porcelain=v2 -z --branch`, read. */
export function parseStatus(raw: string): Omit<Status, "operation" | "remotes" | "truncated"> & { truncated?: boolean } {
  const parts = raw.split("\0");
  const status: Omit<Status, "operation" | "remotes" | "truncated"> = {
    branch: null,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    stashes: 0,
    files: [],
  };
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    if (entry.startsWith("# ")) {
      const [, key, ...rest] = entry.split(" ");
      const value = rest.join(" ");
      if (key === "branch.oid") status.head = value === "(initial)" ? null : value;
      else if (key === "branch.head") status.branch = value === "(detached)" ? null : value;
      else if (key === "branch.upstream") status.upstream = value;
      else if (key === "branch.ab") {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) {
          status.ahead = Number(m[1]);
          status.behind = Number(m[2]);
        }
      } else if (key === "stash") status.stashes = Number(value) || 0;
      continue;
    }
    const kind = entry[0];
    if (kind === "?") {
      status.files.push({ path: entry.slice(2), x: "?", y: "?", kind: "untracked" });
    } else if (kind === "1") {
      // 1 XY sub mH mI mW hH hI path — the path may hold spaces.
      const fields = entry.split(" ");
      status.files.push({ path: fields.slice(8).join(" "), x: fields[1][0], y: fields[1][1], kind: "changed" });
    } else if (kind === "2") {
      // 2 XY sub mH mI mW hH hI Xscore path, then the original path on its own.
      const fields = entry.split(" ");
      status.files.push({ path: fields.slice(9).join(" "), from: parts[++i], x: fields[1][0], y: fields[1][1], kind: "renamed" });
    } else if (kind === "u") {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const fields = entry.split(" ");
      status.files.push({ path: fields.slice(10).join(" "), x: fields[1][0], y: fields[1][1], kind: "conflict" });
    }
  }
  return status;
}

/** `git diff --numstat -z`, by the path each file ends up at. */
export function parseNumstat(raw: string): Map<string, Counts> {
  const counts = new Map<string, Counts>();
  const parts = raw.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(entry);
    if (!m) continue;
    let file = m[3];
    // A rename: the counts, then the old and the new name as fields of their own.
    if (!file) {
      i++;
      file = parts[++i];
    }
    counts.set(file, { added: m[1] === "-" ? 0 : Number(m[1]), removed: m[2] === "-" ? 0 : Number(m[2]), binary: m[1] === "-" });
  }
  return counts;
}

function operationIn(gitDir: string): Status["operation"] {
  if (existsSync(path.join(gitDir, "rebase-merge"))) return "rebase";
  // `git am` keeps its patches where `git rebase --apply` does, and says so with "applying".
  if (existsSync(path.join(gitDir, "rebase-apply"))) return existsSync(path.join(gitDir, "rebase-apply", "applying")) ? "am" : "rebase";
  if (existsSync(path.join(gitDir, "MERGE_HEAD"))) return "merge";
  if (existsSync(path.join(gitDir, "CHERRY_PICK_HEAD"))) return "cherry-pick";
  if (existsSync(path.join(gitDir, "REVERT_HEAD"))) return "revert";
  // Several commits picked or reverted, stopped between two of them: only the sequencer is left.
  if (existsSync(path.join(gitDir, "sequencer"))) {
    try {
      const next = readFileSync(path.join(gitDir, "sequencer", "todo"), "utf8").split("\n").find((line) => line.trim() && !line.startsWith("#")) ?? "";
      return /^(revert|r)\s/.test(next) ? "revert" : "cherry-pick";
    } catch {
      return "cherry-pick";
    }
  }
  return null;
}

/**
 * How much of `git status` is read. What is listed stops at MAX_FILES, and the
 * untracked files come last, so a folder with tens of thousands of them (an
 * unignored node_modules) would otherwise be read whole, and parsed, on every
 * refresh just to be cut down to a list. What is changed is first, and is kept.
 */
const STATUS_MAX = 1024 * 1024;

export async function status(repo: Repo): Promise<Status> {
  const [raw, unstaged, staged, remotes] = await Promise.all([
    git(repo, ["status", "--porcelain=v2", "-z", "--branch", "--show-stash", "--untracked-files=all", "--ignore-submodules=dirty"], { max: STATUS_MAX }),
    git(repo, ["diff", "--numstat", "-z", "-M", "--no-ext-diff", "--no-textconv", "--ignore-submodules=dirty"]),
    git(repo, ["diff", "--cached", "--numstat", "-z", "-M", "--no-ext-diff", "--no-textconv", "--ignore-submodules=dirty"]),
    listRemotes(repo),
  ]);
  // Cut off, its last entry may be half of one: that is not a file.
  const parsed = parseStatus(raw.cut ? raw.stdout.slice(0, raw.stdout.lastIndexOf("\0") + 1) : raw.stdout);
  const inIndex = parseNumstat(staged.stdout);
  const inTree = parseNumstat(unstaged.stdout);
  const files = parsed.files.slice(0, MAX_FILES).map((file) => ({
    ...file,
    ...(file.x !== "." && file.x !== "?" && inIndex.has(file.path) ? { staged: inIndex.get(file.path) } : {}),
    ...(file.y !== "." && file.y !== "?" && inTree.has(file.path) ? { unstaged: inTree.get(file.path) } : {}),
  }));
  return { ...parsed, files, truncated: raw.cut || parsed.files.length > MAX_FILES, operation: operationIn(repo.gitDir), remotes };
}

/** What deleting a folder would lose for good: nothing else holds a copy of these. */
// --- remotes ------------------------------------------------------------------

export interface Remote {
  name: string;
  /** Where it is, with any login taken out: a URL can carry a token. */
  address: string;
  /** Its page on the web, where it is on a host that has one. */
  web?: string;
}

/**
 * Where a remote is, fit to show: the host and the path, never the user and
 * password an https URL may carry.
 */
export function describeRemote(url: string): { address: string; web?: string } {
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+?)(?:\.git)?\/?$/.exec(url);
  if (scp && !/^[a-z]+:\/\//i.test(url)) return { address: `${scp[1]}:${scp[2]}`, web: `https://${scp[1]}/${scp[2]}` };
  try {
    const u = new URL(url);
    if (u.protocol === "file:") return { address: u.pathname };
    const where = u.pathname.replace(/\.git\/?$/, "").replace(/\/$/, "");
    const address = `${u.hostname}${u.port ? `:${u.port}` : ""}${where}`;
    const web = /^(https?|ssh|git):$/.test(u.protocol) && where.split("/").filter(Boolean).length >= 2 ? `https://${u.hostname}${where}` : undefined;
    return { address, web };
  } catch {
    // A local path.
    return { address: url };
  }
}

/** The remotes of a repository, each by its name and the URL as it is written in the config. */
async function remoteUrls(repo: Repo): Promise<{ name: string; url: string }[]> {
  const { stdout } = await git(repo, ["config", "--get-regexp", "^remote\\..*\\.url$"], { ok: [1] });
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [key, ...rest] = line.split(" ");
      return { name: key.replace(/^remote\./, "").replace(/\.url$/, ""), url: rest.join(" ") };
    });
}

async function listRemotes(repo: Repo): Promise<Remote[]> {
  return (await remoteUrls(repo)).map(({ name, url }) => ({ name, ...describeRemote(url) }));
}

// --- diffs --------------------------------------------------------------------

const DIFF = ["--no-color", "--no-ext-diff", "--no-textconv", "-M"];

export interface Diff {
  diff: string;
  truncated: boolean;
}

/** An empty tree in this repository's hash: what a first commit is compared with. */
async function emptyTree(repo: Repo): Promise<string> {
  const { stdout } = await git(repo, ["hash-object", "-t", "tree", "/dev/null"]);
  return stdout.trim();
}

/** The commit a commit is shown against: its first parent, or nothing for the first. */
async function parentOf(repo: Repo, sha: string): Promise<string> {
  const { stdout } = await git(repo, ["rev-list", "--parents", "-n", "1", "--end-of-options", sha]);
  const [, first] = stdout.trim().split(" ");
  return first ?? (await emptyTree(repo));
}

export type DiffOf =
  | { of: "unstaged" | "staged"; path: string; from?: string }
  | { of: "untracked"; path: string }
  | { of: "commit"; sha: string; path?: string; from?: string }
  | { of: "range"; base: string; head?: string; path?: string; from?: string }
  | { of: "stash"; stash: string };

/** One file's changes, or a commit's, as a unified diff. */
export async function diff(repo: Repo, what: DiffOf): Promise<Diff> {
  const paths = (p?: string, from?: string) => (p ? ["--", literal(checkPath(p)), ...(from ? [literal(checkPath(from))] : [])] : []);
  const opts = { max: MAX_DIFF_BYTES };
  let ran: GitRan;
  switch (what.of) {
    case "unstaged":
    case "staged":
      ran = await git(repo, ["diff", ...(what.of === "staged" ? ["--cached"] : []), ...DIFF, ...paths(what.path, what.from)], opts);
      break;
    case "untracked": {
      const file = checkPath(what.path);
      // Only a file git itself lists as new: --no-index takes any path at all.
      const { stdout } = await git(repo, ["ls-files", "-z", "--others", "--exclude-standard", "--", literal(file)]);
      if (!stdout.split("\0").includes(file)) throw new GitError(404, "That file is not a new one here");
      ran = await git(repo, ["diff", "--no-index", ...DIFF, "--", "/dev/null", file], { ...opts, ok: [1] });
      break;
    }
    case "commit": {
      const sha = checkSha(what.sha);
      ran = await git(repo, ["diff", ...DIFF, await parentOf(repo, sha), sha, ...paths(what.path, what.from)], opts);
      break;
    }
    case "range": {
      const base = await checkRef(repo, what.base);
      const head = what.head ? await checkRef(repo, what.head) : "HEAD";
      ran = await git(repo, ["diff", ...DIFF, `${base}...${head}`, ...paths(what.path, what.from)], opts);
      break;
    }
    case "stash":
      ran = await git(repo, ["stash", "show", "-p", "--include-untracked", ...DIFF, checkStash(what.stash)], { ...opts, ok: [1] });
      break;
  }
  return { diff: ran.stdout, truncated: ran.cut };
}

// --- staging and committing -----------------------------------------------------

/** One write at a time per repository: two `git add`s at once is an index.lock error. */
const queues = new Map<string, Promise<unknown>>();
export function serial<T>(repo: Repo, step: () => Promise<T>): Promise<T> {
  const before = queues.get(repo.root) ?? Promise.resolve();
  const next = before.catch(() => {}).then(step);
  queues.set(repo.root, next);
  void next.finally(() => {
    if (queues.get(repo.root) === next) queues.delete(repo.root);
  }).catch(() => {});
  return next;
}

async function hasHead(repo: Repo): Promise<boolean> {
  const { code } = await git(repo, ["rev-parse", "-q", "--verify", "HEAD"], { ok: [1] });
  return code === 0;
}

export async function stage(repo: Repo, paths: unknown, all = false): Promise<void> {
  const list = all ? [] : checkPaths(paths);
  return serial(repo, async () => {
    await git(repo, ["add", "-A", ...(all ? [] : ["--", ...list.map(literal)])], { writes: true });
  });
}

export async function unstage(repo: Repo, paths: unknown, all = false): Promise<void> {
  const list = all ? [] : checkPaths(paths);
  return serial(repo, async () => {
    const which = all ? ["."] : list.map(literal);
    // Before the first commit there is no HEAD to put the index back to.
    if (await hasHead(repo)) await git(repo, ["reset", "-q", "--", ...which], { writes: true });
    else await git(repo, ["rm", "--cached", "-r", "-q", "--", ...which], { writes: true });
  });
}

/**
 * Throw away what is not staged: a changed file goes back to what is staged
 * (or committed), a new one is deleted. The page asks first; this cannot be undone.
 */
export async function discard(repo: Repo, paths: unknown): Promise<void> {
  const list = checkPaths(paths);
  return serial(repo, async () => {
    const { stdout } = await git(repo, ["ls-files", "-z", "--others", "--exclude-standard", "--", ...list.map(literal)]);
    const untracked = new Set(stdout.split("\0").filter(Boolean));
    const fresh = list.filter((p) => untracked.has(p));
    const tracked = list.filter((p) => !untracked.has(p));
    if (tracked.length) await git(repo, ["checkout", "-q", "--", ...tracked.map(literal)], { writes: true });
    if (fresh.length) await git(repo, ["clean", "-f", "-q", "--", ...fresh.map(literal)], { writes: true });
  });
}

export async function commit(repo: Repo, message: unknown, amend = false): Promise<{ sha: string }> {
  const text = typeof message === "string" ? message.trim() : "";
  if (!text && !amend) throw new GitError(400, "A commit needs a message");
  return serial(repo, async () => {
    // Whitespace only: "strip" takes every line that starts with "#" as a
    // comment, and "#42 fix login" is a message, not a comment.
    await git(repo, ["commit", "--cleanup=whitespace", ...(amend ? ["--amend"] : []), ...(text ? ["-F", "-"] : ["--no-edit"])], {
      input: text,
      writes: true,
    });
    const { stdout } = await git(repo, ["rev-parse", "HEAD"]);
    return { sha: stdout.trim() };
  });
}

/** Give up on a merge, rebase, cherry-pick or revert that stopped half way. */
export async function abortOperation(repo: Repo): Promise<void> {
  return serial(repo, async () => {
    const operation = operationIn(repo.gitDir);
    if (!operation) throw new GitError(409, "Nothing is in progress");
    await git(repo, [operation, "--abort"], { writes: true });
  });
}

/** Carry on with it, now the conflicts are resolved and staged. */
export async function continueOperation(repo: Repo): Promise<void> {
  return serial(repo, async () => {
    const operation = operationIn(repo.gitDir);
    if (!operation) throw new GitError(409, "Nothing is in progress");
    if (operation === "merge") await git(repo, ["commit", "--no-edit"], { writes: true });
    else await git(repo, [operation, "--continue"], { writes: true });
  });
}

// --- history ------------------------------------------------------------------

export interface Commit {
  sha: string;
  short: string;
  parents: string[];
  author: string;
  email: string;
  /** Seconds since the epoch. */
  date: number;
  /** Branches and tags pointing here, as git decorates them. */
  refs: string[];
  subject: string;
}

const LOG_FORMAT = "%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1e";

export function parseLog(raw: string): Commit[] {
  return raw
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter(Boolean)
    .map((record) => {
      const [sha, short, parents, author, email, date, refs, subject] = record.split("\x1f");
      return {
        sha,
        short,
        parents: parents ? parents.split(" ") : [],
        author,
        email,
        date: Number(date),
        refs: refs ? refs.split(", ").filter(Boolean) : [],
        subject: subject ?? "",
      };
    });
}

export async function log(repo: Repo, opts: { ref?: unknown; skip?: number; limit?: number; path?: unknown; range?: string }): Promise<Commit[]> {
  if (!(await hasHead(repo)) && !opts.ref) return [];
  const limit = Math.min(Math.max(1, opts.limit ?? 100), 500);
  const skip = Math.max(0, opts.skip ?? 0);
  const from = opts.range ?? (opts.ref ? await checkRef(repo, opts.ref) : "HEAD");
  const { stdout } = await git(repo, [
    "log",
    `--format=${LOG_FORMAT}`,
    "--decorate=short",
    `--max-count=${limit}`,
    `--skip=${skip}`,
    "--end-of-options",
    from,
    ...(opts.path ? ["--", literal(checkPath(opts.path))] : []),
  ]);
  return parseLog(stdout);
}

export interface FileChange {
  path: string;
  from?: string;
  /** A for added, M changed, D deleted, R renamed, C copied, T type changed. */
  status: string;
  added: number;
  removed: number;
  binary: boolean;
}

/** `--name-status -z` and `--numstat -z` for the same two trees, put together. */
export function parseNameStatus(raw: string, counts: Map<string, Counts>): FileChange[] {
  const parts = raw.split("\0");
  const files: FileChange[] = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (!code) continue;
    const status = code[0];
    let file = parts[++i];
    let from: string | undefined;
    if (status === "R" || status === "C") {
      from = file;
      file = parts[++i];
    }
    const c = counts.get(file) ?? { added: 0, removed: 0, binary: false };
    files.push({ path: file, ...(from ? { from } : {}), status, ...c });
  }
  return files;
}

async function filesBetween(repo: Repo, from: string, to: string): Promise<FileChange[]> {
  const [names, nums] = await Promise.all([
    git(repo, ["diff", "--name-status", "-z", ...DIFF, from, to]),
    git(repo, ["diff", "--numstat", "-z", ...DIFF, from, to]),
  ]);
  return parseNameStatus(names.stdout, parseNumstat(nums.stdout)).slice(0, MAX_FILES);
}

export interface CommitDetail extends Commit {
  /** The whole message, subject and body. */
  message: string;
  committer: string;
  files: FileChange[];
}

export async function commitDetail(repo: Repo, shaIn: unknown): Promise<CommitDetail> {
  const sha = checkSha(shaIn);
  const { stdout } = await git(repo, ["show", "-s", `--format=${LOG_FORMAT.replace("%x1e", "")}%x1f%cn%x1f%B`, "--decorate=short", "--end-of-options", sha]).catch(() => {
    throw new GitError(404, "No such commit");
  });
  const fields = stdout.split("\x1f");
  const [head] = parseLog(fields.slice(0, 8).join("\x1f"));
  const files = await filesBetween(repo, await parentOf(repo, head.sha), head.sha);
  return { ...head, committer: fields[8] ?? "", message: (fields.slice(9).join("\x1f") ?? "").trim(), files };
}

// --- branches -----------------------------------------------------------------

export interface Branch {
  name: string;
  remote: boolean;
  sha: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Its upstream was deleted on the remote. */
  gone: boolean;
  current: boolean;
  date: number;
  subject: string;
}

export function parseBranches(raw: string): Branch[] {
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref, name, sha, upstream, track, head, date, subject] = line.split("\x1f");
      return {
        ref,
        name,
        remote: ref.startsWith("refs/remotes/"),
        sha,
        upstream: upstream || null,
        ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
        behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
        gone: track === "gone",
        current: head === "*",
        date: Number(date),
        subject: subject ?? "",
      };
    })
    // A remote's HEAD is where it points, not a branch of its own.
    .filter((b) => !(b.remote && b.ref.endsWith("/HEAD")))
    .map(({ ref: _ref, ...branch }) => branch);
}

export async function branches(repo: Repo): Promise<Branch[]> {
  const { stdout } = await git(repo, [
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname)%1f%(refname:short)%1f%(objectname:short)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(HEAD)%1f%(committerdate:unix)%1f%(contents:subject)",
    "refs/heads",
    "refs/remotes",
  ]);
  return parseBranches(stdout);
}

/**
 * Check out a branch. A remote one gets a local branch following it — or the
 * local one of that name, where there already is one.
 */
export async function switchBranch(repo: Repo, nameIn: unknown, remote = false): Promise<void> {
  return serial(repo, async () => {
    const name = await checkRef(repo, nameIn);
    if (!remote) return void (await git(repo, ["switch", name], { writes: true }));
    const local = name.split("/").slice(1).join("/");
    if (!local) throw new GitError(400, "Not a remote branch");
    const { code } = await git(repo, ["rev-parse", "-q", "--verify", `refs/heads/${local}`], { ok: [1] });
    if (code === 0) await git(repo, ["switch", local], { writes: true });
    else await git(repo, ["switch", "-c", local, "--track", name], { writes: true });
  });
}

export async function createBranch(repo: Repo, nameIn: unknown, fromIn?: unknown): Promise<void> {
  return serial(repo, async () => {
    const name = await checkRef(repo, nameIn, "branch");
    const from = fromIn ? await checkRef(repo, fromIn) : undefined;
    // Not following what it was made from: a branch made from origin/main
    // followed origin/main, and its first push went nowhere — or onto main.
    await git(repo, ["switch", "-c", name, ...(from ? ["--no-track", from] : [])], { writes: true });
  });
}

export async function deleteBranch(repo: Repo, nameIn: unknown, force = false): Promise<void> {
  return serial(repo, async () => {
    const name = await checkRef(repo, nameIn, "branch");
    await git(repo, ["branch", force ? "-D" : "-d", name], { writes: true });
  });
}

// --- remotes: fetch, pull, push -------------------------------------------------

export async function fetch(repo: Repo): Promise<string> {
  return serial(repo, async () => {
    const { stdout, stderr } = await git(repo, ["fetch", "--all", "--prune"], { writes: true });
    return said(stderr) || said(stdout);
  });
}

/** Only a fast-forward: a pull that would merge or rebase is something to decide, and the page says why it stopped. */
export async function pull(repo: Repo): Promise<string> {
  return serial(repo, async () => {
    const { stdout, stderr } = await git(repo, ["pull", "--ff-only"], { writes: true });
    return said(stdout) || said(stderr);
  });
}

/** The remote a branch without one is pushed to: origin, or the only one there is. */
async function pushRemote(repo: Repo): Promise<string> {
  const remotes = await listRemotes(repo);
  if (!remotes.length) throw new GitError(409, "This repository has no remote to push to");
  return (remotes.find((r) => r.name === "origin") ?? remotes[0]).name;
}

/** The branch checked out, and where it pushes to — null for a detached HEAD, `upstream` null where it follows nothing. */
async function tracking(repo: Repo): Promise<{ branch: string; upstream: { remote: string; ref: string } | null } | null> {
  const { stdout: head } = await git(repo, ["symbolic-ref", "-q", "--short", "HEAD"], { ok: [1] });
  const branch = head.trim();
  if (!branch) return null;
  const { stdout } = await git(repo, ["for-each-ref", "--format=%(upstream:remotename)%1f%(upstream:remoteref)", `refs/heads/${branch}`]);
  const [remote = "", ref = ""] = stdout.trim().split("\x1f");
  return { branch, upstream: remote && ref ? { remote, ref } : null };
}

/** Whether a push has anything to do: no branch of its own on the remote yet, or commits it does not have. */
async function needsPush(repo: Repo): Promise<boolean> {
  const t = await tracking(repo);
  if (!t) return false;
  if (!t.upstream || t.upstream.ref !== `refs/heads/${t.branch}`) return true;
  const { stdout } = await git(repo, ["rev-list", "--count", "@{upstream}..HEAD"]);
  return Number(stdout.trim()) > 0;
}

/**
 * Push the branch. One that is not on the remote yet is published there and
 * follows it from then on — and so is one that follows a branch of another
 * name, as a branch made from origin/main does: a plain push of it fails, or
 * with push.default=upstream puts its commits on main. Never forced:
 * rewriting what others may have is not something a button does.
 */
export async function push(repo: Repo): Promise<string> {
  return serial(repo, async () => {
    const t = await tracking(repo);
    if (!t) throw new GitError(409, "Check out a branch first: a detached HEAD has no branch to push");
    const own = t.upstream && t.upstream.ref === `refs/heads/${t.branch}`;
    const args = own ? ["push"] : ["push", "-u", t.upstream?.remote ?? (await pushRemote(repo)), "HEAD"];
    const { stdout, stderr } = await git(repo, args, { writes: true });
    return said(stderr) || said(stdout);
  });
}

// --- stash ------------------------------------------------------------------------

export interface Stash {
  ref: string;
  /** The stash's own commit: what an action on `ref` checks it still is. */
  sha: string;
  date: number;
  message: string;
}

function checkStash(ref: unknown): string {
  if (typeof ref !== "string" || !/^stash@\{\d+\}$/.test(ref)) throw new GitError(400, "Not a stash");
  return ref;
}

export async function stashes(repo: Repo): Promise<Stash[]> {
  const { stdout } = await git(repo, ["stash", "list", "--format=%gd%x1f%H%x1f%ct%x1f%gs"]);
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref, sha, date, message] = line.split("\x1f");
      return { ref, sha, date: Number(date), message: message ?? "" };
    });
}

export async function stashPush(repo: Repo, message?: unknown): Promise<void> {
  return serial(repo, async () => {
    const text = typeof message === "string" ? message.trim().slice(0, 500) : "";
    await git(repo, ["stash", "push", "--include-untracked", ...(text ? ["-m", text] : [])], { writes: true });
  });
}

/**
 * Apply, pop or drop a stash. `stash@{0}` is a place in a list, not a stash:
 * after the agent popped one and pushed another the same place holds another
 * stash, and a list read before that would drop the wrong one for good. So the
 * page says which stash it means, and nothing is done when that is not it.
 */
export async function stashDo(repo: Repo, action: "apply" | "pop" | "drop", ref: unknown, sha: unknown): Promise<void> {
  const stash = checkStash(ref);
  const meant = checkSha(sha);
  return serial(repo, async () => {
    const { stdout } = await git(repo, ["rev-parse", "-q", "--verify", `${stash}^{commit}`], { ok: [1] });
    if (!stdout.trim().startsWith(meant.toLowerCase())) throw new GitError(409, "The stashes changed since this list was read — look again");
    await git(repo, ["stash", action, stash], { writes: true });
  });
}

// --- comparing a branch with its base, as a pull request would ---------------------

/**
 * What a branch is compared with, where nothing is said: the remote's default
 * branch, then the usual names. A branch that is the default itself is
 * compared with its upstream — what would go out on the next push.
 */
export async function defaultBase(repo: Repo, current: string | null): Promise<string | null> {
  const has = async (ref: string) => (await git(repo, ["rev-parse", "-q", "--verify", `${ref}^{commit}`], { ok: [1] })).code === 0;
  const { stdout } = await git(repo, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], { ok: [1] });
  const candidates = [stdout.trim(), "origin/main", "origin/master", "main", "master"].filter(Boolean);
  for (const ref of candidates) {
    if (ref === current || !(await has(ref))) continue;
    return ref;
  }
  return null;
}

export interface Comparison {
  base: string;
  head: string;
  /** Where the two parted: what the files are compared against. */
  mergeBase: string;
  commits: Commit[];
  files: FileChange[];
}

export async function compare(repo: Repo, baseIn?: unknown): Promise<Comparison | null> {
  if (!(await hasHead(repo))) return null;
  const { stdout: branchOut } = await git(repo, ["symbolic-ref", "-q", "--short", "HEAD"], { ok: [1] });
  const head = branchOut.trim() || "HEAD";
  const base = baseIn ? await checkRef(repo, baseIn) : await defaultBase(repo, branchOut.trim() || null);
  if (!base) return null;
  const { stdout, code } = await git(repo, ["merge-base", "--end-of-options", base, "HEAD"], { ok: [1] });
  if (code !== 0) throw new GitError(409, `${base} and ${head} have nothing in common`);
  const mergeBase = stdout.trim();
  const [commits, files] = await Promise.all([log(repo, { range: `${base}..HEAD`, limit: 250 }), filesBetween(repo, mergeBase, "HEAD")]);
  return { base, head, mergeBase, commits, files };
}

// --- GitHub, through gh --------------------------------------------------------------

export interface GhState {
  installed: boolean;
  /** Signed in to the host this repository is on. */
  authed: boolean;
  /** owner/name on GitHub, when the repository is one there. */
  repo: string | null;
  url: string | null;
  defaultBranch: string | null;
  /**
   * The default branch as this clone has it: on the remote that is that
   * repository — not always origin, which in a fork's clone is the fork.
   */
  baseRef?: string | null;
  /** Why pull requests are not on offer, when they are not. */
  note?: string;
}

const ghStates = new Map<string, { at: number; state: GhState }>();
/** gh asks GitHub; the answer is kept a while, not asked for on every refresh. */
const GH_FRESH_MS = 60_000;

export async function ghState(repo: Repo, fresh = false): Promise<GhState> {
  const kept = ghStates.get(repo.root);
  if (kept && !fresh && Date.now() - kept.at < GH_FRESH_MS) return kept.state;
  let state: GhState;
  try {
    const view = await gh(repo.root, ["repo", "view", "--json", "nameWithOwner,url,defaultBranchRef"]);
    const parsed = JSON.parse(view.stdout) as { nameWithOwner: string; url: string; defaultBranchRef?: { name: string } };
    const defaultBranch = parsed.defaultBranchRef?.name ?? null;
    const remote = remoteFor(await listRemotes(repo), parsed.url);
    state = {
      installed: true,
      authed: true,
      repo: parsed.nameWithOwner,
      url: parsed.url,
      defaultBranch,
      baseRef: remote && defaultBranch ? `${remote.name}/${defaultBranch}` : null,
    };
  } catch (e) {
    if (isGitError(e) && e.status === 501) {
      state = { installed: false, authed: false, repo: null, url: null, defaultBranch: null, note: "Install the GitHub CLI (gh) to see and open pull requests here" };
    } else {
      const message = (e as Error).message;
      const signedOut = /auth login|not logged|authentication/i.test(message);
      state = {
        installed: true,
        authed: !signedOut,
        repo: null,
        url: null,
        defaultBranch: null,
        note: signedOut ? "gh is not signed in — run `gh auth login` in the terminal" : message.split("\n")[0] || "This repository is not on GitHub",
      };
    }
  }
  ghStates.set(repo.root, { at: Date.now(), state });
  return state;
}

/** The remote whose address is this page on the web. */
function remoteFor(remotes: Remote[], web: string): Remote | undefined {
  const plain = (u: string) => u.toLowerCase().replace(/\.git$/, "").replace(/\/$/, "");
  return remotes.find((r) => r.web && plain(r.web) === plain(web));
}

async function needGh(repo: Repo): Promise<GhState> {
  const state = await ghState(repo);
  if (!state.repo) throw new GitError(409, state.note ?? "Pull requests need gh and a repository on GitHub");
  return state;
}

const PR_LIST_FIELDS = "number,title,author,headRefName,baseRefName,isDraft,state,updatedAt,url,reviewDecision,additions,deletions";
// `isCrossRepository` tells a branch of a fork from one of this repository: `headRefName` alone is
// the name in the fork, which `main` may be too.
const PR_FIELDS =
  "number,title,body,author,state,isDraft,headRefName,baseRefName,isCrossRepository,headRepositoryOwner,url,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,additions,deletions,changedFiles,files,commits,comments,reviews,createdAt,updatedAt";

function checkNumber(n: unknown): string {
  const text = String(n);
  if (!/^\d{1,9}$/.test(text)) throw new GitError(400, "Not a pull request number");
  return text;
}

export async function pulls(repo: Repo, state: unknown = "open"): Promise<unknown[]> {
  await needGh(repo);
  const which = typeof state === "string" && ["open", "closed", "merged", "all"].includes(state) ? state : "open";
  const { stdout } = await gh(repo.root, ["pr", "list", "--state", which, "--limit", "50", "--json", PR_LIST_FIELDS]);
  return JSON.parse(stdout || "[]");
}

/** One pull request — or the one for the branch checked out, and null when it has none. */
export async function pullRequest(repo: Repo, n?: unknown): Promise<unknown | null> {
  await needGh(repo);
  try {
    const { stdout } = await gh(repo.root, ["pr", "view", ...(n === undefined ? [] : [checkNumber(n)]), "--json", PR_FIELDS]);
    return JSON.parse(stdout);
  } catch (e) {
    if (n === undefined && isGitError(e) && /no (open )?pull requests? found/i.test(e.message)) return null;
    throw e;
  }
}

export async function pullDiff(repo: Repo, n: unknown): Promise<Diff> {
  await needGh(repo);
  const ran = await gh(repo.root, ["pr", "diff", checkNumber(n), "--color=never"], { max: MAX_PR_DIFF_BYTES });
  return { diff: ran.stdout, truncated: ran.cut };
}

/**
 * Open a pull request for the branch checked out. A branch not on GitHub yet
 * is pushed first — gh would otherwise stop to ask where to.
 */
export async function createPull(repo: Repo, opts: { title?: unknown; body?: unknown; base?: unknown; draft?: boolean }): Promise<{ url: string }> {
  await needGh(repo);
  const title = typeof opts.title === "string" ? opts.title.trim() : "";
  if (!title) throw new GitError(400, "A pull request needs a title");
  const body = typeof opts.body === "string" ? opts.body : "";
  const base = opts.base ? await checkRef(repo, opts.base) : undefined;
  const t = await tracking(repo);
  if (!t) throw new GitError(409, "Check out a branch first: a detached HEAD has nothing to open a pull request from");
  // Pushed only when there is something to push: a branch already on the
  // remote, and behind it, has nothing to add, and a push would be refused.
  if (await needsPush(repo)) await push(repo);
  // Named with its owner: in a fork's clone gh opens the pull request on the
  // repository forked from, which has no branch of that name — the branch is
  // on the fork it was pushed to.
  const after = await tracking(repo);
  const where = after?.upstream ? (await listRemotes(repo)).find((r) => r.name === after.upstream!.remote) : undefined;
  const owner = where?.web ? /^https:\/\/[^/]+\/([^/]+)\//.exec(where.web)?.[1] : undefined;
  const head = owner ? `${owner}:${t.branch}` : t.branch;
  return serial(repo, async () => {
    const { stdout } = await gh(
      repo.root,
      ["pr", "create", "--title", title, "--body-file", "-", "--head", head, ...(base ? ["--base", base] : []), ...(opts.draft ? ["--draft"] : [])],
      { input: body, writes: true },
    );
    const url = stdout.trim().split("\n").reverse().find((line) => /^https?:\/\//.test(line)) ?? stdout.trim();
    return { url };
  });
}

export async function checkoutPull(repo: Repo, n: unknown): Promise<void> {
  await needGh(repo);
  const number = checkNumber(n);
  await serial(repo, async () => {
    await gh(repo.root, ["pr", "checkout", number], { writes: true });
  });
}

export async function mergePull(repo: Repo, n: unknown, method: unknown, deleteBranch = false): Promise<string> {
  await needGh(repo);
  const number = checkNumber(n);
  const how = method === "squash" || method === "rebase" ? method : "merge";
  return serial(repo, async () => {
    const { stdout, stderr } = await gh(repo.root, ["pr", "merge", number, `--${how}`, ...(deleteBranch ? ["--delete-branch"] : [])], { writes: true });
    return said(stdout) || said(stderr);
  });
}

export async function commentPull(repo: Repo, n: unknown, body: unknown): Promise<void> {
  await needGh(repo);
  const number = checkNumber(n);
  const text = typeof body === "string" ? body.trim() : "";
  if (!text) throw new GitError(400, "Say something first");
  await gh(repo.root, ["pr", "comment", number, "--body-file", "-"], { input: text, writes: true });
}

/** Approve, ask for changes, or only comment — as a review. */
export async function reviewPull(repo: Repo, n: unknown, action: unknown, body: unknown): Promise<void> {
  await needGh(repo);
  const number = checkNumber(n);
  const how = action === "approve" ? "--approve" : action === "request-changes" ? "--request-changes" : "--comment";
  const text = typeof body === "string" ? body.trim() : "";
  if (how !== "--approve" && !text) throw new GitError(400, "Say what you think first");
  await gh(repo.root, ["pr", "review", number, how, "--body-file", "-"], { input: text, writes: true });
}
