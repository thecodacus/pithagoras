/**
 * Folders going up: what the picker and a drop give as a tree, checked, made
 * in the chat's folder with the folder route and filled with the per-file
 * upload. No server route of its own: the server checks every name and path
 * as it does for a single file, and these checks are a second fence in front
 * of it, so that a path with a way out in it is never even sent.
 */

/** A folder, as picked or dropped, with what is in it. */
export interface TreeDir {
  name: string;
  dirs: TreeDir[];
  files: File[];
}

/** What a pick or a drop gives, to be put into the folder being looked at. */
export interface Tree {
  dirs: TreeDir[];
  files: File[];
  /** What was left out before anything was sent, and why. */
  problems: string[];
}

/** What the upload needs of the server: the two calls Files already has. */
export interface TreeApi {
  /** A new folder `name` in `dir`; the answer says what it is called there. Rejects when the name is taken. */
  createFolder(dir: string, name: string): Promise<{ path: string }>;
  uploadFile(dir: string, file: File): Promise<unknown>;
}

const MAX_NAME_BYTES = 255;
/** How many numbers are tried for a taken folder name; the server does the same for files. */
const MAX_NUMBER = 999;

/** A name that may be one folder or one file: what the server's own check lets through, so that nothing is sent that it would refuse for the path. */
export function plainName(name: string): boolean {
  if (!name.trim() || name === "." || name === "..") return false;
  if (/[/\\\0]/.test(name)) return false;
  return new TextEncoder().encode(name).length <= MAX_NAME_BYTES;
}

/** A taken folder name with its number: "photos", "photos (2)". The whole name, extension-like ending or not: a folder has none. */
export const numberedFolder = (name: string, n: number): string => (n < 2 ? name : `${name} (${n})`);

const emptyDir = (name: string): TreeDir => ({ name, dirs: [], files: [] });

/**
 * The tree a folder picker gives: each file with its path from the picked
 * folder (`webkitRelativePath`, "folder/sub/file.txt"). A file with no such
 * path (the picker of a browser that lacks the option) is a plain file. A path
 * that is not one inside the folder — an empty part, `.`, `..`, a backslash,
 * a NUL — leaves its file out and is said.
 */
export function treeOfPaths(files: Iterable<File>): Tree {
  const tree: Tree = { dirs: [], files: [], problems: [] };
  for (const file of files) {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || "";
    if (!rel) {
      if (plainName(file.name)) tree.files.push(file);
      else tree.problems.push(file.name);
      continue;
    }
    const parts = rel.split("/");
    if (!parts.every(plainName) || !plainName(file.name)) {
      tree.problems.push(rel);
      continue;
    }
    // Each folder on the way once, however many files are in it.
    let level: { dirs: TreeDir[]; files: File[] } = tree;
    for (const part of parts.slice(0, -1)) {
      let next = level.dirs.find((d) => d.name === part);
      if (!next) level.dirs.push((next = emptyDir(part)));
      level = next;
    }
    // The File itself is uploaded under the name it has, which is the path's last part.
    level.files.push(file);
  }
  return tree;
}

/** The parts of the File System Entries API that are used here; the browser's own types are not in every build of the DOM lib. */
export interface Entry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?(ok: (f: File) => void, fail: (e: unknown) => void): void;
  createReader?(): { readEntries(ok: (batch: Entry[]) => void, fail: (e: unknown) => void): void };
}

/** The entries of what was dropped, taken now: they cannot be asked for once the drop event is over. Undefined where the browser has none (then the plain files are all there is). */
export function droppedEntries(items: DataTransferItemList | undefined | null): Entry[] | undefined {
  if (!items || !items.length) return undefined;
  const entries: Entry[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== "file") continue;
    const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => Entry | null }).webkitGetAsEntry?.();
    if (!entry) return undefined;
    entries.push(entry);
  }
  return entries.length ? entries : undefined;
}

/** All of a directory's entries: a reader gives them in batches (a hundred, in Chrome) until one is empty. */
const readAll = async (dir: Entry): Promise<Entry[]> => {
  const reader = dir.createReader!();
  const all: Entry[] = [];
  for (;;) {
    const batch = await new Promise<Entry[]>((ok, fail) => reader.readEntries(ok, fail));
    if (!batch.length) return all;
    all.push(...batch);
  }
};

/** Where a file of the entries API can be read from; rejects for one that was unreadable (gone since the drop, or a permission). */
const fileOf = (entry: Entry) => new Promise<File>((ok, fail) => entry.file!(ok, fail));

async function walk(entry: Entry, into: TreeDir | Tree, trail: string, problems: string[]): Promise<void> {
  const here = trail ? `${trail}/${entry.name}` : entry.name;
  if (!plainName(entry.name)) return void problems.push(here);
  try {
    if (entry.isFile) {
      into.files.push(await fileOf(entry));
      return;
    }
    if (!entry.isDirectory) return;
    const dir = emptyDir(entry.name);
    into.dirs.push(dir);
    for (const child of await readAll(entry)) await walk(child, dir, here, problems);
  } catch {
    problems.push(here);
  }
}

/** The tree of what was dropped, folders walked to their end. Empty folders are kept: they are made. */
export async function treeOfEntries(entries: Entry[]): Promise<Tree> {
  const tree: Tree = { dirs: [], files: [], problems: [] };
  for (const entry of entries) await walk(entry, tree, "", tree.problems);
  return tree;
}

/** How many files are in the tree, whichever folder they are in: what the progress counts. */
export const countFiles = (tree: { dirs: TreeDir[]; files: File[] }): number => tree.files.length + tree.dirs.reduce((n, d) => n + countFiles(d), 0);

/** What an upload of a tree ended with: what could not be done, by the path from the folder it went into. */
export interface TreeResult {
  problems: string[];
}

/**
 * Makes the tree's folders in `into` and puts its files up, one after the
 * other. A folder whose name is taken is made under the next free number, and
 * its files go into that one: nothing is merged and nothing replaced. A file
 * that fails is a problem and the rest goes on; a folder that cannot be made
 * takes its files and folders with it, each of those counted as one that
 * failed. `done` is called once for each file, uploaded or not.
 */
export async function uploadTree(
  api: TreeApi,
  isTaken: (e: unknown) => boolean,
  into: string,
  tree: { dirs: TreeDir[]; files: File[] },
  done: (file: File) => void,
): Promise<TreeResult> {
  const problems: string[] = [];
  const say = (e: unknown) => (e as Error)?.message || String(e);
  const failAll = (dir: TreeDir, why: string) => {
    problems.push(why);
    for (const file of dir.files) done(file);
    for (const sub of dir.dirs) failAll(sub, why);
  };
  const makeFolder = async (dir: string, name: string): Promise<string> => {
    for (let n = 1; n <= MAX_NUMBER; n++) {
      try {
        return (await api.createFolder(dir, numberedFolder(name, n))).path;
      } catch (e) {
        if (!isTaken(e)) throw e;
      }
    }
    throw new Error(`Too many folders called "${name}" here`);
  };
  const put = async (dir: string, level: { dirs: TreeDir[]; files: File[] }) => {
    for (const file of level.files) {
      try {
        await api.uploadFile(dir, file);
      } catch (e) {
        problems.push(say(e));
      } finally {
        done(file);
      }
    }
    for (const sub of level.dirs) {
      let made: string;
      try {
        made = await makeFolder(dir, sub.name);
      } catch (e) {
        failAll(sub, say(e));
        continue;
      }
      await put(made, sub);
    }
  };
  await put(into, tree);
  return { problems };
}
