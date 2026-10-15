/**
 * The documents of one folder: their files, their history and what is said
 * about them.
 *
 *   <folder>/documents/<slug>.md          the documents, ordinary files, in the folder
 *   <data>/<folder id>/                   the store's own, 0700, the portal's alone (guard.js, place.js)
 *     git/                                 the history: one commit per revision (git.js)
 *     docs.sqlite                          documents, revisions (an index of the history), threads, comments, pings
 *     folder.json                          the folder it was made for
 *
 * The store is in the portal's data folder, out of reach of the agents'
 * group; the documents stay where the agent and Files can read them.
 *
 * A write (save, create, restore) goes in three steps, under the folder's
 * lock: the file is written in place (files.js), the change is committed with
 * trailers that name the document, its revision and its author, and the
 * database is told in one transaction. A failure between the steps is put
 * right the next time the store is used ("recovery", before every request
 * that reads or writes):
 *
 *   - temporary files a write left behind are deleted, and an index.lock git left
 *   - commits the database does not know yet are replayed into it from their trailers
 *   - a file that is not the text of its last revision (written, but not
 *     committed; or changed by someone else: the agent, Files, an editor) is
 *     committed as a revision of its own, by author `external`
 *   - a Markdown file in the documents folder that is no document yet becomes
 *     one, the same way
 *
 * Documents are named by ids, never by paths: a name is made by the store
 * (a slug of the title) or found on disk by it.
 *
 * Comments are in the database, not in the files or the history. A thread is on
 * a passage of the document's text (web/anchor.js): its words, what is around
 * them, and where they were in the revision it was last placed at. That is
 * brought to the text the document has now when the threads are asked for
 * (`follow`), from the old revision's text in the history, so that a revision
 * made any way at all (the page, the agent, a file written outside, a restore)
 * moves the passages and none has to say how.
 *
 * A comment that asks the agent (ping.js) is a row of `pings` as well, naming the
 * chat asked and when the chat took it. The thread is `to_agent` from then until
 * the agent comments in it, and `answered` from the agent's comment, or its
 * resolving the thread, until the person reacts (a comment, resolving or opening
 * it again, or saying they have seen it). The page saves the person's comment as it
 * is typed: it is made, then changed, then taken away if it is typed away, while it
 * is the last of its thread.
 */
import { randomBytes } from "node:crypto";
import { accessSync, closeSync, constants, fchmodSync, fchownSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DocError, explained } from "./errors.js";
import { blobId, GitError, messageFor, parseTrailers, Repo } from "./git.js";
import { Guard } from "./guard.js";
import { bindingFor, readBinding, sameBinding, writeBinding } from "./place.js";
import { isAdoptable, isDocumentName, isTempName, isPlainFile, MAX_BYTES, openDocument, readDocument, readOpen, Refused, writeDocument } from "./files.js";
import { carry, isWhole, locate, MAX_QUOTE, passage } from "./web/anchor.js";
import { merge3 } from "./web/merge.js";

export const DOCUMENTS = "documents";
/** As many documents as a folder lists: the store takes in no more than that. */
export const MAX_DOCUMENTS = 1000;
/** As many comment threads as one document has, and comments in one thread. */
export const MAX_THREADS = 1000;
export const MAX_COMMENTS = 100;
/** The most a comment can be, in bytes (the database holds it to this too). */
export const MAX_BODY = 4096;
const SCHEMA = 1;
/** How many commits go by between two looks at whether git wants to pack the history. */
const GC_EVERY = 100;

export const isDocumentId = (id) => typeof id === "string" && /^[0-9a-f]{16}$/.test(id);

export { DocError };

/** A file name from a title: lower case, letters and digits joined by dashes, at most 80 characters. */
export function slugOf(title) {
  const slug = String(title ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
  return slug || "document";
}

/** The slug, or the slug with a number, cut so that the whole stays within 80 characters. */
const numbered = (slug, n) => (n === 1 ? slug : `${slug.slice(0, 80 - String(n).length - 1).replace(/-+$/, "")}-${n}`);

/** What kind of revision a commit's trailers describe. */
function kindOf({ revision, author, restoredFrom }) {
  if (restoredFrom) return "restore";
  if (author === "external") return revision === 1 ? "adopted" : "recovered";
  return revision === 1 ? "create" : "save";
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL DEFAULT 'project' CHECK (scope IN ('project', 'chat')),
  chat_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  blob TEXT,
  stat TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS revisions (
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  sha TEXT NOT NULL,
  blob TEXT NOT NULL,
  author TEXT NOT NULL,
  kind TEXT NOT NULL,
  restored_from INTEGER,
  at TEXT NOT NULL,
  PRIMARY KEY (doc_id, revision)
);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  quote TEXT NOT NULL,
  prefix TEXT NOT NULL DEFAULT '',
  suffix TEXT NOT NULL DEFAULT '',
  start INTEGER,
  "end" INTEGER,
  revision INTEGER NOT NULL,
  orphaned INTEGER NOT NULL DEFAULT 0,
  to_agent INTEGER NOT NULL DEFAULT 0,
  answered INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS threads_by_doc ON threads (doc_id, status);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  author TEXT NOT NULL CHECK (author IN ('user', 'agent')),
  body TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) <= 4096),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_by_thread ON comments (thread_id, created_at);
CREATE TABLE IF NOT EXISTS pings (
  id INTEGER PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  chat_id TEXT,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
`;

export class Store {
  /**
   * The store of `folder` (a chat's folder, as the portal names it), opened
   * in `dir` (place.js has seen to which one it is): made where it is not
   * there yet, then put right. `inside` is the portal's files helper.
   * `faults` lets a test break a write after one of its steps, or do
   * what someone else could in between: `faults.after(step)` is called
   * after "write" and after "commit", and while a missing `documents` folder
   * is made, after it is made ("documents") and after it is opened
   * ("documents-open").
   * `gitTimeoutMs` is how long one git run may take. `onRevision` is told of
   * every revision made from here on, as it is made (see `commit`), and
   * `onThreads` of every change to a document's comments.
   */
  static async open(folder, { dir, inside, Database, faults, gitTimeoutMs, onRevision, onThreads }) {
    const store = new Store(folder, dir, inside, faults, gitTimeoutMs, onRevision, onThreads);
    try {
      await store.#open(Database);
    } catch (e) {
      // A store that fails to open is tried again on the next request: its database and its folder must not stay open meanwhile.
      try {
        store.db?.close();
      } catch {
        // Closed already, or never open.
      }
      store.guard?.close();
      throw explained(e, dir);
    }
    return store;
  }

  constructor(folder, dir, inside, faults, gitTimeoutMs, onRevision, onThreads) {
    this.folder = folder;
    this.inside = inside;
    this.faults = faults;
    this.gitTimeoutMs = gitTimeoutMs;
    this.onRevision = onRevision;
    this.onThreads = onThreads;
    this.storeDir = dir;
    this.queue = Promise.resolve();
    this.commits = 0;
  }

  async #open(Database) {
    // Held from here on: everything below is done through this one open folder, never by its path again.
    this.guard = Guard.open(this.storeDir);
    this.repo = new Repo(this.guard, this.gitTimeoutMs ? { timeoutMs: this.gitTimeoutMs } : undefined);
    let fresh = false;
    try {
      lstatSync(this.guard.at("git"));
    } catch {
      fresh = true;
    }
    if (fresh) await this.repo.init();
    this.guard.audit();
    // Which folder it is for: told once, and again when the folder has moved or been restored (place.js decided it is the same).
    this.bound = bindingFor(this.folder);
    if (!sameBinding(readBinding(this.guard.at()), this.bound)) writeBinding(this.guard.at(), this.bound);
    const file = this.guard.at("docs.sqlite");
    // Made by hand first, with its mode and never through a link: SQLite would make it readable for everyone.
    try {
      closeSync(openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    const db = lstatSync(file);
    if (!db.isFile() || (process.getuid && db.uid !== process.getuid())) throw Object.assign(new DocError(409, `The documents database is not the store's own (the store is ${this.storeDir})`), { operator: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 2000");
    this.db.exec(SCHEMA_SQL);
    const version = this.meta("schema");
    if (version && Number(version) > SCHEMA) throw new DocError(500, `The documents database is of a later version (${version})`);
    this.setMeta("schema", String(SCHEMA));
    await this.locked(async () => {
      await this.recover();
      await this.repo.gc();
    });
  }

  /**
   * Whether the store's folder is still the one opened and the portal's alone,
   * with its history and database in it, and the folder it is for still the
   * folder at its path: one deleted, replaced, opened to others or missing a
   * part, or for a folder that was deleted and made again, is opened again
   * (place.js looks at which store it is).
   */
  stillThere() {
    try {
      this.guard.check();
      if (!sameBinding(bindingFor(this.folder), this.bound)) return false;
      // Opening makes what is missing: the history again from nothing, the database again from the history.
      return lstatSync(this.guard.at("git")).isDirectory() && lstatSync(this.guard.at("docs.sqlite")).isFile();
    } catch {
      return false;
    }
  }

  async close() {
    await this.queue;
    this.db?.close();
    this.guard?.close();
  }

  /** Runs `work` once everything before it in this folder is done: one write at a time, and no read in the middle of one. */
  locked(work) {
    const next = this.queue.then(async () => {
      try {
        return await work();
      } catch (e) {
        throw explained(e, this.storeDir);
      }
    });
    this.queue = next.catch(() => {});
    return next;
  }

  meta(key) {
    return this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
  }

  setMeta(key, value) {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** The documents folder, or nothing when there is none (or it is a link, which is none). */
  documentsDir() {
    const dir = path.join(this.folder, DOCUMENTS);
    try {
      if (this.inside(this.folder, DOCUMENTS) !== dir) return null;
      return lstatSync(dir).isDirectory() ? dir : null;
    } catch {
      return null;
    }
  }

  /** The documents folder, made if it is not there: with the folder's owner and mode, so the agent can write in it as before. */
  makeDocumentsDir() {
    const found = this.documentsDir();
    if (found) return found;
    const dir = path.join(this.folder, DOCUMENTS);
    let followed;
    try {
      followed = this.inside(this.folder, DOCUMENTS);
    } catch {
      // A link that leads out of the folder is refused by `inside`: it is a link all the same.
      throw new DocError(409, "documents in this folder is a link");
    }
    if (followed !== dir) throw new DocError(409, "documents in this folder is a link");
    const folder = lstatSync(this.folder);
    try {
      mkdirSync(dir, { mode: folder.mode & 0o7777 });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    this.fault("documents");
    // Opened once, never through a link, and its mode and owner set through that descriptor: with the sandbox on the portal is root and
    // the agent can write in the chat folder, so a link put where the folder was between a check and a `chmod` by path would have its
    // target given the chat folder's mode and owner.
    let fd;
    try {
      fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } catch (e) {
      if (e.code !== "ELOOP" && e.code !== "ENOTDIR") throw e;
      // Which of the two it is only changes what is said: nothing was opened, or changed.
      let link = e.code === "ELOOP";
      try {
        link ||= lstatSync(dir).isSymbolicLink();
      } catch {
        // Gone again: it is neither.
      }
      throw new DocError(409, link ? "documents in this folder is a link" : "documents in this folder is not a folder");
    }
    try {
      this.fault("documents-open");
      fchmodSync(fd, folder.mode & 0o7777);
      try {
        fchownSync(fd, folder.uid, folder.gid);
      } catch {
        // The portal is not root: the folder is its own already.
      }
    } finally {
      closeSync(fd);
    }
    return dir;
  }

  row(id) {
    return this.db.prepare("SELECT * FROM documents WHERE id = ?").get(id);
  }

  rows() {
    return this.db.prepare("SELECT * FROM documents ORDER BY name").all();
  }

  /** Steps of a write a test breaks: nothing in normal use. */
  fault(step) {
    this.faults?.after(step);
  }

  /** Puts right what a write cut off, or someone else changed, left: see the top of this file. Under the lock. */
  async recover() {
    rmSync(this.repo.gitPath("index.lock"), { force: true });
    await this.replay();
    await this.takeIn();
  }

  /** Commits the database does not know yet, told to it from their trailers, in order. */
  async replay() {
    const head = await this.repo.head();
    const known = this.meta("head");
    if (head === known) return;
    let from = known;
    // A history the database does not know at all (its git dir made again, or it was rewritten): it is read again from the start.
    const rebuild = !head || !known || !(await this.repo.isAncestor(known, head));
    if (rebuild) from = null;
    const commits = head ? await this.repo.commitsAfter(from, head) : [];
    const read = [];
    for (const sha of commits) {
      const { time, message } = await this.repo.commit(sha);
      const groups = parseTrailers(message);
      const blobs = await this.repo.blobsIn(sha, [...new Set(groups.map((g) => g.name))]);
      read.push({ sha, at: new Date(time * 1000).toISOString(), groups: groups.filter((g) => blobs.has(g.name)).map((g) => ({ ...g, blob: blobs.get(g.name) })) });
    }
    this.db.transaction(() => {
      if (rebuild) {
        this.db.prepare("DELETE FROM revisions").run();
        this.db.prepare("UPDATE documents SET revision = 0, blob = NULL, stat = NULL").run();
      }
      for (const commit of read) this.record(commit.sha, commit.groups, commit.at);
      if (!head) this.db.prepare("DELETE FROM meta WHERE key = 'head'").run();
    })();
  }

  /**
   * Tells the database of a commit: each of its documents' revision, in the
   * index and as where the document stands. A document it does not know (the
   * database was lost) is known from the trailers. In a transaction of the caller's.
   */
  record(sha, groups, at, keys = new Map()) {
    const now = new Date().toISOString();
    for (const group of groups) {
      if (!this.row(group.id)) {
        // Its name may be another's by now: that one keeps it, and this one's history stays in git.
        if (this.db.prepare("SELECT 1 FROM documents WHERE name = ?").get(group.name)) continue;
        this.db.prepare("INSERT INTO documents (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(group.id, group.name, at, at);
      }
      this.db
        .prepare("INSERT OR REPLACE INTO revisions (doc_id, revision, sha, blob, author, kind, restored_from, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(group.id, group.revision, sha, group.blob, group.author, kindOf(group), group.restoredFrom ?? null, at);
      this.db
        .prepare("UPDATE documents SET revision = ?, blob = ?, stat = ?, updated_at = ? WHERE id = ? AND revision < ?")
        .run(group.revision, group.blob, keys.get(group.id) ?? null, now, group.id, group.revision);
    }
    this.setMeta("head", sha);
  }

  /**
   * Commits `groups` (`{ id, name, blob, revision, author, restoredFrom }`),
   * one commit for all, and tells the database. `keys`: the files' change keys
   * as written, by document id. Returns the commit. Every write goes through
   * here, under the lock, so `onRevision` hears the revisions in the order they
   * were made.
   */
  async commit(subject, groups, keys) {
    const parent = this.meta("head");
    const sha = await this.repo.commitEntries(parent, groups, messageFor(subject, groups));
    this.fault("commit");
    const at = new Date().toISOString();
    this.db.transaction(() => this.record(sha, groups, at, keys))();
    for (const group of groups) this.told({ id: group.id, revision: group.revision, author: group.author, at });
    if (++this.commits % GC_EVERY === 0) await this.repo.gc();
    return sha;
  }

  /** A revision was made: said to whoever listens, and a failure of theirs is not the write's. */
  told(revision) {
    try {
      this.onRevision?.(revision);
    } catch {
      // The listener's own: the revision is made all the same.
    }
  }

  /**
   * Files that are not the text of their document's last revision, and
   * Markdown files that are no document yet, committed as revisions by author
   * `external`. Registered documents whose file is gone stay as they are; one
   * whose first revision never got committed is forgotten.
   */
  async takeIn() {
    const dir = this.documentsDir();
    const rows = this.rows();
    if (!dir) {
      for (const row of rows) if (row.revision === 0) this.db.prepare("DELETE FROM documents WHERE id = ?").run(row.id);
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set();
    for (const entry of entries) {
      if (isTempName(entry.name) && (entry.isFile() || entry.isSymbolicLink())) rmSync(path.join(dir, entry.name), { force: true });
      else if (entry.isFile() && isDocumentName(entry.name)) names.add(entry.name);
    }
    const changed = [];
    const byName = new Set();
    for (const row of rows) {
      byName.add(row.name);
      if (!names.has(row.name)) {
        if (row.revision === 0) this.db.prepare("DELETE FROM documents WHERE id = ?").run(row.id);
        continue;
      }
      const opened = openDocument(this.inside, dir, row.name);
      if (!opened) continue;
      closeSync(opened.fd);
      if (opened.key === row.stat) continue;
      const file = readDocument(this.inside, dir, row.name);
      if (!file) continue;
      const blob = blobId(file.bytes);
      if (blob === row.blob) this.db.prepare("UPDATE documents SET stat = ? WHERE id = ?").run(file.key, row.id);
      else {
        // Written from the bytes read here: git is never given the file's path to open again.
        await this.repo.storeBlob(file.bytes);
        changed.push({ id: row.id, name: row.name, blob, revision: row.revision + 1, key: file.key });
      }
    }
    let room = MAX_DOCUMENTS - rows.length;
    const now = new Date().toISOString();
    for (const name of [...names].sort()) {
      if (room <= 0) break;
      if (byName.has(name) || !isAdoptable(name)) continue;
      const file = readDocument(this.inside, dir, name);
      if (!file) continue;
      const id = randomBytes(8).toString("hex");
      this.db.prepare("INSERT INTO documents (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, name, now, now);
      await this.repo.storeBlob(file.bytes);
      changed.push({ id, name, blob: blobId(file.bytes), revision: 1, key: file.key });
      room--;
    }
    if (!changed.length) return;
    const groups = changed.map((c) => ({ ...c, author: "external" }));
    const subject = groups.length === 1 ? `${groups[0].revision === 1 ? "Take in" : "Recover"} ${groups[0].name}` : `Take in or recover ${groups.length} documents`;
    await this.commit(subject, groups, new Map(groups.map((g) => [g.id, g.key])));
  }

  /** A document's row, or a 404. */
  existing(id) {
    const row = isDocumentId(id) ? this.row(id) : null;
    if (!row || row.revision === 0) throw new DocError(404, "There is no such document");
    return row;
  }

  describe(row, file) {
    return { id: row.id, name: row.name, scope: row.scope, chat: row.chat_id, revision: row.revision, size: file.bytes?.length ?? file.size, modified: file.modified.toISOString() };
  }

  /** The documents there are, each with the start of its text (for its title) and how many comment threads are open on it. */
  list(headBytes) {
    return this.locked(async () => {
      await this.recover();
      const dir = this.documentsDir();
      if (!dir) return [];
      const closed = this.closed(dir);
      if (closed) throw closed;
      const out = [];
      const open = new Map(this.db.prepare("SELECT doc_id, COUNT(*) AS n FROM threads WHERE status = 'open' GROUP BY doc_id").all().map((r) => [r.doc_id, r.n]));
      const answered = new Map(this.db.prepare("SELECT doc_id, COUNT(*) AS n FROM threads WHERE answered = 1 GROUP BY doc_id").all().map((r) => [r.doc_id, r.n]));
      const asking = new Map(this.db.prepare("SELECT doc_id, COUNT(*) AS n FROM threads WHERE status = 'open' AND to_agent = 1 GROUP BY doc_id").all().map((r) => [r.doc_id, r.n]));
      for (const row of this.rows()) {
        if (row.revision === 0) continue;
        const opened = openDocument(this.inside, dir, row.name);
        if (!opened) continue;
        try {
          out.push({ ...this.describe(row, opened), openThreads: open.get(row.id) ?? 0, answeredThreads: answered.get(row.id) ?? 0, askingThreads: asking.get(row.id) ?? 0, head: readOpen(opened.fd, Math.min(headBytes, opened.size)) });
        } finally {
          closeSync(opened.fd);
        }
      }
      return out;
    });
  }

  /** Where a document stands: its revision, who made it and when. What someone else did to its file is taken in first. */
  current(id) {
    return this.locked(async () => {
      await this.recover();
      const row = this.existing(id);
      const made = this.db.prepare("SELECT author, at FROM revisions WHERE doc_id = ? AND revision = ?").get(row.id, row.revision);
      return { revision: row.revision, author: made?.author ?? "external", at: made?.at ?? row.updated_at };
    });
  }

  /** What someone else did to the files since is taken in, each change as a revision (and told, with the others). */
  refresh() {
    return this.locked(() => this.recover());
  }

  /** One document, whole: its text as `bytes`, and the revision that text is. */
  read(id) {
    return this.locked(async () => {
      await this.recover();
      const row = this.existing(id);
      const file = this.fileOf(row);
      if (!file) throw this.unreadable(row);
      return { ...this.describe(row, file), bytes: file.bytes };
    });
  }

  /** Whose a document is (`scope`, and the chat for a chat's own): what asking the agent about it depends on, which needs no file. */
  ownerOf(id) {
    return this.locked(async () => {
      await this.recover();
      const row = this.existing(id);
      return { scope: row.scope, chat: row.chat_id };
    });
  }

  fileOf(row) {
    const dir = this.documentsDir();
    return dir ? readDocument(this.inside, dir, row.name) : null;
  }

  /** A refusal when the portal may not read the documents folder `dir`: an unreadable folder is not an empty one, nor are its files gone. */
  closed(dir) {
    try {
      accessSync(dir, constants.R_OK | constants.X_OK);
    } catch (e) {
      if (e.code === "EACCES" || e.code === "EPERM") return new DocError(403, "The portal is not allowed to read this folder's documents folder (permission denied)");
    }
    return null;
  }

  /**
   * Why a document's file cannot be read, as a refusal: the portal may not read the documents folder (403), it is gone (deleted,
   * or renamed: 404, as for a document that is not there), or something is at its name that the portal does not read as a
   * document (a file past 1 MB, or one it is not allowed to read: 409, which says so).
   */
  unreadable(row) {
    const dir = this.documentsDir();
    const closed = dir && this.closed(dir);
    if (closed) return closed;
    if (dir && isPlainFile(this.inside, dir, row.name)) return new DocError(409, "The document's file is bigger than 1 MB, or the portal is not allowed to read it");
    return new DocError(404, "There is no such document");
  }

  /**
   * A new document named after `title`, holding `markdown`: revision 1.
   * Never in place of a file: a name that is taken gets a number, or with
   * `exclusive` is refused (409, with the taken document's id as `exists`
   * where it is one), for a caller that would rather not make a second one.
   */
  create({ title, markdown, scope = "project", chat = null, author = "user", exclusive = false }) {
    const bytes = Buffer.from(markdown, "utf8");
    if (bytes.length > MAX_BYTES) throw new DocError(413, "A document can be at most 1 MB");
    return this.locked(async () => {
      await this.recover();
      if (this.rows().length >= MAX_DOCUMENTS) throw new DocError(409, `A folder holds at most ${MAX_DOCUMENTS} documents`);
      const dir = this.makeDocumentsDir();
      const slug = slugOf(title);
      const id = randomBytes(8).toString("hex");
      const now = new Date().toISOString();
      for (let n = 1; n < 1000; n++) {
        const name = `${numbered(slug, n)}.md`;
        const taken = this.db.prepare("SELECT id FROM documents WHERE name = ?").get(name);
        if (taken) {
          // A document whose file is gone (deleted, or renamed) is not there to be told of: the number after it is used, not an error
          // about a document that is neither listed nor readable.
          if (exclusive && isPlainFile(this.inside, dir, name)) throw new DocError(409, `A document called ${name} exists already`, { exists: taken.id });
          continue;
        }
        let written;
        // The row first, without a revision: a failure after the file is written leaves a file recovery takes in under this id.
        this.db.prepare("INSERT INTO documents (id, name, scope, chat_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, name, scope, chat, now, now);
        try {
          written = writeDocument(this.inside, dir, name, bytes, { create: true });
        } catch (e) {
          this.db.prepare("DELETE FROM documents WHERE id = ?").run(id);
          // Anything in the way (a file, a link, a second name) makes the name taken: the next number is free.
          if (e instanceof Refused) {
            if (exclusive) throw new DocError(409, `A file called ${name} is in the way`, { exists: null });
            continue;
          }
          throw e;
        }
        this.fault("write");
        const blob = await this.repo.storeBlob(bytes);
        await this.commit(`Create ${name}`, [{ id, name, blob, revision: 1, author }], new Map([[id, written.key]]));
        return { ...this.describe(this.row(id), { bytes, modified: written.modified }) };
      }
      throw new DocError(409, "Every name for this title is taken");
    });
  }

  /**
   * Saves `markdown` as the document's next revision, if `base` is the
   * revision it stands at. Otherwise nothing is written, and the answer (409)
   * carries the text and the revision it stands at now.
   *
   * With `merge`, a text that started from an earlier revision is not refused
   * for that: its changes are made to the text the document has now, as long
   * as they touch none of the lines that changed since (merge.js), and that
   * is saved as the next revision. The answer then has `merged` and the text
   * that was saved, which is not the one that was sent: the sender is to take
   * it up. A change that does touch those lines is refused as before.
   */
  save(id, { markdown, base, author = "user", merge = false }) {
    const bytes = Buffer.from(markdown, "utf8");
    if (bytes.length > MAX_BYTES) throw new DocError(413, "A document can be at most 1 MB");
    return this.locked(async () => {
      await this.recover();
      const row = this.existing(id);
      const file = this.fileOf(row);
      if (!file) return this.#saveUnread(row, bytes, base, author);
      if (base !== row.revision) {
        const merged = merge ? await this.#merged(row, file, base, markdown, bytes, author) : null;
        if (merged) return merged;
        throw new DocError(409, `The document changed: it is at revision ${row.revision}, not ${base}`, { revision: row.revision, markdown: file.bytes.toString("utf8") });
      }
      if (file.bytes.equals(bytes)) return { ...this.describe(row, file), changed: false };
      return this.#write(row, bytes, { author, subject: `Save ${row.name}` });
    });
  }

  /**
   * A save for a document whose file cannot be read. Where the file is gone (deleted, or renamed) the person's text is the
   * document: it is written as the document's file again, on the revision it started from, and the answer says so
   * (`recreated`). One that has moved on since is the person's to choose about, as with a file that is there. A file that is there
   * but is not read (past 1 MB, not readable) is an outside change nothing has taken in: it is not written over. Under the lock,
   * after recovery.
   */
  async #saveUnread(row, bytes, base, author) {
    const refusal = this.unreadable(row);
    if (refusal.status !== 404) throw refusal;
    if (base !== row.revision) {
      const last = await this.textAt(row, row.revision);
      if (last === null) throw refusal;
      throw new DocError(409, `The document changed: it is at revision ${row.revision}, not ${base}`, { revision: row.revision, markdown: last });
    }
    return { ...(await this.#write(row, bytes, { author, subject: `Save ${row.name}, its file made again`, create: true })), recreated: true };
  }

  /**
   * `markdown`, which started from revision `base`, put together with the text
   * the document has now (`file`) and saved: the save's answer, or nothing when
   * that cannot be done (the base is not an earlier revision of this document,
   * the texts are not all text, or the changes meet). Under the lock, after recovery.
   */
  async #merged(row, file, base, markdown, bytes, author) {
    if (!Number.isInteger(base) || base < 1 || base >= row.revision) return null;
    const found = this.db.prepare("SELECT sha FROM revisions WHERE doc_id = ? AND revision = ?").get(row.id, base);
    if (!found) return null;
    let was;
    try {
      was = await this.repo.show(found.sha, row.name);
    } catch (e) {
      if (e instanceof GitError) return null;
      throw e;
    }
    // Bytes that are not UTF-8 would be written back as other bytes: they are not merged.
    const [before, now] = [was, file.bytes].map((b) => b.toString("utf8"));
    if (!Buffer.from(before, "utf8").equals(was) || !Buffer.from(now, "utf8").equals(file.bytes) || !Buffer.from(markdown, "utf8").equals(bytes)) return null;
    const text = merge3(before, markdown, now);
    if (text === null) return null;
    const merged = Buffer.from(text, "utf8");
    // What was sent is in the document already (or was nothing new): there is nothing to write.
    if (merged.equals(file.bytes)) return { ...this.describe(row, file), changed: false, merged: true, markdown: now };
    if (merged.length > MAX_BYTES) throw new DocError(413, "A document can be at most 1 MB");
    const saved = await this.#write(row, merged, { author, subject: `Save ${row.name}, merged with revision ${row.revision}` });
    return { ...saved, merged: true, markdown: text };
  }

  /** Writes `bytes` as the next revision of `row`'s document: file, commit, database. Under the lock, after recovery. */
  async #write(row, bytes, { author, subject, restoredFrom, create = false }) {
    const dir = create ? this.makeDocumentsDir() : this.documentsDir();
    if (!dir) throw new DocError(404, "There is no such document");
    let written;
    try {
      written = writeDocument(this.inside, dir, row.name, bytes, { create });
    } catch (e) {
      if (e instanceof Refused) throw new DocError(409, e.taken ? "Another file took the document's name" : e.message);
      throw e;
    }
    this.fault("write");
    const blob = await this.repo.storeBlob(bytes);
    const revision = row.revision + 1;
    await this.commit(subject, [{ id: row.id, name: row.name, blob, revision, author, restoredFrom }], new Map([[row.id, written.key]]));
    return { ...this.describe(this.row(row.id), { bytes, modified: written.modified }), changed: true, ...(restoredFrom ? { restoredFrom } : {}) };
  }

  /** The document's revisions, newest first: at most `limit`, those before `before` when it is given. */
  history(id, { before, limit = 200 } = {}) {
    return this.locked(async () => {
      await this.recover();
      const row = this.existing(id);
      const list = this.db
        .prepare("SELECT revision, author, kind, restored_from AS restoredFrom, at FROM revisions WHERE doc_id = ? AND revision < ? ORDER BY revision DESC LIMIT ?")
        .all(row.id, before ?? Number.MAX_SAFE_INTEGER, limit + 1);
      return { revision: row.revision, revisions: list.slice(0, limit).map((r) => ({ ...r, restoredFrom: r.restoredFrom ?? undefined })), more: list.length > limit };
    });
  }

  /** The text of one revision, from the history. */
  revision(id, revision) {
    return this.locked(async () => {
      await this.recover();
      const row = this.existing(id);
      const found = this.db.prepare("SELECT * FROM revisions WHERE doc_id = ? AND revision = ?").get(row.id, revision);
      if (!found) throw new DocError(404, "There is no such revision");
      return { revision: found.revision, author: found.author, kind: found.kind, at: found.at, bytes: await this.repo.show(found.sha, row.name) };
    });
  }

  /**
   * The text of an earlier revision, saved as the next one: history only
   * grows. With `base`, only if the document still stands there. A document
   * whose file is gone is made again.
   */
  restore(id, { revision, base, author = "user" }) {
    return this.locked(async () => {
      await this.recover();
      const row = this.existing(id);
      if (base !== undefined && base !== row.revision) {
        const file = this.fileOf(row);
        throw new DocError(409, `The document changed: it is at revision ${row.revision}, not ${base}`, { revision: row.revision, markdown: file?.bytes.toString("utf8") ?? "" });
      }
      const found = this.db.prepare("SELECT * FROM revisions WHERE doc_id = ? AND revision = ?").get(row.id, revision);
      if (!found) throw new DocError(404, "There is no such revision");
      const bytes = await this.repo.show(found.sha, row.name);
      const file = this.fileOf(row);
      if (file?.bytes.equals(bytes)) return { ...this.describe(row, file), changed: false };
      // A file that is only too big to be read (an outside change) is written over, as a save would; only no file at all is made again.
      const dir = file ? null : this.documentsDir();
      const replace = !file && dir !== null && isPlainFile(this.inside, dir, row.name);
      return this.#write(row, bytes, { author, subject: `Restore ${row.name} to revision ${revision}`, restoredFrom: revision, create: !file && !replace });
    });
  }

  /** A document's text as text, or nothing when its bytes are not UTF-8 (they would be written back as other bytes). */
  text(bytes) {
    const text = bytes.toString("utf8");
    return Buffer.from(text, "utf8").equals(bytes) ? text : null;
  }

  /** The text of one revision of a document, from the history: nothing when there is no such revision or it is not text. */
  async textAt(row, revision) {
    const found = this.db.prepare("SELECT sha FROM revisions WHERE doc_id = ? AND revision = ?").get(row.id, revision);
    if (!found) return null;
    try {
      return this.text(await this.repo.show(found.sha, row.name));
    } catch (e) {
      if (e instanceof GitError) return null;
      throw e;
    }
  }

  /**
   * A comment thread as the page and the tools get it, with its comments in the order they were made. `toAgent`: the person asked
   * the agent in it (`@agent`) and it has not answered. `answered`: the agent answered in it and the person has not reacted
   * since. `ping`: the last time the agent was asked: its number, the comment that asked, the chat it was for and whether the
   * chat took it.
   */
  threadView(t, comments, ping) {
    return {
      id: t.id,
      status: t.status,
      orphaned: Boolean(t.orphaned),
      quote: t.quote,
      prefix: t.prefix,
      suffix: t.suffix,
      start: t.start,
      end: t.end,
      revision: t.revision,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
      toAgent: Boolean(t.to_agent),
      answered: Boolean(t.answered),
      ping: ping ? { id: ping.id, chat: ping.chat_id, comment: ping.comment_id, sent: ping.sent_at !== null } : null,
      comments: comments.map((c) => ({ id: c.id, author: c.author, body: c.body, at: c.created_at })),
    };
  }

  /** A document's threads, oldest first, with their comments. */
  threadsOf(row) {
    const threads = this.db.prepare("SELECT * FROM threads WHERE doc_id = ? ORDER BY rowid").all(row.id);
    const comments = new Map(threads.map((t) => [t.id, []]));
    for (const c of this.db.prepare("SELECT c.* FROM comments c JOIN threads t ON t.id = c.thread_id WHERE t.doc_id = ? ORDER BY c.rowid").all(row.id)) comments.get(c.thread_id).push(c);
    // The last time each thread was asked about: the pings are in the order they were made.
    const pings = new Map();
    for (const p of this.db.prepare("SELECT p.* FROM pings p JOIN threads t ON t.id = p.thread_id WHERE t.doc_id = ? ORDER BY p.id").all(row.id)) pings.set(p.thread_id, p);
    return threads.map((t) => this.threadView(t, comments.get(t.id), pings.get(t.id)));
  }

  /** A thread of the document, or a 404. */
  thread(row, id) {
    const found = typeof id === "string" && /^[0-9a-f]{16}$/.test(id) ? this.db.prepare("SELECT * FROM threads WHERE id = ? AND doc_id = ?").get(id, row.id) : null;
    if (!found) throw new DocError(404, "There is no such comment thread", { code: "thread_not_found" });
    return found;
  }

  /** The thread told to whoever listens: its document's comments changed. A listener's failure is not the write's. */
  toldThreads(row) {
    try {
      this.onThreads?.({ id: row.id, at: new Date().toISOString() });
    } catch {
      // The listener's own: the comment is made all the same.
    }
  }

  /** A comment's text as it is kept: trimmed, not empty, and no more than the database holds. */
  bodyOf(body) {
    const text = typeof body === "string" ? body.trim() : "";
    if (!text) throw new DocError(400, "A comment cannot be empty", { code: "invalid" });
    if (Buffer.byteLength(text, "utf8") > MAX_BODY) throw new DocError(413, `A comment can be at most ${MAX_BODY} bytes`, { code: "too_large" });
    return text;
  }

  /**
   * Puts the passages of the document's threads that were placed on an earlier
   * revision where they are in the text it has now (anchor.js): the words of a
   * passage that was changed are the passage, one that is nowhere is orphaned
   * (kept, with its words, and looked for again with the next revision). Under
   * the lock, after recovery. A document whose file cannot be read as text
   * leaves them as they are.
   */
  async follow(row) {
    const behind = this.db.prepare("SELECT * FROM threads WHERE doc_id = ? AND revision != ?").all(row.id, row.revision);
    if (!behind.length) return;
    const file = this.fileOf(row);
    const after = file ? this.text(file.bytes) : null;
    if (after === null) return;
    const moves = [];
    for (const revision of new Set(behind.map((t) => t.revision))) {
      const group = behind.filter((t) => t.revision === revision);
      // A thread with no place is looked for by its words, which the text it was last in cannot help with.
      const placed = group.filter((t) => !t.orphaned && t.start !== null);
      const before = placed.length ? await this.textAt(row, revision) : null;
      const anchors = group.map((t) => (before !== null && !t.orphaned && t.start !== null ? { quote: t.quote, prefix: t.prefix, suffix: t.suffix, start: t.start, end: t.end } : { quote: t.quote, prefix: t.prefix, suffix: t.suffix, start: null, end: null }));
      const found = carry(before ?? after, after, anchors);
      group.forEach((t, i) => moves.push({ t, to: found[i] ? passage(after, found[i].start, found[i].end) : null }));
    }
    this.db.transaction(() => {
      for (const { t, to } of moves) {
        if (to) this.db.prepare('UPDATE threads SET quote = ?, prefix = ?, suffix = ?, start = ?, "end" = ?, revision = ?, orphaned = 0 WHERE id = ?').run(to.quote, to.prefix, to.suffix, to.start, to.end, row.revision, t.id);
        else this.db.prepare('UPDATE threads SET start = NULL, "end" = NULL, revision = ?, orphaned = 1 WHERE id = ?').run(row.revision, t.id);
      }
    })();
  }

  /** A document's comment threads, each with its passage where it is in the text now. */
  threads(id) {
    return this.locked(async () => {
      await this.recover();
      const row = this.existing(id);
      await this.follow(row);
      // Whose the document is tells which chats can answer a comment on it.
      return { revision: row.revision, scope: row.scope, chat: row.chat_id, threads: this.threadsOf(row) };
    });
  }

  /**
   * Starts a thread on a passage of the document, with its first comment.
   * `quote` is the passage as the sender saw it in revision `base` (the
   * document's text then, which may be an earlier one than the document is at
   * now), with `prefix` and `suffix` around it and `start` where it began; it
   * is found in that text again (anchor.js) and brought forward to the text the
   * document has now. Refused (422) when it is not in that text.
   */
  addThread(id, { base, quote, prefix = "", suffix = "", start = null, body, author }) {
    return this.locked(async () => {
      await this.recover();
      const row = this.existing(id);
      const text = this.bodyOf(body);
      if (typeof quote !== "string" || !quote.trim() || [prefix, suffix].some((x) => typeof x !== "string")) throw new DocError(400, "A comment needs the passage it is on", { code: "invalid" });
      if (!isWhole(quote) || !isWhole(prefix) || !isWhole(suffix)) throw new DocError(400, "The passage is cut in the middle of a character", { code: "invalid" });
      if (quote.length > MAX_QUOTE) throw new DocError(413, `A comment can be on at most ${MAX_QUOTE} characters of the text`, { code: "too_large" });
      if (!Number.isInteger(base) || base < 1 || base > row.revision) throw new DocError(409, `The document is at revision ${row.revision}, not ${base}`, { code: "revision_mismatch", revision: row.revision });
      if (this.db.prepare("SELECT COUNT(*) AS n FROM threads WHERE doc_id = ?").get(row.id).n >= MAX_THREADS) throw new DocError(409, `A document can have at most ${MAX_THREADS} comment threads`, { code: "too_many" });
      const file = this.fileOf(row);
      // A document whose file is gone (deleted, or renamed) is still open on a page that has its text: the passage is in the text the
      // document last had, which is what the page shows until its next save makes the file again.
      const refusal = file ? null : this.unreadable(row);
      if (refusal && refusal.status !== 404) throw refusal;
      const current = file ? this.text(file.bytes) : await this.textAt(row, row.revision);
      const there = base === row.revision ? current : await this.textAt(row, base);
      if (there === null || current === null) throw new DocError(409, "The document is not text that can be commented on");
      const found = locate(there, { quote, prefix, suffix, start });
      const placed = found && passage(there, found.start, found.end);
      if (!placed) throw new DocError(422, `That passage is not in the document at revision ${base}`, { code: "quote_not_found", revision: row.revision });
      const now = new Date().toISOString();
      const thread = randomBytes(8).toString("hex");
      this.db.transaction(() => {
        this.db
          .prepare('INSERT INTO threads (id, doc_id, quote, prefix, suffix, start, "end", revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(thread, row.id, placed.quote, placed.prefix, placed.suffix, placed.start, placed.end, base, now, now);
        this.db.prepare("INSERT INTO comments (id, thread_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)").run(randomBytes(8).toString("hex"), thread, author, text, now);
      })();
      await this.follow(row);
      this.toldThreads(row);
      return this.threadsOf(row).find((t) => t.id === thread);
    });
  }

  /**
   * Puts a thread's passage at `[start, end)` of the text the document has at
   * `revision`, for a caller that knows where it is: the change that was made
   * to answer the comment has just put new words in its place. True when it
   * was done; false when the document has moved on or the stretch is nothing
   * (the passage is then put where it goes by the next look at the threads).
   */
  place(id, thread, { revision, start, end }) {
    return this.locked(async () => {
      await this.recover();
      const row = this.existing(id);
      const found = this.thread(row, thread);
      if (revision !== row.revision) return false;
      const file = this.fileOf(row);
      const text = file ? this.text(file.bytes) : null;
      const placed = text !== null && Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= text.length ? passage(text, start, end) : null;
      if (!placed || placed.quote.length > MAX_QUOTE) return false;
      this.db.prepare('UPDATE threads SET quote = ?, prefix = ?, suffix = ?, start = ?, "end" = ?, revision = ?, orphaned = 0 WHERE id = ?').run(placed.quote, placed.prefix, placed.suffix, placed.start, placed.end, row.revision, found.id);
      return true;
    });
  }

  /** Adds a comment to an open thread. */
  reply(id, thread, { body, author }) {
    return this.locked(async () => {
      await this.recover();
      const row = this.existing(id);
      const found = this.thread(row, thread);
      const text = this.bodyOf(body);
      if (found.status !== "open") throw new DocError(409, "The thread is resolved: it is to be reopened to be added to", { code: "thread_resolved" });
      this.addComment(found, text, author);
      this.toldThreads(row);
      return this.threadsOf(row).find((t) => t.id === found.id);
    });
  }

  /**
   * The comment is added and the thread is last changed now. The agent's comment is its answer to whoever asked it (the thread
   * no longer waits for it) and is news to the person; the person's is a reaction to it.
   */
  addComment(thread, text, author) {
    if (this.db.prepare("SELECT COUNT(*) AS n FROM comments WHERE thread_id = ?").get(thread.id).n >= MAX_COMMENTS) throw new DocError(409, `A thread can have at most ${MAX_COMMENTS} comments`, { code: "too_many" });
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO comments (id, thread_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)").run(randomBytes(8).toString("hex"), thread.id, author, text, now);
      this.db.prepare(`UPDATE threads SET updated_at = ?, ${author === "agent" ? "to_agent = 0, answered = 1" : "answered = 0"} WHERE id = ?`).run(now, thread.id);
    })();
  }

  /** A thread's last comment, or nothing. */
  lastComment(thread) {
    return this.db.prepare("SELECT * FROM comments WHERE thread_id = ? ORDER BY rowid DESC LIMIT 1").get(thread.id);
  }

  /**
   * The flags a thread has when the comments it has are all there is: it waits for the agent if a ping asks in a comment later
   * than the agent's last, and the agent has the last word if its comment is the last. For after a comment was taken away.
   */
  settleFlags(thread) {
    const last = this.lastComment(thread);
    const waiting = this.db
      .prepare("SELECT 1 FROM pings p JOIN comments c ON c.id = p.comment_id WHERE p.thread_id = ? AND c.rowid > COALESCE((SELECT MAX(rowid) FROM comments WHERE thread_id = ? AND author = 'agent'), 0)")
      .get(thread.id, thread.id);
    this.db.prepare("UPDATE threads SET to_agent = ?, answered = ? WHERE id = ?").run(waiting ? 1 : 0, last?.author === "agent" ? 1 : 0, thread.id);
  }

  /**
   * The person's last comment in an open thread asks the agent, to be answered by the agent of `chat` (nobody, when it is none:
   * the ping is made all the same, and not delivered): the thread waits for the agent until the agent comments in it. A comment
   * is asked in once: one that was taken by a chat is left as it is (`sent`), and one that was not is asked in again, of `chat`.
   * `reached` says when a chat took it. Returns the ping's number, whether it was taken, and the thread.
   */
  ping(id, thread, { chat }) {
    return this.locked(async () => {
      await this.recover();
      const row = this.existing(id);
      const found = this.thread(row, thread);
      if (found.status !== "open") throw new DocError(409, "The thread is resolved: it is to be reopened to be asked in", { code: "thread_resolved" });
      const last = this.lastComment(found);
      if (last?.author !== "user") throw new DocError(409, "Only a comment of the person's asks the agent", { code: "comment_not_yours" });
      const had = this.db.prepare("SELECT * FROM pings WHERE comment_id = ?").get(last.id);
      let ping = had?.id;
      this.db.transaction(() => {
        if (!had) ping = Number(this.db.prepare("INSERT INTO pings (thread_id, comment_id, chat_id, kind, created_at) VALUES (?, ?, ?, 'mention', ?)").run(found.id, last.id, chat, new Date().toISOString()).lastInsertRowid);
        else if (had.sent_at === null && had.chat_id !== chat) this.db.prepare("UPDATE pings SET chat_id = ? WHERE id = ?").run(chat, had.id);
        this.db.prepare("UPDATE threads SET to_agent = 1 WHERE id = ?").run(found.id);
      })();
      this.toldThreads(row);
      return { ping, sent: had ? had.sent_at !== null : false, thread: this.threadsOf(row).find((t) => t.id === found.id) };
    });
  }

  /**
   * The person's last comment of the thread no longer asks the agent (it was edited): a ping that no chat took is taken back.
   * Returns the number of the ping that was, or nothing, the comment it was for, and the thread.
   */
  unping(id, thread) {
    return this.locked(async () => {
      await this.recover();
      const row = this.existing(id);
      const found = this.thread(row, thread);
      const last = this.lastComment(found);
      const had = last ? this.db.prepare("SELECT * FROM pings WHERE comment_id = ? AND sent_at IS NULL").get(last.id) : undefined;
      if (had) {
        this.db.transaction(() => {
          this.db.prepare("DELETE FROM pings WHERE id = ?").run(had.id);
          this.settleFlags(found);
        })();
        this.toldThreads(row);
      }
      return { ping: had?.id, comment: had ? last.id : undefined, thread: this.threadsOf(row).find((t) => t.id === found.id) };
    });
  }

  /**
   * The chat took the ping `ping` of a thread, which was made for the comment `comment`. A ping number is given again once the ping
   * that had it is gone (its comment typed away), so the ping that is marked is the one of that comment and no other. Returns the thread.
   */
  reached(id, thread, ping, comment) {
    return this.locked(async () => {
      await this.recover();
      const row = this.existing(id);
      const found = this.thread(row, thread);
      this.db.prepare("UPDATE pings SET sent_at = ? WHERE id = ? AND thread_id = ? AND comment_id = ?").run(new Date().toISOString(), ping, found.id, comment);
      this.toldThreads(row);
      return this.threadsOf(row).find((t) => t.id === found.id);
    });
  }

  /** The person has read what the agent said in a thread: it is no longer news. */
  seen(id, thread) {
    return this.locked(async () => {
      await this.recover();
      const row = this.existing(id);
      const found = this.thread(row, thread);
      if (found.answered) {
        this.db.prepare("UPDATE threads SET answered = 0 WHERE id = ?").run(found.id);
        this.toldThreads(row);
      }
      return this.threadsOf(row).find((t) => t.id === found.id);
    });
  }

  /**
   * The comment `comment` of an open thread, which is its last and written by `author`: it is the only one that can be changed
   * or taken away, while the page saves it as it is typed. A refusal says which of these it is not.
   */
  editable(found, comment, author) {
    if (found.status !== "open") throw new DocError(409, "The thread is resolved: it is to be reopened to be changed", { code: "thread_resolved" });
    const last = this.lastComment(found);
    const mine = typeof comment === "string" ? this.db.prepare("SELECT * FROM comments WHERE id = ? AND thread_id = ?").get(comment, found.id) : undefined;
    if (!mine) throw new DocError(404, "There is no such comment", { code: "comment_not_found" });
    if (mine.author !== author) throw new DocError(409, "That comment is not yours to change", { code: "comment_not_yours" });
    if (last.id !== mine.id) throw new DocError(409, "Something was said in the thread after that comment: it is not changed any more", { code: "comment_not_last" });
    return mine;
  }

  /** Changes the text of a comment, which is the last of its open thread and written by `author`. Returns the thread. */
  edit(id, thread, comment, { body, author }) {
    return this.locked(async () => {
      await this.recover();
      const row = this.existing(id);
      const found = this.thread(row, thread);
      const mine = this.editable(found, comment, author);
      const text = this.bodyOf(body);
      this.db.transaction(() => {
        this.db.prepare("UPDATE comments SET body = ? WHERE id = ?").run(text, mine.id);
        this.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), found.id);
      })();
      this.toldThreads(row);
      return this.threadsOf(row).find((t) => t.id === found.id);
    });
  }

  /**
   * Takes away a comment, which is the last of its open thread and written by `author`: the page does it when what it saved
   * was typed away. The thread goes with its only comment. Returns what was taken away (`thread` or `comment`), and the thread if
   * it is still there. Its pings go with it.
   */
  remove(id, thread, comment, { author }) {
    return this.locked(async () => {
      await this.recover();
      const row = this.existing(id);
      const found = this.thread(row, thread);
      const mine = this.editable(found, comment, author);
      const only = this.db.prepare("SELECT COUNT(*) AS n FROM comments WHERE thread_id = ?").get(found.id).n === 1;
      this.db.transaction(() => {
        if (only) return this.db.prepare("DELETE FROM threads WHERE id = ?").run(found.id);
        this.db.prepare("DELETE FROM comments WHERE id = ?").run(mine.id);
        this.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), found.id);
        this.settleFlags(found);
      })();
      this.toldThreads(row);
      return { removed: only ? "thread" : "comment", thread: only ? null : this.threadsOf(row).find((t) => t.id === found.id) };
    });
  }

  /**
   * Resolves a thread, or opens a resolved one again (`status`). A `body` is
   * added to the thread with it, as the last comment of a resolved thread. One
   * that is in the state asked for already is left as it is.
   */
  settle(id, thread, { status, body, author }) {
    return this.locked(async () => {
      await this.recover();
      const row = this.existing(id);
      const found = this.thread(row, thread);
      const text = body === undefined ? null : this.bodyOf(body);
      if (found.status !== status) {
        // The comment and the new state are made together or not at all.
        this.db.transaction(() => {
          if (text !== null && status === "resolved") this.addComment(found, text, author);
          // A closed thread waits for nobody. The agent's resolving it is an answer, news to the person; the person's is a
          // reaction to what it said, like opening it again.
          this.db.prepare(`UPDATE threads SET status = ?, updated_at = ?, answered = ${status === "resolved" && author === "agent" ? 1 : 0}${status === "resolved" ? ", to_agent = 0" : ""} WHERE id = ?`).run(status, new Date().toISOString(), found.id);
          if (text !== null && status === "open") this.addComment(found, text, author);
        })();
        this.toldThreads(row);
      }
      return this.threadsOf(row).find((t) => t.id === found.id);
    });
  }
}
