import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, openSync, writeSync, closeSync, utimesSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { freePort, inProcessHome } from "./server-harness.mjs";

const home = inProcessHome("pithagoras-upgrade-");

const { DamagedDatabase, backupTo, backupsIn, integrityProblems, pruneBackups, runUpgrade } = await import("../dist/db-upgrade-steps.js");
const { SCHEMA_VERSION } = await import("../dist/schema-version.js");
const { repairSteps, upgradeCheck } = await import("../dist/db-upgrade.js");

/** A database as an older portal left it: sessions and events, no version. */
function oldDatabase(file, rows = 2000) {
  const d = new Database(file);
  d.pragma("journal_mode = WAL");
  d.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle');
          CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));`);
  d.prepare("INSERT INTO sessions (id, title, workspace) VALUES ('s1', 'kept', '/tmp')").run();
  const add = d.prepare("INSERT INTO events (session_id, type, payload) VALUES ('s1', 'message', ?)");
  d.transaction(() => { for (let i = 0; i < rows; i++) add.run(JSON.stringify({ text: "x".repeat(200), i })); })();
  d.close();
}
const hash = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
/** Overwrites a page in the middle of the file: a table's pages, not the header. */
function damage(file) {
  const fd = openSync(file, "r+");
  writeSync(fd, Buffer.alloc(4096, 0xab), 0, 4096, 4096 * 20);
  closeSync(fd);
}
const fresh = (name) => { const dir = path.join(home, name); mkdirSync(dir, { recursive: true }); return { dir, file: path.join(dir, "portal.db") }; };

test("a new install needs no upgrade; an old database does, from version 0", () => {
  const a = fresh("check");
  assert.deepEqual(upgradeCheck(a.file), { needed: false, from: 0 });
  oldDatabase(a.file, 10);
  assert.deepEqual(upgradeCheck(a.file), { needed: true, from: 0 });
});

test("a healthy database is backed up, then upgraded, and the copy holds what was there", async () => {
  const a = fresh("healthy");
  oldDatabase(a.file);
  const said = [];
  let migrated = false;
  const backup = await runUpgrade({ file: a.file, from: 0, backupDir: path.join(a.dir, "backups"), migrate: async () => {
    const d = new Database(a.file); d.pragma(`user_version = ${SCHEMA_VERSION}`); d.close(); migrated = true;
  } }, (m) => said.push(m));
  assert.ok(migrated);
  assert.ok(backup && existsSync(backup));
  const copy = new Database(backup, { readonly: true });
  assert.equal(copy.prepare("SELECT title FROM sessions").get().title, "kept");
  assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM events").get().n, 2000);
  copy.close();
  assert.ok(said.some((m) => m.startsWith("Checking")) && said.some((m) => m.startsWith("Backing up")) && said.at(-1).startsWith("Upgrading"));
  assert.equal(upgradeCheck(a.file).needed, false);
});

test("a damaged database is found before anything changes, and is not backed up", async () => {
  const a = fresh("damaged");
  oldDatabase(a.file);
  damage(a.file);
  assert.ok(integrityProblems(a.file).length > 0);
  const before = hash(a.file);
  let migrated = false;
  await assert.rejects(runUpgrade({ file: a.file, from: 0, backupDir: path.join(a.dir, "backups"), migrate: async () => { migrated = true; } }, () => {}),
    (e) => e instanceof DamagedDatabase && /damaged/.test(e.message));
  assert.equal(migrated, false);
  assert.equal(hash(a.file), before);
  assert.deepEqual(backupsIn(path.join(a.dir, "backups")), []);
});

test("with no room for the backup it refuses, and changes nothing", async () => {
  const a = fresh("full");
  oldDatabase(a.file, 50);
  let migrated = false;
  await assert.rejects(runUpgrade({ file: a.file, from: 0, backupDir: path.join(a.dir, "backups"), free: () => 0, migrate: async () => { migrated = true; } }, () => {}),
    /not room to back up/);
  assert.equal(migrated, false);
  assert.equal(upgradeCheck(a.file).needed, true);
});

test("only the newest backups are kept, and nothing else in the folder is touched", () => {
  const dir = fresh("prune").dir;
  const names = ["portal-v0-20260101-000000.db", "portal-v0-20260102-000000.db", "portal-v1-20260103-000000.db", "notes.txt"];
  names.forEach((n, i) => { const f = path.join(dir, n); writeFileSync(f, "x"); utimesSync(f, 1000 + i, 1000 + i); });
  pruneBackups(dir, 2);
  assert.ok(!existsSync(path.join(dir, names[0])));
  assert.ok(existsSync(path.join(dir, names[1])) && existsSync(path.join(dir, names[2])) && existsSync(path.join(dir, "notes.txt")));
});

/** Runs prepareDatabase() as the server would, in its own process, on a data folder and port of its own. */
function startUpgrade(dataDir, port) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(new URL("../dist/db-upgrade.js", import.meta.url).href)}); await m.prepareDatabase(); console.log("READY");`],
    { env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), PORTAL_PASSWORD: "", ALLOW_OPEN: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { out += c; });
  return { child, output: () => out };
}
const until = async (ok, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ok()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

test("a whole upgrade on startup: backed up, upgraded with the real migrations, then it returns", async () => {
  const a = fresh("startup");
  oldDatabase(a.file, 500);
  const run = startUpgrade(a.dir, await freePort());
  const exited = await new Promise((resolve) => run.child.on("exit", resolve));
  assert.equal(exited, 0, run.output());
  assert.match(run.output(), /READY/);
  assert.equal(upgradeCheck(a.file).needed, false);
  assert.equal(backupsIn(path.join(a.dir, "backups")).length, 1);
  const d = new Database(a.file, { readonly: true });
  assert.equal(d.prepare("SELECT title FROM sessions WHERE id = 's1'").get().title, "kept");
  d.close();
});

test("a damaged database on startup keeps the page up with how to repair it, rather than exiting", async () => {
  const a = fresh("startup-damaged");
  oldDatabase(a.file);
  damage(a.file);
  const port = await freePort();
  const run = startUpgrade(a.dir, port);
  try {
    assert.ok(await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/api/sessions`)).status === 500; } catch { return false; } }), run.output());
    // The answers above are this process's page, not whatever else listens on a port: it was there to be had.
    assert.doesNotMatch(run.output(), /could not be shown/);
    const api = await (await fetch(`http://127.0.0.1:${port}/api/sessions`)).json();
    assert.match(api.error, /damaged/);
    assert.equal(api.upgrading, false);
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(html, /To repair it/);
    assert.match(html, /\.recover/);
    assert.equal(run.child.exitCode, null, "still running");
    assert.doesNotMatch(run.output(), /READY/);
  } finally {
    run.child.kill();
  }
});

test("an upgrade whose page cannot have its port still upgrades", async () => {
  const a = fresh("port-taken");
  oldDatabase(a.file, 50);
  const { createServer } = await import("node:http");
  const holder = createServer(() => {});
  await new Promise((r) => holder.listen(0, "127.0.0.1", r));
  const run = startUpgrade(a.dir, holder.address().port);
  try {
    const exited = await new Promise((resolve) => run.child.on("exit", resolve));
    assert.equal(exited, 0, run.output());
    assert.match(run.output(), /upgrade page could not be shown/);
    assert.match(run.output(), /READY/);
    assert.equal(upgradeCheck(a.file).needed, false);
  } finally {
    holder.close();
  }
});

test("a backup that fails or is cut off leaves no file that could be taken for one, and the next try finds its room", async () => {
  const a = fresh("partial");
  oldDatabase(a.file, 60_000);
  const backups = path.join(a.dir, "backups");
  mkdirSync(backups, { recursive: true });
  // A good backup from before.
  const good = path.join(backups, "portal-v1-20260101-000000.db");
  writeFileSync(good, "good");
  utimesSync(good, 1000, 1000);
  // The process stops in the middle of the copy: a disk that fills, or a restart, does the same to it.
  const dest = path.join(backups, "portal-v0-20260102-000000.db");
  const script = `const m = await import(${JSON.stringify(new URL("../dist/db-upgrade-steps.js", import.meta.url).href)}); await m.backupTo(${JSON.stringify(a.file)}, ${JSON.stringify(dest)}, () => process.kill(process.pid, "SIGKILL"));`;
  const killed = await new Promise((resolve) => spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" }).on("exit", (code, signal) => resolve(signal)));
  assert.equal(killed, "SIGKILL");
  assert.ok(readdirSync(backups).some((f) => f.endsWith(".partial")), "what it had written is there, under a name of its own");
  assert.ok(!existsSync(dest), "and not under the name of a backup");
  assert.deepEqual(backupsIn(backups), [good], "so it is not counted, and not kept in place of a good one");
  pruneBackups(backups, 1);
  assert.ok(existsSync(good));

  // A copy that fails with an error leaves nothing either.
  const failing = path.join(backups, "portal-v0-20260104-000000.db");
  await assert.rejects(backupTo(a.file, failing, () => { throw new Error("the disk is full"); }), /disk is full/);
  assert.ok(!existsSync(failing) && !existsSync(failing + ".partial"));

  // The next try removes what was left before it looks for room: that file holds the space it needs.
  const leftover = readdirSync(backups).find((f) => f.endsWith(".partial"));
  assert.ok(leftover);
  let sawLeftover = true;
  const made = await runUpgrade({ file: a.file, from: 0, backupDir: backups, free: () => { sawLeftover = existsSync(path.join(backups, leftover)); return Infinity; }, migrate: async () => {} }, () => {});
  assert.equal(sawLeftover, false, "removed before the room is looked at");
  assert.ok(made && existsSync(made));
  assert.ok(readdirSync(backups).every((f) => /^portal-v\d+-\d{8}-\d{6}\.db$/.test(f)), readdirSync(backups).join(", "));
});

test("the repair steps name the container the portal is told it has, and have a form for a portal that is not in one", () => {
  const named = repairSteps({ PORTAL_CONTAINER_NAME: "pi-portal" }, "/srv/data", true).join("\n");
  assert.match(named, /docker stop pi-portal/);
  assert.match(named, /\.Mounts.*pi-portal\)/);
  assert.match(named, /docker start pi-portal/);
  assert.doesNotMatch(named, /pithagoras/);
  assert.match(repairSteps({}, "/srv/data", true).join("\n"), /docker stop pithagoras/, "the name the Compose files give it, when none is said");
  assert.doesNotMatch(repairSteps({ PORTAL_CONTAINER_NAME: "x; rm -rf /" }, "/srv/data", true).join("\n"), /x; rm/, "a name that is no container's is not put in a command");
  const native = repairSteps({}, "/srv/my data", false).join("\n");
  assert.match(native, /sqlite3 '\/srv\/my data\/portal\.db' \.recover \| sqlite3 '\/srv\/my data\/portal-recovered\.db'/);
  assert.doesNotMatch(native, /docker/);
});

test("a database from a newer portal is not opened: the page says so, and the file is as it was", async () => {
  const a = fresh("newer");
  oldDatabase(a.file, 20);
  const d = new Database(a.file);
  d.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
  d.close();
  assert.deepEqual(upgradeCheck(a.file), { needed: false, from: SCHEMA_VERSION + 1, newer: true });
  // One at the version is as it was: no check, no flag.
  const same = fresh("same-version");
  oldDatabase(same.file, 5);
  const e = new Database(same.file);
  e.pragma(`user_version = ${SCHEMA_VERSION}`);
  e.close();
  assert.deepEqual(upgradeCheck(same.file), { needed: false, from: SCHEMA_VERSION });

  const before = hash(a.file);
  const port = await freePort();
  const run = startUpgrade(a.dir, port);
  try {
    assert.ok(await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/api/sessions`)).status === 500; } catch { return false; } }), run.output());
    // The answers above are this process's page, not whatever else listens on a port: it was there to be had.
    assert.doesNotMatch(run.output(), /could not be shown/);
    const api = await (await fetch(`http://127.0.0.1:${port}/api/sessions`)).json();
    assert.match(api.error, /newer portal/);
    assert.equal(api.upgrading, false);
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(html, /from a newer version/);
    assert.doesNotMatch(html, /To repair it/);
    assert.equal(run.child.exitCode, null, "still running, not restarted into the same failure");
    assert.doesNotMatch(run.output(), /READY/);
  } finally {
    run.child.kill();
  }
  assert.equal(hash(a.file), before);
  assert.deepEqual(backupsIn(path.join(a.dir, "backups")), []);
});
