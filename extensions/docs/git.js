/**
 * The history of a folder's documents: a git repository of the extension's
 * own, in `<folder>/.pithagoras-docs/git`, whose work tree is the documents
 * folder. It is not the folder's own repository, if it has one, and nothing
 * of the folder's or the user's git configuration takes part in it.
 *
 * Every call is the same shape: git started without a shell, its arguments an
 * array, with the git dir and the work tree named, hooks off, no signing, no
 * system or global configuration, and paths taken literally. A commit is made
 * from bytes the store hands it (or ones it checked), into an index of the
 * repository's own: only the documents named are added, never the folder.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

/** Who every commit is by. Who changed the document is its `Author` trailer. */
const COMMITTER = { name: "Pithagoras Docs", email: "docs@pithagoras.invalid" };
const BRANCH = "refs/heads/main";

/** A document's text as git names it: the id of its blob. Computed here, so a file can be compared without a process. */
export const blobId = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

export class GitError extends Error {}

export class Repo {
  /** `gitDir` and `workTree` absolute. */
  constructor(gitDir, workTree) {
    this.gitDir = gitDir;
    this.workTree = workTree;
  }

  /**
   * Runs git with `args` (and `input` on its stdin): its stdout, or a GitError
   * with what it said. Its environment is made here, not inherited: a GIT_DIR
   * or GIT_INDEX_FILE of the portal's own would point it elsewhere.
   */
  run(args, { input, allowFail = false } = {}) {
    const argv = [
      `--git-dir=${this.gitDir}`,
      `--work-tree=${this.workTree}`,
      "-c", "core.hooksPath=/dev/null",
      "-c", "core.fsmonitor=false",
      "-c", "commit.gpgSign=false",
      "-c", "gc.autoDetach=false",
      ...args,
    ];
    const env = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_LITERAL_PATHSPECS: "1",
      GIT_AUTHOR_NAME: COMMITTER.name,
      GIT_AUTHOR_EMAIL: COMMITTER.email,
      GIT_COMMITTER_NAME: COMMITTER.name,
      GIT_COMMITTER_EMAIL: COMMITTER.email,
    };
    return new Promise((resolve, reject) => {
      const child = spawn("git", argv, { env, cwd: path.dirname(this.gitDir), stdio: ["pipe", "pipe", "pipe"] });
      const out = [];
      let err = "";
      child.stdout.on("data", (chunk) => out.push(chunk));
      child.stderr.on("data", (chunk) => (err = (err + chunk).slice(-4000)));
      child.on("error", (error) => reject(new GitError(`git could not be started: ${error.message}`)));
      child.on("close", (code) => {
        const stdout = Buffer.concat(out);
        if (code === 0 || allowFail) resolve({ code, stdout });
        else reject(new GitError(`git ${args[0]} failed (${code}): ${err.trim()}`));
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
  }

  async text(args, options) {
    return (await this.run(args, options)).stdout.toString("utf8").trim();
  }

  /** Makes the repository, once: its git dir must not exist yet. sha1, so that `blobId` is what git computes. */
  async init() {
    await this.run(["init", "-q", "-b", "main", "--object-format=sha1"]);
  }

  /** The commit the branch is at, or nothing before the first one. */
  async head() {
    const { code, stdout } = await this.run(["rev-parse", "--verify", "-q", `${BRANCH}^{commit}`], { allowFail: true });
    return code === 0 ? stdout.toString("utf8").trim() : null;
  }

  async isAncestor(older, newer) {
    const { code } = await this.run(["merge-base", "--is-ancestor", older, newer], { allowFail: true });
    return code === 0;
  }

  /** The commits after `from` up to `to`, oldest first; all of them up to `to` without `from`. */
  async commitsAfter(from, to) {
    const out = await this.text(["rev-list", "--reverse", from ? `${from}..${to}` : to]);
    return out ? out.split("\n") : [];
  }

  /** A commit's time (seconds) and message. */
  async commit(sha) {
    const out = (await this.run(["show", "-s", "--format=%ct%x00%B", sha])).stdout.toString("utf8");
    const at = out.indexOf("\0");
    return { time: Number(out.slice(0, at)), message: out.slice(at + 1) };
  }

  /** The blob ids of `names` in commit `sha`, by name. */
  async blobsIn(sha, names) {
    const found = new Map();
    if (!names.length) return found;
    const out = (await this.run(["ls-tree", "-z", sha, "--", ...names])).stdout.toString("utf8");
    for (const entry of out.split("\0")) {
      const tab = entry.indexOf("\t");
      if (tab === -1) continue;
      const [, type, id] = entry.slice(0, tab).split(" ");
      if (type === "blob") found.set(entry.slice(tab + 1), id);
    }
    return found;
  }

  /** The text of `name` as commit `sha` has it. */
  async show(sha, name) {
    return (await this.run(["cat-file", "blob", `${sha}:${name}`])).stdout;
  }

  /** Stores `bytes` as a blob: its id, checked against the one computed here. */
  async storeBlob(bytes) {
    const id = await this.text(["hash-object", "-w", "--no-filters", "--stdin"], { input: bytes });
    if (id !== blobId(bytes)) throw new GitError(`git stored ${id} for a text whose id is ${blobId(bytes)}`);
    return id;
  }

  /**
   * Stores the files at `paths` (absolute) as blobs, in one process: the id
   * of each, in order. A file swapped or changed after it was read comes back
   * under another id than the one the store computed: the store compares them.
   */
  async storeFiles(paths) {
    if (!paths.length) return [];
    const out = await this.text(["hash-object", "-w", "--no-filters", "--stdin-paths"], { input: paths.map((p) => `${p}\n`).join("") });
    return out.split("\n");
  }

  /**
   * One commit on the branch, from `parent` (nothing for the first), that sets
   * each `{ name, blob }` in `entries` and leaves the other documents as they
   * were. Moves the branch only if it is still at `parent`. Returns the commit.
   */
  async commitEntries(parent, entries, message) {
    // The index is the repository's own and holds only registered documents; it is read from the parent each time,
    // so one a failure left half-written does not carry over.
    if (parent) await this.run(["read-tree", parent]);
    else await this.run(["read-tree", "--empty"]);
    const info = entries.map(({ name, blob }) => `100644 ${blob}\t${name}\0`).join("");
    await this.run(["update-index", "-z", "--add", "--index-info"], { input: info });
    const tree = await this.text(["write-tree"]);
    const commit = await this.text(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-F", "-"], { input: message });
    await this.run(["update-ref", "-m", "pithagoras-docs", BRANCH, commit, parent ?? ""]);
    return commit;
  }

  /** Packs the history now and then, as git judges it. */
  async gc() {
    await this.run(["gc", "--auto", "--quiet"], { allowFail: true });
  }
}

/** The trailers a revision is told by, in a commit message. `Doc-Name` is there to rebuild the index without the database. */
const KEYS = ["Doc-Id", "Doc-Name", "Revision", "Author", "Restored-From"];

/** A commit's message: a subject, and one group of trailers per document it changes. */
export function messageFor(subject, groups) {
  const lines = [subject.replace(/[\r\n]+/g, " "), ""];
  for (const group of groups) {
    lines.push(`Doc-Id: ${group.id}`, `Doc-Name: ${group.name}`, `Revision: ${group.revision}`, `Author: ${group.author}`);
    if (group.restoredFrom) lines.push(`Restored-From: ${group.restoredFrom}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The groups of trailers in a message the store wrote: `[{ id, name, revision, author, restoredFrom }]`. Other lines are not trailers. */
export function parseTrailers(message) {
  const groups = [];
  for (const line of message.split("\n")) {
    const at = line.indexOf(": ");
    const key = line.slice(0, at);
    if (at === -1 || !KEYS.includes(key)) continue;
    const value = line.slice(at + 2).trim();
    if (key === "Doc-Id") groups.push({ id: value });
    const group = groups.at(-1);
    if (!group) continue;
    if (key === "Doc-Name") group.name = value;
    else if (key === "Revision") group.revision = Number(value);
    else if (key === "Author") group.author = value;
    else if (key === "Restored-From") group.restoredFrom = Number(value);
  }
  return groups.filter((g) => /^[0-9a-f]{16}$/.test(g.id) && Number.isInteger(g.revision) && g.revision > 0 && g.name && g.author);
}
