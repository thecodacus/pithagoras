import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { insideReal, isUnderText, realPath } from "./within.js";

/**
 * git as the portal runs it, in folders the agent can write: for what it asks
 * before deleting a folder (the work in it that nothing else has: unsavedWork),
 * for the updater and the skill importer (the environment), and for the
 * extensions' server halves (`portal.git`, see gitAt), where the Git panel is.
 *
 * Without a prompt that nobody can answer, without a pager, and without a lock
 * that trips up the agent working in the same repo. What a repo's own config
 * would run while only *looking* at it is turned off: an fsmonitor hook, an
 * external diff, a text conversion, a filter. The agent writes that config,
 * and a look should not run what it put there.
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

/** More changed files than this are cut off, and the page says so. */
export const MAX_FILES = 2000;

/** Reading: seconds. Talking to a remote, or a commit's hooks: minutes. */
const QUICK_MS = 20_000;
const SLOW_MS = 180_000;

interface Ran {
  stdout: string;
  stderr: string;
  code: number;
  /** The output was longer than asked for, and was cut. */
  cut: boolean;
}

interface RunOptions {
  input?: string;
  timeout?: number;
  /** Stop reading after this many bytes of output. */
  max?: number;
  /** Exit codes that are answers rather than failures (`diff --no-index` says 1 for "they differ"). */
  ok?: number[];
  /** A step that changes the repo: may take the index lock, and may run a hook. */
  writes?: boolean;
  /** Config given as key and value apart, so that no name can be read as the other. */
  config?: [string, string][];
}

/** What every git here runs with: no colour, no pager, names as they are, nothing the repo's config would run just to look. */
export const GIT_CONFIG = [
  "-c", "core.quotepath=false",
  "-c", "color.ui=false",
  "-c", "core.fsmonitor=false",
  "-c", "core.pager=cat",
  "-c", "advice.detachedHead=false",
  // A signed commit in the history would run whatever gpg.program names.
  "-c", "log.showSignature=false",
];

/** What git runs in, here and for the skill importer's clone: no prompt, no editor, no pager. */
export function environment(writes: boolean, config: [string, string][] = []): NodeJS.ProcessEnv {
  const pairs = Object.fromEntries(config.flatMap(([key, value], i) => [[`GIT_CONFIG_KEY_${i}`, key], [`GIT_CONFIG_VALUE_${i}`, value]]));
  return {
    ...process.env,
    GIT_CONFIG_COUNT: String(config.length),
    ...pairs,
    // Nobody is at a terminal to answer: a question fails instead of hanging.
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes",
    GIT_PAGER: "cat",
    PAGER: "cat",
    // A commit or a pull that wants a message takes the one it has.
    GIT_EDITOR: "true",
    GIT_MERGE_AUTOEDIT: "no",
    // Parsed here, so in the words it is parsed in.
    LC_ALL: "C",
    LANGUAGE: "C",
    // Looking does not refresh the index: that takes its lock, and the agent's
    // own `git add` a moment later would find it held.
    ...(writes ? {} : { GIT_OPTIONAL_LOCKS: "0" }),
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_PAGER: "cat",
    NO_COLOR: "1",
    CLICOLOR: "0",
  };
}

function run(command: "git" | "gh", cwd: string, args: string[], opts: RunOptions = {}): Promise<Ran> {
  const max = opts.max ?? 16 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(command, command === "git" ? [...GIT_CONFIG, ...args] : args, {
      cwd,
      env: environment(opts.writes ?? false, opts.config),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let cut = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeout ?? (opts.writes ? SLOW_MS : QUICK_MS));
    child.stdout.on("data", (chunk: Buffer) => {
      if (cut) return;
      if (size + chunk.length > max) {
        out.push(chunk.subarray(0, max - size));
        size = max;
        cut = true;
        child.kill("SIGKILL");
        return;
      }
      out.push(chunk);
      size += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (err.reduce((n, b) => n + b.length, 0) < 64 * 1024) err.push(chunk);
    });
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (e.code === "ENOENT") reject(new GitError(501, `${command} is not installed here`));
      else reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      if (timedOut) return reject(new GitError(504, `${command} ${args[0]} took too long and was stopped`));
      if (cut) return resolve({ stdout, stderr, code: code ?? 0, cut });
      if (code !== 0 && !(opts.ok ?? []).includes(code ?? -1)) {
        return reject(new GitError(409, said(stderr) || said(stdout) || `${command} ${args[0]} failed`));
      }
      resolve({ stdout, stderr, code: code ?? 0, cut });
    });
    child.stdin.on("error", () => {
      // Gone before it read what it was given: its exit says why.
    });
    child.stdin.end(opts.input ?? "");
  });
}

/** What a failed command said, without git's own prefixes and hints. */
function said(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^(error|fatal): /, "").trimEnd())
    .filter((line) => line && !line.startsWith("hint:"))
    .join("\n")
    .slice(0, 2000);
}

/**
 * What a filter the repository's config names would run is not run while
 * looking. A `filter.<name>.clean` (or `process`) that .gitattributes points a
 * file at runs whenever git compares that file with the index — every status
 * and diff — and neither --no-ext-diff nor --no-textconv stops it. Each driver
 * the config names is given empty commands instead, which git takes as "no
 * filter", and made optional so that having none is not an error.
 *
 * git-lfs is left alone when it is configured exactly as `git lfs install`
 * writes it: without its filter every file it tracks would read as changed.
 * The agent can write that config as well, but then what runs is git-lfs.
 *
 * Only for looking. Staging and committing are what `git add` and
 * `git commit` in the terminal are, filters included.
 */
const LFS: Record<string, string> = {
  clean: "git-lfs clean -- %f",
  smudge: "git-lfs smudge -- %f",
  process: "git-lfs filter-process",
  required: "true",
};

export async function filterOverrides(cwd: string): Promise<[string, string][]> {
  const { stdout } = await run("git", cwd, ["config", "-z", "--get-regexp", "^filter\\."], { ok: [1] });
  const drivers = new Map<string, Map<string, string>>();
  // -z: each entry is the key, a newline, the value, and a NUL — a value may hold newlines.
  for (const entry of stdout.split("\0")) {
    if (!entry) continue;
    const newline = entry.indexOf("\n");
    const key = newline < 0 ? entry : entry.slice(0, newline);
    const last = key.lastIndexOf(".");
    if (last <= 7) continue;
    const name = key.slice(7, last);
    const field = key.slice(last + 1).toLowerCase();
    if (!drivers.has(name)) drivers.set(name, new Map());
    drivers.get(name)!.set(field, newline < 0 ? "" : entry.slice(newline + 1));
  }
  const config: [string, string][] = [];
  for (const [name, fields] of drivers) {
    if (name === "lfs" && [...fields].every(([field, value]) => LFS[field] === value)) continue;
    for (const field of ["clean", "smudge", "process"]) config.push([`filter.${name}.${field}`, ""]);
    config.push([`filter.${name}.required`, "false"]);
  }
  return config;
}

/**
 * git, for looking or for changing: looking runs none of the repository's
 * filters. Given a Repo, what to turn off is read once for it — a Repo is made
 * for each request — rather than before every command of a refresh.
 */
const git = async (where: string | Repo, args: string[], opts?: RunOptions) => {
  const cwd = typeof where === "string" ? where : where.root;
  if (opts?.writes) return run("git", cwd, args, opts);
  const config = typeof where === "string" ? await filterOverrides(cwd) : await (where.filters ??= filterOverrides(where.root));
  return run("git", cwd, args, { ...opts, config });
};
const gh = (cwd: string, args: string[], opts?: RunOptions) => run("gh", cwd, args, opts);

/** What an extension's git step may say of itself: not the config, which is the runner's to set. */
export type GitStepOptions = Omit<RunOptions, "config">;

/**
 * git and gh in `folder`, hardened as the portal's own are (see run and git), for an extension's server half
 * (`portal.git.at`). What reading turns off is read once for the handle: one for each request, as a Repo is.
 */
export function gitAt(folder: string) {
  let filters: Promise<[string, string][]> | undefined;
  return {
    run: async (args: string[], opts: GitStepOptions = {}) =>
      opts.writes ? run("git", folder, args, opts) : run("git", folder, args, { ...opts, config: await (filters ??= filterOverrides(folder)) }),
    gh: (args: string[], opts: GitStepOptions = {}) => run("gh", folder, args, opts),
  };
}

/** A path as git should take it: exactly that path, not a pattern. */
const literal = (p: string) => `:(literal)${p}`;
// --- where the repo is ------------------------------------------------------

export interface Repo {
  /** The repository's top folder. */
  root: string;
  /** Its .git folder, where a merge or a rebase in progress leaves its marks. */
  gitDir: string;
  /** The chat's folder inside it, "" when it is the top. */
  prefix: string;
  /** What looking turns off, read the first time it is needed (see git()). */
  filters?: Promise<[string, string][]>;
}

/** The repository `folder` is in, or null when it is in none. */
export async function findRepo(folder: string): Promise<Repo | null> {
  try {
    const { stdout } = await run("git", folder, ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--show-prefix"]);
    const [root, gitDir, prefix = ""] = stdout.split("\n");
    if (!root || !gitDir) return null;
    return { root, gitDir, prefix: prefix.replace(/\/$/, "") };
  } catch (e) {
    // Only "there is none" is none. Anything else — git refusing a repository
    // somebody else owns ("dubious ownership"), a broken one — is said as it
    // is: taken for none, the panel offered to make one inside it.
    if (e instanceof GitError && e.status !== 501 && /not a git repository/i.test(e.message)) return null;
    throw e;
  }
}

/** A repository the panel can show: where it is, as a path from the chat's folder ("" for the one around it). */
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
export interface Unsaved {
  /** Changes that are not committed: a changed file, a new one, or a new folder, which counts once. */
  changed: number;
  /** Commits on a local branch, or on a detached HEAD, that no remote has. */
  unpushed: number;
  /** Stashes whose repository is inside the folder, so they go with it. */
  stashes: number;
  /** Not everything could be read, so there may be more than this says. */
  unknown?: true;
}

/** Whether there is anything to ask about: work only this folder has, or a folder that could not be told. */
export const holdsWork = (u: Unsaved | null): boolean => !!u && !!(u.changed || u.unpushed || u.stashes || u.unknown);

/**
 * The 409 body a delete is refused with, where it would take unsaved work and
 * was not told that is meant. The page asks again on its `code`, with `unsaved`.
 */
export const unsavedRefusal = (unsaved: Unsaved) => ({
  error: "This folder holds work that exists nowhere else. Delete it only when that is meant.",
  code: "unsaved-work" as const,
  unsaved,
});

/** Not everything could be read, so there may be anything. */
const couldNotTell = (): Unsaved => ({ changed: 0, unpushed: 0, stashes: 0, unknown: true });

/** More folders than this are not searched for repositories: the answer is "could not tell". */
const REPO_SEARCH_LIMIT = 50_000;

/**
 * Not looked into: what these hold was fetched or made from elsewhere, and can
 * be tens of thousands of folders. A repository at their top is still seen.
 */
const GENERATED = new Set(["node_modules", ".venv", "venv", "__pycache__", ".tox", ".mypy_cache", ".cache"]);

/**
 * Every folder at or under `folder` with a .git of its own — the folder itself,
 * submodules, repositories cloned into a subfolder — or null when there are
 * too many folders to look through. Symlinks are not followed, as a delete does
 * not follow them. A folder that cannot be listed is an error, not an empty one.
 * A tool's folder (node_modules, .venv…) counts when it is a repository itself,
 * but what is inside it is not looked through.
 */
async function reposUnder(folder: string): Promise<string[] | null> {
  const found: string[] = [];
  let level = [folder];
  let seen = 0;
  while (level.length) {
    seen += level.length;
    if (seen > REPO_SEARCH_LIMIT) return null;
    const listed = await Promise.all(
      level.map((dir) =>
        readdir(dir, { withFileTypes: true }).then(
          (entries) => ({ dir, entries }),
          (e: NodeJS.ErrnoException) => {
            // Gone since it was listed: nothing of it is deleted either.
            if (e.code === "ENOENT" || e.code === "ENOTDIR") return { dir, entries: [] };
            throw e;
          },
        ),
      ),
    );
    level = [];
    for (const { dir, entries } of listed) {
      for (const entry of entries) {
        if (entry.name === ".git") found.push(dir);
        else if (!entry.isDirectory()) continue;
        else if (!GENERATED.has(entry.name)) level.push(path.join(dir, entry.name));
        else if (existsSync(path.join(dir, entry.name, ".git"))) found.push(path.join(dir, entry.name));
      }
    }
  }
  return found;
}

/**
 * What the folder holds that only it has, or null when no repository is in it
 * or around it. A repository that cannot be read — "dubious ownership", a
 * broken one, git missing — is not taken for a clean one.
 */
export async function unsavedWork(
  folder: string,
  /**
   * "project": the folder is looked through, and one the repository around it
   * has none of is as good as one without git. "entry", a folder picked in the
   * Files panel: a tool's (node_modules…) is not looked through, and a new
   * folder in a part of that repository it does track is the one new folder
   * git says it is, unless it is a tool's.
   */
  as: "project" | "entry" = "project",
): Promise<Unsaved | null> {
  const unknown = couldNotTell();
  const tool = as === "entry" && GENERATED.has(path.basename(folder));
  let repos: string[] | null;
  let tops: Set<string>;
  let outer: number | null;
  try {
    // A tool's folder: only whether it is a repository itself, not what is under it.
    repos = tool ? (existsSync(path.join(folder, ".git")) ? [folder] : []) : await reposUnder(folder);
    if (!repos) {
      console.warn(`[git] could not tell what ${folder} holds: more than ${REPO_SEARCH_LIMIT} folders to look through`);
      return unknown;
    }
    tops = new Set(repos.map((dir) => realpathSync(dir)));
    outer = await outerChanges(folder, tops, as === "entry" && !tool);
  } catch (e) {
    console.warn(`[git] could not tell what ${folder} holds: ${(e as Error).message}`);
    return unknown;
  }
  if (!repos.length && outer === null) return null;
  const total: Unsaved = { changed: outer ?? 0, unpushed: 0, stashes: 0 };
  // A repository's branches and stashes are counted once, however many of its worktrees are here.
  const counted = new Set<string>();
  // A few at a time: each is several git processes, and none waits on another.
  let next = 0;
  const worker = async () => {
    while (next < repos.length) {
      const dir = repos[next++];
      try {
        const work = await repoWork(dir, folder, counted, tops);
        total.changed += work.changed;
        total.unpushed += work.unpushed;
        total.stashes += work.stashes;
      } catch (e) {
        // Said, not swallowed: the page can only say "could not be read".
        console.warn(`[git] could not tell what ${dir} holds: ${(e as Error).message}`);
        total.unknown = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, repos.length) }, worker));
  return total;
}

/**
 * What deleting `target` — a file or a folder somewhere in the chat's folder
 * `base`, not a project — would lose for good, or null when nothing git holds
 * goes with it.
 *
 * A file is what the person picked, and so is a link. A folder is looked at as
 * an "entry" (see unsavedWork).
 *
 * A repository's `.git`, or anything in it, is not told apart here: the Files
 * panel does not list it, and what goes with it — its submodules' data, its
 * worktrees' commits — is more than a count says. It is "could not be told".
 */
export async function unsavedIn(base: string, target: string): Promise<Unsaved | null> {
  if (path.relative(base, target).split(path.sep).includes(".git")) return couldNotTell();
  try {
    if (!(await lstat(target)).isDirectory()) return null;
    return await unsavedWork(target, "entry");
  } catch (e) {
    // Gone since it was looked for: nothing of it is deleted either. Anything else is not "none".
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    console.warn(`[git] could not tell what ${target} holds: ${(e as Error).message}`);
    return couldNotTell();
  }
}

/** A path's real place, or the path when it is gone. */
function real(p: string): string {
  return realPath(p) ?? p;
}

/**
 * How many changes git sees, less the repositories under it that are counted
 * on their own. A new folder counts once, and not at all when all it holds is
 * such repositories.
 */
async function ownChanges(repo: Repo, files: ChangedFile[], tops: Set<string>): Promise<number> {
  const isTop = (f: ChangedFile) => f.kind === "untracked" && f.path.endsWith("/") && tops.has(real(path.join(repo.root, f.path)));
  const topList = [...tops];
  let n = 0;
  for (const f of files) {
    if (isTop(f)) continue;
    const at = real(path.join(repo.root, f.path));
    if (f.kind !== "untracked" || !f.path.endsWith("/") || !topList.some((top) => isUnderText(at, top))) {
      n++;
      continue;
    }
    // git gives a new folder as one line, even when a repository is in it: what else is in it, then.
    const ran = await git(repo, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--", literal(f.path)]);
    if (ran.cut) throw new GitError(409, "git status said more than could be read");
    if (parseStatus(ran.stdout).files.some((inner) => !isTop(inner))) n++;
  }
  return n;
}

/**
 * Changes to files under `folder` that a repository around it tracks, as when
 * the workspace root is one: that repository stays, the changes go. Null when
 * no repository is around it, or git has none of the folder — unless
 * `newCounts` and git tracks the folder it is in, when it is the one new folder
 * it is.
 */
async function outerChanges(folder: string, tops: Set<string>, newCounts = false): Promise<number | null> {
  let repo: Repo | null;
  try {
    repo = await findRepo(folder);
  } catch (e) {
    // No git at all: nothing git holds can be lost.
    if (e instanceof GitError && e.status === 501) return null;
    throw e;
  }
  // None around it, or the folder's own, which is counted on its own.
  if (!repo || !repo.prefix) return null;
  const ran = await git(repo, ["status", "--porcelain=v2", "-z", "--untracked-files=normal", "--ignore-submodules=dirty", "--", literal(repo.prefix)]);
  if (ran.cut) throw new GitError(409, "git status said more than could be read");
  const files = parseStatus(ran.stdout).files;
  // The whole folder untracked: git has none of it, as if there were no git —
  // for a project, and for a folder whose own folder git has none of either,
  // as when the repository is the workspace root and the chat's folder is not
  // in it. Only in a part of the repository it tracks is it a new folder.
  const whole = files.length === 1 && files[0].kind === "untracked" && files[0].path === `${repo.prefix}/`;
  if (whole && !(newCounts && (await tracksAround(repo)))) return null;
  return ownChanges(repo, files, tops);
}

/** Whether git has anything of the folder `repo.prefix` is in: the top, or one it has not only as untracked. */
async function tracksAround(repo: Repo): Promise<boolean> {
  const parent = path.posix.dirname(repo.prefix);
  if (parent === ".") return true;
  const ran = await git(repo, ["status", "--porcelain=v2", "-z", "--untracked-files=normal", "--ignore-submodules=all", "--", literal(parent)]);
  if (ran.cut) throw new GitError(409, "git status said more than could be read");
  const files = parseStatus(ran.stdout).files;
  return !(files.length === 1 && files[0].kind === "untracked" && files[0].path === `${parent}/`);
}

/** Where a remote's URL is on this machine, or null when it is elsewhere. */
function localRemote(url: string, base: string): string | null {
  if (url.startsWith("file://")) return url.slice("file://".length);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return null;
  // user@host:path, as scp writes it: a colon before any slash.
  if (/^[^/]*:/.test(url)) return null;
  return path.resolve(base, url);
}

/** What the repository whose top is `dir` would lose when `folder`, which holds it, goes. */
async function repoWork(dir: string, folder: string, counted: Set<string>, tops: Set<string>): Promise<Unsaved> {
  const repo = await findRepo(dir);
  // A .git that git does not take for the folder's own repository is a broken one.
  if (!repo || realpathSync(repo.root) !== realpathSync(dir)) throw new GitError(409, "not a readable repository");
  // One command, and only whether something is there: a new folder is one
  // entry, not every file in it, and status() would also run two diffs.
  const ran = await git(repo, ["status", "--porcelain=v2", "-z", "--branch", "--show-stash", "--untracked-files=normal", "--ignore-submodules=dirty"]);
  if (ran.cut) throw new GitError(409, "git status said more than could be read");
  const now = parseStatus(ran.stdout);
  const changed = await ownChanges(repo, now.files, tops);
  // A remote inside the folder goes with it: what only it has is not saved.
  // Then only the others count, named one by one.
  const remotes = (await remoteUrls(repo)).map(({ name, url }) => ({ name, goes: insideReal(folder)(localRemote(url, repo.root)) }));
  const saved = remotes.some((r) => r.goes) ? remotes.filter((r) => !r.goes).map((r) => `--remotes=${r.name}`) : ["--remotes"];
  const count = async (args: string[]) => {
    const out = (await git(repo, ["rev-list", ...args, "--count"])).stdout.trim();
    // Not `|| 0`: output that is not a number is not "none", and the guard fails closed.
    if (!/^\d+$/.test(out)) throw new GitError(409, `rev-list said "${out.slice(0, 40)}"`);
    return Number(out);
  };
  // Commits only a HEAD holds — detached, mid-rebase, in a worktree — and no
  // branch, tag or remote. A commit a tag holds is taken for one a remote has:
  // that is where tags mostly come from. Nothing to ask before the first commit.
  const onlyIn = (heads: string[]) => (heads.length ? count([...heads, "--not", "--branches", "--tags", ...saved]) : 0);
  // Branches and stashes live where the repository's data does. A linked
  // worktree of a repository elsewhere loses only its files and HEAD; a
  // submodule, whose data is in the parent's .git, or a .git that points
  // inside the folder, loses them all.
  const common = (await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
  const data = realpathSync(common);
  if (!insideReal(folder)(data)) return { changed, unpushed: await onlyIn(now.head ? ["HEAD"] : []), stashes: 0 };
  // Counted once, with every HEAD in it, by whichever of its worktrees came first.
  if (counted.has(data)) return { changed, unpushed: 0, stashes: 0 };
  counted.add(data);
  // With the data goes what the HEAD of every worktree holds: of those here, and
  // of those elsewhere, which are left without it.
  const [heldByHeads, onBranches] = await Promise.all([
    git(repo, ["worktree", "list", "--porcelain"]).then(({ stdout }) =>
      onlyIn([...stdout.matchAll(/^HEAD ([0-9a-f]+)$/gm)].map((m) => m[1]).filter((sha) => /[1-9a-f]/.test(sha))),
    ),
    count(["--branches", "--not", ...saved]),
  ]);
  return { changed, unpushed: heldByHeads + onBranches, stashes: now.stashes };
}

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
