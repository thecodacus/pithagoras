import { randomBytes } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { holdsWork, unsavedIn, unsavedRefusal, type Unsaved } from "./git.js";
import { pictureType } from "./prompt-images.js";
import { isWithinText, pathBelow } from "./within.js";

/**
 * Looking at, changing and taking away the files in a chat's folder, from the browser.
 *
 * The folder is one the agent already works in with full access, so this gives
 * the browser the same view and nothing more. What it must not do is let a
 * name that arrives in a URL reach past that folder, and the agent can leave
 * links in it that point anywhere. So a path is checked twice: as text, and
 * again where it really leads once every link along it is followed. And a file
 * is opened without following a link in its last place, which closes the gap
 * between the check and the open.
 *
 * The listing, reading and resolving here were first written for the workspace
 * file browser in PR 2, keyed by workspace name; this is the same, keyed by
 * folder, so that a chat in Home — outside the workspace root — has files too.
 */

/** Above this a file is offered as a download only: it is neither shown nor sent back whole. */
export const MAX_EDIT_BYTES = 1024 * 1024;
/** A folder with more than this is cut off, and says so. */
export const MAX_ENTRIES = 2_000;

export type FileErrorCode = "invalid" | "missing" | "conflict" | "exists" | "too_large" | "failed" | "unsaved";

export class FileError extends Error {
  /** With "failed": the system's own code for it (ENOSPC, EACCES, EROFS…), for a caller that says more than the sentence does. */
  readonly errno?: string;

  constructor(
    readonly code: FileErrorCode,
    message: string,
    /** With "unsaved": what the delete would lose. */
    readonly unsaved?: Unsaved,
    /** With "failed": the error the system gave. */
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    const errno = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (typeof errno === "string") this.errno = errno;
  }
}

export interface FileEntry {
  name: string;
  /** "link" is a link that could not be followed to something inside the folder. */
  type: "dir" | "file" | "link";
  /**
   * The entry is a link, whatever `type` says. A link that leads to a folder inside
   * this one is listed as a "dir", but taking it away removes the link, not the folder.
   */
  link?: boolean;
  size: number;
  mtime: number;
}

const lexists = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * The real folder `dir` stands for, or an error if there is none.
 *
 * Canonical once, up front, so that every check after it compares real paths
 * with real paths.
 */
export function baseDir(dir: string): string {
  try {
    const real = realpathSync(dir);
    if (!statSync(real).isDirectory()) throw new Error("not a directory");
    return real;
  } catch {
    throw new FileError("missing", "This chat's folder does not exist");
  }
}

/** `p` with every link in the part of it that exists followed; the rest stays as written. */
function realThroughExisting(p: string): string {
  let current = p;
  const tail: string[] = [];
  // lstat, not exists: a link that points nowhere still exists, and stopping at
  // it is what lets realpath below refuse it. Walking past it would treat its
  // name as a plain missing folder, and a write would then follow the link.
  while (!lexists(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new FileError("missing", "There is no such place");
    tail.unshift(path.basename(current));
    current = parent;
  }
  let real: string;
  try {
    real = realpathSync(current);
  } catch {
    throw new FileError("invalid", "That path leads outside the folder");
  }
  return tail.length ? path.join(real, ...tail) : real;
}

/**
 * The absolute path for `rel` inside `base` (which is already canonical).
 *
 * Refuses `..`, an absolute path and anything that a link leads out of the
 * folder by. What is returned is the checked, canonical path — use it, not the
 * text that came in.
 */
export function resolveInside(base: string, rel: unknown): string {
  const text = String(rel ?? "");
  if (text.includes("\0")) throw new FileError("invalid", "That is not a valid path");
  const resolved = path.resolve(base, text.replace(/^[/\\]+/, ""));
  if (!isWithinText(base, resolved)) throw new FileError("invalid", "That path leads outside the folder");
  const real = realThroughExisting(resolved);
  if (!isWithinText(base, real)) throw new FileError("invalid", "That path leads outside the folder");
  return real;
}

/** What is directly in a folder: folders first, then files, each by name. */
export function listDir(base: string, rel: unknown, options: AgentUse = {}): { path: string; entries: FileEntry[]; truncated: boolean } {
  const target = resolveInside(base, rel);
  // Held for the whole listing: what is listed is this folder, whatever the path leads to by the time each entry is looked at.
  let held: Held;
  try {
    held = holdFolder(base, target, using(options, READ_IN));
  } catch (e) {
    if (e instanceof FileError && e.code === "missing") throw new FileError("missing", "There is no such folder");
    throw e;
  }
  try {
    return listHeld(base, target, held);
  } finally {
    held.close();
  }
}

function listHeld(base: string, target: string, held: Held): { path: string; entries: FileEntry[]; truncated: boolean } {
  let names;
  try {
    names = readdirSync(held.here, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOTDIR") throw new FileError("invalid", "That is not a folder");
    throw new FileError("missing", "There is no such folder");
  }
  // The cap bounds the work, not only the answer: every entry that is looked at
  // is a syscall (two more for a link), on the thread that also serves every
  // other request. So a big folder is cut down first, on what the listing
  // already says — folders before files, then by name — and only what is kept is
  // looked at. That is also the order the answer is in, so nothing is lost by it.
  let candidates = names.filter((d) => d.name !== ".git");
  const total = candidates.length;
  if (total > MAX_ENTRIES) {
    const kind = (d: (typeof candidates)[number]) => (d.isDirectory() ? 0 : 1);
    candidates = candidates
      .sort((a, b) => kind(a) - kind(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .slice(0, MAX_ENTRIES);
  }
  const entries: FileEntry[] = [];
  for (const dirent of candidates) {
    const full = held.at(dirent.name);
    try {
      let st = lstatSync(full);
      let type: FileEntry["type"] = st.isDirectory() ? "dir" : "file";
      const link = st.isSymbolicLink();
      if (link) {
        // Shown as what it leads to, but only if that is inside the folder.
        // A link that leads out, or nowhere, is listed and left alone.
        type = "link";
        const real = realpathSync(full);
        if (isWithinText(base, real)) {
          st = statSync(real);
          type = st.isDirectory() ? "dir" : "file";
        }
      }
      entries.push({ name: dirent.name, type, ...(link ? { link } : {}), size: st.size, mtime: st.mtimeMs });
    } catch {
      // Gone since it was listed, or a link to nowhere.
      entries.push({ name: dirent.name, type: "link", link: true, size: 0, mtime: 0 });
    }
  }
  entries.sort((a, b) => {
    const rank = (t: FileEntry["type"]) => (t === "dir" ? 0 : 1);
    return rank(a.type) - rank(b.type) || a.name.localeCompare(b.name);
  });
  return { path: path.relative(base, target), entries, truncated: total > MAX_ENTRIES };
}

/** What is said when a save would put older text over newer, or over a file that is gone. */
export const CHANGED = "The file changed after you opened it";

/**
 * Opens a plain file without following a link in its last place, or waiting on one.
 * A pipe left there would otherwise hold the server; a device is not a file.
 */
function openPlain(file: string, flags: number): number {
  let fd: number;
  try {
    fd = openSync(file, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o644);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new FileError("missing", "There is no such file");
    // Only where a file is being made and something is there by now.
    if (code === "EEXIST") throw new FileError("conflict", CHANGED);
    if (code === "ELOOP" || code === "ENXIO" || code === "EISDIR") {
      throw new FileError("invalid", "That is a link, a folder or not a plain file");
    }
    throw e;
  }
  if (!fstatSync(fd).isFile()) {
    closeSync(fd);
    throw new FileError("invalid", "That is not a plain file");
  }
  return fd;
}

/** Whether a descriptor can be named as a path (`/proc/self/fd/<n>`), which is what stands in for `openat` here: Linux. */
const HAS_FD_PATHS = existsSync("/proc/self/fd");
const namesDescriptors = () => process.platform === "linux" && HAS_FD_PATHS;

const OPEN_FOLDER = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/** Node does not export it. A descriptor that only names a folder (no read, no sync), for which the right to search the folders above it is enough. */
const O_PATH = 0o10000000;

/**
 * How a folder is opened to be walked through: with O_PATH where the kernel has it, so that a folder the portal may
 * search but not read (mode 0311, say) can be walked through as it could before. What tells that the flag is the one it
 * is taken for is that such a descriptor cannot be synced (EBADF).
 */
const WALK_FOLDER = (() => {
  if (process.platform !== "linux") return OPEN_FOLDER;
  let fd: number | undefined;
  try {
    fd = openSync("/", O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    fsyncSync(fd);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EBADF") return O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return OPEN_FOLDER;
})();

/** A descriptor as a path, `/proc/self/fd/<n>`: the folder it is, whatever its path leads to now (see holdFolder). */
const named = (descriptor: number) => `/proc/self/fd/${descriptor}`;

/** A folder opened without following a link in its last place. */
function openFolder(where: string, flags = OPEN_FOLDER): number {
  try {
    return openSync(where, flags);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new FileError("missing", "There is no such file or folder");
    // A link is ENOTDIR here too: O_DIRECTORY is looked at before O_NOFOLLOW.
    if (code === "ELOOP" || code === "ENOTDIR") {
      if (lstatSync(where, { throwIfNoEntry: false })?.isSymbolicLink()) throw new FileError("invalid", "That path leads outside the folder");
      throw new FileError("invalid", "That is not a folder");
    }
    throw ioFailure(e, "The folder could not be opened", "Nothing was changed.");
  }
}

/**
 * A folder inside the chat's folder, held open: what is made, read or removed in
 * it is named through `at`, so that it happens in this folder.
 */
interface Held {
  /** The folder, for `fstat` and for naming it: it may be an O_PATH descriptor, which cannot be read, synced or given away. */
  readonly fd: number;
  /** The folder itself, as a path for the calls that take one. */
  readonly here: string;
  /**
   * Whether `at` goes through the descriptor, so that no change of a folder on the way to it can send
   * a call elsewhere: Linux. Where it is not, the names are the checked path's, as they were before.
   */
  readonly pinned: boolean;
  /** The agents the folder was held for (`likeParent`), who a file in it is looked at for too; nothing where none was asked for or the sandbox is off. */
  readonly agents?: AgentAccess[];
  /** `name` in the folder: one name, no place. */
  at(name: string): string;
  close(): void;
}

/**
 * The folder open on `fd`, whose checked path is `dir`, as a Held: named through its descriptor where descriptors can be
 * named (`pinned`), else by its path, which leaves the gap that holdFolder tells of.
 */
function heldOf(fd: number, dir: string, agents?: AgentAccess[]): Held {
  const pinned = namesDescriptors();
  const here = pinned ? named(fd) : dir;
  let open = true;
  return {
    fd,
    here,
    pinned,
    agents,
    at: (name) => (pinned ? `${here}/${name}` : path.join(dir, name)),
    close: () => {
      if (open) closeSync(fd);
      open = false;
    },
  };
}

/** What is said of a folder or a file that the sandbox closed to the agent. */
const CLOSED_FOLDER = "That folder is closed to the agent, so it is left alone";
const CLOSED_FILE = "That file is closed to the agent, so it is left alone";
const STICKY_FILE = "That is another user's, in a folder where each keeps their own, so it is left alone";

/**
 * Who an agent is in the sandbox, as the kernel decides by it when the agent opens something: the user and the groups (its own and the sandbox
 * group) the sandbox runs it as. The portal says who the agents of some chats are (setAgentAccess); nothing where the agent is not another user
 * (the sandbox is off), and then nothing is closed to it that the portal's own user may use.
 */
export interface AgentAccess {
  uid: number;
  /** Its group and the groups it is also in. */
  groups: number[];
}

let agentAccessOf: (chats: readonly string[], agents: readonly string[]) => AgentAccess[] | undefined = () => undefined;

/**
 * Tells who the agents of some chats are, and who some agents are by their ids: the portal sets it where the sandbox is (extension-host.ts),
 * from each chat's own stored workspace (what the sandbox runs its agent by), never from a path that the agent could lead somewhere else.
 * Nothing where there is no sandbox; it throws for a chat or an agent it does not know.
 */
export function setAgentAccess(resolve: (chats: readonly string[], agents: readonly string[]) => AgentAccess[] | undefined): void {
  agentAccessOf = resolve;
}

/**
 * The agents of `chats` (the chats that work in a folder: all of them must be able to use what is read or changed there for them) and the
 * agents named by `ids`, or nothing where there is no sandbox. Who they are not being known, or no chat and no agent being named, is a
 * refusal: what is not known to be open to the agent is closed, and the agent is not taken from a path.
 */
function agentsOf(chats: readonly string[], ids: readonly string[]): AgentAccess[] | undefined {
  let agents: AgentAccess[] | undefined;
  try {
    agents = agentAccessOf(chats, ids);
  } catch {
    throw new FileError("invalid", "Who the agent is here could not be told, so the folder is left alone");
  }
  if (agents && agents.length === 0) throw new FileError("invalid", "No chat is known that works in this folder, so the folder is left alone");
  return agents;
}

/** What the agent must be allowed to do to a folder the portal reads in for it (list it and open what is in it), changes in (make, replace, take away and give names), or both. */
const READ_IN = 0o5;
const CHANGE_IN = 0o3;
const USE_IN = 0o7;
/** To each folder on the way to it: search it. */
const PASS = 0o1;
/** And to a file the portal reads for it. */
const READ_FILE = 0o4;

/** For the calls that act for the agents of some chats: what they must be allowed to do to the folder the call holds, and whose they are. */
interface Use {
  need: number;
  chats: readonly string[];
  agents: readonly string[];
}

/** What a call that took `likeParent` is held to: `need` of the folder, for `options.chats` and `options.agents`. Nothing where it was not asked for. */
const using = (options: AgentUse, need: number): Use | undefined =>
  options.likeParent ? { need, chats: options.chats ?? [], agents: options.agents ?? [] } : undefined;

/**
 * Whether `agent` may do `need` (a mask of 4 read, 2 write, 1 search or run) to something with this owner and mode, as the kernel decides it:
 * by the owner's bits if the agent's user owns it, else by the group's if its group is one of the agent's, else by everyone's. The sandbox
 * closes what an agent may not enter to root: `root:root 0700` for a folder (0600 a file), `root:` the tools' group 0750 for the keys.
 * Who owns a folder or a file says nothing: a project is root's, with the sandbox's group set on it, and so is the closed folder in it.
 * Not modelled: POSIX ACLs (an entry for the agent, or a mask, changes what the mode bits say). Node cannot read them and nothing the sandbox
 * sets is one; where a person put one on a folder or file of a chat, the mode bits are what is asked.
 */
function mayAs(st: { uid: number; gid: number; mode: number }, agent: AgentAccess, need: number): boolean {
  const bits = st.uid === agent.uid ? (st.mode >> 6) & 7 : agent.groups.includes(st.gid) ? (st.mode >> 3) & 7 : st.mode & 7;
  return (bits & need) === need;
}

/** `mayAs` for every one of the agents. */
const mayAll = (st: { uid: number; gid: number; mode: number }, agents: AgentAccess[], need: number) => agents.every((agent) => mayAs(st, agent, need));

/**
 * Whether the agents may take away, rename or replace `entry` in the held folder. In a sticky folder (a mode of 1777, as a shared temporary
 * folder has) the kernel lets a user do that only to what is its own, or in a folder that is its own: write and search on the folder is not enough.
 */
function mayChange(held: Held, entry: { uid: number | bigint }): boolean {
  if (!held.agents) return true;
  const folder = fstatSync(held.fd);
  if (!(folder.mode & 0o1000)) return true;
  return held.agents.every((agent) => Number(entry.uid) === agent.uid || folder.uid === agent.uid);
}

/**
 * Holds the folder `dir`, a checked path (`resolveInside`'s) inside `base`.
 *
 * A check of a path and a call on it are two steps, and between them the agent
 * can put a link where a folder on the way was: the call then goes where the link
 * leads, and the portal, which may be root, makes a file or a folder there. So the
 * folder is walked down from `base` one part at a time, each opened relative to
 * the one before it (`/proc/self/fd/<n>/<part>`) and never through a link, and
 * what is done in the folder is done through the descriptor of the last one.
 * What this guarantees on Linux: the descriptor is a folder inside `base`,
 * whatever is done to the path from now on. A checked path has no link on it, so a
 * link found on the way is one put there after the check, and is refused. The
 * walk starts at `base` itself, whose real path is checked on the descriptor, so a
 * folder above it that was swapped is found as well.
 *
 * Where descriptors cannot be named (macOS has no /proc) the folder is opened
 * by its path and calls go by the path, which leaves the gap this closes; there the portal
 * does not give anything it makes away (see handOver), so the worst that is left is a
 * file the portal owns in the wrong place, as it was before.
 */
function holdFolder(base: string, dir: string, use?: Use): Held {
  const below = pathBelow(base, dir);
  if (below === undefined) throw new FileError("invalid", "That path leads outside the folder");
  // The agents first: who they are not being known is a refusal before anything is opened.
  const agents = use ? agentsOf(use.chats, use.agents) : undefined;
  // What is asked of the folder is told from its own descriptor: not of one looked at by its path before.
  const closed = (fd: number, need: number) => {
    if (agents && !mayAll(fstatSync(fd), agents, need)) throw new FileError("invalid", CLOSED_FOLDER);
  };
  const need = use?.need ?? 0;
  if (!namesDescriptors()) {
    // Every folder on the way is searched by the agents too, by its path: all there is where a folder cannot be named by its descriptor.
    if (agents) {
      for (let up = path.dirname(dir); ; up = path.dirname(up)) {
        if (!mayAll(lstatSync(up), agents, PASS)) throw new FileError("invalid", CLOSED_FOLDER);
        if (up === path.dirname(up)) break;
      }
    }
    const fd = openFolder(dir);
    try {
      closed(fd, need);
    } catch (e) {
      closeSync(fd);
      throw e;
    }
    return heldOf(fd, dir, agents);
  }
  // For the agents the walk starts at `/`: the kernel needs search on every folder of a path, and the sandbox closes a subtree by its top folder
  // alone (what is inside keeps the group's rights), so a path that leads through a closed folder is closed all the way down. No folder on the
  // way is followed as a link, `base` itself included (it is a canonical path, so one that is a link now was swapped).
  const above = agents ? path.resolve(base).split(path.sep).filter(Boolean) : [];
  let fd = openFolder(agents ? path.parse(path.resolve(base)).root : base, WALK_FOLDER);
  try {
    // The part of the path above `base` is not walked, so it is checked on what was opened: a folder up there swapped for a
    // link since `base` was made canonical leads this open somewhere else, and the descriptor says where.
    if (!agents && realpathSync.native(named(fd)) !== path.resolve(base)) throw new FileError("invalid", "That path leads outside the folder");
    for (const part of [...above, ...below.split(path.sep).filter(Boolean)]) {
      closed(fd, PASS);
      const next = openFolder(`${named(fd)}/${part}`, WALK_FOLDER);
      closeSync(fd);
      fd = next;
    }
    closed(fd, need);
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  return heldOf(fd, dir, agents);
}

/**
 * A plain file opened in the folder it is in, held and not followed (see holdFolder). `file` is a checked path.
 * What is returned is the file's descriptor, which is what every later step goes through.
 */
function openIn(base: string, file: string, flags: number, use?: Use): number {
  if (file === base) throw new FileError("invalid", "That is not a plain file");
  let held: Held;
  try {
    held = holdFolder(base, path.dirname(file), use);
  } catch (e) {
    if (e instanceof FileError && e.code === "missing") throw new FileError("missing", "There is no such file");
    throw e;
  }
  try {
    const fd = openPlain(held.at(path.basename(file)), flags);
    // A file the agent could not read itself is not read for it.
    if (held.agents && !mayAll(fstatSync(fd), held.agents, READ_FILE)) {
      closeSync(fd);
      throw new FileError("invalid", CLOSED_FILE);
    }
    return fd;
  } finally {
    held.close();
  }
}

/** Null bytes early in a file are the cheap, reliable sign that it is not text. */
const looksBinary = (head: Buffer) => head.includes(0);

export type FileContent = { binary: true; size: number; mtime: number } | { binary: false; size: number; mtime: number; content: string };

/** A file's text, or the fact that it is not text or too large to show. */
export function readText(base: string, rel: unknown, options: AgentUse = {}): FileContent {
  const fd = openIn(base, resolveInside(base, rel), constants.O_RDONLY, using(options, READ_IN));
  try {
    const st = fstatSync(fd);
    if (st.size > MAX_EDIT_BYTES) return { binary: true, size: st.size, mtime: st.mtimeMs };
    const buffer = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const n = readSync(fd, buffer, read, st.size - read, read);
      if (n === 0) break;
      read += n;
    }
    const data = buffer.subarray(0, read);
    if (looksBinary(data.subarray(0, 8000))) return { binary: true, size: st.size, mtime: st.mtimeMs };
    return { binary: false, size: st.size, mtime: st.mtimeMs, content: data.toString("utf8") };
  } finally {
    closeSync(fd);
  }
}

/** What a call that acts in a folder for the agents that work in it takes. */
export interface AgentUse {
  /**
   * For what the portal reads or writes as root in a folder that an agent can write next to, and so rename things into (a folder the sandbox
   * closed to the agent, moved to the name of one the portal reads for it, would be handed to it): the folder, and the file, must be something
   * the agents of `chats`, and those of `agents`, could use themselves. That is told as the kernel would for the user and groups the sandbox runs each as (setAgentAccess):
   * every folder of the path from `/` down to the folder must be one they may search (the sandbox closes a subtree by its top folder only, and
   * `base` is reached through the folders above it), and the folder itself, as it is held, one they may read and search for what is read in it,
   * write in and search for what is changed, both for a folder that is held to. A file must be one they may read, and in a sticky folder what is
   * taken away, renamed or replaced must be one of their own. Refused (`invalid`) otherwise. Where the sandbox is off nothing is refused.
   */
  likeParent?: boolean;
  /**
   * The chats whose agents work in the folder, every one of which must be able to use it (what is read for one is handed to the others). The agent
   * is not taken from the path: a folder can be led elsewhere by a link, and the sandbox runs a chat's agent by the workspace stored for it. No chat
   * named, and no agent, is a refusal, with the sandbox on.
   */
  chats?: readonly string[];
  /**
   * Agents by their ids, held to as the agents of `chats` are: for a file of an agent's own that the portal hands to a chat that runs as
   * another agent. A chat in a project linked to an agent carries that agent's files, read from its home, which the sandbox closes to every
   * other agent, the one the project's chats run as among them: they are read as the agent whose home it is, the one that can write there.
   */
  agents?: readonly string[];
}

/** What opens a file for reading, beyond the checks every path gets. */
export interface OpenOptions extends AgentUse {
  /**
   * `rel` is a name in `base` itself, reached through no link: refused (`invalid`) when `resolveInside` led it
   * elsewhere, even to another file inside the folder. For a file that is only to be what its name says.
   */
  direct?: boolean;
  /** A file with a second name (a hard link, which may be outside the folder) is refused (`invalid`). */
  alone?: boolean;
}

/**
 * What tells that a file's content changed without reading it: its identity
 * (inode), size and times. A write in place changes the times, a file put in
 * place by a rename its inode.
 */
const changeOf = (st: BigIntStats) => `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
/** The modification time in ms, with its fraction, worked out as Node does for `Stats.mtimeMs`, so that the two agree to the last digit. */
const mtimeOf = (st: BigIntStats) => Number(st.mtimeNs / 1_000_000_000n) * 1000 + Number(st.mtimeNs % 1_000_000_000n) / 1e6;

/** The checked path of `rel`, and with `direct` only if it is that name in `base` and nothing a link led to. */
function placeOf(base: string, rel: unknown, direct: boolean | undefined): string {
  const file = resolveInside(base, rel);
  if (direct && (path.dirname(file) !== base || path.basename(file) !== String(rel))) {
    throw new FileError("invalid", "That is not a file directly in the folder");
  }
  return file;
}

/**
 * A plain file opened for reading or sending: the descriptor, its size, its
 * name, and when it was changed last (`mtime`, and `change`, which differs
 * whenever the file was written, or put in place by a rename).
 *
 * What is read or sent comes from the descriptor that was opened here, without
 * following a link, so nothing can be swapped in between the check and the
 * send. Handing the path on to be opened again is what that would allow, and it
 * would also treat a name that starts with a dot as one to refuse. The caller
 * owns the descriptor.
 */
export function openFile(
  base: string,
  rel: unknown,
  options: OpenOptions = {},
): { fd: number; size: number; name: string; mtime: number; change: string } {
  const file = placeOf(base, rel, options.direct);
  const fd = openIn(base, file, constants.O_RDONLY, using(options, READ_IN));
  try {
    const st = fstatSync(fd, { bigint: true });
    if (options.alone && st.nlink !== 1n) throw new FileError("invalid", "That file has another name elsewhere (a hard link)");
    return { fd, size: Number(st.size), name: path.basename(file), mtime: mtimeOf(st), change: changeOf(st) };
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}

/** A plain file opened for sending as a download: the descriptor, its size and its name. The caller owns the descriptor. */
export function openDownload(base: string, rel: unknown): { fd: number; size: number; name: string } {
  const { fd, size, name } = openFile(base, rel);
  return { fd, size, name };
}

/**
 * A file's bytes, as they are: no text is made of them, and a file with null
 * bytes is not set aside as binary. At most 1 MB (`too_large`), as `readText`
 * has it. With `head`, only that many bytes from the start are read (none, for
 * a caller that wants only `change`), and `size` is still the whole file's.
 */
export function readBytes(
  base: string,
  rel: unknown,
  options: OpenOptions & { head?: number } = {},
): { bytes: Buffer; size: number; mtime: number; change: string } {
  const { fd, size, mtime, change } = openFile(base, rel, options);
  try {
    if (size > MAX_EDIT_BYTES) throw new FileError("too_large", `Files over ${MAX_EDIT_BYTES / 1024 / 1024} MB are not read here`);
    const want = Math.min(size, Math.max(0, Math.floor(options.head ?? size)));
    const buffer = Buffer.alloc(want);
    let read = 0;
    while (read < want) {
      const n = readSync(fd, buffer, read, want - read, read);
      // Shorter than it was when it was measured.
      if (n === 0) break;
      read += n;
    }
    return { bytes: buffer.subarray(0, read), size, mtime, change };
  } finally {
    closeSync(fd);
  }
}

/** The rename of a save is only lasting once the folder that holds it is synced. */
function syncFolder(held: Held): void {
  let fd: number | undefined;
  try {
    // The held descriptor may be an O_PATH one, which cannot be synced: the folder is opened for reading again through it
    // (the folder it names, not a lookup of its name).
    fd = openSync(held.here, constants.O_RDONLY | constants.O_DIRECTORY);
    fsyncSync(fd);
  } catch {
    // Some file systems cannot sync a folder, and a folder the portal may search but not read cannot be opened to be
    // synced; the rename stands all the same.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Larger than this, a picture is not shown: it is a download like any other file. */
export const MAX_PICTURE_BYTES = 25 * 1024 * 1024;

/**
 * A picture in the folder, opened to be shown in the page, not saved.
 *
 * Its type comes from its first bytes, as a picture sent with a message does
 * (see prompt-images.ts), not from its name: whatever is served back to be
 * drawn inline must really be one of the four kinds a browser draws and
 * nothing else, so that no page and no script is ever served under this
 * portal's origin from a file the agent wrote.
 *
 * With `likeParent`, for a picture an agent names: one the agent could not
 * read itself is refused (see AgentUse).
 */
export function openPicture(base: string, rel: unknown, options: AgentUse = {}): { fd: number; size: number; name: string; mimeType: string } {
  const { fd, size, name } = openFile(base, rel, options);
  const opened = { fd, size, name };
  try {
    if (opened.size > MAX_PICTURE_BYTES) throw new FileError("too_large", "The picture is over 25 MB; download it instead");
    const head = Buffer.alloc(12);
    readSync(opened.fd, head, 0, head.length, 0);
    const mimeType = pictureType(head);
    if (!mimeType) throw new FileError("invalid", "That is not a PNG, JPEG, GIF or WebP picture");
    return { ...opened, mimeType };
  } catch (e) {
    closeSync(opened.fd);
    throw e;
  }
}

/**
 * A picture in the folder, read whole, for one that is sent on as it is, such
 * as to a channel. Opened as a picture shown is: checked by its bytes and its
 * size, and never through a link out of the folder; `options` as for
 * openPicture.
 */
export function readPicture(base: string, rel: unknown, options: AgentUse = {}): { bytes: Buffer; mimeType: string; name: string } {
  return readOpened(openPicture(base, rel, options));
}

/** A file opened by openPicture or openVideo, read whole and closed. */
export function readOpened(opened: { fd: number; size: number; name: string; mimeType: string }): { bytes: Buffer; mimeType: string; name: string } {
  try {
    const bytes = Buffer.alloc(opened.size);
    let read = 0;
    while (read < bytes.length) {
      const n = readSync(opened.fd, bytes, read, bytes.length - read, read);
      // Shorter than it was when it was measured.
      if (n === 0) break;
      read += n;
    }
    return { bytes: bytes.subarray(0, read), mimeType: opened.mimeType, name: opened.name };
  } finally {
    closeSync(opened.fd);
  }
}

/**
 * What a failed change is called to the person, by what the system said.
 * Anything not known here is left as it is, and becomes a plain 500 with a log line.
 */
function ioFailure(e: unknown, what: string, after: string): unknown {
  const code = (e as NodeJS.ErrnoException)?.code;
  // Gone since it was looked at, or the folder it was to go in is not there.
  if (code === "ENOENT") return new FileError("missing", "There is no such file or folder");
  if (code === "ENOTDIR") return new FileError("invalid", "That is not a folder");
  if (code && ["ENOSPC", "EDQUOT", "EIO", "EROFS", "EACCES", "EPERM", "EFBIG", "ENOTEMPTY", "EBUSY"].includes(code)) {
    return new FileError("failed", `${what} (${code}). ${after}`, undefined, e);
  }
  return e;
}

/** A save that did not happen: the file is as it was. */
const writeFailure = (e: unknown) => ioFailure(e, "The file could not be saved", "It was left as it was.");

/** What a save can be told beyond the text and the time the person saw. */
export interface WriteOptions extends AgentUse {
  /** `rel` is a name in `base` itself, reached through no link (see OpenOptions.direct). */
  direct?: boolean;
}

/** Who a file or folder belongs to. */
interface Owner {
  uid: number;
  gid: number;
}

/**
 * What a file that is made in the held folder is given: the mode of the folder
 * (a file: 0644, and writable for the folder's group where the folder is) and
 * its owner and group, read from the folder's descriptor. With the sandbox on
 * the portal writes as root in a folder the agent's user works in, and what the
 * portal makes has to be something the agent goes on editing; where the portal
 * is not allowed to give a file away it stays the portal's, as it always was.
 */
function madeIn(held: Held): { mode: number; owner: Owner } {
  const folder = fstatSync(held.fd);
  return { mode: 0o644 | (folder.mode & 0o020), owner: { uid: folder.uid, gid: folder.gid } };
}

/**
 * Gives the file or folder behind `fd`, which was just made in the held folder,
 * to `owner`, and then its mode.
 *
 * Only through the held folder on Linux (`pinned`): it is known to be inside the
 * chat's folder, so that what is given away is the agent's own place. Where it is
 * not known, nothing is given: a swapped folder would otherwise have the portal, as
 * root, make a file for the agent anywhere.
 *
 * Group-write is the folder's group's. A file that stays in another group (the
 * portal may not give it away, as it is not root, and is not in the folder's
 * group) does not get it: the portal's own group is not the one the folder
 * lets write.
 */
function handOver(fd: number, owner: Owner, mode: number, held: Held): void {
  if (held.pinned) {
    try {
      fchownSync(fd, owner.uid, owner.gid);
    } catch {
      // Not allowed to give it away. The group may still be the folder's, if the portal belongs to it.
      try {
        fchownSync(fd, -1, owner.gid);
      } catch {
        // It stays in the portal's group.
      }
    }
  }
  // After the owner: giving a file away takes setuid and setgid off it, and they are not carried over in any case.
  if (fstatSync(fd).gid !== owner.gid) mode &= ~0o2020;
  fchmodSync(fd, mode);
}

/**
 * Saves a file's text, or its bytes.
 *
 * `expected` is the modification time the editor was showing. If the file has
 * changed since — the agent writes here too — the save is refused instead of
 * putting the older text over the newer, and the person chooses what to keep.
 *
 * The text is written to a file beside it and put in place by a rename, not
 * written into the file itself. Cutting a file off and then failing to fill it
 * (a full disk, an I/O error) leaves an empty file where the work was, and a
 * file whose time has moved, so the next save is refused as a conflict. Done this
 * way a failed save leaves the file exactly as it was. The rename also replaces
 * whatever is at the name and does not follow it, so a link put there after the
 * check is replaced, not written through. The folder is synced after it, so the
 * rename lasts through a crash.
 *
 * The answer is the written file's own (read from the descriptor it was
 * written through), with its `change`: see openFile.
 */
export function writeText(
  base: string,
  rel: unknown,
  content: string | Uint8Array,
  expected?: number,
  /** Only make it: a file already there is not replaced. What "New file" means. */
  createOnly = false,
  options: WriteOptions = {},
): { size: number; mtime: number; change: string } {
  const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  if (data.length > MAX_EDIT_BYTES) {
    throw new FileError("too_large", `Files over ${MAX_EDIT_BYTES / 1024 / 1024} MB are not edited here`);
  }
  const target = placeOf(base, rel, options.direct);
  if (target === base) throw new FileError("invalid", "That is the folder, not a file");
  const name = path.basename(target);
  // The folder is held for all of it: the file is looked at, written and put in place in this folder and no other,
  // whatever happens to the path meanwhile (see holdFolder).
  let held: Held;
  try {
    held = holdFolder(base, path.dirname(target), using(options, CHANGE_IN));
  } catch (e) {
    // A folder that is gone is a file that is gone: what the person was shown is out of date.
    if (e instanceof FileError && e.code === "missing" && expected !== undefined) throw new FileError("conflict", CHANGED);
    throw e;
  }
  try {
    // Looked at before anything is written, and without O_CREAT: a file that is
    // there is checked as it is, so an emptied one is compared like any other. One
    // that is not there was either never made (no `expected`, so make it) or has
    // been taken away since it was opened, and putting it back with old text is
    // not what a save means.
    let mode = 0o644;
    let owner: Owner;
    let existed = true;
    try {
      // Only to look at: what is written goes to a file beside it, so the file itself
      // need not be writable (a read-only one is replaced, and keeps its mode).
      const fd = openPlain(held.at(name), constants.O_RDONLY);
      try {
        const st = fstatSync(fd);
        if (createOnly) throw new FileError("exists", `There is already something called "${name}" here`);
        if (st.nlink > 1) throw new FileError("invalid", "That file is shared with another, so it is left alone");
        if (held.agents && !mayAll(st, held.agents, READ_FILE)) throw new FileError("invalid", CLOSED_FILE);
        if (!mayChange(held, st)) throw new FileError("invalid", STICKY_FILE);
        if (expected !== undefined && Math.abs(st.mtimeMs - expected) > 1) throw new FileError("conflict", CHANGED);
        // Not setuid or setgid: a file the portal writes does not carry them over (see handOver).
        mode = st.mode & 0o1777;
        owner = { uid: st.uid, gid: st.gid };
      } finally {
        closeSync(fd);
      }
    } catch (e) {
      if (!(e instanceof FileError) || e.code !== "missing") throw writeFailure(e);
      if (expected !== undefined) throw new FileError("conflict", CHANGED);
      existed = false;
      try {
        ({ mode, owner } = madeIn(held));
      } catch (e) {
        throw writeFailure(e);
      }
    }

    const tempName = `.${tempStem(name)}.${randomBytes(6).toString("hex")}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(held.at(tempName), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
      // What the file had: the mode is cut by the umask on creation, and the owner is not ours if the portal runs as another user.
      handOver(fd, owner, mode, held);
      let written = 0;
      while (written < data.length) written += writeSync(fd, data, written, data.length - written, written);
      fsyncSync(fd);
      if (existed) {
        renameSync(held.at(tempName), held.at(name));
      } else {
        // A file that is made is not put over one that has appeared since: a link
        // fails where a rename would replace. Where links are not possible, rename.
        try {
          linkSync(held.at(tempName), held.at(name));
          unlinkSync(held.at(tempName));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new FileError("conflict", CHANGED);
          renameSync(held.at(tempName), held.at(name));
        }
      }
      // After the rename or link, which both change the file's times.
      const after = fstatSync(fd, { bigint: true });
      closeSync(fd);
      fd = undefined;
      syncFolder(held);
      return { size: Number(after.size), mtime: mtimeOf(after), change: changeOf(after) };
    } catch (e) {
      if (fd !== undefined) closeSync(fd);
      rmSync(held.at(tempName), { force: true });
      throw writeFailure(e);
    }
  } finally {
    held.close();
  }
}

/**
 * The place `rel` names, for taking it away or giving it another name: its
 * folder followed and checked, its last name not, so that a link there is what
 * is changed, not what it leads to. The folder itself is not something in it.
 * One check for both, because what one lets through the other must not.
 */
function entryPlace(base: string, rel: unknown, verb: "removed" | "renamed"): string {
  const text = String(rel ?? "");
  if (text.includes("\0")) throw new FileError("invalid", "That is not a valid path");
  const lexical = path.resolve(base, text.replace(/^[/\\]+/, ""));
  const under = pathBelow(base, lexical);
  if (under === undefined) throw new FileError("invalid", "That path leads outside the folder");
  if (under === "") throw new FileError("invalid", `The folder itself is not ${verb} from here`);
  const parent = resolveInside(base, path.relative(base, path.dirname(lexical)));
  const target = path.join(parent, path.basename(lexical));
  if (!lexists(target)) throw new FileError("missing", "There is no such file or folder");
  return target;
}

/**
 * What deleting `rel` would lose that nothing else has — see unsavedIn — or
 * null when nothing git holds goes with it. Asked before the question, so that
 * it can say so.
 */
export async function unsavedAt(base: string, rel: unknown): Promise<Unsaved | null> {
  return unsavedIn(base, entryPlace(base, rel, "removed"));
}

/**
 * Removes a file, or a folder and all that is in it. A link is removed as the
 * link it is, and what it points at stays. The folder itself is not removable
 * from here: that is the chat's place, not something in it.
 *
 * A folder that holds git work nothing else has — a clone with commits no
 * remote has, changes not committed, stashes — or a repository's .git is
 * refused, with what it holds, unless `discard` says that is meant.
 *
 * Asking git takes a while, and an agent can put a link where a folder on the
 * way was meanwhile: a removal by the path would then go where the link leads,
 * as root and with all that is there. So the folder the entry is in is held
 * once git has answered (see holdFolder), and the entry is removed through it
 * (see removeIn).
 */
export async function removeEntry(base: string, rel: unknown, discard = false): Promise<void> {
  const target = entryPlace(base, rel, "removed");
  if (!discard) {
    const unsaved = await unsavedIn(base, target);
    if (unsaved && holdsWork(unsaved)) throw new FileError("unsaved", unsavedRefusal(unsaved).error, unsaved);
  }
  let held: Held;
  try {
    held = holdFolder(base, path.dirname(target));
  } catch (e) {
    // A file that has gone since it was looked for, with the folder it was in, is what was asked for.
    if (e instanceof FileError && e.code === "missing") return;
    throw e;
  }
  try {
    const name = path.basename(target);
    const st = await lstat(held.at(name)).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return undefined;
      throw e;
    });
    if (st) await removeIn(held.at(name), st.isDirectory());
  } catch (e) {
    throw ioFailure(e, "It could not be deleted", "Nothing more was changed.");
  } finally {
    held.close();
  }
}

/** What is said when an entry is turned into another thing while it is removed, and so is left as it is now. */
const CHANGED_WHILE_REMOVED = "It changed while it was deleted, and what it is now was left";

/**
 * How deep a folder is gone into to delete it: each folder on the way is held open while what is in it goes, so an agent's folder a million
 * deep would take as many of the portal's descriptors. Beyond what a path could reach before (PATH_MAX, 4096 bytes, is about 2048 folders of
 * one letter) the delete stops, with what it took on the way gone, as a delete that fails partway is.
 */
const MAX_REMOVE_DEPTH = 2048;

/** How many names in a folder are taken away at once: as fs.rm takes them, without putting every one on the thread in one go. */
const UNLINKS_AT_ONCE = 64;

/**
 * Removes what is at `place`, a name in a held folder (see holdFolder): `folder` says whether it was a folder (not a link to one) when it
 * was looked at. A folder that is empty goes by `rmdir`; one that is not is opened without following a link (as holdFolder walks), emptied
 * through its own descriptor, each folder in it the same way, and then goes. Anything else goes by `unlink`. Neither follows a link, so
 * what goes is what is in the folder that was checked, whatever an agent swaps in on the way: a link put where a folder was goes as the
 * link it is, and what it leads to stays; a folder put where a file was is left. The names are the bytes the system has, not text, so a
 * name that is not UTF-8 goes too. Off the thread, not by rmSync: a folder with many files is seconds on the thread that serves every
 * chat. A name that has gone since it was listed is what was asked for.
 */
async function removeIn(place: string | Buffer, folder: boolean, depth = 0): Promise<void> {
  if (!folder) {
    try {
      await unlink(place);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      // A folder took the name since it was looked at. (POSIX says EPERM for it where Linux says EISDIR.)
      if (code === "EISDIR" || (code === "EPERM" && lstatSync(place, { throwIfNoEntry: false })?.isDirectory())) {
        throw new FileError("conflict", CHANGED_WHILE_REMOVED);
      }
      throw e;
    }
    return;
  }
  // An empty folder goes at once, and needs no right to read it, as fs.rm has it.
  try {
    await rmdir(place);
    return;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    // A link or a file took the folder's name since it was looked at.
    if (code === "ENOTDIR") return removeIn(place, false);
    if (code !== "ENOTEMPTY" && code !== "EEXIST") throw e;
  }
  if (depth >= MAX_REMOVE_DEPTH) throw new FileError("failed", `It is more than ${MAX_REMOVE_DEPTH} folders deep, and what is deeper is not deleted from here`);
  let fd: number;
  try {
    fd = openSync(place, OPEN_FOLDER);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    // A link (O_DIRECTORY is looked at before O_NOFOLLOW, so it is ENOTDIR too) or a file took its name since.
    if (code === "ELOOP" || code === "ENOTDIR") return removeIn(place, false);
    throw e;
  }
  try {
    // The folder as a path for the names in it: by its descriptor where descriptors can be named, else by the path (see holdFolder).
    const here = Buffer.from(namesDescriptors() ? named(fd) : place);
    const inside = (name: Buffer) => Buffer.concat([here, Buffer.from("/"), name]);
    let entries;
    try {
      entries = await readdir(here, { withFileTypes: true, encoding: "buffer" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      // Taken away since it was opened: what was asked for. Not so a name in it that went while the listing looked at it (on a file
      // system that does not say what each name is, which Node then looks at one by one): the folder is still there.
      const now = lstatSync(place, { bigint: true, throwIfNoEntry: false });
      const held = fstatSync(fd, { bigint: true });
      if (now?.dev === held.dev && now.ino === held.ino) throw new FileError("conflict", CHANGED_WHILE_REMOVED);
      return;
    }
    // Every name is done with before the folder's descriptor is closed: its number names this folder only while it is open.
    const files = entries.filter((entry) => !entry.isDirectory());
    let next = 0;
    let failed: unknown;
    const unlinking = async () => {
      while (next < files.length) {
        try {
          await removeIn(inside(files[next++].name), false);
        } catch (e) {
          failed ??= e;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(UNLINKS_AT_ONCE, files.length) }, unlinking));
    if (failed) throw failed;
    // The folders one at a time, so that only one is held open at each depth.
    for (const entry of entries) if (entry.isDirectory()) await removeIn(inside(entry.name), true, depth + 1);
  } finally {
    closeSync(fd);
  }
  try {
    await rmdir(place);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    // Not a folder any more: the one that was emptied was moved away, and something else took its name.
    if (code === "ENOTDIR") throw new FileError("conflict", CHANGED_WHILE_REMOVED);
    throw e;
  }
}

/** A name for one entry: no place in it, and not one of the two that mean a place. */
function checkName(name: unknown): string {
  if (typeof name !== "string" || !name.trim()) throw new FileError("invalid", "A name is required");
  const clean = name.trim();
  if (clean === "." || clean === ".." || /[/\\\0]/.test(clean)) throw new FileError("invalid", "A name cannot contain / or \\, or be . or ..");
  if (Buffer.byteLength(clean, "utf8") > 255) throw new FileError("invalid", "That name is too long");
  return clean;
}

/**
 * Gives a file or a folder another name, in the folder it is in. It is a new
 * name, not a new place, and it never replaces something that is already there.
 * A link is renamed as the link it is. Returns the new path, from the folder.
 */
export function renameEntry(base: string, rel: unknown, newName: unknown): string {
  const name = checkName(newName);
  const from = entryPlace(base, rel, "renamed");
  const parent = path.dirname(from);
  const to = path.join(parent, name);
  if (to === from) return path.relative(base, to);
  // In the folder as it is held (see holdFolder): a folder on the way that an agent swapped for a link since the check is refused, or, once it is
  // held, makes no difference, and the rename is never sent where the link leads.
  const held = holdFolder(base, parent);
  try {
    if (lexists(held.at(name))) throw new FileError("exists", `There is already something called "${name}" here`);
    renameSync(held.at(path.basename(from)), held.at(name));
  } catch (e) {
    throw ioFailure(e, "It could not be renamed", "It keeps its name.");
  } finally {
    held.close();
  }
  return path.relative(base, to);
}

/**
 * The place `rel` names for removeFile and renameFile: `entryPlace`, and with `direct` only a name in `base` itself
 * (see OpenOptions.direct), as it was spelled.
 */
function filePlace(base: string, rel: unknown, direct: boolean | undefined, verb: "removed" | "renamed"): string {
  const target = entryPlace(base, rel, verb);
  if (direct && (path.dirname(target) !== base || path.basename(target) !== String(rel))) {
    throw new FileError("invalid", "That is not a file directly in the folder");
  }
  return target;
}

/**
 * `name` in the held folder, looked at without following a link in its last place: what is there if it is a plain file,
 * else a refusal (`invalid`: a link, a folder, a pipe, or with `alone` a file with a second name; `missing`).
 * Read from the descriptor of the folder, so that it is a name in that folder and no other, and by `lstat`, which opens
 * nothing: a pipe is not waited at, and a file the portal may not read can still be taken away.
 */
function plainIn(held: Held, name: string, alone: boolean | undefined): BigIntStats {
  let st: BigIntStats | undefined;
  try {
    st = lstatSync(held.at(name), { bigint: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw ioFailure(e, "The file could not be looked at", "Nothing was changed.");
  }
  if (!st) throw new FileError("missing", "There is no such file");
  if (!st.isFile()) throw new FileError("invalid", "That is a link, a folder or not a plain file");
  if (alone && st.nlink !== 1n) throw new FileError("invalid", "That file has another name elsewhere (a hard link)");
  return st;
}

/** What removeFile and renameFile take beyond OpenOptions (whose `likeParent` is for `base`, the folder the file is in, here). */
export interface ChangeOptions extends OpenOptions {
  /**
   * The folder the file is in must be this one, by its device and inode as `stat` gives them: another folder at that path (one swapped in since
   * the caller looked) is refused (`conflict`) before anything is touched. Told from the descriptor of the held folder, which is the folder the
   * call then works in, so it cannot be one folder checked and another changed.
   */
  expect?: { dev: string | number | bigint; ino: string | number | bigint };
}

/**
 * The folder an entry is in, held for what is done to the entry (see holdFolder), with the options both calls on an entry take:
 * `likeParent`, and with `expect` refused (`conflict`) unless the held folder is that one, told by its descriptor, before anything is changed.
 */
function holdEntryFolder(base: string, dir: string, options: ChangeOptions): Held {
  const held = holdFolder(base, dir, using(options, CHANGE_IN));
  const expect = options.expect;
  if (!expect) return held;
  try {
    const st = fstatSync(held.fd, { bigint: true });
    if (String(st.dev) !== String(expect.dev) || String(st.ino) !== String(expect.ino)) {
      throw new FileError("conflict", "That folder is not the one it was expected to be");
    }
  } catch (e) {
    held.close();
    throw e;
  }
  return held;
}

/**
 * Takes away one plain file: not a folder, and not a link, which is refused, not removed as a link. It is the one for a
 * server half that deletes a file of its own that an agent can change as it runs: removeEntry takes whatever has the
 * name by then, a folder and all in it.
 *
 * The folder is held (see holdFolder) and the name is taken from it by `unlink`, so the file goes from the folder that was
 * checked, whatever its path leads to by then. A look at the name comes first, for the refusal that says what is
 * wrong; what is swapped in after it is still safe, because `unlink` never follows a link (a link put there is what goes,
 * and what it leads to stays) and never removes a folder (it says `EISDIR`, and nothing is lost, where a recursive remove
 * by path would take the folder and all in it). The name an agent swaps another file of the folder onto between the look and
 * the `unlink` is the one that goes: all of them are the folder's own, which the agent can remove as well.
 *
 * `direct`: `rel` is a name in `base` itself (see OpenOptions.direct); `alone`: a file with a second name is refused; `likeParent`: the
 * held folder must be one the agent could write in (see OpenOptions.likeParent); `expect`: the folder must be that one (see ChangeOptions),
 * for a caller that decided on a folder earlier and must not act in another.
 * Refusals: `missing`, `invalid`, `conflict` (another folder than `expect`), and `failed` for the system's own reasons.
 */
export function removeFile(base: string, rel: unknown, options: ChangeOptions = {}): void {
  const target = filePlace(base, rel, options.direct, "removed");
  const held = holdEntryFolder(base, path.dirname(target), options);
  try {
    const name = path.basename(target);
    const seen = plainIn(held, name, options.alone);
    if (!mayChange(held, seen)) throw new FileError("invalid", STICKY_FILE);
    try {
      unlinkSync(held.at(name));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new FileError("missing", "There is no such file");
      // A folder took the name since it was looked at: it is left as it is. (POSIX says EPERM for it where Linux says EISDIR.)
      if (code === "EISDIR" || (code === "EPERM" && lstatSync(held.at(name), { throwIfNoEntry: false })?.isDirectory())) {
        throw new FileError("invalid", "That is a link, a folder or not a plain file");
      }
      throw ioFailure(e, "It could not be deleted", "Nothing was changed.");
    }
    syncFolder(held);
  } finally {
    held.close();
  }
}

/**
 * Gives one plain file another name in the folder it is in, never over something that is there, and refuses a link and a
 * folder (as removeFile does). Returns the new path, from `base`. `direct`, `alone`, `likeParent` and `expect` as for removeFile.
 *
 * Done in the held folder (see holdFolder) by a hard link and the removal of the old name, not by `rename`: a rename puts
 * the file over whatever is at the new name, and an agent that writes in the folder can make a file of that name between the
 * look and the call, which would be gone. `link` fails with `EEXIST` for it, in the system call itself, so nothing
 * that is at the new name is ever replaced. It does not follow a link at the old name either (a link put there since is
 * made a second name of the link, not of what it leads to), and refuses a folder (`EPERM`). The new name is then
 * looked at: if it is not the file that was looked at (the old name was swapped in between) it is taken away again and
 * nothing is renamed (`conflict`). Only then is the old name removed, so a crash between the two leaves one file with two names, never
 * none. If the old name cannot be removed the new one is given up again, but never when it is the file's only name (a folder
 * took the old name just before): the file is not deleted for that, and the rename stands. The file itself is not touched: its
 * owner, mode and content stay, and its change key does not (its inode is the same, its times are not).
 *
 * A new name that the file system does not tell from the old one (they differ in capitals, or in the form of a letter, on macOS,
 * Windows or a casefold folder) is the old name, so it is `exists`: there is no second name to make, and a `rename` of a name onto
 * itself does nothing on some of them.
 *
 * Where hard links cannot be made (a file system without them, or `protected_hardlinks` for a file that is not the
 * portal's own) it is a `rename` after a look at the new name, which is the best there is, and leaves the gap above
 * for a file that is made at the name in between, as uploadTarget does.
 */
export function renameFile(base: string, rel: unknown, newName: unknown, options: ChangeOptions = {}): string {
  const name = checkName(newName);
  const from = filePlace(base, rel, options.direct, "renamed");
  const parent = path.dirname(from);
  const held = holdEntryFolder(base, parent, options);
  try {
    const old = path.basename(from);
    const seen = plainIn(held, old, options.alone);
    if (!mayChange(held, seen)) throw new FileError("invalid", STICKY_FILE);
    if (name !== old) {
      linkOver(held, old, name, seen);
      syncFolder(held);
    }
  } finally {
    held.close();
  }
  return path.relative(base, path.join(parent, name));
}

/** A name this call made in the held folder, taken away again: by `unlink`, which removes the name and never what it leads to. */
function dropName(place: string): void {
  try {
    unlinkSync(place);
  } catch {
    // Gone already, or not ours to remove: what is left is a second name of a file, and nothing is lost.
  }
}

/** `from` in the held folder given the name `to` (see renameFile); `seen` is what `from` was when it was looked at. */
function linkOver(held: Held, from: string, to: string, seen: BigIntStats): void {
  const source = held.at(from);
  const target = held.at(to);
  const taken = () => new FileError("exists", `There is already something called "${to}" here`);
  // What the system says of a name it cannot make or take away. Too many links to the file is the system's refusal like a full disk is, not a failure of this code.
  const refused = (e: unknown) =>
    (e as NodeJS.ErrnoException).code === "EMLINK"
      ? new FileError("failed", "It could not be renamed (EMLINK). It keeps its name.", undefined, e)
      : ioFailure(e, "It could not be renamed", "It keeps its name.");
  // The same file by its number, and a plain file still: a file system gives the number of a file that was just removed to the next one
  // that is made (ext4 does), so a folder swapped onto the name can have it.
  const same = (st: BigIntStats | undefined) => st !== undefined && st.isFile() && st.dev === seen.dev && st.ino === seen.ino;
  try {
    linkSync(source, target);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw taken();
    if (code === "ENOENT") throw new FileError("missing", "There is no such file");
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw refused(e);
    // A folder is `EPERM` too: the name was a plain file when it was looked at, and is another thing now.
    if (!same(lstatSync(source, { bigint: true, throwIfNoEntry: false }))) throw new FileError("conflict", "The file changed while it was renamed");
    // No hard links here: the best that is left is to look and rename.
    if (lexists(target)) throw taken();
    try {
      renameSync(source, target);
    } catch (e) {
      throw refused(e);
    }
    return;
  }
  // The new name is the file that was looked at, or it is taken away again: it is the name this call has just made.
  const made = lstatSync(target, { bigint: true, throwIfNoEntry: false });
  if (!same(made)) {
    if (made && !made.isDirectory()) dropName(target);
    throw new FileError("conflict", "The file changed while it was renamed");
  }
  try {
    unlinkSync(source);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // Gone meanwhile (the agent removed it): the new name is the file, which is what was asked.
    if (code === "ENOENT") return;
    // The old name cannot be taken away, and the new one is made to be given up again, but only while the file has another name besides it:
    // it is the only one when a folder took the old name just before (`EISDIR`), and taking it away then would delete the file.
    // Then the old name is not the file's any more, which is a rename; and a new name that is not the file any more is not ours to take away.
    const left = lstatSync(target, { bigint: true, throwIfNoEntry: false });
    if (!same(left)) throw new FileError("conflict", "The file changed while it was renamed");
    if (left!.nlink < 2n) return;
    dropName(target);
    throw code === "EISDIR" ? new FileError("conflict", "The file changed while it was renamed") : refused(e);
  }
}

/**
 * The checked path of a folder, for archiving it. With `direct`, a folder that is a name in `base` itself (see OpenOptions.direct).
 * With `likeParent`, a folder the sandbox closed to the agents, or one that is reached through such a folder, is refused (`invalid`, see AgentUse):
 * the folder is held and looked at as the agents would, not by its path.
 */
export function folderPath(base: string, rel: unknown, options: AgentUse & { direct?: boolean } = {}): string {
  const dir = placeOf(base, rel, options.direct);
  if (options.likeParent) {
    let held: Held;
    try {
      held = holdFolder(base, dir, using(options, READ_IN));
    } catch (e) {
      if (e instanceof FileError && e.code === "missing") throw new FileError("missing", "There is no such folder");
      throw e;
    }
    held.close();
    return dir;
  }
  const st = lstatSync(dir, { throwIfNoEntry: false });
  if (!st) throw new FileError("missing", "There is no such folder");
  if (!st.isDirectory()) throw new FileError("invalid", "That is not a folder");
  return dir;
}

/**
 * Which folder `rel` is, on this system: its device and inode as text (an inode can be wider than a number), read from the folder
 * as it is held, so that it is the folder the checks were made on and not what its path leads to by the time it is looked at. No
 * two folders have the same pair at once; a folder that is moved keeps it, and one that is deleted and made again does not (a
 * number can be given to the next folder made, though, so it tells that a folder is the one it was while it exists, not for ever).
 * `direct` as for `folderPath`. With `likeParent` the folder must be one the agents could read and write in, and reach (`invalid` otherwise,
 * see AgentUse): for a caller that holds to a folder and acts in it later, so it is asked of the folder the identity is read from, not of
 * one looked at before, which an agent swaps for another between a look at the path and this call.
 */
export function folderIdentity(base: string, rel: unknown, options: AgentUse & { direct?: boolean } = {}): { dev: string; ino: string } {
  const dir = placeOf(base, rel, options.direct);
  let held: Held;
  try {
    held = holdFolder(base, dir, using(options, USE_IN));
  } catch (e) {
    if (e instanceof FileError && e.code === "missing") throw new FileError("missing", "There is no such folder");
    throw e;
  }
  try {
    const st = fstatSync(held.fd, { bigint: true });
    return { dev: String(st.dev), ino: String(st.ino) };
  } finally {
    held.close();
  }
}

/**
 * Whether `fd`, a folder opened by the name just made, is plainly the one that was made: empty, and on the parent's file
 * system. Not who it belongs to: some file systems (NFS with root_squash, CIFS or vfat mounted with a uid, FUSE) give a
 * new folder an owner that is not the one who made it, and a folder moved in from another parent needs the agent to
 * be allowed to write in it, so the owner says nothing the emptiness does not.
 *
 * Node cannot make a folder and open it in one call, so the name is looked up twice, and in between an agent that writes in
 * the parent can remove the new (empty) folder and move another one of the parent onto the name. What the portal does next
 * (give it away, give it a mode) must not reach that one. It is told by the folder's own descriptor: the new folder is made
 * closed to everyone but the portal, so nothing can have been put in it, while a folder moved there holds what it held
 * and is turned away. An empty one that is moved there is relabelled, which gives the agent nothing: it could have removed
 * it and made one of its own. A folder of another file system (a mount) is turned away too, for its root is not the agent's
 * to remove.
 */
function isFresh(fd: number, where: string, parent: { dev: number }): boolean {
  try {
    const st = fstatSync(fd);
    if (st.dev !== parent.dev) return false;
    return readdirSync(where).length === 0;
  } catch {
    return false;
  }
}

/**
 * Makes a folder inside `dir`. Like a new file, it never takes the place of
 * something already there. It has the mode, owner and group of the folder it
 * is made in, so that the agent can write in it as it can there (see madeIn).
 * It is made in the folder as it is held (see holdFolder), not in the place
 * its path leads to by the time of the call, and given away only once it is
 * known to be the one just made (see isFresh). Returns its path, from the chat's folder.
 * With `likeParent` (see AgentUse) the folder it is made in must be one the agents could write in and reach, as for any change: otherwise it is refused
 * (`invalid`) before anything is made, so the portal does not make, as root, what the agent could not.
 */
export function makeFolder(base: string, dirRel: unknown, name: unknown, options: AgentUse = {}): string {
  const clean = checkName(name);
  const parent = folderPath(base, dirRel);
  const held = holdFolder(base, parent, using(options, CHANGE_IN));
  const taken = () => new FileError("exists", `There is already something called "${clean}" here`);
  try {
    const target = held.at(clean);
    if (lexists(target)) throw taken();
    try {
      // The mode and owner are the held folder's own, from its descriptor.
      const folder = fstatSync(held.fd);
      const mode = folder.mode & 0o7777;
      // Closed to everyone but the portal until it has its own mode, whatever that is.
      mkdirSync(target, { mode: 0o700 });
      // Given its mode and owner through the folder that is opened, never by its path: a link put where it was, by an agent
      // that writes in the folder, would have what it leads to changed, and the portal may be root.
      let fd: number | undefined;
      try {
        fd = openSync(target, OPEN_FOLDER);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ELOOP" || (e as NodeJS.ErrnoException).code === "ENOTDIR") throw taken();
        throw e;
      }
      try {
        // Not the folder just made: something else took the name since, and is left as it is.
        if (!isFresh(fd, held.pinned ? `/proc/self/fd/${fd}` : target, folder)) throw taken();
        handOver(fd, { uid: folder.uid, gid: folder.gid }, mode, held);
      } finally {
        closeSync(fd);
      }
    } catch (e) {
      if (e instanceof FileError) throw e;
      if ((e as NodeJS.ErrnoException).code === "EEXIST") throw taken();
      throw ioFailure(e, "The folder could not be made", "Nothing was changed.");
    }
  } finally {
    held.close();
  }
  return path.relative(base, path.join(parent, clean));
}

/** The start of a name that fits in `max` bytes, cut between letters, not inside one. */
export function fitBytes(name: string, max: number): string {
  let start = "";
  for (const ch of name) {
    if (Buffer.byteLength(start + ch) > max) break;
    start += ch;
  }
  return start;
}

/**
 * The start of a name, for a temporary file beside it: at most 100 bytes, so
 * the dot and suffix around it stay inside the 255 bytes a name may have.
 */
function tempStem(name: string): string {
  return fitBytes(name, 100);
}

/** The temporary file a save writes beside its file until it is put in place: `.<name>.<12 hex>.tmp`. */
const SAVE_TEMP = /^\..+\.[0-9a-f]{12}\.tmp$/;
/** How old a temporary file of a save must be to be taken for one that was cut off. Far more than a save takes. */
export const TEMP_GRACE_MS = 60_000;

/**
 * Removes the temporary files that saves in the folder `rel` left behind when
 * they were cut off (the portal stopped, the disk was full), and returns their
 * names. A save in the folder that is under way writes such a file too, in the
 * time between making it and putting it in place; so only one older than
 * `olderThanMs` (a minute) is taken for a leftover, and nothing of a save by
 * Files or another half is removed under it. A link of that name is removed as
 * the link it is.
 */
export function sweepTemp(base: string, rel: unknown, olderThanMs = TEMP_GRACE_MS, options: AgentUse = {}): string[] {
  const dir = resolveInside(base, rel);
  let held: Held;
  try {
    held = holdFolder(base, dir, using(options, CHANGE_IN));
  } catch (e) {
    // Not there, not a folder, or no longer what the check saw: nothing is swept.
    if (e instanceof FileError) return [];
    throw e;
  }
  try {
    let names: string[];
    try {
      names = readdirSync(held.here);
    } catch {
      return [];
    }
    const removed: string[] = [];
    const now = Date.now();
    for (const name of names) {
      if (!SAVE_TEMP.test(name)) continue;
      const file = held.at(name);
      try {
        const st = lstatSync(file);
        if (!st.isFile() && !st.isSymbolicLink()) continue;
        if (now - st.mtimeMs < olderThanMs) continue;
        // In a sticky folder the agents could not take it away themselves.
        if (!mayChange(held, st)) continue;
        unlinkSync(file);
        removed.push(name);
      } catch {
        // Gone since it was listed, or not ours to remove: left.
      }
    }
    return removed;
  } finally {
    held.close();
  }
}

/**
 * "report.pdf", then "report (2).pdf", "report (3).pdf"… A name near the
 * 255-byte limit loses the end of its stem to make room for the number.
 */
export function numbered(name: string, n: number): string {
  if (n < 2) return name;
  const dot = name.lastIndexOf(".");
  const tail = dot > 0 ? ` (${n})${name.slice(dot)}` : ` (${n})`;
  const room = 255 - Buffer.byteLength(tail);
  // An extension too long to leave room for any of the stem is kept as part of it.
  if (dot > 0 && room >= 4) return fitBytes(name.slice(0, dot), room) + tail;
  if (dot > 0) return fitBytes(name, 255 - Buffer.byteLength(` (${n})`)) + ` (${n})`;
  return fitBytes(name, room) + tail;
}

/**
 * Where an uploaded file goes: a temporary file beside its place, and the call
 * that puts it there once all of it has arrived.
 *
 * An upload never replaces anything. A name that is taken becomes
 * "name (2).ext", as a download folder does, because the person dropping a
 * file wants it in, not a question. The name is settled only when the file is
 * complete, and put in place by a link, which fails rather than replaces if
 * something took the name in the meantime; then the next number is tried. The
 * folder is synced after it, so the file lasts through a crash.
 */
export function uploadTarget(
  base: string,
  dirRel: unknown,
  name: unknown,
): { fd: number; finish: () => string; abandon: () => void } {
  const clean = checkName(name);
  const parent = folderPath(base, dirRel);
  // Held until the upload is finished or given up: the temporary file and the place it is put in are this folder, whatever
  // happens to the path while the file comes in.
  const held = holdFolder(base, parent);
  const tempName = `.${tempStem(clean)}.${randomBytes(6).toString("hex")}.upload`;
  const temp = held.at(tempName);
  let fd: number | undefined;
  try {
    const { mode, owner } = madeIn(held);
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    // The mode is cut by the umask on creation; this is the one it is to have.
    handOver(fd, owner, mode, held);
  } catch (e) {
    if (fd !== undefined) {
      closeSync(fd);
      rmSync(temp, { force: true });
    }
    held.close();
    throw ioFailure(e, "The file could not be uploaded", "Nothing was changed.");
  }
  const abandon = () => {
    rmSync(temp, { force: true });
    held.close();
  };
  const finish = () => {
    try {
      for (let n = 1; n < 1000; n++) {
        const numberedName = numbered(clean, n);
        const target = held.at(numberedName);
        try {
          linkSync(temp, target);
          unlinkSync(temp);
          syncFolder(held);
          return path.relative(base, path.join(parent, numberedName));
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === "EEXIST") continue;
          // Where links are not possible: a rename, after looking, is the best there is.
          if (code === "EPERM" || code === "ENOTSUP" || code === "EOPNOTSUPP") {
            if (lexists(target)) continue;
            renameSync(temp, target);
            syncFolder(held);
            return path.relative(base, path.join(parent, numberedName));
          }
          rmSync(temp, { force: true });
          throw ioFailure(e, "The file could not be uploaded", "Nothing was changed.");
        }
      }
      rmSync(temp, { force: true });
      throw new FileError("exists", `Too many files called "${clean}" here`);
    } finally {
      held.close();
    }
  };
  return { fd, finish, abandon };
}

/**
 * Keeps `data` as a new file called `name` in the folder `dirRel`, for what
 * the portal makes itself, such as a picture the agent had generated. Put in
 * place as an upload is: written beside its place first, never over something
 * that is there (a taken name gets a number), and into no place outside the
 * folder. Returns its path, from the chat's folder.
 */
export function saveNewFile(base: string, dirRel: unknown, name: string, data: Buffer): string {
  const target = uploadTarget(base, dirRel, name);
  try {
    let written = 0;
    while (written < data.length) written += writeSync(target.fd, data, written, data.length - written, written);
    fsyncSync(target.fd);
  } catch (e) {
    closeSync(target.fd);
    target.abandon();
    throw ioFailure(e, "The file could not be saved", "Nothing was changed.");
  }
  closeSync(target.fd);
  return target.finish();
}
