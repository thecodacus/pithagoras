/**
 * Where a folder's store is kept: in the portal's data folder, not in the
 * folder, so that nothing an agent of the sandbox's group can reach is in the
 * way of the portal's git and SQLite.
 *
 *   <data>/<folder id>/            the store (store.js): git/, docs.sqlite
 *   <data>/<folder id>/folder.json the folder it was made for: its path, and which folder that is (device and inode)
 *
 * The folder's id is the one the page names it by (server.js). It is made
 * from the folder's path, which a folder can lose (it is moved, or deleted and
 * made again), so the store says which folder it was made for, and is only
 * used for that one:
 *
 *   - the store at the folder's id is for this folder: used
 *   - for another folder (the path is a new folder now: deleted and made again,
 *     or restored from a backup, which has other inodes): used if the folder's
 *     documents are the ones the store knows, else put aside as
 *     `<id>.replaced-…`, never deleted, and a new store is made
 *   - none there, and the folder is one that was moved (a store made for this
 *     very folder, at a path that is not this folder any more): that store
 *     follows it
 *   - none there, and the folder has `.pithagoras-docs`, as an earlier
 *     version kept the store: moved here (not with the sandbox on: an agent
 *     could have changed it), or refused with the reason
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { DocError } from "./errors.js";
import { readDocument } from "./files.js";
import { blobId } from "./git.js";
import { Guard, isOurs, OPEN_DIR, removeEntry } from "./guard.js";

/** Where an earlier version kept the store: in the folder itself. */
export const LEGACY_STORE = ".pithagoras-docs";
const BINDING = "folder.json";
/** A store's folder in the data folder: its folder's id, or the same put aside (a moved folder finds its own again there). */
const STORE_NAME = /^[0-9a-f]{16}(\.replaced-.+)?$/;
/** Deeper than a store goes: what is deeper is not one. */
const MAX_DEPTH = 16;
/** How many documents are compared to tell a restored folder from another one. */
const COMPARED = 200;

/** Which folder it is, on this system: no two folders have the same device and inode at once. As text, since inodes can be wider than a number. */
export function identityOf(folder) {
  const stat = statSync(folder, { bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

/** What a store says of the folder it was made for. */
export const bindingFor = (folder) => ({ path: folder, ...identityOf(folder) });

/** The binding in the store folder `root`, or nothing: no such file, or not one the store wrote. */
export function readBinding(root) {
  try {
    const file = path.join(root, BINDING);
    if (!lstatSync(file).isFile()) return null;
    const found = JSON.parse(readFileSync(file, "utf8"));
    return typeof found?.path === "string" && /^\d+$/.test(found.dev) && /^\d+$/.test(found.ino) ? found : null;
  } catch {
    return null;
  }
}

export const sameBinding = (a, b) => Boolean(a && b) && a.path === b.path && a.dev === b.dev && a.ino === b.ino;

/** Writes the binding into the store folder `root`, whole or not at all. */
export function writeBinding(root, binding) {
  const temp = path.join(root, `${BINDING}.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(temp, `${JSON.stringify(binding, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(temp, path.join(root, BINDING));
}

const exists = (place) => {
  try {
    lstatSync(place);
    return true;
  } catch {
    return false;
  }
};

/** The data folder is the portal's own, and closed to everyone else: it is where the stores' parent is held to be. */
function closedData(dir) {
  let fd;
  try {
    fd = openSync(dir, OPEN_DIR);
  } catch {
    throw new DocError(500, "The portal's data folder for the documents is not a folder (a link, or not there)");
  }
  try {
    const stat = fstatSync(fd);
    if (!isOurs(stat)) throw new DocError(500, "The portal's data folder for the documents is not the portal's own");
    if (stat.mode & 0o077) fchmodSync(fd, 0o700);
  } finally {
    closeSync(fd);
  }
}

/**
 * Whether the folder's documents are the ones the store at `dir` knows: some
 * document of the store is in the folder, with the text it had at one of its
 * revisions. The store is read, not opened for use: nothing in it is changed.
 */
function knows(Database, dir, documents, files) {
  if (!documents) return false;
  let db;
  try {
    const file = path.join(dir, "docs.sqlite");
    if (!lstatSync(file).isFile()) return false;
    db = new Database(file, { readonly: true, fileMustExist: true });
    const has = db.prepare("SELECT 1 FROM revisions r JOIN documents d ON d.id = r.doc_id WHERE d.name = ? AND r.blob = ?");
    for (const { name } of db.prepare("SELECT DISTINCT name FROM documents WHERE revision > 0 LIMIT ?").all(COMPARED)) {
      const text = readDocument(files, documents, name);
      if (text && has.get(name, blobId(text.bytes))) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      // Closed already.
    }
  }
}

/** A store that is not this folder's, out of the way and kept: it is somebody's history. */
function putAside(dir, log) {
  const aside = `${dir}.replaced-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomBytes(2).toString("hex")}`;
  renameSync(dir, aside);
  log(`The documents store ${path.basename(dir)} was made for another folder; it is kept as ${path.basename(aside)}, and this folder starts a new history`);
}

/** Whether `place` is the folder `here`: a path that leads to it still. */
function leadsTo(place, here) {
  try {
    const found = identityOf(place);
    return found.dev === here.dev && found.ino === here.ino;
  } catch {
    return false;
  }
}

/**
 * The store made for this very folder at a path it has left: the folder was
 * moved. It may have been put aside meanwhile, by a new folder made at its old
 * path that was placed first. Not one whose folder still answers at its path (a second path to one
 * folder, through a mount or a link, does not take its store), and not unless
 * the folder's documents are the ones it knows: an inode is reused when a
 * folder is deleted and another made.
 */
function movedStore(data, id, here, documents, files, Database) {
  let names;
  try {
    names = readdirSync(data);
  } catch {
    return null;
  }
  for (const name of names) {
    if (name === id || !STORE_NAME.test(name)) continue;
    const dir = path.join(data, name);
    const bound = readBinding(dir);
    if (!bound || bound.dev !== here.dev || bound.ino !== here.ino || leadsTo(bound.path, here)) continue;
    if (knows(Database, dir, documents, files)) return dir;
  }
  return null;
}

const refused = (why) => new DocError(409, `${LEGACY_STORE} in this folder is the documents store of an earlier version, and could not be moved into the portal's data folder (${why}). It is not used: move or delete it.`);

/** `from` into `to`, a chunk at a time with the event loop let go between, not following a link. */
async function copyFile(from, to) {
  const out = openSync(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const got = readSync(from, buffer, 0, buffer.length, null);
      if (!got) break;
      let at = 0;
      while (at < got) at += writeSync(out, buffer, at, got - at);
      await new Promise((resolve) => setImmediate(resolve));
    }
    fsyncSync(out);
  } finally {
    closeSync(out);
  }
}

/**
 * The folder held open as `fd` (at `src`), and what is in it, written anew
 * into the folder `dst`: through descriptors, a link or anything that is not a
 * plain file or a folder of the portal's own refused. Nothing is copied that
 * was not looked at after it was opened, whatever else changes the old one
 * while this runs.
 */
async function copyTree(src, fd, dst, depth) {
  if (depth > MAX_DEPTH) throw new Error("it is nested deeper than a store is");
  const from = Guard.pinning ? `/proc/self/fd/${fd}` : src;
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const at = `${from}/${entry.name}`;
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      const sub = openSync(at, OPEN_DIR);
      try {
        if (!isOurs(fstatSync(sub))) throw new Error(`${entry.name} is not the portal's own`);
        mkdirSync(to, { mode: 0o700 });
        await copyTree(`${src}/${entry.name}`, sub, to, depth + 1);
      } finally {
        closeSync(sub);
      }
    } else if (entry.isFile()) {
      // Not waiting at a pipe that took a file's place: it is opened at once, and refused for not being a file.
      const file = openSync(at, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(file);
        if (!stat.isFile() || !isOurs(stat)) throw new Error(`${entry.name} is not the portal's own`);
        await copyFile(file, to);
      } finally {
        closeSync(file);
      }
    } else {
      throw new Error(`${entry.name} is a link or something that is not a file`);
    }
  }
}

/**
 * Moves the earlier version's store of `folder` into `dir`. Where it can it
 * is renamed, so that it is one store before and after; across file systems
 * (a container's data and workspaces are two volumes) it is written anew and
 * the old one removed. Not with the sandbox on: the sandbox's preparation of a
 * chat's folder gives everything in it to the agents' group, so what is in an
 * old store is not the portal's to trust, and the portal does not run git on
 * it, or remove it as root. Nothing is changed where it is refused. False
 * where there is none.
 */
async function moveLegacy({ folder, data, id, dir, sandbox, faults, log }) {
  const old = path.join(folder, LEGACY_STORE);
  let stat;
  try {
    stat = lstatSync(old);
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw refused(e.code ?? e.message);
  }
  if (sandbox) throw refused("the sandbox is on, and an agent could have changed what is in it");
  if (!stat.isDirectory()) throw refused("it is a link or a file, not a folder");
  let fd;
  try {
    fd = openSync(old, OPEN_DIR);
  } catch (e) {
    throw refused(`it cannot be opened: ${e.code ?? e.message}`);
  }
  try {
    if (!isOurs(fstatSync(fd))) throw refused("it was not made by the portal");
    let copy = false;
    try {
      faults?.after("move");
      renameSync(old, dir);
      const moved = lstatSync(dir);
      if (!moved.isDirectory() || !isOurs(moved)) {
        removeEntry(data, id);
        throw refused("it was replaced while it was moved");
      }
    } catch (e) {
      if (e instanceof DocError) throw e;
      if (e.code !== "EXDEV") throw refused(e.code ?? e.message);
      copy = true;
    }
    if (copy) {
      // What an earlier try that was cut off left.
      try {
        for (const left of readdirSync(data)) if (left.startsWith(`.moving-${id}-`)) removeEntry(data, left);
      } catch {
        // Only junk: the move does not wait on it.
      }
      const temp = `.moving-${id}-${randomBytes(4).toString("hex")}`;
      try {
        mkdirSync(path.join(data, temp), { mode: 0o700 });
        await copyTree(old, fd, path.join(data, temp), 0);
        renameSync(path.join(data, temp), dir);
      } catch (e) {
        try {
          removeEntry(data, temp);
        } catch {
          // Said by what refuses the move; this is only what it left.
        }
        throw refused(e.code ?? e.message);
      }
      // Moved, not copied: the old one goes. Its removal is by descriptors, never by what a path leads to now.
      try {
        removeEntry(folder, LEGACY_STORE);
      } catch (e) {
        log(`The documents store was moved into the portal's data folder, but ${LEGACY_STORE} in ${folder} could not be removed (${e.code ?? e.message}): remove it`);
      }
    }
  } finally {
    closeSync(fd);
  }
  log(`The documents store of ${folder} was moved from ${LEGACY_STORE} into the portal's data folder`);
  return true;
}

/**
 * The store folder to open for `folder`, whose id is `id`: it is there to be
 * used, or it is not there and is made by the store. `documents` is the
 * folder's documents folder (or nothing), `sandbox` whether agents run as users
 * of their own (a store of an earlier version is then not moved).
 */
export async function placeStore({ data, id, folder, documents, files, Database, sandbox = false, faults, log }) {
  closedData(data);
  const dir = path.join(data, id);
  const here = identityOf(folder);
  // An old store beside the folder's own is not used, and not removed: it is said, once, when the store is opened.
  const leftover = () => {
    if (exists(path.join(folder, LEGACY_STORE))) log(`${LEGACY_STORE} in ${folder} is not used, as the store in the portal's data folder is: remove it`);
    return dir;
  };
  if (exists(dir)) {
    const bound = readBinding(dir);
    // Made by hand, or by a version before the binding: this folder's, as its id says.
    if (!bound || (bound.dev === here.dev && bound.ino === here.ino)) return leftover();
    if (knows(Database, dir, documents, files)) {
      log(`The documents store of ${folder} was made for another folder with the same documents (a restore, say): it is this folder's now`);
      return leftover();
    }
    putAside(dir, log);
  }
  // The folder's own store, where it was moved from, before an old one in the folder: that is a leftover then (a copy kept by hand).
  const moved = movedStore(data, id, here, documents, files, Database);
  if (moved) {
    renameSync(moved, dir);
    log(`The documents store of ${folder} followed it from ${readBinding(dir)?.path ?? path.basename(moved)}`);
    return leftover();
  }
  await moveLegacy({ folder, data, id, dir, sandbox, faults, log });
  return dir;
}
