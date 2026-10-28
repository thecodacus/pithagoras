import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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
const PINNED = { version: 16, fingerprint: "ba52cad83d268b2700843d8970a6f880eaa924ae3076b3ab66414b2af22eeb1a" };
/** The schema of version 15, the one pinned before: no chat is one nobody attends, and every child takes its parent's tools. */
const V15_FINGERPRINT = "830934df6dce1dd977d16b086c0bbe883bfc18a3463f84e9f22f31efa43fc0cd";
/** The schema of version 14: no index on the questions a chat asked. */
const V14_FINGERPRINT = "7a7fcf8359ff86a38fcb9060888fa9ed7816b18bb9cfb2d9da454a893c015bda";
/** The schema of version 13, which version 14 kept: it only left what each chat said its subagents run on for the subagent extension. */
const V13_FINGERPRINT = "7a7fcf8359ff86a38fcb9060888fa9ed7816b18bb9cfb2d9da454a893c015bda";
/** The schema of version 12: no chat is a child of another. */
const V12_FINGERPRINT = "d118d40ea237b90e58c0ef97d6f1cdcb5e876ed739c3e2bbc6684f74a8aa653a";
/** The schema of version 11, which version 12 kept: it only left the subagent's settings for its extension. */
const V11_FINGERPRINT = "d118d40ea237b90e58c0ef97d6f1cdcb5e876ed739c3e2bbc6684f74a8aa653a";
/** The schema of version 10, the one pinned before: chats with no mode, and no table of the modes the person made. */
const V10_FINGERPRINT = "155cf58f87a19f0a102c8475bdceee87a98d9169c400d887a37411107f0a5ccf";
/** The schema of version 9: a project's switch for the agent's memory named for Understory. */
const V9_FINGERPRINT = "656225d48b5a69bf29eefe05e4e51928df1e1a8f7baab4c60dd40723978dd419";

const home = inProcessHome("pithagoras-schema-");

const { SCHEMA_VERSION } = await import("../dist/schema-version.js");
const { getDb } = await import("../dist/db.js");

/** A database of the schema of version 15 at `file`, open: a fresh one, whose chats are all attended and whose children take their parents' tools. */
function freshAt15(file) {
  getDb().exec(`VACUUM INTO '${file}'`);
  const d = new Database(file);
  d.exec("ALTER TABLE sessions DROP COLUMN unattended; ALTER TABLE sessions DROP COLUMN tools_from;");
  return d;
}

/** A database of the schema of version 13 (which 14 kept) at `file`, open: one of version 15, with no index on the questions a chat asked. */
function freshAt13(file) {
  const d = freshAt15(file);
  d.exec("DROP INDEX idx_events_questions");
  return d;
}

/** A database of the schema of version 12 at `file`, open: one of version 13, whose chats have no parent, listing or maker. */
function freshAt12(file) {
  const d = freshAt13(file);
  d.exec("DROP INDEX idx_sessions_parent; ALTER TABLE sessions DROP COLUMN parent_id; ALTER TABLE sessions DROP COLUMN listed; ALTER TABLE sessions DROP COLUMN creator;");
  return d;
}

/** A database of the schema of version 10 at `file`, open: one of version 11 (whose schema 12 kept), with no mode on a chat and no table of the person's modes. */
function freshAt10(file) {
  const d = freshAt12(file);
  d.exec("ALTER TABLE sessions DROP COLUMN mode; DROP TABLE chat_modes;");
  return d;
}

/** A database of the schema of version 9 at `file`, open: one of version 10, with the project's switch for the agent's memory named for Understory. */
function freshAt9(file) {
  const d = freshAt10(file);
  d.exec("ALTER TABLE project_agent RENAME COLUMN memory_off TO understory_off");
  return d;
}
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

test("the indexes that the queries of a chat's messages rely on are there", () => {
  const d = getDb();
  const plan = (sql, ...args) => d.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((r) => r.detail).join(" | ");
  assert.match(plan("SELECT seq, type, payload FROM events WHERE session_id = ? AND type = 'portal_prompt' ORDER BY seq ASC", "x"), /idx_events_prompts/);
});

/** Runs prepareDatabase() as the server would, then reads what it can of the portal from the upgraded database. */
function startUpgrade(dataDir, port) {
  const dist = (f) => JSON.stringify(new URL(`../dist/${f}`, import.meta.url).href);
  const script = `
    const m = await import(${dist("db-upgrade.js")});
    await m.prepareDatabase();
    const db = await import(${dist("db.js")});
    console.log("RESULT " + JSON.stringify({
      title: db.getSession("chat1")?.title,
      messages: db.sentMessages("chat1").map((x) => x.message),
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
  // one for a role, one for a person, one for a heartbeat, and one that is nothing of the kind.
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
  // Canvases are an extension's now: the one it had is a Markdown file. Its chat's folder (/work/example) is not on this
  // machine, so it is in the data folder, beside the backup.
  assert.ok(!d.prepare("SELECT 1 FROM sqlite_master WHERE name = 'canvases'").get(), "the table is gone");
  assert.equal(readFileSync(path.join(dir, "canvases", "Summary.md"), "utf8"), "The whole summary.");
  assert.match(run.output(), /a stored canvas is now a Markdown file: .*canvases\/Summary\.md/);
  // Pictures are an extension's now: the two it had are left for it, an edit still named after its picture, and the table is gone.
  // Their chat's folder is not on this machine either.
  assert.ok(!d.prepare("SELECT 1 FROM sqlite_master WHERE name = 'images'").get(), "the table is gone");
  const left = (file) => JSON.parse(readFileSync(path.join(dir, "handoff", "media", file), "utf8"));
  assert.deepEqual(left("images.json").rows.map(({ id, source_id, chat }) => ({ id, source_id, chat })).sort((a, b) => (a.id < b.id ? -1 : 1)), [
    { id: "img1", source_id: null, chat: { workspace: "/work/example", real: null } },
    { id: "img2", source_id: "img1", chat: { workspace: "/work/example", real: null } },
  ]);
  assert.deepEqual(left("videos.json"), { rows: [] }, "a portal of then had no clips");
  assert.deepEqual(left("settings.json"), { image_generation: null, video_generation: null });
  assert.equal(d.prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = 'chat1'").get().n, 4);
  // The saved voice is left for Voice, with nothing else of voice mode, as there was none, and the table is gone.
  assert.ok(!d.prepare("SELECT 1 FROM sqlite_master WHERE name = 'voice_presets'").get(), "the table is gone");
  const voiceLeft = (file) => JSON.parse(readFileSync(path.join(dir, "handoff", "voice-service", file), "utf8"));
  assert.deepEqual(voiceLeft("voices.json").map(({ id, name, kind, audio }) => ({ id, name, kind, audio })), [
    { id: "voice-d36b934e-af12-462f-841c-5fad27aa6c39", name: "Calm", kind: "design", audio: null },
  ]);
  assert.deepEqual(Object.values(voiceLeft("settings.json")), Array(10).fill(null));
  assert.equal(existsSync(path.join(dir, "handoff", "voice-addresses")), false);
  assert.deepEqual(d.prepare("SELECT id FROM tool_rules ORDER BY id").all(), [{ id: "r4" }], "what never applies is not left listed as a rule that does");
  assert.deepEqual(d.prepare("SELECT id, home FROM agents").all(), [{ id: "home", home: "/data/home" }], "the agent's folder is a neutral one");
  d.close();

  // And the portal reads it.
  const result = JSON.parse(/RESULT (.*)/.exec(run.output())[1]);
  assert.deepEqual(result, { title: "A chat from the 2026-10-02 build", messages: ["Write the summary", "Shorter, please"] });
  assert.ok(!readdirSync(dir).some((f) => f.endsWith(".partial")));
  assert.equal(existsSync(path.join(dir, "backups")), true);
});

/** The tools the portal's browser registered, which the Browser extension registers under the same names, sorted. */
const BROWSER_TOOLS = ["browser_back", "browser_click", "browser_find", "browser_get_text", "browser_key", "browser_navigate", "browser_screenshot", "browser_scroll", "browser_select", "browser_snapshot", "browser_type"];

/** Runs prepareDatabase() as the server would, then reads what each routine of fixtures/portal-v3.db says about tools. */
function startToolsUpgrade(dataDir, port) {
  const dist = (f) => JSON.stringify(new URL(`../dist/${f}`, import.meta.url).href);
  const script = `
    const m = await import(${dist("db-upgrade.js")});
    await m.prepareDatabase();
    const db = await import(${dist("db.js")});
    console.log("RESULT " + JSON.stringify({
      news: db.routineTools("news"),
      tidy: db.routineTools("tidy"),
      project: db.projectTools("research"),
      defaults: db.toolDefaultsOff(),
      agentTools: db.getDb().prepare("SELECT COUNT(*) AS n FROM agent_tools").get().n,
      // The agent a project works with (#127): a project of v0.1.0 has none, and keeps the agent's memory.
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
// tool switches of their own and agents a table of them (#81), and projects a table of the agent they work with (#127);
// version 8 writes the Browser switch into the routine's tools, for the browser's tools, which an extension brings now.
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
  d.close();

  const result = JSON.parse(/RESULT (.*)/.exec(run.output())[1]);
  assert.deepEqual(result.news, { off: [], on: BROWSER_TOOLS }, "Browser on stays on");
  assert.deepEqual(result.tidy, { off: BROWSER_TOOLS, on: [] }, "Browser off stays off");
  assert.deepEqual(result.project, { off: ["bash"], on: [] });
  // And code mode, which an upgrade switches off by default beside what the operator had.
  assert.deepEqual(result.defaults, ["codemode", "web_search"]);
  assert.equal(result.agentTools, 0, "no agent says anything yet");
  assert.deepEqual(result.projectAgent, { agent: "", memoryOff: false }, "a project of v0.1.0 is a blank slate, as it was");
  assert.equal(result.projectAgents, 0);
});

// Canvases are an extension's from version 5 (extensions/canvas), with a store of its own. Two canvases of a chat stored
// in a database of v0.1.0, with the same title, and one of a chat whose folder is gone: each becomes a Markdown file,
// in its chat's folder where there is one, and the table goes. The canvas tools' set marked lazy and given a name: both
// go to the set the extension's tools are filed in.
test("the canvases a portal stored are written out as Markdown in their chat's folder, and the table goes", async () => {
  const dir = path.join(home, "canvases-out");
  const folder = path.join(dir, "ws", "site");
  mkdirSync(folder, { recursive: true });
  const file = path.join(dir, "portal.db");
  copyFileSync(new URL("./fixtures/portal-v3.db", import.meta.url), file);
  const before = new Database(file);
  const chat = before.prepare("INSERT INTO sessions (id, title, workspace, kind) VALUES (?, ?, ?, 'task')");
  chat.run("c1", "Plans", folder);
  chat.run("c2", "Moved away", path.join(dir, "ws", "gone"));
  const canvas = before.prepare("INSERT INTO canvases (id, session_id, title, content, revision, status, updated_at) VALUES (?, ?, ?, ?, 1, 'saved', '2026-10-10T10:00:00Z')");
  canvas.run("k1", "c1", "Launch plan", "# Launch\n\nFirst draft.");
  canvas.run("k2", "c1", "Launch plan", "Second draft.");
  canvas.run("k3", "c2", "Notes/2026: draft?", "Kept anyway.");
  const setting = before.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  setting.run("tools_lazy", "<tool>web_fetch\ncanvases");
  setting.run("tool_group_names", JSON.stringify({ canvases: "Documents", "pi-web": "Web" }));
  before.close();

  const run = startUpgrade(dir, await freePort());
  const exited = await new Promise((resolve) => run.child.on("exit", resolve));
  assert.equal(exited, 0, run.output());

  const d = new Database(file, { readonly: true });
  assert.ok(!d.prepare("SELECT 1 FROM sqlite_master WHERE name = 'canvases'").get(), run.output());
  assert.equal(schemaFingerprint(d), PINNED.fingerprint);
  const value = (key) => d.prepare("SELECT value FROM settings WHERE key = ?").get(key).value;
  assert.equal(value("tools_lazy"), "<tool>web_fetch\npithagoras-canvas");
  assert.deepEqual(JSON.parse(value("tool_group_names")), { "pi-web": "Web", "pithagoras-canvas": "Documents" });
  d.close();
  // In the chat's folder, a taken name numbered as an upload's is; nothing over anything.
  assert.deepEqual(readdirSync(path.join(folder, "canvases")).sort(), ["Launch plan (2).md", "Launch plan.md"]);
  assert.deepEqual(
    readdirSync(path.join(folder, "canvases")).map((f) => readFileSync(path.join(folder, "canvases", f), "utf8")).sort(),
    ["# Launch\n\nFirst draft.", "Second draft."],
  );
  // A chat whose folder is gone: in the data folder, its name made one a file can have.
  assert.equal(readFileSync(path.join(dir, "canvases", "Notes_2026_ draft_.md"), "utf8"), "Kept anyway.");
});

// Versions 7 and 8 had the schema of version 9 with the table of saved voices, which version 9 hands to Voice (see the
// voice cases below): made here from one of version 9, and checked to be that by the fingerprint they were pinned with.
const V8_FINGERPRINT = "409b5243d409e83047250a4c34dea217699b16f8e7ab13e861396938f3bf78ee";
const V8_VOICE_PRESETS = `
  CREATE TABLE voice_presets (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, instruction TEXT NOT NULL, transcript TEXT NOT NULL, audio BLOB);
`;
/** A database of the schema of versions 7 and 8 at `file`, open, of the version it says it is at. */
function freshAt8(file) {
  const d = freshAt9(file);
  d.exec(V8_VOICE_PRESETS);
  return d;
}

// Pictures and videos are an extension's from version 7 (extensions/media), with a store of its own. A database of version 6
// is the schema of version 8 with the two tables of the Media page: made here, and checked to be that by the fingerprint
// version 6 was pinned with.
const V6_FINGERPRINT = "06e47b6fe66c1c572ae81987761da0aad10656b2f72825fdff93f74f342ed6cc";
const V6_MEDIA = `
  CREATE TABLE images (id TEXT PRIMARY KEY, origin TEXT NOT NULL, session_id TEXT, folder TEXT, path TEXT NOT NULL, kind TEXT NOT NULL, prompt TEXT NOT NULL DEFAULT '', params TEXT NOT NULL DEFAULT '{}', source_id TEXT, bytes INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_images_created ON images(created_at DESC, id DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_images_chat_file ON images(session_id, path) WHERE session_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_images_folder_file ON images(folder, path) WHERE folder IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_images_source ON images(source_id) WHERE source_id IS NOT NULL;
  CREATE TABLE videos (id TEXT PRIMARY KEY, origin TEXT NOT NULL, session_id TEXT, folder TEXT, path TEXT NOT NULL, kind TEXT NOT NULL, prompt TEXT NOT NULL DEFAULT '', params TEXT NOT NULL DEFAULT '{}', bytes INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_videos_created ON videos(created_at DESC, id DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_videos_chat_file ON videos(session_id, path) WHERE session_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_videos_folder_file ON videos(folder, path) WHERE folder IS NOT NULL;
`;
const IMAGE_COLUMNS = ["id", "origin", "session_id", "folder", "path", "kind", "prompt", "params", "source_id", "bytes", "created_at"];
const VIDEO_COLUMNS = IMAGE_COLUMNS.filter((column) => column !== "source_id");
const IMAGE_SETTINGS = JSON.stringify({ enabled: true, baseUrl: "http://127.0.0.1:9/v1", model: "flux", size: "1024x1024", apiKey: "sk-images", editEnabled: false });
const VIDEO_SETTINGS = JSON.stringify({ enabled: true, backend: "sdcpp", baseUrl: "http://127.0.0.1:9", model: "wan", apiKey: "sk-videos", storageLimitMb: 0 });
/** The five tools as a chat of version 6 reported them, each under a name of its own, and a tool of another extension. */
const SEEN = [
  { name: "show_image", source: "pictures", package: null, inline: true },
  { name: "generate_image", source: "image-generation", package: null, inline: true },
  { name: "edit_image", source: "image-editing", package: null, inline: true },
  { name: "generate_video", source: "video-generation", package: null, inline: true },
  { name: "show_video", source: "videos", package: null, inline: true },
  { name: "web_fetch", source: "pi-web-access", package: "npm:pi-web-access", inline: false },
];
const ATTACHED = path.join("images", "c1", "3f2b8c1e-0a4d-4e6f-9b7a-1c2d3e4f5a6b.png");

/**
 * A data folder as version 6 left it, with what the Media page kept: its rows (the page's own pictures and a clip, an
 * edit named after its picture, a picture whose file is gone, the agent's in a chat whose folder is there, in one whose
 * folder is gone and in one that was deleted, one found in a folder), its two settings, its tools' set marked lazy and
 * given a name, and its files beside the database, among them a picture a chat sent with a message, which is the chat's.
 */
function mediaOfV6(dir) {
  const site = path.join(dir, "ws", "site");
  mkdirSync(site, { recursive: true });
  const d = freshAt8(path.join(dir, "portal.db"));
  d.exec(V6_MEDIA);
  d.pragma("user_version = 6");
  assert.equal(schemaFingerprint(d), V6_FINGERPRINT, "the schema of version 6");
  const chat = d.prepare("INSERT INTO sessions (id, title, workspace, kind) VALUES (?, ?, ?, 'task')");
  chat.run("c1", "Kites", site);
  chat.run("c2", "Moved away", path.join(dir, "ws", "gone"));
  const images = [
    ["aaaaaaaaaaa1", "page", null, null, "aaaaaaaaaaa1.png", "generated", "a red kite", '{"model":"flux","size":"512x512"}', null, 14, 1000],
    ["aaaaaaaaaaa2", "page", null, null, "aaaaaaaaaaa2 (2).webp", "edited", "the kite, blue", '{"sources":["aaaaaaaaaaa1"]}', "aaaaaaaaaaa1", 14, 2000],
    ["aaaaaaaaaaa3", "page", null, null, "aaaaaaaaaaa3.png", "uploaded", "lost.png", "{}", null, 14, 3000],
    ["aaaaaaaaaaa4", "chat", "c1", null, "generated-images/kite.png", "generated", "a kite in the chat", "{}", null, 14, 4000],
    ["aaaaaaaaaaa5", "chat", "c2", null, "generated-images/gone.png", "generated", "in a folder that went", "{}", null, 14, 5000],
    ["aaaaaaaaaaa6", "chat", "deleted", null, "generated-images/old.png", "generated", "of a chat that is gone", "{}", null, 14, 6000],
    ["aaaaaaaaaaa7", "folder", null, realpathSync(site), "generated-images/found.png", "unknown", "", "{}", null, 14, 7000],
  ];
  const videos = [
    ["bbbbbbbbbbb1", "page", null, null, "bbbbbbbbbbb1.webm", "animated", "the kite flies", '{"firstFrame":{"picture":"aaaaaaaaaaa1"}}', 9, 8000],
    ["bbbbbbbbbbb2", "chat", "c1", null, "generated-videos/kite.mp4", "generated", "a clip in the chat", "{}", 9, 9000],
  ];
  for (const row of images) d.prepare(`INSERT INTO images (${IMAGE_COLUMNS}) VALUES (${IMAGE_COLUMNS.map(() => "?")})`).run(row);
  for (const row of videos) d.prepare(`INSERT INTO videos (${VIDEO_COLUMNS}) VALUES (${VIDEO_COLUMNS.map(() => "?")})`).run(row);
  const setting = d.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  setting.run("image_generation", IMAGE_SETTINGS);
  setting.run("video_generation", VIDEO_SETTINGS);
  setting.run("tools_lazy", "<portal:media>\n<tool>web_fetch");
  setting.run("tool_group_names", JSON.stringify({ "<portal:media>": "Pictures", "pi-web-access": "Web" }));
  setting.run("tools_seen", JSON.stringify(SEEN));
  d.close();

  const put = (name, text) => {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  };
  put("images/aaaaaaaaaaa1.png", "the page's kite");
  put("images/aaaaaaaaaaa2 (2).webp", "the page's blue kite");
  put(ATTACHED, "sent with a message");
  put("videos/bbbbbbbbbbb1.webm", "the page's clip");
  put("image-thumbs/aaaaaaaaaaa1-f-18f.webp", "a thumbnail");
  put("video-posters/bbbbbbbbbbb1-f-18f.webp", "a poster");
  put("video-copies/bbbbbbbbbbb1-f-18f.webm", "a playable copy");
  // The time a file was made is in the names of what was made of it: it is kept.
  utimesSync(path.join(dir, "images", "aaaaaaaaaaa1.png"), new Date("2026-10-01T10:00:00Z"), new Date("2026-10-01T10:00:00Z"));
  const exported = (columns, values) => {
    const row = Object.fromEntries(columns.map((column, i) => [column, values[i]]));
    const chat = { c1: { workspace: site, real: realpathSync(site) }, c2: { workspace: path.join(dir, "ws", "gone"), real: null } }[row.session_id] ?? null;
    return { ...row, chat };
  };
  return { images: images.map((row) => exported(IMAGE_COLUMNS, row)), videos: videos.map((row) => exported(VIDEO_COLUMNS, row)) };
}

/** Starts the portal on the data folder, as an upgrade does, and gives what it said. */
async function upgraded(dir) {
  const run = startUpgrade(dir, await freePort());
  const exited = await new Promise((resolve) => run.child.on("exit", resolve));
  assert.equal(exited, 0, run.output());
  return run.output();
}

const byId = (rows) => [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
const modeOf = (file) => statSync(file).mode & 0o777;

test("what the Media page kept is left for its extension, its files moved and the chats' own pictures kept, and its tables and settings go", async () => {
  const dir = path.join(home, "media-out");
  mkdirSync(dir, { recursive: true });
  const kept = mediaOfV6(dir);
  assert.deepEqual(upgradeCheck(path.join(dir, "portal.db")), { needed: true, from: 6 });
  assert.match(await upgraded(dir), new RegExp(`upgrading the database from version 6 to ${SCHEMA_VERSION}`));

  // The copy from before has it all, as it was.
  const backups = backupsIn(path.join(dir, "backups"));
  assert.match(path.basename(backups[0]), /^portal-v6-\d{8}-\d{6}\.db$/);
  const copy = new Database(backups[0], { readonly: true });
  assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM images").get().n, 7);
  copy.close();

  const d = new Database(path.join(dir, "portal.db"), { readonly: true });
  assert.equal(schemaFingerprint(d), PINNED.fingerprint);
  assert.ok(!d.prepare("SELECT 1 FROM sqlite_master WHERE name IN ('images', 'videos')").get(), "the tables are gone");
  const value = (key) => d.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value;
  assert.equal(value("image_generation"), undefined);
  assert.equal(value("video_generation"), undefined);
  // The set the tools were filed in is the extension's package now, its name and lazy mark with it; and so is each as the lists remember it.
  assert.equal(value("tools_lazy"), "<tool>web_fetch\npithagoras-media");
  assert.deepEqual(JSON.parse(value("tool_group_names")), { "pi-web-access": "Web", "pithagoras-media": "Pictures" });
  assert.deepEqual(JSON.parse(value("tools_seen")), SEEN.map((tool) => (tool.name === "web_fetch" ? tool : { ...tool, source: "pithagoras-media" })));
  // Whenever the extension first starts, it is told of every folder deleted from the upgrade on, for what it takes up of one to go too.
  assert.deepEqual(JSON.parse(value("folders_told")), { "pithagoras-media": 0 });
  d.close();

  // Left whole, closed to all but the portal.
  const left = path.join(dir, "handoff", "media");
  assert.deepEqual(readdirSync(path.join(dir, "handoff")), ["media"], "nothing half done beside it");
  assert.equal(modeOf(path.join(dir, "handoff")), 0o700);
  assert.equal(modeOf(left), 0o700);
  assert.deepEqual(readdirSync(left).sort(), ["cache", "files", "handoff.json", "images.json", "settings.json", "videos.json"]);
  for (const json of ["handoff.json", "images.json", "settings.json", "videos.json"]) assert.equal(modeOf(path.join(left, json)), 0o600, json);
  const read = (file) => JSON.parse(readFileSync(path.join(left, file), "utf8"));
  const { made, ...about } = read("handoff.json");
  assert.deepEqual(about, { format: 1, name: "media", schema: 7 });
  assert.ok(Number.isFinite(Date.parse(made)));
  assert.deepEqual(read("settings.json"), { image_generation: IMAGE_SETTINGS, video_generation: VIDEO_SETTINGS }, "as they were stored");
  // Every row as it was, with the folder of its chat as it was then: the real one where it was there.
  assert.deepEqual(byId(read("images.json").rows), kept.images);
  assert.deepEqual(byId(read("videos.json").rows), kept.videos);

  // The page's own files, moved, with their times; one that was gone is gone, and its row is left all the same.
  const moved = (rel) => readFileSync(path.join(left, rel), "utf8");
  assert.equal(moved("files/images/aaaaaaaaaaa1.png"), "the page's kite");
  assert.equal(moved("files/images/aaaaaaaaaaa2 (2).webp"), "the page's blue kite");
  assert.deepEqual(readdirSync(path.join(left, "files", "images")).sort(), ["aaaaaaaaaaa1.png", "aaaaaaaaaaa2 (2).webp"]);
  assert.equal(statSync(path.join(left, "files", "images", "aaaaaaaaaaa1.png")).mtime.toISOString(), "2026-10-01T10:00:00.000Z");
  assert.equal(moved("files/videos/bbbbbbbbbbb1.webm"), "the page's clip");
  assert.equal(moved("cache/image-thumbs/aaaaaaaaaaa1-f-18f.webp"), "a thumbnail");
  assert.equal(moved("cache/video-posters/bbbbbbbbbbb1-f-18f.webp"), "a poster");
  assert.equal(moved("cache/video-copies/bbbbbbbbbbb1-f-18f.webm"), "a playable copy");
  for (const gone of ["videos", "image-thumbs", "video-posters", "video-copies"]) assert.equal(existsSync(path.join(dir, gone)), false, gone);
  // The pictures a chat sent with its messages are the chat's, and stay where they were.
  assert.deepEqual(readdirSync(path.join(dir, "images")), ["c1"]);
  assert.equal(readFileSync(path.join(dir, ATTACHED), "utf8"), "sent with a message");
});

test("an upgrade that stopped half way through leaving what the Media page kept goes on from where it was", async () => {
  const dir = path.join(home, "media-again");
  mkdirSync(dir, { recursive: true });
  const kept = mediaOfV6(dir);
  // A try before moved one picture into the folder it was filling and wrote a list, and its database rolled back.
  const filling = path.join(dir, "handoff", ".media.partial");
  mkdirSync(path.join(filling, "files", "images"), { recursive: true });
  writeFileSync(path.join(filling, "files", "images", "aaaaaaaaaaa1.png"), "the page's kite");
  rmSync(path.join(dir, "images", "aaaaaaaaaaa1.png"));
  writeFileSync(path.join(filling, "images.json"), JSON.stringify({ rows: [] }));
  await upgraded(dir);

  const left = path.join(dir, "handoff", "media");
  assert.deepEqual(readdirSync(path.join(dir, "handoff")), ["media"]);
  assert.deepEqual(readdirSync(path.join(left, "files", "images")).sort(), ["aaaaaaaaaaa1.png", "aaaaaaaaaaa2 (2).webp"]);
  assert.equal(readFileSync(path.join(left, "files", "videos", "bbbbbbbbbbb1.webm"), "utf8"), "the page's clip");
  assert.deepEqual(byId(JSON.parse(readFileSync(path.join(left, "images.json"), "utf8")).rows), kept.images, "the list is written anew");
  assert.deepEqual(readdirSync(path.join(dir, "images")), ["c1"]);
  const d = new Database(path.join(dir, "portal.db"), { readonly: true });
  assert.equal(schemaFingerprint(d), PINNED.fingerprint);
  d.close();
});

test("an upgrade whose database rolled back after it left what the Media page kept does not leave it again, and drops the tables", async () => {
  const dir = path.join(home, "media-left");
  mkdirSync(dir, { recursive: true });
  mediaOfV6(dir);
  // What that try left, whole: its files were moved into it.
  const left = path.join(dir, "handoff", "media");
  mkdirSync(left, { recursive: true });
  const about = JSON.stringify({ format: 1, name: "media", schema: 7, made: "2026-10-19T08:00:00.000Z" });
  writeFileSync(path.join(left, "handoff.json"), about);
  // And a tool of the same name an extension brought, under the very name the portal's was filed under (a loose
  // extension file of that name), which a chat reported since as not inline: it stays the extension's. One the lists
  // remember from before they said whether a tool is inline is the portal's.
  const before = new Database(path.join(dir, "portal.db"));
  const theirs = { name: "generate_image", source: "image-generation", package: null, inline: false };
  const unsaid = ({ inline, ...tool }) => tool;
  before.prepare("UPDATE settings SET value = ? WHERE key = 'tools_seen'").run(JSON.stringify(SEEN.map((tool) => (tool.name === theirs.name ? theirs : tool.name === "edit_image" ? unsaid(tool) : tool))));
  before.close();
  await upgraded(dir);

  assert.equal(readFileSync(path.join(left, "handoff.json"), "utf8"), about, "not filled again");
  assert.equal(readFileSync(path.join(dir, "images", "aaaaaaaaaaa1.png"), "utf8"), "the page's kite", "what is not in it stays where it is");
  const d = new Database(path.join(dir, "portal.db"), { readonly: true });
  assert.equal(schemaFingerprint(d), PINNED.fingerprint);
  assert.equal(d.prepare("SELECT value FROM settings WHERE key = 'image_generation'").get(), undefined);
  assert.equal(d.prepare("SELECT value FROM settings WHERE key = 'tools_lazy'").get().value, "<tool>web_fetch\npithagoras-media");
  const seen = JSON.parse(d.prepare("SELECT value FROM settings WHERE key = 'tools_seen'").get().value);
  assert.deepEqual(seen.find((tool) => tool.name === "generate_image"), theirs);
  assert.deepEqual(seen.find((tool) => tool.name === "show_image"), { name: "show_image", source: "pithagoras-media", package: null, inline: true });
  assert.deepEqual(seen.find((tool) => tool.name === "edit_image"), { name: "edit_image", source: "pithagoras-media", package: null, inline: true });
  d.close();
});

test("the Media page's clips in a folder that is a link to one elsewhere are left for its extension, and the link stays", async () => {
  const dir = path.join(home, "media-linked");
  mkdirSync(dir, { recursive: true });
  mediaOfV6(dir);
  // videos/ is a link, relative, to a folder beside the data folder: moved as it is, it would lead nowhere.
  const elsewhere = path.join(home, "media-linked-clips");
  renameSync(path.join(dir, "videos"), elsewhere);
  symlinkSync(path.relative(dir, elsewhere), path.join(dir, "videos"));
  await upgraded(dir);

  const clips = path.join(dir, "handoff", "media", "files", "videos");
  assert.equal(lstatSync(clips).isDirectory(), true, "a folder, not a link");
  assert.equal(readFileSync(path.join(clips, "bbbbbbbbbbb1.webm"), "utf8"), "the page's clip");
  assert.equal(lstatSync(path.join(dir, "videos")).isSymbolicLink(), true);
  assert.deepEqual(readdirSync(elsewhere), []);
});

test("what the Media page kept that cannot be left is kept for the next start, which leaves it", async () => {
  const dir = path.join(home, "media-later");
  mkdirSync(dir, { recursive: true });
  mediaOfV6(dir);
  // Something in the way of the folder it is left in.
  writeFileSync(path.join(dir, "handoff"), "not a folder");
  assert.match(await upgraded(dir), /what the Media page kept could not be left for its extension, and is kept for the next start/);
  const tables = () => {
    const d = new Database(path.join(dir, "portal.db"), { readonly: true });
    try {
      return { version: d.pragma("user_version", { simple: true }), tables: d.prepare("SELECT name FROM sqlite_master WHERE name IN ('images', 'videos') ORDER BY name").all().map((t) => t.name), settings: d.prepare("SELECT COUNT(*) AS n FROM settings WHERE key IN ('image_generation', 'video_generation')").get().n };
    } finally {
      d.close();
    }
  };
  assert.deepEqual(tables(), { version: SCHEMA_VERSION, tables: ["images", "videos"], settings: 2 }, "upgraded all the same, with all of it kept");
  assert.equal(readFileSync(path.join(dir, "images", "aaaaaaaaaaa1.png"), "utf8"), "the page's kite");

  // Out of the way: the next start, which is no upgrade, leaves it.
  rmSync(path.join(dir, "handoff"));
  await upgraded(dir);
  assert.deepEqual(tables(), { version: SCHEMA_VERSION, tables: [], settings: 0 });
  assert.equal(readFileSync(path.join(dir, "handoff", "media", "files", "images", "aaaaaaaaaaa1.png"), "utf8"), "the page's kite");
});

// The agent's browser is an extension's from version 8 (extensions/browser), with settings of its own. A database of
// version 7 is made here from a fresh one, as the schema stood then, with what the portal kept of its browser.
const BROWSER_PASSWORD = "the-container-was-made-with-it";
/** The browser's tools as a chat of version 7 reported them, all but two that came later, an MCP server's, and another. */
const BROWSER_SEEN = [
  ...BROWSER_TOOLS.filter((name) => name !== "browser_find" && name !== "browser_get_text").map((name) => ({ name, source: "browser", package: null, inline: true })),
  { name: "browser_browser_click", source: "pi-mcp-adapter", package: "npm:pi-mcp-adapter@2.18.0" },
  { name: "web_fetch", source: "pi-web-access", package: "npm:pi-web-access", inline: false },
];

/**
 * A data folder as version 7 left it, with what it kept of the browser: four of its six settings, its allowlist, its
 * tools' set marked lazy and given a name, how far it had carried the per-chat grant into the tools (`adopted`), chats
 * with and without the grant, a routine run with it, routines with the Browser switch on and off, and the local
 * Chrome's profile beside the database.
 */
function browserOfV7(dir, adopted = "carry") {
  const d = freshAt8(path.join(dir, "portal.db"));
  d.pragma("user_version = 7");
  assert.equal(schemaFingerprint(d), V8_FINGERPRINT, "the schema of version 7");
  const setting = d.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  for (const [key, value] of [
    ["browser_password", BROWSER_PASSWORD],
    ["browser_https_port", "4443"],
    ["browser_cursor", "0"],
    ["browser_tools", "1"],
    ["browser_tools_adopted", adopted],
    ["browser_allowlist", "*.example.com"],
    ["tools_off_default", "codemode"],
    ["tools_lazy", "<tool>web_fetch\nbrowser"],
    ["tool_group_names", JSON.stringify({ browser: "Agent's browser", "pi-web-access": "Web" })],
    ["tools_seen", JSON.stringify(BROWSER_SEEN)],
  ]) setting.run(key, value);
  const chat = d.prepare("INSERT INTO sessions (id, title, workspace, kind, browser, tools_on) VALUES (?, ?, ?, ?, ?, ?)");
  chat.run("granted", "Shopping", path.join(dir, "ws"), "task", 1, "web_fetch");
  chat.run("plain", "Notes", path.join(dir, "ws"), "task", 0, "");
  chat.run("run", "A run", path.join(dir, "ws"), "routine", 1, "");
  const routine = d.prepare("INSERT INTO routines (id, slug, name, browser, tools_off, tools_on) VALUES (?, ?, ?, ?, ?, ?)");
  routine.run("r1", "news", "News", 1, "", "");
  routine.run("r2", "tidy", "Tidy", 0, "web_fetch", "");
  // One whose page wrote down one browser tool: what it said stands, and the rest follow its switch.
  routine.run("r3", "picky", "Picky", 0, "", "browser_navigate");
  d.close();
  mkdirSync(path.join(dir, "browser-profile", "Default"), { recursive: true });
  writeFileSync(path.join(dir, "browser-profile", "Default", "Cookies"), "the agent's logins");
}

/** What the upgraded database holds of the browser: the settings, and the tools of each chat and routine. */
function browserIn(dir) {
  const d = new Database(path.join(dir, "portal.db"), { readonly: true });
  try {
    const settings = Object.fromEntries(d.prepare("SELECT key, value FROM settings").all().map((row) => [row.key, row.value]));
    const lines = (text) => (text ? text.split("\n") : []);
    return {
      version: d.pragma("user_version", { simple: true }),
      fingerprint: schemaFingerprint(d),
      value: (key) => settings[key],
      chats: Object.fromEntries(d.prepare("SELECT id, tools_on FROM sessions ORDER BY id").all().map((row) => [row.id, lines(row.tools_on)])),
      routines: Object.fromEntries(d.prepare("SELECT slug, tools_off, tools_on FROM routines ORDER BY slug").all().map((row) => [row.slug, { off: lines(row.tools_off), on: lines(row.tools_on) }])),
    };
  } finally {
    d.close();
  }
}

test("what the portal kept of its browser is left for its extension, the local profile moved, and its settings go; the allowlist stays the guard's", async () => {
  const dir = path.join(home, "browser-out");
  mkdirSync(dir, { recursive: true });
  browserOfV7(dir);
  assert.deepEqual(upgradeCheck(path.join(dir, "portal.db")), { needed: true, from: 7 });
  assert.match(await upgraded(dir), new RegExp(`upgrading the database from version 7 to ${SCHEMA_VERSION}`));
  assert.match(path.basename(backupsIn(path.join(dir, "backups"))[0]), /^portal-v7-\d{8}-\d{6}\.db$/);

  const now = browserIn(dir);
  assert.equal(now.version, SCHEMA_VERSION);
  assert.equal(now.fingerprint, PINNED.fingerprint);
  for (const key of ["browser_user", "browser_password", "browser_port", "browser_https_port", "browser_cursor", "browser_tools"]) assert.equal(now.value(key), undefined, key);
  assert.equal(now.value("browser_allowlist"), "*.example.com");
  assert.equal(now.value("browser_tools_adopted"), "carry");
  // The set the tools were filed in is the extension's package now, its name and lazy mark with it; and so is each as
  // the lists remember it. An MCP server's tool, and another package's, stay as they were.
  assert.equal(now.value("tools_lazy"), "<tool>web_fetch\npithagoras-browser");
  assert.deepEqual(JSON.parse(now.value("tool_group_names")), { "pi-web-access": "Web", "pithagoras-browser": "Agent's browser" });
  assert.deepEqual(JSON.parse(now.value("tools_seen")), BROWSER_SEEN.map((tool) => (tool.source === "browser" ? { ...tool, source: "pithagoras-browser" } : tool)));

  // Left whole, closed to all but the portal: the six settings as they were stored, and the profile, moved.
  const left = path.join(dir, "handoff", "browser");
  assert.deepEqual(readdirSync(path.join(dir, "handoff")), ["browser"], "nothing half done beside it");
  assert.equal(modeOf(left), 0o700);
  assert.deepEqual(readdirSync(left).sort(), ["handoff.json", "profile", "settings.json"]);
  for (const json of ["handoff.json", "settings.json"]) assert.equal(modeOf(path.join(left, json)), 0o600, json);
  const read = (file) => JSON.parse(readFileSync(path.join(left, file), "utf8"));
  const { made, ...about } = read("handoff.json");
  assert.deepEqual(about, { format: 1, name: "browser", schema: 8 });
  assert.ok(Number.isFinite(Date.parse(made)));
  assert.deepEqual(read("settings.json"), { browser_user: null, browser_password: BROWSER_PASSWORD, browser_port: null, browser_https_port: "4443", browser_cursor: "0", browser_tools: "1" });
  assert.equal(readFileSync(path.join(left, "profile", "Default", "Cookies"), "utf8"), "the agent's logins");
  assert.equal(existsSync(path.join(dir, "browser-profile")), false);
});

test("who may drive the browser is written into the tools' switches: each routine's switch into its lists, and the grants still to be carried into the chats that had them", async () => {
  const dir = path.join(home, "browser-grants");
  mkdirSync(dir, { recursive: true });
  browserOfV7(dir);
  await upgraded(dir);
  const now = browserIn(dir);
  // The two tools no chat had reported yet were still to be carried: off by default, and on where a chat had the grant.
  assert.equal(now.value("tools_off_default"), "browser_find\nbrowser_get_text\ncodemode");
  assert.deepEqual(now.chats, { granted: ["browser_find", "browser_get_text", "web_fetch"], plain: [], run: [] }, "a routine's run answers by its routine");
  assert.deepEqual(now.routines, {
    news: { off: [], on: BROWSER_TOOLS },
    picky: { off: BROWSER_TOOLS.filter((name) => name !== "browser_navigate"), on: ["browser_navigate"] },
    tidy: { off: [...BROWSER_TOOLS, "web_fetch"].sort(), on: [] },
  });

  // Once: a start at version 8 writes nothing again.
  rmSync(path.join(dir, "handoff"), { recursive: true });
  await upgraded(dir);
  const again = browserIn(dir);
  assert.deepEqual([again.value("tools_off_default"), again.chats, again.routines], [now.value("tools_off_default"), now.chats, now.routines]);
  assert.equal(existsSync(path.join(dir, "handoff", "browser")), false, "nothing to leave again");
});

test("a portal still waiting for the browser's tools to carry the grants over carries them now, for all of them; one that had carried them has nothing to carry", async () => {
  const waiting = path.join(home, "browser-pending");
  mkdirSync(waiting, { recursive: true });
  browserOfV7(waiting, "pending");
  await upgraded(waiting);
  const pending = browserIn(waiting);
  // The tools it had seen were never carried while it waited: the grant was read from the column all along.
  assert.equal(pending.value("tools_off_default"), [...BROWSER_TOOLS, "codemode"].sort().join("\n"));
  assert.deepEqual(pending.chats.granted, [...BROWSER_TOOLS, "web_fetch"].sort());
  assert.deepEqual(pending.chats.plain, []);

  const done = path.join(home, "browser-adopted");
  mkdirSync(done, { recursive: true });
  browserOfV7(done, "1");
  await upgraded(done);
  const adopted = browserIn(done);
  assert.equal(adopted.value("tools_off_default"), "codemode");
  assert.deepEqual(adopted.chats.granted, ["web_fetch"]);
  assert.deepEqual(adopted.routines.news, { off: [], on: BROWSER_TOOLS }, "a routine's switch is written all the same");
});

test("the tools seen of a Playwright server pointed at a browser were the browser's as well, and are written with the portal's; the run of a routine that is gone has them off", async () => {
  const dir = path.join(home, "browser-mcp");
  mkdirSync(dir, { recursive: true });
  browserOfV7(dir, "pending");
  // A server under a name of its own whose tool a chat reported, and the runs of a routine there is and of one that is gone.
  const PLAYWRIGHT = "playwright_browser_navigate";
  const before = new Database(path.join(dir, "portal.db"));
  before.prepare("UPDATE settings SET value = ? WHERE key = 'tools_seen'").run(JSON.stringify([...BROWSER_SEEN, { name: PLAYWRIGHT, source: "pi-mcp-adapter", package: "npm:pi-mcp-adapter@2.18.0" }]));
  const run = before.prepare("INSERT INTO sessions (id, title, workspace, kind, routine_slug, tools_on) VALUES (?, ?, ?, 'routine', ?, ?)");
  run.run("gone-run", "A run", path.join(dir, "ws"), "deleted-one", "browser_navigate");
  run.run("news-run", "A run", path.join(dir, "ws"), "news", "");
  before.close();
  const mcp = path.join(process.env.PI_CODING_AGENT_DIR, "mcp.json");
  writeFileSync(mcp, JSON.stringify({ mcpServers: { playwright: { command: "npx", args: ["@playwright/mcp", "--cdp-endpoint", "http://127.0.0.1:9222"] } } }));
  try {
    await upgraded(dir);
  } finally {
    rmSync(mcp);
  }
  const now = browserIn(dir);
  const all = [...BROWSER_TOOLS, PLAYWRIGHT].sort();
  assert.deepEqual(now.routines, {
    news: { off: [], on: all },
    picky: { off: all.filter((name) => name !== "browser_navigate"), on: ["browser_navigate"] },
    tidy: { off: [...all, "web_fetch"].sort(), on: [] },
  });
  assert.equal(now.value("tools_off_default"), [...all, "codemode"].sort().join("\n"));
  assert.deepEqual(now.chats.granted, [...all, "web_fetch"].sort());
  // What the run of the gone routine switched on itself stays on; a run of a routine there answers by its routine.
  const d = new Database(path.join(dir, "portal.db"), { readonly: true });
  const lists = (id) => d.prepare("SELECT tools_off, tools_on FROM sessions WHERE id = ?").get(id);
  assert.deepEqual(lists("gone-run"), { tools_off: all.filter((name) => name !== "browser_navigate").join("\n"), tools_on: "browser_navigate" });
  assert.deepEqual(lists("news-run"), { tools_off: "", tools_on: "" });
  d.close();
});

test("what the browser kept that cannot be left is kept for the next start, which leaves it; one left before the database rolled back is not left again", async () => {
  const dir = path.join(home, "browser-later");
  mkdirSync(dir, { recursive: true });
  browserOfV7(dir);
  writeFileSync(path.join(dir, "handoff"), "not a folder");
  assert.match(await upgraded(dir), /what the browser kept could not be left for its extension, and is kept for the next start/);
  let now = browserIn(dir);
  assert.equal(now.version, SCHEMA_VERSION, "upgraded all the same");
  assert.equal(now.value("browser_password"), BROWSER_PASSWORD, "with all of it kept");
  assert.equal(now.value("tools_lazy"), "<tool>web_fetch\nbrowser");
  assert.equal(readFileSync(path.join(dir, "browser-profile", "Default", "Cookies"), "utf8"), "the agent's logins");
  // Out of the way: the next start, which is no upgrade, leaves it.
  rmSync(path.join(dir, "handoff"));
  await upgraded(dir);
  now = browserIn(dir);
  assert.equal(now.value("browser_password"), undefined);
  assert.equal(now.value("tools_lazy"), "<tool>web_fetch\npithagoras-browser");
  assert.equal(JSON.parse(readFileSync(path.join(dir, "handoff", "browser", "settings.json"), "utf8")).browser_password, BROWSER_PASSWORD);

  // A try that left it whole, and whose database rolled back: not filled again, and the settings go.
  const rolled = path.join(home, "browser-left");
  mkdirSync(rolled, { recursive: true });
  browserOfV7(rolled);
  const left = path.join(rolled, "handoff", "browser");
  mkdirSync(left, { recursive: true });
  const about = JSON.stringify({ format: 1, name: "browser", schema: 8, made: "2026-10-21T08:00:00.000Z" });
  writeFileSync(path.join(left, "handoff.json"), about);
  await upgraded(rolled);
  assert.equal(readFileSync(path.join(left, "handoff.json"), "utf8"), about);
  assert.equal(readFileSync(path.join(rolled, "browser-profile", "Default", "Cookies"), "utf8"), "the agent's logins", "what is not in it stays where it is");
  const after = browserIn(rolled);
  assert.equal(after.value("browser_password"), undefined);
  assert.equal(JSON.parse(after.value("tools_seen")).find((tool) => tool.name === "browser_navigate").source, "pithagoras-browser");
});

// Voice mode listens and speaks through an extension from version 9: what the portal kept of its voice service is Voice's
// (extensions/voice), and the person's own speech servers are Voice servers' (extensions/voice-servers). A database of
// version 8 is made here from a fresh one with the table of saved voices, and what the portal kept of voice mode.
const SERVICE = { whisper: "http://127.0.0.1:8188/inference", speech: "http://127.0.0.1:7862/v1/audio/speech" };
const OWN = { whisper: "http://stt.example.test:9000/inference", speech: "http://tts.example.test:9001/v1/audio/speech", dictation: "http://dictate.example.test:9002/inference" };
const VAD = { positiveSpeechThreshold: 0.65, negativeSpeechThreshold: 0.35, minSpeechMs: 256, preSpeechPadMs: 320, redemptionMs: 1000 };
const DEFAULT_INSTRUCTION = "A warm, clear English voice with a calm, conversational delivery.";
/** Voice mode's settings as friday has them at version 8: on, at the service's addresses, speaking with Aria. */
const FRIDAY_VOICE = {
  voice: "voice-db42d4ce-9a43-4ce1-9dd2-cc8596d3305e", language: "en", cfgScale: 1, vad: VAD, lazyLoad: true,
  runtime: "audio-cpp", sttModel: "", exaggeration: 0.5, kokoroVoice: "af_heart", speed: 1, responseInstructions: "",
  enabled: true, whisperUrl: SERVICE.whisper, breezeUrl: SERVICE.speech, instruction: DEFAULT_INSTRUCTION,
};
/** A recording as a clone keeps it: mono, 16 kHz, 16-bit, `seconds` long, of samples that differ from one to the next. */
function cloneWav(seconds = 1, seed = 1) {
  const pcm = Buffer.alloc(32000 * seconds);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(((i * 7919 + seed * 104729) % 65536) - 32768, i);
  const header = Buffer.alloc(44);
  header.write("RIFF"); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
/** Aria, as friday keeps her: a clone with a description of 28 characters and the words of her recording. */
const ARIA = {
  id: "voice-db42d4ce-9a43-4ce1-9dd2-cc8596d3305e", name: "Aria", kind: "clone", instruction: "Warm, bright and unhurried.",
  transcript: "Hello, I am Aria. I read the news to you every morning, and I keep my sentences short so that they are easy to follow when you only half listen.",
  audio: cloneWav(7),
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A data folder as version 8 left it, with the settings given (null for none), the saved voices, and nothing else of voice. */
function voiceOfV8(dir, settings, voices = []) {
  mkdirSync(dir, { recursive: true });
  const d = freshAt8(path.join(dir, "portal.db"));
  d.pragma("user_version = 8");
  assert.equal(schemaFingerprint(d), V8_FINGERPRINT, "the schema of version 8");
  const put = d.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  for (const [key, value] of Object.entries(settings)) if (value !== null) put.run(key, typeof value === "string" ? value : JSON.stringify(value));
  const voice = d.prepare("INSERT INTO voice_presets (id, name, kind, instruction, transcript, audio) VALUES (?, ?, ?, ?, ?, ?)");
  for (const v of voices) voice.run(v.id, v.name, v.kind, v.instruction, v.transcript, v.audio ?? null);
  d.close();
}

/** What the database holds of voice: its settings, `voice` read, and whether the table of saved voices is there. */
function voiceIn(dir) {
  const d = new Database(path.join(dir, "portal.db"), { readonly: true });
  try {
    const settings = Object.fromEntries(d.prepare("SELECT key, value FROM settings").all().map((row) => [row.key, row.value]));
    const value = (key) => settings[key];
    return {
      version: d.pragma("user_version", { simple: true }),
      fingerprint: schemaFingerprint(d),
      value,
      voice: JSON.parse(value("voice") ?? "null"),
      table: !!d.prepare("SELECT 1 FROM sqlite_master WHERE name = 'voice_presets'").get(),
    };
  } finally {
    d.close();
  }
}
const voiceLeft = (dir, name, file) => JSON.parse(readFileSync(path.join(dir, "handoff", name, file), "utf8"));
const leftAt = (dir) => (existsSync(path.join(dir, "handoff")) ? readdirSync(path.join(dir, "handoff")).sort() : []);
/** The addresses voice-addresses carries, as `voice` holds them, each null where it has none. */
const addressesOf = (voice) =>
  Object.fromEntries(["whisperUrl", "sttModel", "breezeUrl", "runtime", "dictationUrl", "dictationModel", "language", "kokoroVoice"].map((key) => [key, voice[key] ?? null]));
/** The settings voice-service carries of `voice`, the GPU and a setup still to come up. */
const serviceOf = (voice, gpu = null, setupPending = null) => ({
  gpu, setupPending, lazyLoad: voice.lazyLoad ?? null, voice: voice.voice ?? null, instruction: voice.instruction ?? null, cfgScale: voice.cfgScale ?? null,
  exaggeration: voice.exaggeration ?? null, kokoroVoice: voice.kokoroVoice ?? null, speed: voice.speed ?? null, language: voice.language ?? null,
});
/** The spoken error line as the portal kept it, and the file a write of it left half done. */
function errorLines(dir) {
  mkdirSync(path.join(dir, "voice"), { recursive: true });
  const line = path.join(dir, "voice", "error-line-0123456789abcdef0123456789abcdef.wav");
  const half = path.join(dir, "voice", ".error-line-0123456789abcdef0123456789abcdef.wav.0a1b2c3d4e5f.tmp");
  writeFileSync(line, cloneWav(1));
  writeFileSync(half, "half");
  return [line, half];
}

test("friday's voice mode at version 8 is left for Voice whole, Aria's recording as it was stored, and voice mode listens and speaks through it", async () => {
  const dir = path.join(home, "voice-friday");
  voiceOfV8(dir, { voice: FRIDAY_VOICE, voice_gpu: "GPU-648bf6c5-346e-81f5-f155-dc8061172da3", voice_before_managed: { noSpeech: false } }, [ARIA]);
  errorLines(dir);
  assert.deepEqual(upgradeCheck(path.join(dir, "portal.db")), { needed: true, from: 8 });
  assert.match(await upgraded(dir), new RegExp(`upgrading the database from version 8 to ${SCHEMA_VERSION}`));
  const backup = backupsIn(path.join(dir, "backups"))[0];
  assert.match(path.basename(backup), /^portal-v8-\d{8}-\d{6}\.db$/);

  const now = voiceIn(dir);
  assert.equal(now.version, SCHEMA_VERSION);
  assert.equal(now.fingerprint, PINNED.fingerprint);
  assert.equal(now.table, false, "the table is gone");
  for (const key of ["voice_gpu", "voice_setup_pending", "voice_before_managed"]) assert.equal(now.value(key), undefined, key);
  assert.deepEqual(now.voice, { provider: "pithagoras-voice", vad: VAD, responseInstructions: "" });

  // Left whole, closed to all but the portal; and nothing for Voice servers, as nothing of the person's own was kept.
  assert.deepEqual(leftAt(dir), ["voice-service"], "nothing half done beside it");
  const left = path.join(dir, "handoff", "voice-service");
  for (const folder of [path.join(dir, "handoff"), left, path.join(left, "voices")]) assert.equal(modeOf(folder), 0o700, folder);
  assert.deepEqual(readdirSync(left).sort(), ["handoff.json", "settings.json", "voices", "voices.json"]);
  for (const file of ["handoff.json", "settings.json", "voices.json", "voices/0.wav"]) assert.equal(modeOf(path.join(left, file)), 0o600, file);
  const { made, ...about } = voiceLeft(dir, "voice-service", "handoff.json");
  assert.deepEqual(about, { format: 1, name: "voice-service", schema: 9 });
  assert.ok(Number.isFinite(Date.parse(made)));
  assert.deepEqual(voiceLeft(dir, "voice-service", "settings.json"), {
    gpu: "GPU-648bf6c5-346e-81f5-f155-dc8061172da3", setupPending: null, lazyLoad: true, voice: ARIA.id, instruction: DEFAULT_INSTRUCTION,
    cfgScale: 1, exaggeration: 0.5, kokoroVoice: "af_heart", speed: 1, language: "en",
  });
  const { audio: _audio, ...aria } = ARIA;
  assert.deepEqual(voiceLeft(dir, "voice-service", "voices.json"), [{ ...aria, audio: "voices/0.wav" }]);
  // The recording is the bytes the backup holds.
  const copy = new Database(backup, { readonly: true });
  const stored = copy.prepare("SELECT audio FROM voice_presets WHERE id = ?").get(ARIA.id).audio;
  copy.close();
  assert.equal(sha256(readFileSync(path.join(left, "voices", "0.wav"))), sha256(stored));
  assert.equal(stored.length, ARIA.audio.length);
  // The spoken error line the portal kept is gone, and its folder with it.
  assert.equal(existsSync(path.join(dir, "voice")), false);
});

test("only the spoken error line goes of the folder it was kept in: anything else there stays, and the folder with it", async () => {
  const dir = path.join(home, "voice-lines");
  voiceOfV8(dir, { voice: FRIDAY_VOICE });
  const lines = errorLines(dir);
  const other = path.join(dir, "voice", "notes.txt");
  writeFileSync(other, "not a line");
  await upgraded(dir);
  for (const line of lines) assert.equal(existsSync(line), false, line);
  assert.equal(readFileSync(other, "utf8"), "not a line");
});

test("the person's own addresses are left for Voice servers whether voice mode was on or off; it listens through them only where it was on", async () => {
  const own = { ...FRIDAY_VOICE, whisperUrl: OWN.whisper, sttModel: "my-model", breezeUrl: OWN.speech, runtime: "kokoro", kokoroVoice: "am_onyx", dictationUrl: OWN.dictation, dictationModel: "my-dictation", language: "de" };
  for (const [name, enabled, provider] of [["voice-own-on", true, "pithagoras-voice-servers"], ["voice-own-off", false, ""]]) {
    const dir = path.join(home, name);
    voiceOfV8(dir, { voice: { ...own, enabled } });
    await upgraded(dir);
    assert.deepEqual(leftAt(dir), ["voice-addresses", "voice-service"], name);
    const { made, ...about } = voiceLeft(dir, "voice-addresses", "handoff.json");
    assert.deepEqual(about, { format: 1, name: "voice-addresses", schema: 9 });
    assert.ok(Number.isFinite(Date.parse(made)));
    assert.equal(modeOf(path.join(dir, "handoff", "voice-addresses", "settings.json")), 0o600);
    assert.deepEqual(voiceLeft(dir, "voice-addresses", "settings.json"), addressesOf(own), name);
    assert.deepEqual(voiceLeft(dir, "voice-service", "settings.json"), serviceOf(own), name);
    assert.deepEqual(voiceIn(dir).voice, { provider, vad: VAD, responseInstructions: "" }, name);
  }
});

test("a source chosen at version 8 stays the source where voice mode was on, with the person's own addresses left beside it; voice mode that was off has none", async () => {
  const chosen = path.join(home, "voice-chosen");
  const speaker = { vad: VAD, enabled: true, provider: "test-speaker", whisperUrl: OWN.whisper, breezeUrl: OWN.speech, runtime: "breeze", voiceModel: "fast/small" };
  voiceOfV8(chosen, { voice: speaker });
  await upgraded(chosen);
  assert.deepEqual(voiceIn(chosen).voice, { provider: "test-speaker", vad: VAD, voiceModel: "fast/small" });
  assert.deepEqual(voiceLeft(chosen, "voice-addresses", "settings.json"), addressesOf(speaker));

  const off = path.join(home, "voice-off");
  voiceOfV8(off, { voice: { ...FRIDAY_VOICE, enabled: false }, voice_before_managed: { noSpeech: false } });
  await upgraded(off);
  assert.deepEqual(voiceIn(off).voice, { provider: "", vad: VAD, responseInstructions: "" });
  assert.deepEqual(leftAt(off), ["voice-service"]);
});

test("where the service's addresses were in use, what connecting it remembered of the person's own is left for Voice servers, each side as it was kept", async () => {
  // Recognition and dictation of their own, remembered.
  const heard = path.join(home, "voice-kept-heard");
  const listening = { whisperUrl: OWN.whisper, sttModel: "my-model", dictationUrl: OWN.dictation, dictationModel: "my-dictation", enabled: true };
  voiceOfV8(heard, { voice: FRIDAY_VOICE, voice_before_managed: { listening, noSpeech: false } });
  await upgraded(heard);
  assert.deepEqual(voiceLeft(heard, "voice-addresses", "settings.json"), {
    whisperUrl: OWN.whisper, sttModel: "my-model", breezeUrl: null, runtime: null, dictationUrl: OWN.dictation, dictationModel: "my-dictation", language: "en", kokoroVoice: "af_heart",
  });
  assert.equal(voiceIn(heard).voice.provider, "pithagoras-voice");

  // A dictation address of their own beside the service's.
  const dictated = path.join(home, "voice-own-dictation");
  const big = { dictationUrl: "http://big.example.test:9100/v1/audio/transcriptions", dictationModel: "big-asr" };
  voiceOfV8(dictated, { voice: { ...FRIDAY_VOICE, ...big }, voice_before_managed: { noSpeech: false } });
  await upgraded(dictated);
  assert.deepEqual(voiceLeft(dictated, "voice-addresses", "settings.json"), {
    whisperUrl: null, sttModel: null, breezeUrl: null, runtime: null, ...big, language: "en", kokoroVoice: "af_heart",
  });

  // The service's recognition alone, connected so (no speech address, runtime none), and a speech server of their own remembered.
  const alone = path.join(home, "voice-kept-speech");
  const speaking = { breezeUrl: OWN.speech, runtime: "chatterbox", enabled: true };
  voiceOfV8(alone, { voice: { ...FRIDAY_VOICE, runtime: "none", breezeUrl: "" }, voice_before_managed: { speaking, noSpeech: true } });
  await upgraded(alone);
  assert.deepEqual(voiceLeft(alone, "voice-addresses", "settings.json"), {
    whisperUrl: null, sttModel: null, breezeUrl: OWN.speech, runtime: "chatterbox", dictationUrl: null, dictationModel: null, language: "en", kokoroVoice: "af_heart",
  });
  assert.equal(voiceIn(alone).voice.provider, "pithagoras-voice");

  // The same row with speech switched off by hand after connecting: the speech server remembered was not in use, and is not left.
  const off = path.join(home, "voice-speech-off");
  voiceOfV8(off, { voice: { ...FRIDAY_VOICE, runtime: "none", breezeUrl: "" }, voice_before_managed: { speaking, noSpeech: false } });
  await upgraded(off);
  assert.deepEqual(leftAt(off), ["voice-service"]);
  assert.equal(voiceIn(off).voice.provider, "pithagoras-voice");
});

test("with nothing of voice mode there, nothing is left and the table goes; settings voice mode cannot read go too", async () => {
  const none = path.join(home, "voice-nothing");
  voiceOfV8(none, {});
  await upgraded(none);
  assert.deepEqual(leftAt(none), []);
  assert.deepEqual([voiceIn(none).table, voiceIn(none).value("voice"), voiceIn(none).fingerprint], [false, undefined, PINNED.fingerprint]);

  const unreadable = path.join(home, "voice-unreadable");
  voiceOfV8(unreadable, { voice: "{not json", voice_gpu: "GPU-1" });
  await upgraded(unreadable);
  assert.equal(voiceIn(unreadable).value("voice"), undefined);
  assert.deepEqual(voiceLeft(unreadable, "voice-service", "settings.json"), serviceOf({}, "GPU-1"));
  assert.deepEqual(voiceLeft(unreadable, "voice-service", "voices.json"), []);
  assert.deepEqual(leftAt(unreadable), ["voice-service"]);
});

test("what voice mode kept that cannot be left is kept whole for the next start, a save meanwhile keeps it, and the next start leaves it", async () => {
  const dir = path.join(home, "voice-later");
  const own = { ...FRIDAY_VOICE, whisperUrl: OWN.whisper, breezeUrl: OWN.speech, runtime: "kokoro" };
  voiceOfV8(dir, { voice: own, voice_gpu: "GPU-1" }, [ARIA]);
  const [line] = errorLines(dir);
  writeFileSync(path.join(dir, "handoff"), "not a folder");
  assert.match(await upgraded(dir), /what voice mode kept could not be left for its extensions, and is kept for the next start/);
  let now = voiceIn(dir);
  assert.equal(now.version, SCHEMA_VERSION, "upgraded all the same");
  assert.deepEqual([now.voice, now.value("voice_gpu"), now.table, existsSync(line)], [own, "GPU-1", true, true], "with all of it kept");

  // Voice mode's settings saved meanwhile, as the page saves them: what the next start reads is kept.
  const run = spawn(process.execPath, ["--input-type=module", "-e", `
    const m = await import(${JSON.stringify(new URL("../dist/db-upgrade.js", import.meta.url).href)});
    await m.prepareDatabase();
    const { voiceRouter } = await import(${JSON.stringify(new URL("../dist/api/voice.js", import.meta.url).href)});
    const { default: express } = await import(${JSON.stringify(import.meta.resolve("express"))});
    const server = express().use(express.json()).use("/api", voiceRouter()).listen(0, "127.0.0.1", async () => {
      const answer = await fetch("http://127.0.0.1:" + server.address().port + "/api/voice", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ responseInstructions: "Answer briefly." }) });
      console.log("RESULT " + answer.status);
      process.exit(0);
    });`], {
    env: { ...process.env, DATA_DIR: dir, WORKSPACE_ROOT: path.join(dir, "ws"), AGENT_HOME: path.join(dir, "home"), PORTAL_PASSWORD: "", ALLOW_OPEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  run.stdout.on("data", (c) => { out += c; });
  run.stderr.on("data", (c) => { out += c; });
  assert.equal(await new Promise((resolve) => run.on("exit", resolve)), 0, out);
  assert.match(out, /RESULT 200/);
  now = voiceIn(dir);
  assert.deepEqual(now.voice, { ...own, provider: "", responseInstructions: "Answer briefly.", voiceModel: "", conversation: true });

  // Out of the way: the next start, which is no upgrade, leaves it, from what version 8 held.
  rmSync(path.join(dir, "handoff"));
  await upgraded(dir);
  now = voiceIn(dir);
  assert.deepEqual([now.voice, now.value("voice_gpu"), now.table, existsSync(line)], [{ provider: "pithagoras-voice-servers", vad: VAD, responseInstructions: "Answer briefly.", voiceModel: "", conversation: true }, undefined, false, false]);
  assert.deepEqual(voiceLeft(dir, "voice-service", "settings.json"), serviceOf(own, "GPU-1"));
  assert.deepEqual(voiceLeft(dir, "voice-service", "voices.json").map((v) => v.name), ["Aria"]);
  assert.deepEqual(voiceLeft(dir, "voice-addresses", "settings.json"), addressesOf(own));
});

test("what an earlier try left that nothing took is left anew from the rows, with the voices added since; one that no longer applies goes", async () => {
  const dir = path.join(home, "voice-again");
  const calm = { id: "voice-5b1e0c9a-0d7e-4f3c-8a2b-6c4d2e1f0a9b", name: "Calm", kind: "clone", instruction: "Slow and low.", transcript: "A calm voice.", audio: cloneWav(2, 2) };
  voiceOfV8(dir, { voice: FRIDAY_VOICE, voice_before_managed: { noSpeech: false } }, [ARIA, calm]);
  // A try left Aria alone, and the person's own addresses of then, and its database rolled back; Calm was added after.
  const earlier = path.join(dir, "handoff", "voice-service");
  mkdirSync(path.join(earlier, "voices"), { recursive: true });
  writeFileSync(path.join(earlier, "voices", "0.wav"), "an older recording");
  writeFileSync(path.join(earlier, "voices.json"), JSON.stringify([{ ...ARIA, audio: "voices/0.wav" }]));
  writeFileSync(path.join(earlier, "handoff.json"), JSON.stringify({ format: 1, name: "voice-service", schema: 9, made: "2026-10-22T06:00:00.000Z" }));
  mkdirSync(path.join(dir, "handoff", "voice-addresses"));
  writeFileSync(path.join(dir, "handoff", "voice-addresses", "handoff.json"), JSON.stringify({ format: 1, name: "voice-addresses", schema: 9, made: "2026-10-22T06:00:00.000Z" }));
  await upgraded(dir);

  assert.deepEqual(leftAt(dir), ["voice-service"], "the addresses of then are not the person's now");
  assert.notEqual(voiceLeft(dir, "voice-service", "handoff.json").made, "2026-10-22T06:00:00.000Z");
  const { audio: _aria, ...aria } = ARIA;
  const { audio: _calm, ...rest } = calm;
  assert.deepEqual(voiceLeft(dir, "voice-service", "voices.json"), [{ ...aria, audio: "voices/0.wav" }, { ...rest, audio: "voices/1.wav" }]);
  assert.equal(sha256(readFileSync(path.join(earlier, "voices", "0.wav"))), sha256(ARIA.audio));
  assert.equal(sha256(readFileSync(path.join(earlier, "voices", "1.wav"))), sha256(calm.audio));
  assert.equal(voiceIn(dir).table, false);
});

test("a database at version 9 has nothing of voice mode to leave, and keeps what it holds", async () => {
  const dir = path.join(home, "voice-fresh");
  mkdirSync(dir, { recursive: true });
  const d = freshAt9(path.join(dir, "portal.db"));
  d.pragma("user_version = 9");
  assert.equal(schemaFingerprint(d), V9_FINGERPRINT, "the schema of version 9");
  d.prepare("INSERT INTO settings (key, value) VALUES ('voice', ?)").run(JSON.stringify({ provider: "test-speaker", responseInstructions: "Short." }));
  d.close();
  const [line] = errorLines(dir);
  const before = voiceIn(dir);
  await upgraded(dir);
  const now = voiceIn(dir);
  assert.deepEqual([now.version, now.fingerprint, now.value("voice")], [SCHEMA_VERSION, PINNED.fingerprint, before.value("voice")]);
  assert.deepEqual(leftAt(dir), []);
  assert.equal(existsSync(line), true, "the step did not run");
});

// The agent's memory in Understory is an extension's from version 10 (extensions/understory), with settings of its own,
// and a project's switch for the agent's memory is named for no extension. A database of version 9 is made here from a
// fresh one, as the schema stood then, with what the portal kept of Understory.
const UNDERSTORY_KEPT = {
  understory_config: JSON.stringify({ llm: { source: "custom", baseUrl: "http://gpu:8080/v1", model: "qwen", format: "openai", apiKey: "sk-own" }, dreamInterval: "", dreamAt: "03:00" }),
  understory_token: "t".repeat(48),
  understory_llm_token: "l".repeat(48),
  understory_last_dream: JSON.stringify({ at: "2026-10-22T21:30:00.000Z", ok: true, ran: false, said: "Nothing to do" }),
};
/** The agent's MCP entry for the Understory the portal ran, as it wrote it: its token in it. */
const UNDERSTORY_ENTRY = { understory: { url: "http://127.0.0.1:3800/mcp", lifecycle: "lazy", directTools: true, auth: "bearer", bearerToken: "t".repeat(48) } };

/** A data folder as version 9 left it, with the settings given (null for none) and projects that said something about the agent's memory. */
function understoryOfV9(dir, settings) {
  const d = freshAt9(path.join(dir, "portal.db"));
  d.pragma("user_version = 9");
  assert.equal(schemaFingerprint(d), V9_FINGERPRINT, "the schema of version 9");
  const put = d.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  for (const [key, value] of Object.entries(settings)) if (value !== null) put.run(key, value);
  const link = d.prepare("INSERT INTO project_agent (project, agent, understory_off) VALUES (?, ?, ?)");
  link.run("research", "home", 1);
  link.run("site", "home", 0);
  d.close();
}

/** What the upgraded database holds: its settings, and what each project says. */
function understoryIn(dir) {
  const d = new Database(path.join(dir, "portal.db"), { readonly: true });
  try {
    const settings = Object.fromEntries(d.prepare("SELECT key, value FROM settings").all().map((row) => [row.key, row.value]));
    return {
      version: d.pragma("user_version", { simple: true }),
      fingerprint: schemaFingerprint(d),
      value: (key) => settings[key],
      projects: d.prepare("SELECT project, agent, memory_off FROM project_agent ORDER BY project").all(),
    };
  } finally {
    d.close();
  }
}
const understoryLeft = (dir, file) => JSON.parse(readFileSync(path.join(dir, "handoff", "understory", file), "utf8"));

/** The portal started on the data folder with pi's mcp.json holding `servers` (none: no file), as an upgrade does. */
async function upgradedWith(dir, servers) {
  const mcp = path.join(process.env.PI_CODING_AGENT_DIR, "mcp.json");
  mkdirSync(path.dirname(mcp), { recursive: true });
  if (servers) writeFileSync(mcp, JSON.stringify({ mcpServers: servers }));
  try {
    return await upgraded(dir);
  } finally {
    rmSync(mcp, { force: true });
  }
}

test("what the portal kept of Understory is left for its extension, the guard trusts its server where the person had said nothing, and each project's switch is kept under its new name", async () => {
  const dir = path.join(home, "understory-out");
  mkdirSync(dir, { recursive: true });
  understoryOfV9(dir, UNDERSTORY_KEPT);
  assert.deepEqual(upgradeCheck(path.join(dir, "portal.db")), { needed: true, from: 9 });
  const mcp = path.join(process.env.PI_CODING_AGENT_DIR, "mcp.json");
  mkdirSync(path.dirname(mcp), { recursive: true });
  writeFileSync(mcp, JSON.stringify({ mcpServers: UNDERSTORY_ENTRY }));
  try {
    assert.match(await upgraded(dir), new RegExp(`upgrading the database from version 9 to ${SCHEMA_VERSION}`));
    assert.deepEqual(JSON.parse(readFileSync(mcp, "utf8")), { mcpServers: UNDERSTORY_ENTRY }, "the agent's MCP entry is pi's, and stays as it was");
  } finally {
    rmSync(mcp);
  }
  assert.match(path.basename(backupsIn(path.join(dir, "backups"))[0]), /^portal-v9-\d{8}-\d{6}\.db$/);

  const now = understoryIn(dir);
  assert.deepEqual([now.version, now.fingerprint], [SCHEMA_VERSION, PINNED.fingerprint]);
  for (const key of Object.keys(UNDERSTORY_KEPT)) assert.equal(now.value(key), undefined, key);
  assert.equal(now.value("guard_trusted_mcp_servers"), JSON.stringify(["understory"]), "trusted as it was, now in the person's list, where they can take it out");
  assert.deepEqual(now.projects, [{ project: "research", agent: "home", memory_off: 1 }, { project: "site", agent: "home", memory_off: 0 }]);

  // Left whole, closed to all but the portal: the four settings as they were stored.
  const left = path.join(dir, "handoff", "understory");
  assert.deepEqual(readdirSync(path.join(dir, "handoff")), ["understory"], "nothing half done beside it");
  assert.equal(modeOf(left), 0o700);
  assert.deepEqual(readdirSync(left).sort(), ["handoff.json", "settings.json"]);
  for (const json of ["handoff.json", "settings.json"]) assert.equal(modeOf(path.join(left, json)), 0o600, json);
  const { made, ...about } = understoryLeft(dir, "handoff.json");
  assert.deepEqual(about, { format: 1, name: "understory", schema: 10 });
  assert.ok(Number.isFinite(Date.parse(made)));
  assert.deepEqual(understoryLeft(dir, "settings.json"), UNDERSTORY_KEPT);

  // Once: the person takes the trust back, and a start at version 10 does not give it again.
  const d = new Database(path.join(dir, "portal.db"));
  d.prepare("UPDATE settings SET value = '[]' WHERE key = 'guard_trusted_mcp_servers'").run();
  d.close();
  await upgradedWith(dir, UNDERSTORY_ENTRY);
  assert.equal(understoryIn(dir).value("guard_trusted_mcp_servers"), "[]");
});

test("the servers the person said are theirs stay as they said; an Understory of their own in mcp.json is trusted as it was; one never used leaves nothing", async () => {
  const said = path.join(home, "understory-said");
  mkdirSync(said, { recursive: true });
  understoryOfV9(said, { understory_token: "t".repeat(48), guard_trusted_mcp_servers: JSON.stringify(["jira"]) });
  await upgradedWith(said, UNDERSTORY_ENTRY);
  assert.equal(understoryIn(said).value("guard_trusted_mcp_servers"), JSON.stringify(["jira"]));
  assert.deepEqual(understoryLeft(said, "settings.json"), { understory_config: null, understory_token: "t".repeat(48), understory_llm_token: null, understory_last_dream: null });

  // Run elsewhere, never by the portal: no settings to leave, and its server trusted as it was.
  const own = path.join(home, "understory-own");
  mkdirSync(own, { recursive: true });
  understoryOfV9(own, {});
  await upgradedWith(own, { understory: { url: "http://understory.example.test:3800/mcp", lifecycle: "lazy", directTools: true } });
  assert.equal(understoryIn(own).value("guard_trusted_mcp_servers"), JSON.stringify(["understory"]));
  assert.equal(existsSync(path.join(own, "handoff")), false);

  // Never used: nothing trusted, nothing left, and the projects' switches renamed all the same.
  const none = path.join(home, "understory-none");
  mkdirSync(none, { recursive: true });
  understoryOfV9(none, {});
  await upgradedWith(none, { jira: { command: "j" } });
  const now = understoryIn(none);
  assert.equal(now.value("guard_trusted_mcp_servers"), undefined);
  assert.equal(existsSync(path.join(none, "handoff")), false);
  assert.deepEqual(now.projects.map((p) => p.memory_off), [1, 0]);
});

test("what Understory kept that cannot be left is kept for the next start, which leaves it; the trust it had is written at the upgrade all the same", async () => {
  const dir = path.join(home, "understory-later");
  mkdirSync(dir, { recursive: true });
  understoryOfV9(dir, UNDERSTORY_KEPT);
  writeFileSync(path.join(dir, "handoff"), "not a folder");
  assert.match(await upgradedWith(dir), /what Understory kept could not be left for its extension, and is kept for the next start/);
  let now = understoryIn(dir);
  assert.equal(now.version, SCHEMA_VERSION, "upgraded all the same");
  for (const [key, value] of Object.entries(UNDERSTORY_KEPT)) assert.equal(now.value(key), value, key);
  assert.equal(now.value("guard_trusted_mcp_servers"), JSON.stringify(["understory"]));
  // Out of the way: the next start, which is no upgrade, leaves it.
  rmSync(path.join(dir, "handoff"));
  await upgradedWith(dir);
  now = understoryIn(dir);
  for (const key of Object.keys(UNDERSTORY_KEPT)) assert.equal(now.value(key), undefined, key);
  assert.deepEqual(understoryLeft(dir, "settings.json"), UNDERSTORY_KEPT);
});

test("friday's database of version 8 is brought to this version in one start: voice mode is left for Voice, Understory, which it never ran, leaves nothing and is trusted nowhere, and its chats are in Standard", async () => {
  const dir = path.join(home, "friday-from-8");
  voiceOfV8(dir, { voice: FRIDAY_VOICE, voice_gpu: "GPU-648bf6c5-346e-81f5-f155-dc8061172da3", voice_before_managed: { noSpeech: false } }, [ARIA]);
  const d = new Database(path.join(dir, "portal.db"));
  d.prepare("INSERT INTO project_agent (project, agent, understory_off) VALUES ('research', 'home', 1)").run();
  d.prepare("INSERT INTO sessions (id, title, workspace, kind) VALUES ('c1', 'Kites', '/w/site', 'task')").run();
  d.close();
  assert.deepEqual(upgradeCheck(path.join(dir, "portal.db")), { needed: true, from: 8 });
  assert.match(await upgradedWith(dir), new RegExp(`upgrading the database from version 8 to ${SCHEMA_VERSION}`));
  const backups = backupsIn(path.join(dir, "backups"));
  assert.equal(backups.length, 1, "one backup, of version 8");
  assert.match(path.basename(backups[0]), /^portal-v8-\d{8}-\d{6}\.db$/);

  const now = understoryIn(dir);
  assert.deepEqual([now.version, now.fingerprint], [SCHEMA_VERSION, PINNED.fingerprint]);
  assert.deepEqual(leftAt(dir), ["voice-service"]);
  assert.equal(now.value("guard_trusted_mcp_servers"), undefined);
  assert.deepEqual(now.projects, [{ project: "research", agent: "home", memory_off: 1 }]);
  const voice = voiceIn(dir);
  assert.deepEqual([voice.voice, voice.table], [{ provider: "pithagoras-voice", vad: VAD, responseInstructions: "" }, false]);
  assert.deepEqual(voiceLeft(dir, "voice-service", "voices.json").map((v) => v.name), ["Aria"]);
  assert.deepEqual(modesIn(dir), { chats: [{ id: "c1", mode: null }], made: [] });
});

test("a database of version 8 whose voice mode listened at the person's own addresses, and which ran Understory, leaves all three for their extensions in one start", async () => {
  const dir = path.join(home, "both-from-8");
  const own = { ...FRIDAY_VOICE, whisperUrl: OWN.whisper, sttModel: "my-model", breezeUrl: OWN.speech, runtime: "kokoro", kokoroVoice: "am_onyx" };
  voiceOfV8(dir, { voice: own, ...UNDERSTORY_KEPT }, [ARIA]);
  const d = new Database(path.join(dir, "portal.db"));
  d.prepare("INSERT INTO project_agent (project, agent, understory_off) VALUES ('research', 'home', 1)").run();
  d.close();
  assert.match(await upgradedWith(dir, UNDERSTORY_ENTRY), new RegExp(`upgrading the database from version 8 to ${SCHEMA_VERSION}`));
  const backups = backupsIn(path.join(dir, "backups"));
  assert.equal(backups.length, 1, "one backup, of version 8");
  assert.match(path.basename(backups[0]), /^portal-v8-\d{8}-\d{6}\.db$/);

  const now = understoryIn(dir);
  assert.deepEqual([now.version, now.fingerprint], [SCHEMA_VERSION, PINNED.fingerprint]);
  assert.deepEqual(leftAt(dir), ["understory", "voice-addresses", "voice-service"]);
  for (const [name, schema] of [["voice-service", 9], ["voice-addresses", 9], ["understory", 10]]) {
    const { made: _made, ...about } = JSON.parse(readFileSync(path.join(dir, "handoff", name, "handoff.json"), "utf8"));
    assert.deepEqual(about, { format: 1, name, schema }, name);
  }
  assert.deepEqual(voiceLeft(dir, "voice-service", "settings.json"), serviceOf(own));
  assert.deepEqual(voiceLeft(dir, "voice-service", "voices.json").map((v) => v.name), ["Aria"]);
  assert.deepEqual(voiceLeft(dir, "voice-addresses", "settings.json"), addressesOf(own));
  assert.deepEqual(understoryLeft(dir, "settings.json"), UNDERSTORY_KEPT);
  for (const key of Object.keys(UNDERSTORY_KEPT)) assert.equal(now.value(key), undefined, key);
  assert.equal(now.value("guard_trusted_mcp_servers"), JSON.stringify(["understory"]));
  assert.deepEqual(now.projects, [{ project: "research", agent: "home", memory_off: 1 }]);
  const voice = voiceIn(dir);
  assert.deepEqual([voice.voice, voice.table], [{ provider: "pithagoras-voice-servers", vad: VAD, responseInstructions: "" }, false]);
});

/** The modes of the chats in the upgraded database, and the modes the person made. */
function modesIn(dir) {
  const d = new Database(path.join(dir, "portal.db"), { readonly: true });
  try {
    return { chats: d.prepare("SELECT id, mode FROM sessions ORDER BY id").all(), made: d.prepare("SELECT * FROM chat_modes").all() };
  } finally {
    d.close();
  }
}

test("a database of version 10 is backed up and given chat modes: every chat is in Standard, and there are no modes of the person's own", async () => {
  const dir = path.join(home, "modes-from-10");
  mkdirSync(dir, { recursive: true });
  const d = freshAt10(path.join(dir, "portal.db"));
  d.pragma("user_version = 10");
  assert.equal(schemaFingerprint(d), V10_FINGERPRINT, "the schema of version 10");
  const chat = d.prepare("INSERT INTO sessions (id, title, workspace, kind) VALUES (?, ?, ?, 'task')");
  chat.run("c1", "Kites", "/w/site");
  chat.run("c2", "Notes", "/w/notes");
  d.close();
  assert.deepEqual(upgradeCheck(path.join(dir, "portal.db")), { needed: true, from: 10 });
  assert.match(await upgraded(dir), new RegExp(`upgrading the database from version 10 to ${SCHEMA_VERSION}`));
  const backups = backupsIn(path.join(dir, "backups"));
  assert.equal(backups.length, 1);
  assert.match(path.basename(backups[0]), /^portal-v10-\d{8}-\d{6}\.db$/);

  const now = new Database(path.join(dir, "portal.db"), { readonly: true });
  assert.deepEqual([now.pragma("user_version", { simple: true }), schemaFingerprint(now)], [SCHEMA_VERSION, PINNED.fingerprint]);
  now.close();
  assert.deepEqual(modesIn(dir), { chats: [{ id: "c1", mode: null }, { id: "c2", mode: null }], made: [] });
});

/**
 * pi's settings.json while the test runs `work`, holding `text`; what was there before is put back after. The upgrade
 * reads it from where every test's pi has its folder.
 */
async function withPiSettings(text, work) {
  const file = path.join(process.env.PI_CODING_AGENT_DIR, "settings.json");
  mkdirSync(path.dirname(file), { recursive: true });
  const before = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  writeFileSync(file, text);
  try {
    return await work(file);
  } finally {
    if (before === undefined) rmSync(file, { force: true });
    else writeFileSync(file, before);
    rmSync(`${file}.bak`, { force: true });
  }
}

/** A database of version 11 in its own folder `name`, with one chat: the schema of version 11, which 12 kept. */
function databaseAt11(name) {
  const dir = path.join(home, name);
  mkdirSync(dir, { recursive: true });
  const d = freshAt12(path.join(dir, "portal.db"));
  d.pragma("user_version = 11");
  assert.equal(schemaFingerprint(d), V11_FINGERPRINT, "the schema of version 11");
  d.prepare("INSERT INTO sessions (id, title, workspace, kind) VALUES ('c1', 'Kites', '/w/site', 'task')").run();
  d.close();
  return dir;
}

test("the subagent settings in pi's settings.json are left for its extension at schema 12, and leave pi's file, the rest of it kept", async () => {
  const dir = databaseAt11("subagent-out");
  assert.deepEqual(upgradeCheck(path.join(dir, "portal.db")), { needed: true, from: 11 });
  const others = { packages: ["../../extensions/subagent"], defaultProvider: "llama-swap" };
  await withPiSettings(JSON.stringify({ ...others, subagentMode: "background", subagentMaxParallel: 3 }), async (file) => {
    assert.match(await upgraded(dir), new RegExp(`upgrading the database from version 11 to ${SCHEMA_VERSION}`));
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), others);
    // What pi's file was is kept beside it, as every change of it keeps it.
    assert.deepEqual(JSON.parse(readFileSync(`${file}.bak`, "utf8")), { ...others, subagentMode: "background", subagentMaxParallel: 3 });
  });
  assert.match(path.basename(backupsIn(path.join(dir, "backups"))[0]), /^portal-v11-\d{8}-\d{6}\.db$/);
  const now = new Database(path.join(dir, "portal.db"), { readonly: true });
  assert.deepEqual([now.pragma("user_version", { simple: true }), schemaFingerprint(now)], [SCHEMA_VERSION, PINNED.fingerprint]);
  now.close();
  assert.deepEqual(leftAt(dir), ["subagent"], "nothing half done beside it");
  const left = (name) => path.join(dir, "handoff", "subagent", name);
  const { made: _made, ...about } = JSON.parse(readFileSync(left("handoff.json"), "utf8"));
  assert.deepEqual(about, { format: 1, name: "subagent", schema: 12 });
  assert.deepEqual(JSON.parse(readFileSync(left("settings.json"), "utf8")), { subagentMode: "background", subagentMaxParallel: 3, subagentModel: null });
  assert.equal(modeOf(left("settings.json")), 0o600);
});

test("pi's settings with none of the subagent's, or that cannot be read, leave nothing and are not changed", async () => {
  for (const [name, text] of [["subagent-none", JSON.stringify({ defaultProvider: "llama-swap" })], ["subagent-unreadable", '{ "subagentMode": "background", ']]) {
    const dir = databaseAt11(name);
    await withPiSettings(text, async (file) => {
      await upgraded(dir);
      assert.equal(readFileSync(file, "utf8"), text, name);
    });
    assert.deepEqual(leftAt(dir), [], name);
  }
});

test("pi's settings that cannot be written keep the subagent's for the next start, which takes them out and leaves them once", async () => {
  const dir = databaseAt11("subagent-kept");
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const text = JSON.stringify({ subagentModel: "llama-swap/model-b" });
  await withPiSettings(text, async (file) => {
    chmodSync(agentDir, 0o555);
    try {
      assert.match(await upgraded(dir), /could not be left for its extension, and are kept for the next start/);
    } finally {
      chmodSync(agentDir, 0o755);
    }
    assert.equal(readFileSync(file, "utf8"), text);
    await upgraded(dir);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {});
  });
  assert.deepEqual(leftAt(dir), ["subagent"]);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "handoff", "subagent", "settings.json"), "utf8")), { subagentMode: null, subagentMaxParallel: null, subagentModel: "llama-swap/model-b" });
});

test("a subagent hand-off that waits from an earlier upgrade is written anew from the keys pi's settings hold now", async () => {
  const dir = databaseAt11("subagent-again");
  const left = (name) => path.join(dir, "handoff", "subagent", name);
  await withPiSettings(JSON.stringify({ subagentMode: "background" }), () => upgraded(dir));
  assert.deepEqual(JSON.parse(readFileSync(left("settings.json"), "utf8")), { subagentMode: "background", subagentMaxParallel: null, subagentModel: null });
  // Gone back to the older version, the person raised the limit there; the database is at 11 again, as its backup is put in.
  const d = new Database(path.join(dir, "portal.db"));
  d.pragma("user_version = 11");
  d.close();
  await withPiSettings(JSON.stringify({ subagentMode: "background", subagentMaxParallel: 4 }), async (file) => {
    await upgraded(dir);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {});
  });
  assert.deepEqual(JSON.parse(readFileSync(left("settings.json"), "utf8")), { subagentMode: "background", subagentMaxParallel: 4, subagentModel: null });
  assert.deepEqual(leftAt(dir), ["subagent"]);
});

test("a copy of the subagent tool that is no extension keeps its settings in pi's file, which it still reads, and says so", async () => {
  const dir = databaseAt11("subagent-copy");
  const copy = path.join(home, "subagent-clone");
  mkdirSync(copy, { recursive: true });
  writeFileSync(path.join(copy, "package.json"), JSON.stringify({ name: "pithagoras-subagent", version: "0.1.0", pi: { extensions: ["./index.ts"] } }));
  const text = JSON.stringify({ packages: [copy], subagentMode: "background" });
  await withPiSettings(text, async (file) => {
    assert.match(await upgraded(dir), /subagent settings stay in pi's settings\.json/);
    assert.equal(readFileSync(file, "utf8"), text);
    // The same folder with a server half is the extension, and the settings go.
    writeFileSync(path.join(copy, "package.json"), JSON.stringify({ name: "pithagoras-subagent", version: "0.2.0", pithagoras: { server: "server.js" } }));
    await upgraded(dir);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { packages: [copy] });
  });
  assert.deepEqual(leftAt(dir), ["subagent"]);
});

test("a database of version 12, or of 11, is backed up and given child chats at schema 13: every chat is one of its own, and listed", async () => {
  for (const [version, fingerprint] of [[12, V12_FINGERPRINT], [11, V11_FINGERPRINT]]) {
    const dir = path.join(home, `children-from-${version}`);
    mkdirSync(dir, { recursive: true });
    const d = freshAt12(path.join(dir, "portal.db"));
    d.pragma(`user_version = ${version}`);
    assert.equal(schemaFingerprint(d), fingerprint, `the schema of version ${version}`);
    const chat = d.prepare("INSERT INTO sessions (id, title, workspace, kind) VALUES (?, ?, ?, ?)");
    chat.run("c1", "Kites", "/w/site", "task");
    chat.run("c2", "From a channel", "/w/notes", "agent");
    d.close();
    assert.deepEqual(upgradeCheck(path.join(dir, "portal.db")), { needed: true, from: version });
    assert.match(await upgraded(dir), new RegExp(`upgrading the database from version ${version} to ${SCHEMA_VERSION}`));
    const backups = backupsIn(path.join(dir, "backups"));
    assert.equal(backups.length, 1, `one backup, of version ${version}`);
    assert.match(path.basename(backups[0]), new RegExp(`^portal-v${version}-\\d{8}-\\d{6}\\.db$`));

    const now = new Database(path.join(dir, "portal.db"), { readonly: true });
    try {
      assert.deepEqual([now.pragma("user_version", { simple: true }), schemaFingerprint(now)], [SCHEMA_VERSION, PINNED.fingerprint]);
      assert.deepEqual(now.prepare("SELECT id, parent_id, listed, creator FROM sessions ORDER BY id").all(), [
        { id: "c1", parent_id: null, listed: 1, creator: null },
        { id: "c2", parent_id: null, listed: 1, creator: null },
      ]);
    } finally {
      now.close();
    }
  }
});

/** A database of version 13 in its own folder `name`, with what chats said their subagents run on: `said`, by chat id. */
function databaseAt13(name, said) {
  const dir = path.join(home, name);
  mkdirSync(dir, { recursive: true });
  const d = freshAt13(path.join(dir, "portal.db"));
  assert.equal(schemaFingerprint(d), V13_FINGERPRINT, "the schema of version 13");
  d.pragma("user_version = 13");
  for (const [chat, model] of Object.entries(said)) d.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(`subagent_model:${chat}`, model);
  d.close();
  return dir;
}
const subagentRows = (dir) => {
  const d = new Database(path.join(dir, "portal.db"), { readonly: true });
  try {
    return d.prepare("SELECT key, value FROM settings WHERE key LIKE 'subagent%' ORDER BY key").all();
  } finally {
    d.close();
  }
};

test("what each chat said its subagents run on is left for the subagent extension at schema 14, and leaves the database", async () => {
  const dir = databaseAt13("subagent-chats-out", { c1: "llama-swap/model-b", c2: "auto", c3: "" });
  assert.deepEqual(upgradeCheck(path.join(dir, "portal.db")), { needed: true, from: 13 });
  assert.match(await upgraded(dir), new RegExp(`upgrading the database from version 13 to ${SCHEMA_VERSION}`));
  assert.match(path.basename(backupsIn(path.join(dir, "backups"))[0]), /^portal-v13-\d{8}-\d{6}\.db$/);
  const now = new Database(path.join(dir, "portal.db"), { readonly: true });
  assert.deepEqual([now.pragma("user_version", { simple: true }), schemaFingerprint(now)], [SCHEMA_VERSION, PINNED.fingerprint]);
  now.close();
  assert.deepEqual(subagentRows(dir), []);
  assert.deepEqual(leftAt(dir), ["subagent-chats"], "nothing half done beside it");
  const left = (name) => path.join(dir, "handoff", "subagent-chats", name);
  const { made: _made, ...about } = JSON.parse(readFileSync(left("handoff.json"), "utf8"));
  assert.deepEqual(about, { format: 1, name: "subagent-chats", schema: 14 });
  // The chat that said the default again ("") said nothing.
  assert.deepEqual(JSON.parse(readFileSync(left("models.json"), "utf8")), { c1: "llama-swap/model-b", c2: "auto" });
  assert.equal(modeOf(left("models.json")), 0o600);
});

test("chats that only ever went back to the default leave nothing for the subagent extension, and their settings go", async () => {
  const dir = databaseAt13("subagent-chats-none", { c1: "", c2: "" });
  await upgraded(dir);
  assert.deepEqual(subagentRows(dir), []);
  assert.deepEqual(leftAt(dir), []);
});

test("a chats' hand-off that waits from an earlier upgrade keeps what it has, with what the chats say now over it", async () => {
  const dir = databaseAt13("subagent-chats-again", { c1: "llama-swap/model-b", c2: "auto" });
  await upgraded(dir);
  // Gone back to the older version, the person chose again in two chats, one of them new; the database is at 13 again.
  const d = new Database(path.join(dir, "portal.db"));
  d.pragma("user_version = 13");
  d.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("subagent_model:c2", "vllm/model-c");
  d.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("subagent_model:c4", "auto");
  d.close();
  await upgraded(dir);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "handoff", "subagent-chats", "models.json"), "utf8")), { c1: "llama-swap/model-b", c2: "vllm/model-c", c4: "auto" });
  assert.deepEqual(subagentRows(dir), []);
  assert.deepEqual(leftAt(dir), ["subagent-chats"]);
});

test("a chats' hand-off that cannot be left keeps what the chats said in the database, for the next start", async () => {
  const dir = databaseAt13("subagent-chats-kept", { c1: "llama-swap/model-b" });
  // A file where the hand-off's folder would go: nothing can be left in it.
  writeFileSync(path.join(dir, "handoff"), "");
  assert.match(await upgraded(dir), /could not be left for the subagent extension, and is kept for the next start/);
  assert.deepEqual(subagentRows(dir), [{ key: "subagent_model:c1", value: "llama-swap/model-b" }]);
  rmSync(path.join(dir, "handoff"));
  await upgraded(dir);
  assert.deepEqual(subagentRows(dir), []);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "handoff", "subagent-chats", "models.json"), "utf8")), { c1: "llama-swap/model-b" });
});

test("a database of version 14, or of 13, is backed up and given the index on the questions a chat asked at schema 15, its chats and questions kept", async () => {
  for (const [version, fingerprint] of [[14, V14_FINGERPRINT], [13, V13_FINGERPRINT]]) {
    const dir = path.join(home, `questions-from-${version}`);
    mkdirSync(dir, { recursive: true });
    const d = freshAt13(path.join(dir, "portal.db"));
    d.pragma(`user_version = ${version}`);
    assert.equal(schemaFingerprint(d), fingerprint, `the schema of version ${version}`);
    d.prepare("INSERT INTO sessions (id, title, workspace, kind) VALUES ('c1', 'Kites', '/w/site', 'task')").run();
    d.prepare("INSERT INTO sessions (id, title, workspace, kind, parent_id, listed) VALUES ('c2', 'Tails', '/w/site', 'task', 'c1', 0)").run();
    d.prepare("INSERT INTO events (session_id, type, payload) VALUES ('c2', 'portal_question', '{}')").run();
    d.close();
    assert.deepEqual(upgradeCheck(path.join(dir, "portal.db")), { needed: true, from: version });
    assert.match(await upgraded(dir), new RegExp(`upgrading the database from version ${version} to ${SCHEMA_VERSION}`));
    const backups = backupsIn(path.join(dir, "backups"));
    assert.equal(backups.length, 1, `one backup, of version ${version}`);
    assert.match(path.basename(backups[0]), new RegExp(`^portal-v${version}-\\d{8}-\\d{6}\\.db$`));

    const now = new Database(path.join(dir, "portal.db"), { readonly: true });
    try {
      assert.deepEqual([now.pragma("user_version", { simple: true }), schemaFingerprint(now)], [SCHEMA_VERSION, PINNED.fingerprint]);
      assert.ok(now.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_questions'").get(), "the index is made");
      assert.deepEqual(now.prepare("SELECT id, parent_id, listed FROM sessions ORDER BY id").all(), [
        { id: "c1", parent_id: null, listed: 1 },
        { id: "c2", parent_id: "c1", listed: 0 },
      ]);
      assert.deepEqual(now.prepare("SELECT session_id, type FROM events").all(), [{ session_id: "c2", type: "portal_question" }]);
    } finally {
      now.close();
    }
  }
});

test("a database of version 15, or of 14, is backed up and given chats nobody attends and children on the defaults at schema 16, its chats kept as they were", async () => {
  for (const [version, fingerprint, make] of [[15, V15_FINGERPRINT, freshAt15], [14, V14_FINGERPRINT, freshAt13]]) {
    const dir = path.join(home, `unattended-from-${version}`);
    mkdirSync(dir, { recursive: true });
    const d = make(path.join(dir, "portal.db"));
    d.pragma(`user_version = ${version}`);
    assert.equal(schemaFingerprint(d), fingerprint, `the schema of version ${version}`);
    d.prepare("INSERT INTO sessions (id, title, workspace, kind) VALUES ('c1', 'Kites', '/w/site', 'task')").run();
    d.prepare("INSERT INTO sessions (id, title, workspace, kind, parent_id, listed, creator) VALUES ('c2', 'Tails', '/w/site', 'task', 'c1', 0, 'helper')").run();
    d.close();
    assert.deepEqual(upgradeCheck(path.join(dir, "portal.db")), { needed: true, from: version });
    assert.match(await upgraded(dir), new RegExp(`upgrading the database from version ${version} to ${SCHEMA_VERSION}`));
    const backups = backupsIn(path.join(dir, "backups"));
    assert.equal(backups.length, 1, `one backup, of version ${version}`);
    assert.match(path.basename(backups[0]), new RegExp(`^portal-v${version}-\\d{8}-\\d{6}\\.db$`));

    const now = new Database(path.join(dir, "portal.db"), { readonly: true });
    try {
      assert.deepEqual([now.pragma("user_version", { simple: true }), schemaFingerprint(now)], [SCHEMA_VERSION, PINNED.fingerprint]);
      assert.deepEqual(now.prepare("SELECT id, parent_id, unattended, tools_from FROM sessions ORDER BY id").all(), [
        { id: "c1", parent_id: null, unattended: 0, tools_from: null },
        { id: "c2", parent_id: "c1", unattended: 0, tools_from: null },
      ]);
    } finally {
      now.close();
    }
  }
});

// A data folder of v0.1.0 that used every part an extension holds now, each kept as v0.1.0 kept it, on fixtures/portal-v3.db:
// a chat with a canvas, a picture of the Media page with its file, the image endpoint, voice mode on at the voice service's
// addresses with the person's own remembered as connecting it kept them, a designed voice and a clone, the GPU chosen,
// Understory's four settings and its MCP entry, the browser's six settings and the local Chrome's profile, the allowlist,
// a heartbeat's rule for a tool that runs as the primary user, the tools as a chat reported them, and names given to the
// pictures' and the browser's sets. One start takes it to this version, with one backup, and leaves each part for its
// extension; what the extensions do with it is in their own tests.
test("a data folder of v0.1.0 that used every part is brought to this version in one start, with one backup, and each part left for its extension", async () => {
  const dir = path.join(home, "everything-from-v3");
  const site = path.join(dir, "ws", "site");
  mkdirSync(site, { recursive: true });
  const file = path.join(dir, "portal.db");
  copyFileSync(new URL("./fixtures/portal-v3.db", import.meta.url), file);
  const before = new Database(file);
  before.prepare("INSERT INTO sessions (id, title, workspace, kind) VALUES ('c1', 'Kites', ?, 'task')").run(site);
  before.prepare("INSERT INTO canvases (id, session_id, title, content) VALUES ('k1', 'c1', 'Plan', '# Plan\n\nFly it.')").run();
  before.prepare(`INSERT INTO images (${IMAGE_COLUMNS}) VALUES (${IMAGE_COLUMNS.map(() => "?")})`).run(["aaaaaaaaaaa1", "page", null, null, "aaaaaaaaaaa1.png", "generated", "a red kite", "{}", null, 14, 1000]);
  const calm = { id: "voice-5b1e0c9a-0d7e-4f3c-8a2b-6c4d2e1f0a9b", name: "Calm", kind: "design", instruction: "Slow and low.", transcript: "", audio: null };
  const voice = before.prepare("INSERT INTO voice_presets (id, name, kind, instruction, transcript, audio) VALUES (?, ?, ?, ?, ?, ?)");
  for (const v of [calm, ARIA]) voice.run(v.id, v.name, v.kind, v.instruction, v.transcript, v.audio);
  const rule = before.prepare("INSERT INTO tool_rules (id, role, tool, pattern, note, person_key) VALUES (?, ?, ?, ?, '', NULL)");
  rule.run("r3", "heartbeat", "routine_update", "{*");
  rule.run("r4", "colleague", "bash", "echo up-*");
  // Voice mode as v0.1.0 saved it once the voice service was connected (api/voice.ts there).
  const voiceMode = {
    vad: VAD, lazyLoad: true, runtime: "audio-cpp", voice: ARIA.id, language: "en", cfgScale: 1, sttModel: "", exaggeration: 0.5, kokoroVoice: "af_heart", speed: 1,
    responseInstructions: "", skipThinkingProviders: ["llama-swap"], enabled: true, whisperUrl: SERVICE.whisper, breezeUrl: SERVICE.speech, instruction: DEFAULT_INSTRUCTION,
  };
  const remembered = { listening: { whisperUrl: OWN.whisper, sttModel: "", enabled: true }, speaking: { breezeUrl: OWN.speech, runtime: "kokoro", enabled: true }, noSpeech: false };
  const browserKept = { browser_user: "agent", browser_password: BROWSER_PASSWORD, browser_port: "3010", browser_https_port: "3011", browser_cursor: "0", browser_tools: "1" };
  const seen = [
    { name: "browser_navigate", source: "browser", package: null, inline: true },
    { name: "show_image", source: "pictures", package: null, inline: true },
    { name: "web_fetch", source: "pi-web-access", package: "npm:pi-web-access", inline: false },
  ];
  const setting = before.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  for (const [key, value] of Object.entries({
    voice: JSON.stringify(voiceMode),
    voice_gpu: "GPU-648bf6c5-346e-81f5-f155-dc8061172da3",
    voice_before_managed: JSON.stringify(remembered),
    image_generation: IMAGE_SETTINGS,
    ...UNDERSTORY_KEPT,
    ...browserKept,
    browser_allowlist: "*.example.com",
    tools_seen: JSON.stringify(seen),
    // v0.1.0 filed its picture tools as "<portal:images>" (web/src/tool-groups.ts there).
    tool_group_names: JSON.stringify({ "<portal:images>": "Pictures", browser: "Web browser", "pi-web-access": "Web" }),
  })) setting.run(key, value);
  before.close();
  mkdirSync(path.join(dir, "images"), { recursive: true });
  writeFileSync(path.join(dir, "images", "aaaaaaaaaaa1.png"), "the page's kite");
  mkdirSync(path.join(dir, "browser-profile", "Default"), { recursive: true });
  writeFileSync(path.join(dir, "browser-profile", "Default", "Cookies"), "the agent's logins");
  assert.deepEqual(upgradeCheck(file), { needed: true, from: 3 });

  assert.match(await upgradedWith(dir, UNDERSTORY_ENTRY), new RegExp(`upgrading the database from version 3 to ${SCHEMA_VERSION}`));
  const backups = backupsIn(path.join(dir, "backups"));
  assert.equal(backups.length, 1, "one backup, of version 3");
  assert.match(path.basename(backups[0]), /^portal-v3-\d{8}-\d{6}\.db$/);
  const copy = new Database(backups[0], { readonly: true });
  assert.deepEqual(
    ["canvases", "images", "voice_presets", "settings"].map((table) => copy.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n),
    [1, 1, 2, 2 + 3 + 1 + 4 + 6 + 3],
    "the copy from before holds all of it",
  );
  copy.close();

  const d = new Database(file, { readonly: true });
  assert.deepEqual([d.pragma("user_version", { simple: true }), schemaFingerprint(d)], [SCHEMA_VERSION, PINNED.fingerprint]);
  for (const table of ["canvases", "images", "voice_presets"]) assert.ok(!d.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(table), `${table} is gone`);
  const settings = Object.fromEntries(d.prepare("SELECT key, value FROM settings").all().map((row) => [row.key, row.value]));
  for (const key of ["voice_gpu", "voice_before_managed", "image_generation", ...Object.keys(UNDERSTORY_KEPT), ...Object.keys(browserKept)]) assert.equal(settings[key], undefined, key);
  assert.deepEqual(JSON.parse(settings.voice), { provider: "pithagoras-voice", vad: VAD, responseInstructions: "", skipThinkingProviders: ["llama-swap"] });
  assert.equal(settings.browser_allowlist, "*.example.com", "the allowlist stays the guard's");
  assert.equal(settings.guard_trusted_mcp_servers, JSON.stringify(["understory"]));
  assert.equal(settings.tools_off_default, "codemode\nweb_search");
  assert.deepEqual(JSON.parse(settings.tool_group_names), { "pithagoras-media": "Pictures", "pithagoras-browser": "Web browser", "pi-web-access": "Web" });
  assert.deepEqual(JSON.parse(settings.tools_seen), [
    { ...seen[0], source: "pithagoras-browser" },
    { ...seen[1], source: "pithagoras-media" },
    seen[2],
  ]);
  assert.deepEqual(d.prepare("SELECT id FROM tool_rules ORDER BY id").all(), [{ id: "r4" }], "a heartbeat's rule for a tool that runs as the primary user goes too");
  d.close();
  assert.deepEqual(modesIn(dir), { chats: [{ id: "c1", mode: null }], made: [] });
  assert.equal(readFileSync(path.join(site, "canvases", "Plan.md"), "utf8"), "# Plan\n\nFly it.");

  // Each part left for its extension, at the schema that left it.
  assert.deepEqual(leftAt(dir), ["browser", "media", "understory", "voice-addresses", "voice-service"], "nothing half done beside them");
  for (const [name, schema] of [["media", 7], ["browser", 8], ["voice-service", 9], ["voice-addresses", 9], ["understory", 10]]) {
    const { made: _made, ...about } = JSON.parse(readFileSync(path.join(dir, "handoff", name, "handoff.json"), "utf8"));
    assert.deepEqual(about, { format: 1, name, schema }, name);
  }
  const left = (name, rel) => readFileSync(path.join(dir, "handoff", name, rel), "utf8");
  assert.deepEqual(JSON.parse(left("media", "settings.json")), { image_generation: IMAGE_SETTINGS, video_generation: null });
  assert.deepEqual(JSON.parse(left("media", "images.json")).rows.map((row) => row.id), ["aaaaaaaaaaa1"]);
  assert.equal(left("media", "files/images/aaaaaaaaaaa1.png"), "the page's kite");
  assert.deepEqual(JSON.parse(left("browser", "settings.json")), browserKept);
  assert.equal(left("browser", "profile/Default/Cookies"), "the agent's logins");
  assert.equal(existsSync(path.join(dir, "browser-profile")), false);
  assert.deepEqual(voiceLeft(dir, "voice-service", "settings.json"), serviceOf(voiceMode, "GPU-648bf6c5-346e-81f5-f155-dc8061172da3"));
  const { audio: _audio, ...aria } = ARIA;
  assert.deepEqual(voiceLeft(dir, "voice-service", "voices.json"), [calm, { ...aria, audio: "voices/1.wav" }]);
  assert.equal(sha256(readFileSync(path.join(dir, "handoff", "voice-service", "voices", "1.wav"))), sha256(ARIA.audio));
  assert.deepEqual(voiceLeft(dir, "voice-addresses", "settings.json"), {
    whisperUrl: OWN.whisper, sttModel: "", breezeUrl: OWN.speech, runtime: "kokoro", dictationUrl: null, dictationModel: null, language: "en", kokoroVoice: "af_heart",
  });
  assert.deepEqual(understoryLeft(dir, "settings.json"), UNDERSTORY_KEPT);
});
