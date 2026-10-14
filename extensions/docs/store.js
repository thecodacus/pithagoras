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
 */
import { randomBytes } from "node:crypto";
import { chmodSync, chownSync, closeSync, constants, lstatSync, mkdirSync, openSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DocError } from "./errors.js";
import { blobId, messageFor, parseTrailers, Repo } from "./git.js";
import { Guard } from "./guard.js";
import { bindingFor, readBinding, sameBinding, writeBinding } from "./place.js";
import { isAdoptable, isDocumentName, isTempName, isPlainFile, MAX_BYTES, openDocument, readDocument, readOpen, Refused, writeDocument } from "./files.js";

export const DOCUMENTS = "documents";
/** As many documents as a folder lists: the store takes in no more than that. */
export const MAX_DOCUMENTS = 1000;
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
   * `faults` lets a test break a write after one of its steps:
   * `faults.after(step)` is called after "write" and after "commit".
   * `gitTimeoutMs` is how long one git run may take.
   */
  static async open(folder, { dir, inside, Database, faults, gitTimeoutMs }) {
    const store = new Store(folder, dir, inside, faults, gitTimeoutMs);
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
      throw e;
    }
    return store;
  }

  constructor(folder, dir, inside, faults, gitTimeoutMs) {
    this.folder = folder;
    this.inside = inside;
    this.faults = faults;
    this.gitTimeoutMs = gitTimeoutMs;
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
    if (!db.isFile() || (process.getuid && db.uid !== process.getuid())) throw new DocError(409, "The documents database is not the store's own");
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
    const next = this.queue.then(() => work());
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
    if (this.inside(this.folder, DOCUMENTS) !== dir) throw new DocError(409, "documents in this folder is a link");
    const folder = lstatSync(this.folder);
    try {
      mkdirSync(dir, { mode: folder.mode & 0o7777 });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    if (!lstatSync(dir).isDirectory()) throw new DocError(409, "documents in this folder is not a folder");
    chmodSync(dir, folder.mode & 0o7777);
    try {
      chownSync(dir, folder.uid, folder.gid);
    } catch {
      // The portal is not root: the folder is its own already.
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
   * as written, by document id. Returns the commit.
   */
  async commit(subject, groups, keys) {
    const parent = this.meta("head");
    const sha = await this.repo.commitEntries(parent, groups, messageFor(subject, groups));
    this.fault("commit");
    const at = new Date().toISOString();
    this.db.transaction(() => this.record(sha, groups, at, keys))();
    if (++this.commits % GC_EVERY === 0) await this.repo.gc();
    return sha;
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

  /** The documents there are, each with the start of its text (for its title). */
  list(headBytes) {
    return this.locked(async () => {
      await this.recover();
      const dir = this.documentsDir();
      if (!dir) return [];
      const out = [];
      for (const row of this.rows()) {
        if (row.revision === 0) continue;
        const opened = openDocument(this.inside, dir, row.name);
        if (!opened) continue;
        try {
          out.push({ ...this.describe(row, opened), head: readOpen(opened.fd, Math.min(headBytes, opened.size)) });
        } finally {
          closeSync(opened.fd);
        }
      }
      return out;
    });
  }

  /** One document, whole: its text as `bytes`, and the revision that text is. */
  read(id) {
    return this.locked(async () => {
      await this.recover();
      const row = this.existing(id);
      const file = this.fileOf(row);
      if (!file) throw new DocError(404, "There is no such document");
      return { ...this.describe(row, file), bytes: file.bytes };
    });
  }

  fileOf(row) {
    const dir = this.documentsDir();
    return dir ? readDocument(this.inside, dir, row.name) : null;
  }

  /**
   * A new document named after `title`, holding `markdown`: revision 1.
   * Never in place of a file: a name that is taken gets a number.
   */
  create({ title, markdown, scope = "project", chat = null, author = "user" }) {
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
        if (this.db.prepare("SELECT 1 FROM documents WHERE name = ?").get(name)) continue;
        let written;
        // The row first, without a revision: a failure after the file is written leaves a file recovery takes in under this id.
        this.db.prepare("INSERT INTO documents (id, name, scope, chat_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, name, scope, chat, now, now);
        try {
          written = writeDocument(this.inside, dir, name, bytes, { create: true });
        } catch (e) {
          this.db.prepare("DELETE FROM documents WHERE id = ?").run(id);
          // Anything in the way (a file, a link, a second name) makes the name taken: the next number is free.
          if (e instanceof Refused) continue;
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
   */
  save(id, { markdown, base, author = "user" }) {
    const bytes = Buffer.from(markdown, "utf8");
    if (bytes.length > MAX_BYTES) throw new DocError(413, "A document can be at most 1 MB");
    return this.locked(async () => {
      await this.recover();
      const row = this.existing(id);
      const file = this.fileOf(row);
      if (!file) throw new DocError(404, "There is no such document");
      if (base !== row.revision) {
        throw new DocError(409, `The document changed: it is at revision ${row.revision}, not ${base}`, { revision: row.revision, markdown: file.bytes.toString("utf8") });
      }
      if (file.bytes.equals(bytes)) return { ...this.describe(row, file), changed: false };
      return this.#write(row, bytes, { author, subject: `Save ${row.name}` });
    });
  }

  /** Writes `bytes` as the next revision of `row`'s document: file, commit, database. Under the lock, after recovery. */
  async #write(row, bytes, { author, subject, restoredFrom, create = false }) {
    const dir = create ? this.makeDocumentsDir() : this.documentsDir();
    if (!dir) throw new DocError(404, "There is no such document");
    let written;
    try {
      written = writeDocument(this.inside, dir, row.name, bytes, { create });
    } catch (e) {
      if (e instanceof Refused) throw new DocError(409, e.message === "exists" ? "Another file took the document's name" : e.message);
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
}
