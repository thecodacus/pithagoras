import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fakeModel } from "./fake-model.mjs";
import { inProcessHome } from "./server-harness.mjs";

/**
 * An extension that installs, loads again and removes a package it wrote into its own data folder
 * (`portal.extensions.install`, `remove` and `status`), and writes rows in Audit (`portal.audit.record`). In this
 * process, with a stand-in pi that installs, removes and lists folders as pi 1.1.0 does, and a server half of the
 * test's own that does the installing; the portal's extension and package routes on a port of their own.
 */
const home = inProcessHome("pithagoras-extension-installs-");
const agent = process.env.PI_CODING_AGENT_DIR;
const model = await fakeModel();
writeFileSync(path.join(agent, "models.json"), JSON.stringify(model.models()));
const settings = path.join(agent, "settings.json");
writeFileSync(settings, JSON.stringify({ defaultProvider: "fake", defaultModel: "m", packages: [] }));

// pi, as far as the portal asks it to install, remove and list: a folder is kept relative to pi's own folder, and
// found again by where it leads; one listed already is left as it is, switched off or not. Each call is noted.
const calls = path.join(home, "pi-calls.log");
const bin = path.join(home, "fake-bin");
mkdirSync(bin, { recursive: true });
writeFileSync(
  path.join(bin, "pi"),
  `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const [command, arg] = process.argv.slice(2);
const file = ${JSON.stringify(settings)};
const agent = ${JSON.stringify(agent)};
fs.appendFileSync(${JSON.stringify(calls)}, command + " " + (arg ?? "") + "\\n");
const all = JSON.parse(fs.readFileSync(file, "utf8"));
const source = (p) => (typeof p === "string" ? p : p.source);
const where = (p) => path.resolve(agent, source(p));
if (command === "list") {
  process.stdout.write("User packages:\\n" + all.packages.map((p) => "  " + source(p) + "\\n    " + where(p) + "\\n").join(""));
} else if (command === "install") {
  if (!all.packages.some((p) => where(p) === path.resolve(arg))) all.packages.push(path.relative(agent, path.resolve(arg)) || ".");
  fs.writeFileSync(file, JSON.stringify(all));
} else if (command === "remove") {
  all.packages = all.packages.filter((p) => where(p) !== path.resolve(arg));
  fs.writeFileSync(file, JSON.stringify(all));
}
`,
);
chmodSync(path.join(bin, "pi"), 0o755);
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
const piCalls = (command) => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter((line) => line.startsWith(`${command} `)) : []);
const packages = () => JSON.parse(readFileSync(settings, "utf8")).packages;
const entriesFor = (folder) => packages().filter((p) => path.resolve(agent, typeof p === "string" ? p : p.source) === folder);

const { installLogCapture } = await import("../dist/logs.js");
installLogCapture();
const host = await import("../dist/extension-host.js");
const db = await import("../dist/db.js");
const { sessions } = await import("../dist/session-manager.js");
const { extensionsRouter, followPackages } = await import("../dist/api/extensions.js");
const { packagesRouter } = await import("../dist/api/packages.js");
const { default: express } = await import("express");
db.setSettings({ ...db.getSettings(), provider: "fake", model: "m" });
test.after(() => host.stopServerHalves());
test.after(() => {
  for (const id of [...sessions.live.keys()]) sessions.live.get(id).client.dispose();
});

// The extensions' routes before any body is read, as server.ts mounts them; then the routes of what is installed.
const app = express().use("/api/x", host.extensionRoutes).use(express.json()).use("/api", extensionsRouter(), packagesRouter());
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
test.after(() => server.close());
const call = async (method, url, body) => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const listed = async (name) => (await call("GET", "/api/extensions")).body.extensions.find((ext) => ext.name === name);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(done, what) {
  for (let i = 0; !(await done()); i++) {
    assert.ok(i < 400, `waited 10 s for ${what}`);
    await sleep(25);
  }
}

/** A package in a folder of its own, outside any extension's data folder: `package.json` with `meta`, and `files`. */
function folderAt(dir, meta, files = {}) {
  mkdirSync(dir, { recursive: true });
  if (meta) writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "1.0.0", type: "module", keywords: ["pi-package"], pi: {}, ...meta }));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}
const halfOf = (body) => `export default function (portal) {\n${body}\n}\n`;

// The test's own installer, put in pi's settings by its folder and started as the portal starts what is installed.
const installerDir = folderAt(path.join(home, "packages", "installer"), { name: "test-installer", pithagoras: { server: "./server.js" } }, { "server.js": halfOf("globalThis.installer = portal;") });
writeFileSync(settings, JSON.stringify({ ...JSON.parse(readFileSync(settings, "utf8")), packages: [path.relative(agent, installerDir)] }));
await followPackages();
/** @type {import("@pithagoras/extension-api/server").ServerPortal} */
const portal = globalThis.installer;
assert.ok(portal, "the installer runs");

/** A package the installer wrote into its own data folder, `made/<folder>`. */
const made = (folder, meta, files) => folderAt(path.join(portal.dataDir(), "made", folder), meta, files);
/** One with a server half, whose default export's body is `body`. */
const withServer = (name, body, more = {}) => made(name, { name, pithagoras: { server: "./server.js" } }, { "server.js": halfOf(body), ...more });

/** x: a route that answers `answer`, and a tool for every chat, whose factory throws in a chat called "breaks". */
const xHalf = (answer) => `portal.router.get("/hello", (req, res) => res.json({ hello: ${answer} }));
portal.chats.extend((pi, chat) => {
  if (chat.title === "breaks") throw new Error("the schema is wrong");
  pi.registerTool({ name: "x_echo", label: "Echo", description: "Says it back.", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: "echo" }], details: {} }; } });
});`;
const xDir = withServer("x", xHalf(1));
let xSpec;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

test("a package from its own data folder is installed and runs: its route answers, and Settings says where it came from", async () => {
  const installs = piCalls("install").length;
  const installed = await portal.extensions.install(xDir, { note: "Made in a chat · extensions/x" });
  assert.equal(piCalls("install").length, installs + 1, "pi is asked once");
  xSpec = installed.spec;
  assert.ok(!path.isAbsolute(xSpec), `kept as pi keeps a folder, relative to its own: ${xSpec}`);
  assert.equal(path.resolve(agent, xSpec), realpathSync(xDir));
  const { lines, ...server } = installed.server;
  assert.deepEqual({ ...installed, server, installedFrom: { ...installed.installedFrom, at: undefined } }, {
    name: "x",
    version: "1.0.0",
    spec: xSpec,
    enabled: true,
    installedFrom: { extension: "test-installer", note: "Made in a chat · extensions/x", at: undefined },
    server: { running: true },
    reloaded: 0,
    waiting: 0,
  });
  assert.match(installed.installedFrom.at, ISO);
  assert.ok(lines.some((line) => line.text === "[extension x] server half started"), JSON.stringify(lines));
  assert.deepEqual(db.installNotes()[xSpec], { note: "Made in a chat · extensions/x", at: installed.installedFrom.at });
  assert.equal(host.isServing("x"), true);
  assert.deepEqual(await call("GET", "/api/x/x/hello"), { status: 200, body: { hello: 1 } });
  assert.deepEqual((await listed("x")).installedFrom, installed.installedFrom);
});

test("only a folder of its own data folder, with a name of its own: anything else is refused, and nothing is installed", async () => {
  const outside = folderAt(path.join(home, "packages", "outside"), { name: "outside" });
  const link = path.join(portal.dataDir(), "made", "link");
  symlinkSync(outside, link);
  // One of that name installed by the person, from elsewhere.
  const dup = folderAt(path.join(home, "packages", "dup"), { name: "dup" });
  assert.equal((await call("POST", "/api/packages", { spec: dup })).status, 200);
  const dupSpec = (await listed("dup")).spec;
  const refusals = [
    [outside, { name: "TypeError", message: "install takes a folder in the extension's own dataDir()" }],
    [link, { name: "TypeError", message: "install takes a folder in the extension's own dataDir()" }],
    [made("empty"), { name: "TypeError", message: /has no package\.json that can be read/ }],
    [made("invalid", { name: "Not a name" }), { name: "TypeError", message: /has no valid name/ }],
    [made("kanban", { name: "pithagoras-kanban" }), { name: "Error", message: "pithagoras-kanban is the name of an extension that comes with Pithagoras" }],
    [made("subagent", { name: "pithagoras-subagent" }), { name: "Error", message: "pithagoras-subagent is the name of an extension that comes with Pithagoras" }],
    [made("dup", { name: "dup" }), { name: "Error", message: `dup is installed already, from ${dupSpec}` }],
  ];
  const before = readFileSync(settings, "utf8");
  const installs = piCalls("install").length;
  for (const [folder, refused] of refusals) await assert.rejects(portal.extensions.install(folder), refused, folder);
  assert.equal(readFileSync(settings, "utf8"), before);
  assert.equal(piCalls("install").length, installs);
  // An argument of the wrong kind is refused at the call.
  assert.throws(() => portal.extensions.install(1), TypeError);
  assert.throws(() => portal.extensions.install(xDir, { note: 1 }), TypeError);
  assert.throws(() => portal.extensions.remove(1), TypeError);
  assert.throws(() => portal.extensions.status(1), TypeError);
});

test("the same folder installed again is loaded again in place: one entry, its half at the new revision, the note replaced", async () => {
  const first = db.installNotes()[xSpec];
  const started = () => host.serverHalfStatus("x").lines.filter((line) => line.text === "[extension x] server half started").length;
  const before = started();
  writeFileSync(path.join(xDir, "server.js"), halfOf(xHalf(2)));
  const again = await portal.extensions.install(xDir, { note: "again" });
  assert.equal(entriesFor(realpathSync(xDir)).length, 1);
  assert.equal(again.spec, xSpec);
  assert.equal(started(), before + 1);
  assert.deepEqual((await call("GET", "/api/x/x/hello")).body, { hello: 2 });
  assert.equal(again.installedFrom.note, "again");
  assert.notEqual(again.installedFrom.at, first.at);
  assert.deepEqual(db.installNotes()[xSpec], { note: "again", at: again.installedFrom.at });
});

test("one the person switched off stays off when it is installed again", async () => {
  assert.equal((await call("PUT", "/api/extensions/enabled", { spec: xSpec, enabled: false })).status, 200);
  const again = await portal.extensions.install(xDir);
  assert.equal(again.enabled, false);
  assert.equal(again.server.running, false);
  assert.equal((await portal.extensions.status("x")).enabled, false);
  assert.equal(host.isServing("x"), false);
  // No note given this time: when, alone.
  assert.deepEqual(Object.keys(again.installedFrom).sort(), ["at", "extension"]);
  assert.equal((await call("PUT", "/api/extensions/enabled", { spec: xSpec, enabled: true })).status, 200);
  assert.equal(host.isServing("x"), true);
});

test("it removes only what is in its own folder: the package goes, with its half and routes, and its files stay", async () => {
  await assert.rejects(portal.extensions.remove("dup"), { message: "dup is not installed from test-installer's folder" });
  assert.deepEqual(await portal.extensions.remove("x"), { reloaded: 0, waiting: 0 });
  assert.deepEqual(entriesFor(realpathSync(xDir)), []);
  assert.equal(xSpec in db.installNotes(), false);
  assert.equal(host.isServing("x"), false);
  assert.equal((await call("GET", "/api/x/x/hello")).status, 404);
  assert.equal(existsSync(path.join(xDir, "server.js")), true);
  assert.equal(await portal.extensions.status("x"), undefined);

  // A folder of its own that the person installed by path in Settings: from it, with no note, and its to remove.
  const y = withServer("y", "");
  assert.equal((await call("POST", "/api/packages", { spec: y })).status, 200);
  assert.deepEqual((await listed("y")).installedFrom, { extension: "test-installer" });
  assert.deepEqual((await portal.extensions.status("y")).installedFrom, { extension: "test-installer" });
  await portal.extensions.remove("y");
  assert.equal(await listed("y"), undefined);
});

test("removed in Settings, a package it installed with a note leaves no note behind", async () => {
  const { spec } = await portal.extensions.install(withServer("z", ""), { note: "z" });
  assert.equal(db.installNotes()[spec].note, "z");
  assert.equal((await call("DELETE", "/api/packages", { spec })).status, 200);
  assert.equal(spec in db.installNotes(), false);
});

test("where an installed extension stands: running, failing, crashed, what it said after a line, its page's failure, a chat's load errors", async () => {
  assert.equal(await portal.extensions.status("not-installed"), undefined);

  // Its lines, with a key in one of them; a route says one more.
  const s = made("s", { name: "s", version: "2.0.0", pithagoras: { server: "./server.js", client: "./web/client.js" } }, {
    "server.js": halfOf(`portal.log("the key is sk-abcdefghijklmnopqrstuvwxyz0123");
portal.router.get("/say", (req, res) => { portal.log("said once more"); res.json({ ok: true }); });
portal.chats.extend((pi, chat) => { if (chat.title === "breaks") throw new Error("the schema is wrong"); });`),
    "web/client.js": "export default function () {}\n",
  });
  // Two chats with their pi running, one of which its factory cannot load in.
  for (const id of ["breaks", "fine"]) db.createSession({ id, title: id, workspace: mkdtempSync(path.join(process.env.WORKSPACE_ROOT, `${id}-`)), executor: "host" });
  await sessions.ensureClient("breaks");
  await sessions.ensureClient("fine");
  db.createSession({ id: "asleep", title: "breaks", workspace: process.env.WORKSPACE_ROOT, executor: "host" });

  const installed = await portal.extensions.install(s);
  assert.equal(installed.reloaded, 2, "the open chats load it");
  const running = await portal.extensions.status("s");
  assert.equal(running.version, "2.0.0");
  assert.equal(running.server.running, true);
  assert.equal(running.loadErrors, undefined, "asked for no chat");
  const keyed = running.server.lines.find((line) => line.text.startsWith("[extension s] the key is "));
  assert.equal(keyed.text, "[extension s] the key is [redacted]");
  assert.deepEqual(Object.keys(keyed).sort(), ["at", "id", "level", "text"]);
  const since = running.server.lines.at(-1).id;
  await call("GET", "/api/x/s/say");
  assert.deepEqual((await portal.extensions.status("s", { since })).server.lines.map((line) => line.text), ["[extension s] said once more"]);

  assert.deepEqual((await portal.extensions.status("s", { chatId: "breaks" })).loadErrors, [{ error: "the schema is wrong" }]);
  assert.deepEqual((await portal.extensions.status("s", { chatId: "fine" })).loadErrors, []);
  assert.deepEqual((await portal.extensions.status("s", { chatId: "asleep" })).loadErrors, [], "its pi is not running");

  const { rev } = (await call("GET", "/api/extension-ui")).body.extensions.find((ext) => ext.name === "s");
  assert.equal((await portal.extensions.status("s")).client, undefined);
  assert.equal((await call("POST", "/api/extension-ui/failures", { name: "s", rev, error: "s is not defined", stack: "at Page" })).status, 200);
  assert.deepEqual((await portal.extensions.status("s")).client, { error: "s is not defined", stack: "at Page" });

  // A half whose module throws as it is imported: why it is not running.
  const broken = await portal.extensions.install(withServer("broken", "", { "server.js": 'throw new Error("it does not start");\n' }));
  assert.equal(broken.server.running, false);
  assert.equal(broken.server.failure, "it does not start");

  // One that throws in a timer crashes, and is held. node:test fails a test on any error that reaches the process, as
  // the portal would end without its own handling (catchExtensionCrashes): while the half crashes, that is the only one.
  const crashy = withServer("crashy", `portal.router.get("/crash", (req, res) => { setTimeout(() => { throw new Error("thrown in a timer"); }); res.json({ ok: true }); });`);
  await portal.extensions.install(crashy);
  const theirs = process.listeners("uncaughtException");
  process.removeAllListeners("uncaughtException");
  host.catchExtensionCrashes();
  try {
    await call("GET", "/api/x/crashy/crash");
    await until(() => host.serverHalfStatus("crashy").crash, "the half to crash");
  } finally {
    for (const listener of theirs) process.on("uncaughtException", listener);
  }
  // Stopped, and held off, by the bringing in line that its crash asked for.
  await host.serversSettled();
  const { server: held } = await portal.extensions.status("crashy");
  assert.equal(held.running, false);
  assert.match(held.failure, /^It crashed at \S+: Error: thrown in a timer\. It stays off/);
  assert.deepEqual(Object.keys(held.crash).sort(), ["at", "error", "rev", "stack"]);
  assert.equal(held.crash.error, "Error: thrown in a timer");
  assert.match(held.crash.stack, /crashy[/\\]server\.js/);
  assert.match(held.lines.at(-1).text, /^\[extension crashy\] its server half crashed\./);
});

test("a row in Audit, under the extension's name: the subject cut at 2,000 characters, the chat kept as given", () => {
  const row = () => {
    const { kind, tool, subject, reason, session_id } = db.listAudit(1)[0];
    return { kind, tool, subject, reason, session_id };
  };
  portal.audit.record({ subject: "x 1.0.0 · 0123456789ab · extensions/x", reason: "Installed", chatId: "a-chat-there-never-was" });
  assert.deepEqual(row(), { kind: "extension", tool: "test-installer", subject: "x 1.0.0 · 0123456789ab · extensions/x", reason: "Installed", session_id: "a-chat-there-never-was" });
  portal.audit.record({ subject: "y".repeat(3000) });
  assert.deepEqual(row(), { kind: "extension", tool: "test-installer", subject: "y".repeat(2000), reason: "", session_id: null });
  for (const entry of [undefined, {}, { subject: "" }, { subject: 1 }, { subject: "s", reason: 1 }, { subject: "s", chatId: 2 }]) {
    assert.throws(() => portal.audit.record(entry), TypeError, JSON.stringify(entry));
  }
});

test("installs go one at a time: two of one name from two folders, and one is refused; not while its half starts, nor once it stopped", async () => {
  const results = await Promise.allSettled([portal.extensions.install(made("twin-a", { name: "twin" })), portal.extensions.install(made("twin-b", { name: "twin" }))]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.match(results.find((result) => result.status === "rejected").reason.message, /^twin is installed already, from /);
  assert.equal(packages().filter((p) => /twin-[ab]$/.test(p)).length, 1);

  // From its default export: refused at once, and the half starts within its time.
  const early = folderAt(path.join(home, "packages", "early"), { name: "test-early", pithagoras: { server: "./server.js" } }, {
    "server.js": `export default async function (portal) {
  globalThis.earlyPortal = portal;
  const asked = Date.now();
  const refused = (e) => ({ message: e.message, took: Date.now() - asked });
  globalThis.early = [await portal.extensions.install(portal.dataDir()).catch(refused), await portal.extensions.remove("x").catch(refused)];
}
`,
  });
  const asked = Date.now();
  assert.equal((await call("POST", "/api/packages", { spec: early })).status, 200);
  assert.ok(Date.now() - asked < 5000, `${Date.now() - asked} ms`);
  assert.equal(host.isServing("test-early"), true);
  assert.deepEqual(globalThis.early.map(({ message }) => message), [
    "extensions.install is not available while its server half is starting or stopped",
    "extensions.remove is not available while its server half is starting or stopped",
  ]);
  for (const { took } of globalThis.early) assert.ok(took < 1000, `${took} ms`);
  // Stopped: a portal it kept refuses as well.
  const spec = (await listed("test-early")).spec;
  assert.equal((await call("PUT", "/api/extensions/enabled", { spec, enabled: false })).status, 200);
  await assert.rejects(globalThis.earlyPortal.extensions.install(made("late", { name: "late" })), { message: "extensions.install is not available while its server half is starting or stopped" });
  await assert.rejects(globalThis.earlyPortal.extensions.remove("late"), { message: "extensions.remove is not available while its server half is starting or stopped" });
});
