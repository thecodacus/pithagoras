import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { removeFolderLater } from "./folder-removal.js";
import { isValidSlug, slugify } from "./slug.js";

/**
 * Projects: the folders a chat can work in.
 *
 * Every chat works in a folder. Most do not need one of their own, so "New"
 * starts chats in Home, the home directory of the agent New is set to, which lives
 * outside the workspace root — so it is not here, and none of this can touch it.
 * A project is an extra folder you make on purpose, with instructions of its
 * own. Nothing here is tied to a session: deleting a chat never touches a
 * folder, and a folder is only ever created or removed by one of the functions
 * below.
 *
 * The instructions are the folder's AGENTS.md, which pi reads on its own when a
 * chat starts in it — there is nothing to hand over, and the file can be edited
 * anywhere.
 */

/** Not a project name: "home" is what chats start in, and would read as it. */
const RESERVED = new Set(["home"]);
/** What pi reads as a project's instructions. */
export const INSTRUCTIONS_FILE = "AGENTS.md";
const MAX_INSTRUCTIONS = 100_000;
/** What is read back: characters can be up to four bytes, and this is a ceiling, not a target. */
const MAX_READ_BYTES = MAX_INSTRUCTIONS * 4;
/** A walk that has counted this many entries stops: the number is a warning, not an inventory. */
const COUNT_LIMIT = 20_000;

export type ProjectErrorCode = "invalid" | "exists" | "missing" | "conflict";

export class ProjectError extends Error {
  constructor(
    readonly code: ProjectErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ProjectInfo {
  name: string;
  path: string;
  isGit: boolean;
  hasInstructions: boolean;
}

/**
 * The real folder a project name stands for, checked to be one directly under the root.
 *
 * Names arrive from a URL, so every one is treated as hostile: no separators,
 * no dot-names, nothing that resolves — through a symlink or otherwise — to a
 * place outside the root. The check is on the resolved path, not the string.
 */
function resolveProject(root: string, name: string): string {
  if (!name || name.includes("/") || name.includes("\\") || name.includes("\0") || name.startsWith(".")) {
    throw new ProjectError("invalid", `"${name}" is not a project name`);
  }
  const target = path.join(root, name);
  let stat;
  try {
    stat = lstatSync(target);
  } catch {
    throw new ProjectError("missing", `There is no project "${name}"`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ProjectError("invalid", `"${name}" is not a project folder`);
  }
  const real = realpathSync(target);
  if (path.dirname(real) !== realpathSync(root)) {
    throw new ProjectError("invalid", `"${name}" is not directly under the workspace root`);
  }
  return real;
}

const infoFor = (root: string, name: string): ProjectInfo => {
  const dir = path.join(root, name);
  return {
    name,
    path: dir,
    isGit: existsSync(path.join(dir, ".git")),
    hasInstructions: existsSync(path.join(dir, INSTRUCTIONS_FILE)),
  };
};

/** Every folder directly under the root, by name. */
export function listProjects(root: string): ProjectInfo[] {
  return readdirSync(root)
    .filter((name) => !name.startsWith("."))
    .filter((name) => {
      // lstat, like resolveProject: a link is not listed as a project, because
      // every operation on one would refuse it.
      try {
        return lstatSync(path.join(root, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .map((name) => infoFor(root, name));
}

export function getProject(root: string, name: string): ProjectInfo {
  resolveProject(root, name);
  return infoFor(root, name);
}

/** Make a project. "Cool Project" becomes the folder "cool-project". */
export function createProject(root: string, rawName: string, instructions?: string): ProjectInfo {
  const name = slugify(rawName);
  if (!isValidSlug(name)) {
    throw new ProjectError("invalid", `"${rawName}" does not produce a usable folder name`);
  }
  if (RESERVED.has(name)) {
    throw new ProjectError("invalid", `"${name}" is taken: it is where chats start by default`);
  }
  const target = path.join(root, name);
  if (path.resolve(target) !== target || path.dirname(target) !== path.resolve(root)) {
    throw new ProjectError("invalid", "Invalid project name");
  }
  // Before the folder exists: a refusal after it would leave the name taken.
  if (instructions !== undefined) checkInstructions(instructions);
  if (existsSync(target)) throw new ProjectError("exists", `There is already a project "${name}"`);
  mkdirSync(target, { recursive: true });
  if (instructions?.trim()) writeInstructions(root, name, instructions);
  return infoFor(root, name);
}

/**
 * Opens the instructions file without following a link or waiting on one.
 *
 * Whatever works in a project can replace AGENTS.md with a link to something
 * the portal would happily read or overwrite as itself — a key, a cron entry,
 * the agent's own SOUL.md — and the folder is where that agent works. So the
 * file is opened with O_NOFOLLOW, and O_NONBLOCK so that a pipe left there
 * cannot hold the server, and only a plain file is ever used.
 */
function openInstructions(file: string, flags: number): number | undefined {
  let fd: number;
  try {
    fd = openSync(file, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o644);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "ELOOP" || code === "ENXIO") {
      throw new ProjectError("invalid", `${INSTRUCTIONS_FILE} is a link or not a plain file, so it is left alone`);
    }
    throw e;
  }
  if (!fstatSync(fd).isFile()) {
    closeSync(fd);
    throw new ProjectError("invalid", `${INSTRUCTIONS_FILE} is not a plain file, so it is left alone`);
  }
  return fd;
}

/** The instructions and when the file last changed, which a save sends back as `expected`. "" and 0 where there is no file. */
export function readInstructions(root: string, name: string): { text: string; mtime: number } {
  const dir = resolveProject(root, name);
  const fd = openInstructions(path.join(dir, INSTRUCTIONS_FILE), constants.O_RDONLY);
  if (fd === undefined) return { text: "", mtime: 0 };
  try {
    // Writes are capped, but the agent can leave a file of any size here, and
    // reading one into a JSON response would be the server's problem.
    const st = fstatSync(fd);
    if (st.size > MAX_READ_BYTES) {
      throw new ProjectError("invalid", `${INSTRUCTIONS_FILE} is too large to edit here; edit it in the folder`);
    }
    return { text: readFileSync(fd, "utf8"), mtime: st.mtimeMs };
  } finally {
    closeSync(fd);
  }
}

function checkInstructions(text: string): void {
  if (text.length > MAX_INSTRUCTIONS) {
    // en-US, not the server's locale: the message is English whatever the host is.
    throw new ProjectError("invalid", `Instructions are limited to ${MAX_INSTRUCTIONS.toLocaleString("en-US")} characters`);
  }
}

/**
 * Saves the project's instructions; blank removes the file, so an empty project has none.
 *
 * `expected` is the modification time the page read the file at, 0 for no file.
 * The agent works in this folder and writes AGENTS.md too, so a file that has
 * changed since is not overwritten with the page's older copy: the save is
 * refused as a "conflict", and the person chooses what to keep.
 */
export function writeInstructions(root: string, name: string, text: string, expected?: number): void {
  const dir = resolveProject(root, name);
  checkInstructions(text);
  const file = path.join(dir, INSTRUCTIONS_FILE);
  // Looked at before anything is written, and not created: what is there is judged as it is.
  const fd = text.trim() ? openInstructions(file, constants.O_RDONLY) : undefined;
  let mtime = 0;
  try {
    if (fd !== undefined) {
      const st = fstatSync(fd);
      if (st.nlink > 1) throw new ProjectError("invalid", `${INSTRUCTIONS_FILE} is shared with another file, so it is left alone`);
      mtime = st.mtimeMs;
    } else {
      mtime = lstatSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0;
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (expected !== undefined && Math.abs(mtime - expected) > 1) {
    throw new ProjectError("conflict", "The file changed after you opened it");
  }
  if (!text.trim()) {
    rmSync(file, { force: true });
    return;
  }
  // trimEnd, not a regex: /\s+$/ backtracks quadratically on a long run of blanks.
  writeFileAtomic(file, text.trimEnd() + "\n");
}

/** What is in a project, for the question "are you sure?". */
export function describeProject(root: string, name: string): { files: number; bytes: number; complete: boolean } {
  const dir = resolveProject(root, name);
  let files = 0;
  let bytes = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++seen > COUNT_LIMIT) return { files, bytes, complete: false };
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        files++;
        try {
          bytes += statSync(full).size;
        } catch {
          // Gone between listing and stat.
        }
      }
    }
  }
  return { files, bytes, complete: true };
}

/** Removes the folder and everything in it: out of the way at once, gone shortly after (see removeFolderLater). */
export function deleteProjectFolder(root: string, name: string): void {
  removeFolderLater(resolveProject(root, name));
}

/**
 * A chat's name from its first message: the first line, short, on one line.
 * Only used while a chat still has the placeholder name, so it never overwrites
 * one somebody chose.
 */
export function titleFrom(message: string): string | undefined {
  const line = message.split("\n").find((l) => l.trim())?.replace(/\s+/g, " ").trim();
  if (!line || line.startsWith("/")) return undefined;
  // By character, not UTF-16 unit: cutting an emoji in half leaves half of it.
  const chars = Array.from(line);
  return chars.length > 48 ? chars.slice(0, 47).join("").trimEnd() + "…" : line;
}

/** The name a chat has until its first message names it. */
export const NEW_CHAT_TITLE = "New chat";

/** The longest name a chat can be given: what the rename field takes. */
const MAX_TITLE = 120;

/**
 * A name as it is kept: on one line and no longer than the field allows, however
 * it came in — the rename field, /name, a chat made through the API, or a child
 * chat a server half made. By character, so an emoji at the cut is not left in
 * halves. Empty when there is no name in it.
 */
export const cleanTitle = (raw: unknown): string =>
  typeof raw === "string"
    ? Array.from(raw.replace(/\s+/g, " ").trim()).slice(0, MAX_TITLE).join("").trimEnd()
    : "";
