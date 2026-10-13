import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { schemaFingerprint } from "./schema-fingerprint.mjs";
import { freePort, inProcessHome } from "./server-harness.mjs";

// The schema is versioned: a database below SCHEMA_VERSION is checked and backed
// up before it is changed, and one at it is not. So a change to the schema that
// is made without raising the version reaches databases unchecked and unbacked.
// This pins the schema of a fresh database beside the version it belongs to,
// and runs the upgrade from the schema before.
//
// When it fails because the schema changed: raise SCHEMA_VERSION in
// src/schema-version.ts (once for the release, not once for each change),
// pin the new version and fingerprint here, and have an upgrade test for what
// changed (below) that starts from a database made before it.
const PINNED = { version: 4, fingerprint: "efbdd8979a8d5394300b7204d1486827c1831b1a13d4956828900facc7aba461" };

const home = inProcessHome("pithagoras-schema-");

const { SCHEMA_VERSION } = await import("../dist/schema-version.js");
const { getDb } = await import("../dist/db.js");
const { upgradeCheck } = await import("../dist/db-upgrade.js");
const { backupsIn } = await import("../dist/db-upgrade-steps.js");

test("a fresh database has the schema this version pins; changing the schema means raising the version", () => {
  const fresh = getDb();
  assert.equal(fresh.pragma("user_version", { simple: true }), SCHEMA_VERSION);
  assert.equal(
    SCHEMA_VERSION,
    PINNED.version,
    `SCHEMA_VERSION is ${SCHEMA_VERSION} and the pin is for ${PINNED.version}: raise or lower both together, with the fingerprint ${schemaFingerprint(fresh)}`,
  );
  assert.equal(
    schemaFingerprint(fresh),
    PINNED.fingerprint,
    `The schema of a fresh database is not the one pinned for version ${PINNED.version}. A schema change has to raise SCHEMA_VERSION (src/schema-version.ts), ` +
      `or databases at the old version get it without the check and the backup. The fingerprint now is ${schemaFingerprint(fresh)}.`,
  );
});

test("the fingerprint tells a change of the schema from a change of how it is written", () => {
  const make = (sql) => {
    const d = new Database(":memory:");
    d.exec(sql);
    return d;
  };
  const base = schemaFingerprint(make("CREATE TABLE t (a TEXT NOT NULL DEFAULT '', b INTEGER); CREATE INDEX i ON t(a) WHERE b = 1;"));
  // Not a change: a comment, spacing, a column that was added after the others.
  assert.equal(schemaFingerprint(make("CREATE TABLE t (\n  a TEXT NOT NULL DEFAULT '', -- the name\n  b INTEGER\n);\nCREATE INDEX i ON t(a)\n  WHERE b = 1;")), base);
  const added = make("CREATE TABLE t (b INTEGER); ALTER TABLE t ADD COLUMN a TEXT NOT NULL DEFAULT ''; CREATE INDEX i ON t(a) WHERE b = 1;");
  assert.equal(schemaFingerprint(added), base);
  // A change: a column, its default, an index, the condition of a partial one.
  for (const sql of [
    "CREATE TABLE t (a TEXT NOT NULL DEFAULT '', b INTEGER, c TEXT); CREATE INDEX i ON t(a) WHERE b = 1;",
    "CREATE TABLE t (a TEXT NOT NULL DEFAULT 'x', b INTEGER); CREATE INDEX i ON t(a) WHERE b = 1;",
    "CREATE TABLE t (a TEXT NOT NULL DEFAULT '', b INTEGER);",
    "CREATE TABLE t (a TEXT NOT NULL DEFAULT '', b INTEGER); CREATE INDEX i ON t(a) WHERE b = 2;",
  ]) assert.notEqual(schemaFingerprint(make(sql)), base, sql);
});

test("the indexes that the queries of a chat's messages and of a picture's edits rely on are there", () => {
  const d = getDb();
  const plan = (sql, ...args) => d.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((r) => r.detail).join(" | ");
  assert.match(plan("SELECT seq, type, payload FROM events WHERE session_id = ? AND type = 'portal_prompt' ORDER BY seq ASC", "x"), /idx_events_prompts/);
  assert.match(plan("UPDATE images SET source_id = NULL WHERE source_id = ?", "x"), /idx_images_source/);
});

/** Runs prepareDatabase() as the server would, then reads what it can of the portal from the upgraded database. */
function startUpgrade(dataDir, port) {
  const dist = (f) => JSON.stringify(new URL(`../dist/${f}`, import.meta.url).href);
  const script = `
    const m = await import(${dist("db-upgrade.js")});
    await m.prepareDatabase();
    const db = await import(${dist("db.js")});
    const voices = await import(${dist("voice-presets.js")});
    const canvases = await import(${dist("canvases.js")});
    console.log("RESULT " + JSON.stringify({
      title: db.getSession("chat1")?.title,
      messages: db.sentMessages("chat1").map((x) => x.message),
      canvas: canvases.listCanvases("chat1").map((c) => [c.content, c.restorable]),
      voices: voices.listVoices().map((v) => v.name),
    }));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, DATA_DIR: dataDir, WORKSPACE_ROOT: path.join(dataDir, "ws"), AGENT_HOME: path.join(dataDir, "home"), PORT: String(port), PORTAL_PASSWORD: "", ALLOW_OPEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { out += c; });
  return { child, output: () => out };
}

// A database in WAL mode (bytes 18 and 19 of its header are 2) leaves a -shm and a -wal file beside it when it is only
// read, which the next `git add -A` commits. The fixtures are kept with a rollback journal; the upgrade turns WAL on itself.
test("the fixtures are kept without a write-ahead log, so that looking into one in place leaves no files beside it", () => {
  for (const name of ["portal-v2.db", "portal-v3.db", "portal-unversioned.db"]) {
    const header = readFileSync(new URL(`./fixtures/${name}`, import.meta.url)).subarray(0, 20);
    assert.deepEqual([header[18], header[19]], [1, 1], name);
  }
});

// A fixture is made on somebody's machine, and ships with the repository: nothing in it may say whose, or where.
test("the fixtures carry no folder of the machine they were made on", () => {
  for (const name of ["portal-v2.db", "portal-v3.db", "portal-unversioned.db"]) {
    const bytes = readFileSync(new URL(`./fixtures/${name}`, import.meta.url)).toString("latin1");
    assert.doesNotMatch(bytes, /\/(?:home|tmp|Users|root)\/[\w.-]/, name);
  }
});

// fixtures/portal-v2.db was made by the code of the release before this one (d2b6fcc, SCHEMA_VERSION 2): a chat with two
// messages and their answers, a stored canvas, two pictures of which one is an edit of the other, a person with notes, and a saved voice.
test("a database at the schema before this one is checked and backed up, brought to the pinned schema, and keeps what it held", async () => {
  const dir = path.join(home, "from-v2");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "portal.db");
  copyFileSync(new URL("./fixtures/portal-v2.db", import.meta.url), file);
  // Rules the release before this one let a person make for the tools that run as the primary user, which no rule opens now:
  // one for a role, one for a person, one for a heartbeat (its own), and one that is nothing of the kind.
  const before = new Database(file);
  const rule = before.prepare("INSERT INTO tool_rules (id, role, tool, pattern, note, person_key) VALUES (?, ?, ?, ?, '', ?)");
  rule.run("r1", "colleague", "subagent", "{*", null);
  rule.run("r2", "all", "routine_create", "{*", "telegram:42");
  rule.run("r3", "heartbeat", "routine_update", "{*", null);
  rule.run("r4", "colleague", "bash", "echo up-*", null);
  before.close();
  assert.deepEqual(upgradeCheck(file), { needed: true, from: 2 });

  const run = startUpgrade(dir, await freePort());
  const exited = await new Promise((resolve) => run.child.on("exit", resolve));
  assert.equal(exited, 0, run.output());
  assert.match(run.output(), new RegExp(`upgrading the database from version 2 to ${SCHEMA_VERSION}`));
  assert.match(run.output(), /database upgraded; the copy from before is /);

  // The copy from before is the database as it was.
  const backups = backupsIn(path.join(dir, "backups"));
  assert.equal(backups.length, 1);
  assert.match(path.basename(backups[0]), /^portal-v2-\d{8}-\d{6}\.db$/);
  const copy = new Database(backups[0], { readonly: true });
  assert.equal(copy.pragma("user_version", { simple: true }), 2);
  assert.ok(!copy.pragma("table_info(people)").some((c) => c.name === "renamed"));
  assert.ok(!copy.pragma("table_info(canvases)").some((c) => c.name === "previous_content"));
  assert.equal(copy.prepare("SELECT content FROM canvases").get().content, "The whole summary.");
  copy.close();

  // The upgraded one is the schema a fresh database has, and has all of its data.
  const d = new Database(file, { readonly: true });
  assert.equal(d.pragma("user_version", { simple: true }), SCHEMA_VERSION);
  assert.equal(schemaFingerprint(d), PINNED.fingerprint);
  assert.deepEqual(d.prepare("SELECT key, renamed FROM people").all(), [{ key: "telegram:42", renamed: 1 }], "a name that had notes is one somebody chose");
  assert.deepEqual(d.prepare("SELECT content, revision, previous_content FROM canvases").all(), [{ content: "The whole summary.", revision: 3, previous_content: null }]);
  assert.deepEqual(d.prepare("SELECT id, source_id FROM images ORDER BY id").all(), [{ id: "img1", source_id: null }, { id: "img2", source_id: "img1" }]);
  assert.equal(d.prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = 'chat1'").get().n, 4);
  assert.equal(d.prepare("SELECT COUNT(*) AS n FROM voice_presets").get().n, 1);
  assert.deepEqual(d.prepare("SELECT id FROM tool_rules ORDER BY id").all(), [{ id: "r3" }, { id: "r4" }], "what never applies is not left listed as a rule that does");
  assert.deepEqual(d.prepare("SELECT id, home FROM agents").all(), [{ id: "home", home: "/data/home" }], "the agent's folder is a neutral one");
  d.close();

  // And the portal reads it.
  const result = JSON.parse(/RESULT (.*)/.exec(run.output())[1]);
  assert.deepEqual(result, { title: "A chat from the 2026-10-02 build", messages: ["Write the summary", "Shorter, please"], canvas: [["The whole summary.", false]], voices: ["Calm"] });
  assert.ok(!readdirSync(dir).some((f) => f.endsWith(".partial")));
  assert.equal(existsSync(path.join(dir, "backups")), true);
});

/** Runs prepareDatabase() as the server would, then reads what each routine of fixtures/portal-v3.db says about tools. */
function startToolsUpgrade(dataDir, port) {
  const dist = (f) => JSON.stringify(new URL(`../dist/${f}`, import.meta.url).href);
  const script = `
    const m = await import(${dist("db-upgrade.js")});
    await m.prepareDatabase();
    const db = await import(${dist("db.js")});
    // The browser's tools, as a chat would have reported them.
    db.rememberTools([{ name: "browser_navigate", source: "browser", package: null }, { name: "bash", source: "built in", package: null }]);
    console.log("RESULT " + JSON.stringify({
      news: db.routineTools("news"),
      tidy: db.routineTools("tidy"),
      project: db.projectTools("research"),
      defaults: db.toolDefaultsOff(),
      agentTools: db.getDb().prepare("SELECT COUNT(*) AS n FROM agent_tools").get().n,
      // The agent a project works with (#127): a project of v0.1.0 has none, and keeps Understory.
      projectAgent: db.projectAgent("research"),
      projectAgents: db.getDb().prepare("SELECT COUNT(*) AS n FROM project_agent").get().n,
    }));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, DATA_DIR: dataDir, WORKSPACE_ROOT: path.join(dataDir, "ws"), AGENT_HOME: path.join(dataDir, "home"), PORT: String(port), PORTAL_PASSWORD: "", ALLOW_OPEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { out += c; });
  return { child, output: () => out };
}

// fixtures/portal-v3.db was made by the code of v0.1.0 (SCHEMA_VERSION 3): a routine with its Browser switch on (news), one
// with it off in a project (tidy), a project that switches bash off, and web_search off by default. Version 4 gives routines
// tool switches of their own and agents a table of them (#81), projects a table of the agent they work with (#127), and the Media page a table of clips (#79).
test("a database of v0.1.0 is brought to the pinned schema, and each routine keeps the browser it had", async () => {
  const dir = path.join(home, "from-v3");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "portal.db");
  copyFileSync(new URL("./fixtures/portal-v3.db", import.meta.url), file);
  assert.deepEqual(upgradeCheck(file), { needed: true, from: 3 });

  const run = startToolsUpgrade(dir, await freePort());
  const exited = await new Promise((resolve) => run.child.on("exit", resolve));
  assert.equal(exited, 0, run.output());
  assert.match(run.output(), new RegExp(`upgrading the database from version 3 to ${SCHEMA_VERSION}`));
  assert.equal(backupsIn(path.join(dir, "backups")).length, 1);

  const d = new Database(file, { readonly: true });
  assert.equal(schemaFingerprint(d), PINNED.fingerprint);
  assert.equal(d.prepare("SELECT COUNT(*) AS n FROM videos").get().n, 0, "the Media page's table is there, and empty");
  d.close();

  const result = JSON.parse(/RESULT (.*)/.exec(run.output())[1]);
  assert.deepEqual(result.news, { off: [], on: ["browser_navigate"] }, "Browser on stays on");
  assert.deepEqual(result.tidy, { off: ["browser_navigate"], on: [] }, "Browser off stays off");
  assert.deepEqual(result.project, { off: ["bash"], on: [] });
  // And code mode, which an upgrade switches off by default beside what the operator had.
  assert.deepEqual(result.defaults, ["codemode", "web_search"]);
  assert.equal(result.agentTools, 0, "no agent says anything yet");
  assert.deepEqual(result.projectAgent, { agent: "", understoryOff: false }, "a project of v0.1.0 is a blank slate, as it was");
  assert.equal(result.projectAgents, 0);
});
