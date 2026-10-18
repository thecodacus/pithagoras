import assert from "node:assert/strict";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { inProcessHome } from "./server-harness.mjs";

/**
 * The SQLite a server half is given (`portal.sqlite`): the driver the portal's own database runs on, so that a package
 * that keeps a database brings none, and its files are SQLite's own.
 */
const home = inProcessHome("extension-sqlite-");
const pkg = path.join(home, "packages", "notes");
mkdirSync(pkg, { recursive: true });
const NAME = "pithagoras-notes";
const file = path.join(pkg, "server.js");
writeFileSync(file, "export default async function (portal) { globalThis.notes = portal; }\n");
const stat = statSync(file);

const host = await import("../dist/extension-host.js");
await host.syncServerHalves([{ name: NAME, version: "1.0.0", file, rev: `${stat.mtimeMs}-1` }]);
test.after(() => host.stopServerHalves());

test("a server half is given the portal's own SQLite driver, and the files it makes are anyone's SQLite", async () => {
  const { sqlite, dataDir } = globalThis.notes;
  const { default: Database } = await import("better-sqlite3");
  assert.equal(sqlite, Database, "the portal's driver, not another copy of it");
  const where = path.join(dataDir(), "notes.db");
  const db = new sqlite(where);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL)");
  const add = db.transaction((texts) => texts.map((text) => Number(db.prepare("INSERT INTO notes (text) VALUES (?)").run(text).lastInsertRowid)));
  assert.deepEqual(add(["one", "two"]), [1, 2]);
  assert.throws(() => add(["three", null]), /NOT NULL/);
  assert.deepEqual(db.prepare("SELECT text FROM notes ORDER BY id").pluck().all(), ["one", "two"], "a transaction that throws is undone");
  db.close();
  // Another connection, read only, as a package opens a file it only looks at.
  const looking = new sqlite(where, { readonly: true, fileMustExist: true });
  assert.equal(looking.pragma("journal_mode", { simple: true }), "wal");
  assert.equal(looking.prepare("SELECT count(*) FROM notes").pluck().get(), 2);
  looking.close();
  assert.throws(() => new sqlite(path.join(dataDir(), "none.db"), { fileMustExist: true }), /unable to open|does not exist/);
});
