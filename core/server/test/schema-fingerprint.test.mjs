import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
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
const PINNED = { version: 7, fingerprint: "409b5243d409e83047250a4c34dea217699b16f8e7ab13e861396938f3bf78ee" };

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
    const voices = await import(${dist("voice-presets.js")});
    console.log("RESULT " + JSON.stringify({
      title: db.getSession("chat1")?.title,
      messages: db.sentMessages("chat1").map((x) => x.message),
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
  assert.equal(d.prepare("SELECT COUNT(*) AS n FROM voice_presets").get().n, 1);
  assert.deepEqual(d.prepare("SELECT id FROM tool_rules ORDER BY id").all(), [{ id: "r4" }], "what never applies is not left listed as a rule that does");
  assert.deepEqual(d.prepare("SELECT id, home FROM agents").all(), [{ id: "home", home: "/data/home" }], "the agent's folder is a neutral one");
  d.close();

  // And the portal reads it.
  const result = JSON.parse(/RESULT (.*)/.exec(run.output())[1]);
  assert.deepEqual(result, { title: "A chat from the 2026-10-02 build", messages: ["Write the summary", "Shorter, please"], voices: ["Calm"] });
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
// tool switches of their own and agents a table of them (#81), and projects a table of the agent they work with (#127).
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
  assert.deepEqual(result.news, { off: [], on: ["browser_navigate"] }, "Browser on stays on");
  assert.deepEqual(result.tidy, { off: ["browser_navigate"], on: [] }, "Browser off stays off");
  assert.deepEqual(result.project, { off: ["bash"], on: [] });
  // And code mode, which an upgrade switches off by default beside what the operator had.
  assert.deepEqual(result.defaults, ["codemode", "web_search"]);
  assert.equal(result.agentTools, 0, "no agent says anything yet");
  assert.deepEqual(result.projectAgent, { agent: "", understoryOff: false }, "a project of v0.1.0 is a blank slate, as it was");
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

// Pictures and videos are an extension's from version 7 (extensions/media), with a store of its own. A database of version 6
// is the schema pinned now with the two tables of the Media page: made here from a fresh one, and checked to be that by
// the fingerprint version 6 was pinned with.
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
  const file = path.join(dir, "portal.db");
  getDb().exec(`VACUUM INTO '${file}'`);
  const d = new Database(file);
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
  // And a tool of the same name an extension brought, which a chat reported since: it stays the extension's.
  const before = new Database(path.join(dir, "portal.db"));
  const theirs = { name: "generate_image", source: "my-images", package: "npm:my-images", inline: false };
  before.prepare("UPDATE settings SET value = ? WHERE key = 'tools_seen'").run(JSON.stringify(SEEN.map((tool) => (tool.name === theirs.name ? theirs : tool))));
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
  d.close();
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
