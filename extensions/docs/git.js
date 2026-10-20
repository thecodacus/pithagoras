/**
 * The history of a folder's documents: a git repository of the extension's
 * own, in the `git` folder of the store (place.js), which is in the portal's
 * data folder. It is not the folder's own
 * repository, if it has one, and nothing of the folder's or the user's git
 * configuration takes part in it.
 *
 * Every call is the same shape: git started without a shell, its arguments an
 * array, with the git dir and the work tree named through the store's held
 * folder (guard.js), checked before the run, hooks off, no signing, no system
 * or global configuration, and paths taken literally; and with a time limit,
 * so that one that hangs cannot hold the folder's queue. A commit is made from
 * bytes the store hands it, into an index of the repository's own: git never
 * opens a document's file, so a link put in its place, or a file that waits at
 * the open, is not git's to follow.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

/** Who every commit is by. Who changed the document is its `Author` trailer. */
const COMMITTER = { name: "Pithagoras Docs", email: "docs@pithagoras.invalid" };
const BRANCH = "refs/heads/main";

/** A document's text as git names it: the id of its blob. Computed here, so a file can be compared without a process. */
export const blobId = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

/** `spawn` is the code of the system's refusal where git could not be started at all (ENOENT: it is not installed). */
export class GitError extends Error {
  constructor(message, { spawn } = {}) {
    super(message);
    this.spawn = spawn;
  }
}

/** How long one git run may take: a hung one is stopped. Far above what any call of the store needs. */
const RUN_LIMIT_MS = 120_000;

export class Repo {
  /** `guard`: the held store folder (guard.js), which has the git dir in it as `git`. */
  constructor(guard, { timeoutMs = RUN_LIMIT_MS } = {}) {
    this.guard = guard;
    this.timeoutMs = timeoutMs;
  }

  /** `rel` in the git dir. */
  gitPath(rel) {
    return this.guard.at(`git/${rel}`);
  }

  /**
   * Runs git with `args` (and `input` on its stdin): its stdout, or a GitError
   * with what it said. Its environment is made here, not inherited: a GIT_DIR
   * or GIT_INDEX_FILE of the portal's own would point it elsewhere. The store
   * folder is checked first and handed to git as its descriptor 3, which the
   * git dir and the work tree (the store folder: no document is ever read
   * through it) are named by: a folder renamed or replaced meanwhile is not
   * found again by its path.
   */
  run(args, { input, allowFail = false } = {}) {
    try {
      this.guard.check();
    } catch (e) {
      return Promise.reject(e);
    }
    const argv = [
      `--git-dir=${this.guard.forGit("git")}`,
      `--work-tree=${this.guard.forGit()}`,
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
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_AUTHOR_NAME: COMMITTER.name,
      GIT_AUTHOR_EMAIL: COMMITTER.email,
      GIT_COMMITTER_NAME: COMMITTER.name,
      GIT_COMMITTER_EMAIL: COMMITTER.email,
    };
    const { pinned } = this.guard;
    return new Promise((resolve, reject) => {
      const child = spawn("git", argv, { env, cwd: pinned ? "/" : this.guard.dir, stdio: ["pipe", "pipe", "pipe", ...(pinned ? [this.guard.fd] : [])] });
      const out = [];
      let err = "";
      let stopped = false;
      const timer = setTimeout(() => {
        stopped = true;
        child.kill("SIGKILL");
        // Not waited for: something git started may hold its pipes open after it is gone.
        child.stdout.destroy();
        child.stderr.destroy();
        reject(new GitError(`git ${args[0]} took longer than ${this.timeoutMs} ms and was stopped`));
      }, this.timeoutMs);
      child.stdout.on("data", (chunk) => out.push(chunk));
      child.stderr.on("data", (chunk) => (err = (err + chunk).slice(-4000)));
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new GitError(`git could not be started: ${error.message}`, { spawn: error.code }));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const stdout = Buffer.concat(out);
        if (stopped) return;
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

  /**
   * The text of the blob `id`, as the index of the revisions names it. A revision is told by its blob, not by the name its document had
   * in that commit: a document that was renamed has had more than one.
   */
  async blobText(id) {
    if (!/^[0-9a-f]{40}$/.test(id)) throw new GitError(`${id} is not the id of a text`);
    return (await this.run(["cat-file", "blob", id])).stdout;
  }

  /** Stores `bytes` as a blob: its id, checked against the one computed here. */
  async storeBlob(bytes) {
    const id = await this.text(["hash-object", "-w", "--no-filters", "--stdin"], { input: bytes });
    if (id !== blobId(bytes)) throw new GitError(`git stored ${id} for a text whose id is ${blobId(bytes)}`);
    return id;
  }

  /**
   * Stores each of `texts` as a blob, all in one run (fast-import): their ids, each checked against the one computed here. A run
   * of its own for each is what took seconds over a folder of documents taken in at once.
   */
  async storeBlobs(texts) {
    if (!texts.length) return [];
    const blobs = texts.flatMap((bytes, i) => [Buffer.from(`blob\nmark :${i + 1}\ndata ${bytes.length}\n`), bytes, Buffer.from("\n")]);
    // Each one's id, in the order given; and `done`, without which a stream cut short would be taken for a shorter one.
    const asked = Buffer.from(`${texts.map((_, i) => `get-mark :${i + 1}\n`).join("")}done\n`);
    const ids = (await this.text(["fast-import", "--quiet", "--done"], { input: Buffer.concat([...blobs, asked]) })).split("\n");
    texts.forEach((bytes, i) => {
      if (ids[i] !== blobId(bytes)) throw new GitError(`git stored ${ids[i]} for a text whose id is ${blobId(bytes)}`);
    });
    return ids;
  }

  /**
   * One commit on the branch, from `parent` (nothing for the first), that sets
   * each `{ name, blob }` in `entries` (a document that is gone has no blob: its
   * name is taken out) and leaves the other documents as they were. Moves the
   * branch only if it is still at `parent`. Returns the commit.
   */
  async commitEntries(parent, entries, message) {
    // The index is the repository's own and holds only registered documents; it is read from the parent each time,
    // so one a failure left half-written does not carry over.
    if (parent) await this.run(["read-tree", parent]);
    else await this.run(["read-tree", "--empty"]);
    // Mode 0 with no object is how `--index-info` says "take this path out".
    const info = entries.map(({ name, blob }) => (blob ? `100644 ${blob}\t${name}\0` : `0 ${"0".repeat(40)}\t${name}\0`)).join("");
    await this.run(["update-index", "-z", "--add", "--index-info"], { input: info });
    const tree = await this.text(["write-tree"]);
    const commit = await this.text(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-F", "-"], { input: message });
    await this.run(["update-ref", "-m", "pithagoras-docs", BRANCH, commit, parent ?? ""]);
    return commit;
  }

  /** Packs the history now and then, as git judges it. Not needed: one that cannot (or takes too long) is left for next time. */
  async gc() {
    try {
      await this.run(["gc", "--auto", "--quiet"], { allowFail: true });
    } catch (e) {
      if (!(e instanceof GitError)) throw e;
    }
  }
}

/** The trailers a revision is told by, in a commit message. `Doc-Name` is there to rebuild the index without the database. */
const KEYS = ["Doc-Id", "Doc-Name", "Revision", "Author", "Restored-From", "Renamed-From", "Deleted"];

/** A commit's message: a subject, and one group of trailers per document it changes. */
export function messageFor(subject, groups) {
  const lines = [subject.replace(/[\r\n]+/g, " "), ""];
  for (const group of groups) {
    lines.push(`Doc-Id: ${group.id}`, `Doc-Name: ${group.name}`, `Revision: ${group.revision}`, `Author: ${group.author}`);
    if (group.restoredFrom) lines.push(`Restored-From: ${group.restoredFrom}`);
    // A rename says what the document was called, and a deletion that it is gone: it has no text to tell by, and rebuilding the index from the history must not bring it back.
    if (group.renamedFrom) lines.push(`Renamed-From: ${group.renamedFrom}`);
    if (group.deleted) lines.push("Deleted: yes");
  }
  return `${lines.join("\n")}\n`;
}

/** The groups of trailers in a message the store wrote: `[{ id, name, revision, author, restoredFrom, renamedFrom, deleted }]`. Other lines are not trailers. */
export function parseTrailers(message) {
  const groups = [];
  for (const line of message.split("\n")) {
    const at = line.indexOf(": ");
    const key = line.slice(0, at);
    if (at === -1 || !KEYS.includes(key)) continue;
    // Not trimmed: a name may start with a space, and an id never has one to lose.
    const value = line.slice(at + 2).replace(/\r$/, "");
    if (key === "Doc-Id") groups.push({ id: value });
    const group = groups.at(-1);
    if (!group) continue;
    if (key === "Doc-Name") group.name = value;
    else if (key === "Revision") group.revision = Number(value);
    else if (key === "Author") group.author = value;
    else if (key === "Restored-From") group.restoredFrom = Number(value);
    else if (key === "Renamed-From") group.renamedFrom = value || undefined;
    else if (key === "Deleted") group.deleted = value === "yes" ? true : undefined;
  }
  return groups.filter((g) => /^[0-9a-f]{16}$/.test(g.id) && Number.isInteger(g.revision) && g.revision > 0 && g.name && g.author);
}
