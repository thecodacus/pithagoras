import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { inProcessHome } from "./server-harness.mjs";

/**
 * An extension's server half: a module the portal loads into its own process,
 * with routes of its own, the chats, the pages open on them, and what it adds
 * to a chat's pi. The module here writes what it is handed and what it hears
 * into `globalThis.seen`, which the tests read.
 */
const home = inProcessHome("extension-host-");
const pkg = path.join(home, "packages", "notes");
mkdirSync(pkg, { recursive: true });
const NAME = "@codacus/notes";

/** The package's server module, written anew: `body` is the default export's own. */
function write(body, file = "server.js") {
  writeFileSync(path.join(pkg, file), `export default async function (portal) {\n${body}\n}\n`);
  const stat = statSync(path.join(pkg, file));
  return (current = { name: NAME, version: "1.0.0", file: path.join(pkg, file), rev: `${Math.round(stat.mtimeMs).toString(36)}-${stat.size.toString(36)}-${++revs}` });
}
let revs = 0;
/** The half last written, as the portal was last told of it. */
let current;

const MODULE = `
  const seen = (globalThis.seen ??= { life: [], events: [], stopped: 0, started: 0 });
  seen.started++;
  seen.portal = portal;
  portal.router.get("/hello", (req, res) => res.json({ hello: portal.extension, url: req.url, query: req.query }));
  portal.router.post("/json", portal.http.json(), (req, res) => res.json({ got: req.body }));
  portal.router.post("/unread", (req, res) => res.json({ body: req.body ?? null }));
  portal.router.post("/file", (req, res) => { let n = 0; req.on("data", (d) => (n += d.length)); req.on("end", () => res.json({ bytes: n })); });
  portal.router.get("/chats/:id", (req, res) => { const chat = portal.chats.get(req.params.id); chat ? res.json({ chat, folder: portal.chats.folder(chat.id) }) : res.status(404).json({ error: "No such chat" }); });
  portal.router.get("/boom", () => { throw new Error("its own failure"); });
  portal.router.get("/files/:name", (req, res) => res.json({ name: req.params.name, query: req.query }));
  portal.chats.onOpen((chatId) => (chatId === "quiet" ? undefined : { type: "state", for: chatId }));
  // One that cannot be written as JSON: left out, and nothing else is the worse for it.
  portal.chats.onOpen((chatId) => (chatId === "a" ? { big: 10n } : undefined));
  portal.chats.on("started", (id) => seen.life.push("started " + id));
  portal.chats.on("stopped", (id) => seen.life.push("stopped " + id));
  portal.chats.on("deleted", (id) => seen.life.push("deleted " + id));
  portal.chats.onEvent((id, event) => seen.events.push([id, event.type]));
  portal.chats.extend((pi, chat) => pi.registerTool({ name: "from_" + chat.id }));
  portal.http.upgrade((req, socket) => { seen.upgraded = req.url; socket.end(); });
  return () => { seen.stopped++; };
`;

const { default: express } = await import("express");
const host = await import("../dist/extension-host.js");
const { createSession } = await import("../dist/db.js");
const { eventsRouter } = await import("../dist/api/events.js");

const work = path.join(process.env.WORKSPACE_ROOT, "site");
mkdirSync(work, { recursive: true });
createSession({ id: "a", title: "First chat", workspace: work, executor: "host" });
createSession({ id: "quiet", title: "Quiet chat", workspace: work, executor: "host" });

const app = express();
// As the portal does: one parser for everything but what reads its own.
const json = express.json();
app.use((req, res, next) => (req.path.startsWith("/api/x/") ? next() : json(req, res, next)));
app.use("/api/x", host.extensionRoutes);
app.use("/api", eventsRouter());
app.use("/api", (req, res) => res.status(404).json({ error: `No such API route: ${req.method} ${req.originalUrl}` }));
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
test.after(async () => {
  await host.stopServerHalves();
  server.closeAllConnections();
  server.close();
});
const at = (p) => `http://127.0.0.1:${server.address().port}${p}`;
const seen = () => globalThis.seen;

await host.syncServerHalves([write(MODULE)]);

test("a server half's routes are under its package's name, written from its own root", async () => {
  const hello = await (await fetch(at("/api/x/@codacus/notes/hello?who=me"))).json();
  assert.deepEqual(hello, { hello: NAME, url: "/hello?who=me", query: { who: "me" } });
  assert.equal((await (await fetch(at("/api/x/%40codacus/notes/hello"))).json()).hello, NAME, "its name written as an address");
  // Nobody's, or not one of its own: the portal's own answer for a route there is none of.
  for (const none of ["/api/x/@codacus/notes/nothing", "/api/x/@codacus/other/hello", "/api/x/@codacus/noteshello", "/api/x/"]) {
    const res = await fetch(at(none));
    assert.equal(res.status, 404, none);
    assert.match((await res.json()).error, /No such API route/, none);
  }
  const boom = await fetch(at("/api/x/@codacus/notes/boom"));
  assert.equal(boom.status, 500);
  assert.equal((await boom.json()).error, "its own failure", "its failure is answered, and the portal goes on");
  assert.equal((await fetch(at("/api/x/@codacus/notes/hello"))).status, 200);
});

test("the rest of a path is read once, by the package's own routes: what was written as part of a name stays part of it", async () => {
  const named = async (written) => (await (await fetch(at(`/api/x/@codacus/notes/files/${written}`))).json());
  assert.deepEqual(await named("what%3F.md"), { name: "what?.md", query: {} });
  assert.deepEqual(await named("a%23b"), { name: "a#b", query: {} });
  assert.deepEqual(await named("100%25"), { name: "100%", query: {} });
  assert.deepEqual(await named("a%252Fb"), { name: "a%2Fb", query: {} }, "not read a second time");
  assert.deepEqual(await named("plain.md?line=7"), { name: "plain.md", query: { line: "7" } });
  // The package's own name, written as an address in either part.
  assert.equal((await fetch(at("/api/x/%40codacus/n%6Ftes/files/x"))).status, 200);
  assert.equal((await fetch(at("/api/x/%40codacus%2Fnotes/files/x"))).status, 404, "a slash written as text is not the one between its two parts");
});

test("no body is read for a server half unless its route asks, so a route can take a file as it comes", async () => {
  const post = (route, body, type = "application/json") => fetch(at(`/api/x/@codacus/notes/${route}`), { method: "POST", headers: { "content-type": type }, body }).then((r) => r.json());
  assert.deepEqual(await post("json", JSON.stringify({ a: 1 })), { got: { a: 1 } });
  assert.deepEqual(await post("unread", JSON.stringify({ a: 1 })), { body: null });
  // A .json file sent as a file is a file: larger than any request the portal reads for itself.
  const big = JSON.stringify({ text: "x".repeat(3 * 1024 * 1024) });
  assert.deepEqual(await post("file", big), { bytes: Buffer.byteLength(big) });
});

test("a server half is told of the chats, and of the folder each works in", async () => {
  const { chat, folder } = await (await fetch(at("/api/x/@codacus/notes/chats/a"))).json();
  assert.deepEqual(chat, { id: "a", title: "First chat", workspace: work, status: "idle" });
  assert.equal(folder, realpathSync(work));
  assert.equal((await fetch(at("/api/x/@codacus/notes/chats/gone"))).status, 404);
  const { portal } = seen();
  assert.deepEqual(portal.chats.list().map((c) => c.id).sort(), ["a", "quiet"]);
  assert.equal(portal.chats.get("gone"), undefined);
  assert.throws(() => portal.chats.folder("gone"), /No such chat/);
  assert.equal(portal.files.inside(folder, "src/index.ts"), path.join(folder, "src", "index.ts"));
  assert.throws(() => portal.files.inside(folder, "../elsewhere"));
});

/** What a page hears under `event: extension` on a chat's stream, until `enough` of it has come. */
async function heard(chat, enough, during = () => {}) {
  const abort = new AbortController();
  const res = await fetch(at(`/api/sessions/${chat}/events`), { signal: abort.signal });
  const got = [];
  let text = "";
  let acted = false;
  const decoder = new TextDecoder();
  try {
    for await (const chunk of res.body) {
      text += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = text.indexOf("\n\n")) !== -1) {
        const block = text.slice(0, end);
        text = text.slice(end + 2);
        const name = /^event: (.+)$/m.exec(block)?.[1];
        if (name === "extension") got.push(JSON.parse(/^data: (.+)$/m.exec(block)[1]));
        // Once the stream has said where things stand, what is sent now is heard live.
        if (name === "live-reset" && !acted) {
          acted = true;
          during();
        }
      }
      if (got.length >= enough) break;
    }
  } finally {
    abort.abort();
  }
  return got;
}

test("a page that opens a chat is told where things stand, then each thing a server half says, and nothing of another chat's", async () => {
  const { portal } = seen();
  const got = await heard("a", 3, () => {
    portal.chats.send("quiet", { type: "elsewhere" });
    portal.chats.send("a", { type: "changed", n: 1 });
    portal.chats.send("a", undefined);
  });
  assert.deepEqual(got, [
    { extension: NAME, data: { type: "state", for: "a" } },
    { extension: NAME, data: { type: "changed", n: 1 } },
    { extension: NAME, data: null },
  ]);
  // What could not be written (the second thing it says first, and this) was left out: the stream went on, as above.
  portal.chats.send("a", { cycle: (() => { const o = {}; o.self = o; return o; })() });
  // A browser half that came into the page later asks for the same, as it would be said now.
  assert.deepEqual(host.openingFor("a", NAME), [{ type: "state", for: "a" }]);
  assert.deepEqual(host.openingFor("quiet", NAME), []);
  assert.deepEqual(host.openingFor("a", "someone-else"), []);
  // Nothing to say first to this one: only what is sent.
  assert.deepEqual(await heard("quiet", 1, () => portal.chats.send("quiet", "hi")), [{ extension: NAME, data: "hi" }]);
});

test("a server half hears a chat's pi start and stop, the chat deleted, and all its pi says", () => {
  host.chatLife("started", "a");
  host.chatEvent("a", { type: "message_update" });
  host.chatEvent("a", { type: "portal_extension_ui", extension: NAME, data: 1 });
  host.chatLife("stopped", "a");
  host.chatLife("deleted", "a");
  assert.deepEqual(seen().life, ["started a", "stopped a", "deleted a"]);
  assert.deepEqual(seen().events, [["a", "message_update"], ["a", "portal_extension_ui"]]);
});

test("what a server half adds to a chat's pi is registered as that pi loads, for that chat", () => {
  const tools = [];
  host.hostExtension("quiet")({ registerTool: (tool) => tools.push(tool.name) });
  assert.deepEqual(tools, ["from_quiet"]);
  host.hostExtension("gone")({ registerTool: (tool) => tools.push(tool.name) });
  assert.deepEqual(tools, ["from_quiet"], "nothing for a chat that is not there");
});

test("a chat's pi is kept while a server half holds it, and let go when every hold is", () => {
  const { portal } = seen();
  assert.equal(host.extensionHolds("quiet"), false);
  const first = portal.chats.hold("quiet");
  const second = portal.chats.hold("quiet");
  first();
  first();
  assert.equal(host.extensionHolds("quiet"), true, "one of two let go, and let go twice, is still one held");
  second();
  assert.equal(host.extensionHolds("quiet"), false);
});

test("upgrades under a server half's routes go to it, with the address as its routes see it", () => {
  assert.equal(host.extensionUpgrade("/browser-ui/websockify"), undefined);
  assert.equal(host.extensionUpgrade("/api/x/@codacus/other/socket"), undefined);
  assert.equal(host.extensionUpgrade(undefined), undefined);
  const handler = host.extensionUpgrade("/api/x/%40codacus/notes/socket?chat=a");
  const req = { url: "/api/x/%40codacus/notes/socket?chat=a" };
  handler(req, { end() {} }, Buffer.alloc(0));
  assert.equal(seen().upgraded, "/socket?chat=a");
});

test("a command is run for a chat in the folder the chat works in, which is where a server half keeps what is the chat's", async () => {
  const { portal } = seen();
  // The sandbox is off here: as the portal's own user.
  assert.equal(portal.sandbox.on(), false);
  assert.deepEqual(portal.sandbox.spawnAs("a").argv, []);
  const ran = await portal.sandbox.run("a", ["sh", "-c", "pwd; cat"], { input: "from stdin" });
  assert.equal(ran.code, 0);
  assert.equal(ran.stdout.toString(), `${realpathSync(work)}\nfrom stdin`);
  assert.equal((await portal.sandbox.run("a", ["sh", "-c", "echo no >&2; exit 3"])).code, 3, "a command that fails is answered, not thrown");
  // What it keeps for the chat is a file there, at a path checked to be inside.
  const kept = portal.files.inside(portal.chats.folder("a"), ".notes/kept.json");
  await portal.sandbox.run("a", ["sh", "-c", 'mkdir -p .notes && printf "%s" "$0" > .notes/kept.json', '{"n":1}']);
  assert.equal(readFileSync(kept, "utf8"), '{"n":1}');
});

test("a server half has a folder of the portal's own in the data folder, closed to everyone else, one for each package", async () => {
  const { portal } = seen();
  const data = path.join(path.resolve(process.env.DATA_DIR), "extension-data");
  assert.equal(existsSync(data), false, "not made until a package asks");
  const dir = portal.dataDir();
  assert.equal(dir, path.join(data, "%40codacus%2Fnotes"), "its name as one part of a path");
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(data).mode & 0o777, 0o700);
  assert.equal(portal.dataDir(), dir, "the same each time, and made once");
  writeFileSync(path.join(dir, "kept"), "still here");
  assert.equal(readFileSync(path.join(portal.dataDir(), "kept"), "utf8"), "still here");
  // A package named as a step up, or as the folder itself, has a folder of its own too, below the data folder.
  for (const name of ["..", ".", ".hidden"]) {
    const file = path.join(pkg, "named.js");
    writeFileSync(file, `export default async function (portal) { globalThis.seenDir = portal.dataDir(); }\n`);
    await host.syncServerHalves([{ name, version: "1.0.0", file, rev: `named-${name}` }]);
    assert.equal(path.dirname(globalThis.seenDir), data, name);
    assert.ok(statSync(globalThis.seenDir).isDirectory(), name);
  }
  await host.syncServerHalves([write(MODULE)]);
});

test("a server half changed is stopped and started anew, one gone is stopped, and one that fails says why", async () => {
  const before = { started: seen().started, stopped: seen().stopped };
  // The same again: nothing to do.
  await host.syncServerHalves([current]);
  assert.deepEqual({ started: seen().started, stopped: seen().stopped }, before);

  await host.syncServerHalves([write(MODULE.replace('"/hello"', '"/hello2"'))]);
  assert.deepEqual({ started: seen().started, stopped: seen().stopped }, { started: before.started + 1, stopped: before.stopped + 1 });
  assert.equal((await fetch(at("/api/x/@codacus/notes/hello"))).status, 404, "the routes it had are gone with it");
  assert.equal((await fetch(at("/api/x/@codacus/notes/hello2"))).status, 200);

  await host.syncServerHalves([write('  throw new Error("cannot start here");')]);
  assert.equal(host.serverFailure(NAME), "cannot start here");
  assert.equal((await fetch(at("/api/x/@codacus/notes/hello2"))).status, 404);
  assert.equal(seen().stopped, before.stopped + 2);

  await host.syncServerHalves([write("  // nothing, and nothing to stop")]);
  assert.equal(host.serverFailure(NAME), undefined);
  await host.syncServerHalves([]);
  assert.equal((await fetch(at("/api/x/@codacus/notes/hello2"))).status, 404);
  assert.match(readFileSync(path.join(pkg, "server.js"), "utf8"), /nothing to stop/);
});

// The sandbox needs root on Linux, as the portal runs in its image, and its tools.
const linuxRoot = process.platform === "linux" && process.getuid?.() === 0;
const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;
const noSandbox = !linuxRoot ? "needs root on Linux, as the portal runs in its image" : !has("setpriv") || !has("useradd") ? "needs setpriv and useradd" : false;

test("with the sandbox on, what a server half runs for a chat runs as the chat's agent, with none of the portal's own environment", { skip: noSandbox }, async () => {
  const exists = (kind, name) => spawnSync("getent", [kind, name]).status === 0;
  if (!exists("group", "pi-sandbox")) execFileSync("groupadd", ["--gid", "10010", "pi-sandbox"]);
  if (!exists("passwd", "pi-tools")) execFileSync("useradd", ["--uid", "10002", "--user-group", "--no-create-home", "--shell", "/usr/sbin/nologin", "pi-tools"]);
  await host.syncServerHalves([write(MODULE)]);
  const { portal } = seen();
  const { parsePolicy, saveSandboxPolicy, defaultRules } = await import("../dist/sandbox/policy.js");
  // Switched on, not applied: applying writes the system's sudo rules, which the sandbox's own test relies on.
  const policy = parsePolicy({ enabled: true, rules: defaultRules(), trusted: [] });
  saveSandboxPolicy(policy);
  process.env.PORTAL_OWN_SECRET = "not for an agent";
  try {
    assert.equal(portal.sandbox.on(), true);
    const as = portal.sandbox.spawnAs("a");
    assert.equal(as.argv[0], "setpriv");
    assert.equal(as.env.PORTAL_OWN_SECRET, undefined);
    assert.match(as.env.USER, /^pi-agent-[0-9a-f]{8}$/);
    // The command itself is the agent's: its user, its own HOME, and nothing of the portal's to print.
    const ran = await portal.sandbox.run("a", ["sh", "-c", "id -un; id -u; echo ${PORTAL_OWN_SECRET:-nothing}"], { cwd: "/" });
    assert.equal(ran.code, 0, ran.stderr);
    const [user, uid, secret] = ran.stdout.toString().trim().split("\n");
    assert.equal(user, as.env.USER);
    assert.notEqual(uid, "0");
    assert.equal(secret, "nothing");
  } finally {
    delete process.env.PORTAL_OWN_SECRET;
    saveSandboxPolicy({ ...policy, enabled: false });
  }
});

test("a server half that fails to stop, or never finishes stopping or starting, holds up nothing else", async () => {
  host.setLimits(300, 300);
  try {
    const other = { name: "other", version: "1.0.0", file: path.join(pkg, "other.js"), rev: "1" };
    writeFileSync(other.file, "export default function (portal) { portal.router.get('/ok', (_req, res) => res.json({ ok: true })); }");

    // One whose stop rejects: said, and the rest of what was asked is still done.
    await host.syncServerHalves([write("  return async () => { throw new Error('cannot stop'); };"), other]);
    assert.equal((await fetch(at("/api/x/other/ok"))).status, 200);
    await host.syncServerHalves([write("  return () => new Promise(() => {});"), other]);
    assert.equal(host.isServing(NAME), true, "stopped, for all its stop said, and its next one started");

    // One whose stop never finishes: given up on after a moment.
    const began = Date.now();
    await host.syncServerHalves([write("  await new Promise(() => {});"), other]);
    assert.ok(Date.now() - began < 3000, "neither is waited for longer than it is given");
    // And one that never finishes starting: not running, with why, and the other untouched.
    assert.equal(host.isServing(NAME), false);
    assert.match(host.serverFailure(NAME), /had not finished starting/);
    assert.equal(host.isServing("other"), true);
    assert.equal((await fetch(at("/api/x/other/ok"))).status, 200);

    // What is asked next is done: nothing waits behind the one that hung.
    await host.syncServerHalves([write("  // fine again")]);
    assert.equal(host.isServing(NAME), true);
    assert.equal(host.isServing("other"), false);
    await host.serversSettled();
  } finally {
    host.setLimits(15_000, 5_000);
  }
});
