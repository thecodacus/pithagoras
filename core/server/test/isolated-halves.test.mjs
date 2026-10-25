import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inProcessHome, runToEnd, serverEnv, testHome } from "./server-harness.mjs";

/**
 * A server half in a process of its own (`isolated`): the same `portal`, its calls made across to the portal's, its
 * routes, upgrades and chats' tools handed on to its process, and a loop, a heap or a process that grows without end,
 * a crash or an exit ending that process and not the portal's. The portal is this test's process, with the halves
 * written inline; what only the end of the portal's own process shows runs in a process of its own
 * (isolated-halves-child.mjs).
 */
const home = inProcessHome("isolated-halves-");
const { installLogCapture } = await import("../dist/logs.js");
installLogCapture();
const host = await import("../dist/extension-host.js");
const { createSession, getSession, installNotes, listAudit, updateSession } = await import("../dist/db.js");
const { memoryHolder } = await import("../dist/memory-holder.js");
const { eventsRouter } = await import("../dist/api/events.js");
const { extensionsRouter, followPackages } = await import("../dist/api/extensions.js");
const { packagesRouter } = await import("../dist/api/packages.js");
const { serverHalf } = await import("../dist/extension-ui.js");
const { listJobs } = await import("../dist/background.js");
const { default: express } = await import("express");
const HANG = 3_000;
host.setLimits(10_000, 1_000, { hang: HANG });
const LINUX = process.platform === "linux";
const CHILD = fileURLToPath(new URL("./isolated-halves-child.mjs", import.meta.url));

let revs = 0;
/** A server half in a folder of its own, its module's default export's body written anew: a revision of its own. */
function half(name, body, { isolated = true, files = {}, ...more } = {}) {
  const dir = path.join(home, "halves", name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) writeFileSync(path.join(dir, rel), text);
  writeFileSync(path.join(dir, "server.js"), `export default async function (portal) {\n${body}\n}\n`);
  return { name, version: "1.0.0", file: path.join(dir, "server.js"), rev: `r${++revs}`, ...(isolated ? { isolated: true } : {}), ...more };
}

/** Where a half stands, with its lines as text. */
function status(name) {
  const { lines, ...rest } = host.serverHalfStatus(name);
  return { ...rest, lines: lines.map((line) => line.text) };
}

async function until(done, what, ms = 15_000) {
  for (const end = Date.now() + ms; !(await done()); await new Promise((resolve) => setTimeout(resolve, 20))) {
    if (Date.now() > end) throw new Error(`timed out waiting until ${what}`);
  }
}

/**
 * Whether a process has ended: it is gone, or it is a zombie its new parent has not reaped (a test's container can have
 * no init that reaps what is left to it, where the portal's has one: Compose's `init: true`).
 */
function ended(pid) {
  try {
    if (LINUX) return /^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
    process.kill(pid, 0);
    return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z");
  } catch {
    // Gone.
    return true;
  }
}

/** The tools, handlers and commands a chat's pi is given by the server halves, as a stand-in pi takes them; each factory awaited, as pi does. */
async function chatPi(chatId) {
  const tools = [], handlers = [], commands = [], errors = [];
  for (const { name, factory } of host.hostExtensions(chatId)) {
    try {
      await factory({ registerTool: (t) => tools.push(t), on: (event, handler) => handlers.push({ event, handler }), registerCommand: (command, options) => commands.push({ name: command, ...options }) });
    } catch (e) {
      errors.push(`${name}: ${e.name}: ${e.message}`);
    }
  }
  return { tools, handlers, commands, errors };
}

const work = path.join(process.env.WORKSPACE_ROOT, "site");
mkdirSync(work, { recursive: true });
createSession({ id: "a", title: "A chat", workspace: work, executor: "host" });
createSession({ id: "m", title: "A chat in Focus mode", workspace: work, executor: "host" });
updateSession("m", { mode: "focuser/focus" });

/** The extensions' routes and upgrades as the portal mounts them, and a chat's event stream. */
const app = express();
app.use("/api/x", host.extensionRoutes);
app.use("/api", eventsRouter());
app.use(express.json()).use("/api", extensionsRouter(), packagesRouter());
app.use("/api", (req, res) => res.status(404).json({ error: `No such API route: ${req.method} ${req.originalUrl}` }));
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
server.on("upgrade", (req, socket, head) => {
  socket.on("error", () => {});
  const taker = host.extensionUpgrade(req.url);
  return taker ? taker(req, socket, head) : socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
});
const base = `http://127.0.0.1:${server.address().port}`;
const get = async (p, options) => {
  const res = await fetch(base + p, options);
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, text };
  }
};
test.after(async () => {
  server.closeAllConnections();
  server.close();
  await host.stopServerHalves();
});

const HELD = /^It crashed at \S+: (.*)\. It stays off until another revision of it is installed, or it is switched off and on\.$/;
const HUNG = `Error: It did not let its process answer for ${HANG / 1000} seconds (a loop that never ends, or a long synchronous call), so its process was ended`;

test("its routes are answered by its own process: a JSON body, a stream, a part of a file, its own 404, and an upgrade", async () => {
  writeFileSync(path.join(work, "clip.bin"), Buffer.from("0123456789abcdefghij"));
  await host.syncServerHalves([
    half("routes", `
      portal.router.post("/json", portal.http.json(), (req, res) => res.json({ got: req.body, url: req.url, pid: process.pid }));
      portal.router.get("/events", (req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: one\\n\\n");
        setTimeout(() => { res.write("data: two\\n\\n"); res.end(); }, 50);
      });
      portal.router.get("/part", (req, res) => portal.http.send(req, res, portal.files.open(portal.chats.folder("a"), "clip.bin")));
      portal.router.get("/drop", (req) => req.socket.destroy());
      portal.http.upgrade((req, socket) => {
        socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: echo\\r\\nConnection: Upgrade\\r\\n\\r\\n");
        socket.on("data", (data) => socket.write("echo " + data + " at " + req.url));
      });
    `),
  ]);
  assert.equal(host.serverFailure("routes"), undefined);
  const posted = await get("/api/x/routes/json?x=1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ a: [1, 2] }) });
  assert.equal(posted.status, 200);
  assert.deepEqual({ ...posted.body, pid: undefined }, { got: { a: [1, 2] }, url: "/json?x=1", pid: undefined });
  assert.notEqual(posted.body.pid, process.pid, "answered by a process of its own");

  const events = await fetch(`${base}/api/x/routes/events`);
  assert.equal(events.headers.get("content-type"), "text/event-stream");
  assert.equal(await events.text(), "data: one\n\ndata: two\n\n");

  const part = await fetch(`${base}/api/x/routes/part`, { headers: { range: "bytes=10-14" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 10-14/20");
  assert.match(part.headers.get("content-disposition"), /attachment; filename="clip.bin"/);
  assert.equal(await part.text(), "abcde");

  assert.deepEqual(await get("/api/x/routes/nothing-here"), { status: 404, body: { error: "Not found" } });
  // A connection its process cut, with the process alive: 502.
  assert.deepEqual(await get("/api/x/routes/drop"), { status: 502, body: { error: "Its server half could not be reached" } });
  assert.equal(host.isServing("routes"), true);

  const socket = connect(server.address().port, "127.0.0.1");
  let heard = "";
  socket.on("data", (data) => (heard += data));
  socket.write("GET /api/x/routes/stream?x=2 HTTP/1.1\r\nHost: here\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n");
  await until(() => heard.includes("\r\n\r\n"), "the upgrade was answered");
  assert.match(heard, /^HTTP\/1\.1 101 /);
  heard = "";
  socket.write("hello");
  await until(() => heard.includes("hello"), "the echo came back");
  assert.equal(heard, "echo hello at /stream?x=2");
  socket.destroy();
});

test("a request its process crashed under is answered with the crash (503)", async () => {
  await host.syncServerHalves([half("dies", `portal.router.get("/die", () => setTimeout(() => { throw new Error("thrown while a request waited"); }, 20));`)]);
  assert.deepEqual(await get("/api/x/dies/die"), { status: 503, body: { error: "Its server half crashed: Error: thrown while a request waited" } });
});

test("chats.extend: its tools in its mode's chat alone, with their guard; a call's updates, its abort, a handler's answer and a command", async () => {
  await host.syncServerHalves([
    half("focuser", `
      const FOCUS = portal.modes.provide({ id: "focus", label: "Focus mode", description: "Has the focus tool." });
      portal.chats.extend((pi, chat) => {
        pi.on("resources_discover", (event) => ({ skillPaths: ["/skills/" + chat.id + "/" + event.reason] }));
        pi.registerCommand("hello", { description: "Says hello.", handler: async (args) => portal.log("hello " + args) });
        if (chat.mode !== FOCUS) return;
        pi.registerTool({
          name: "focus", label: "focus", description: "Focuses.", parameters: { type: "object", properties: { n: { type: "number" } } },
          guard: { acts: ["persist"] }, offByDefault: true, renderCall() {}, renderResult() {},
          async execute(id, params, signal, onUpdate, ctx) {
            onUpdate({ content: [{ type: "text", text: "half way" }] });
            if (params.n === 0) return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("it was aborted"))));
            return { content: [{ type: "text", text: "focused " + params.n + " in " + id + (ctx === undefined ? ", with no ctx" : "") }], details: { n: params.n } };
          },
        });
      });
    `),
  ]);
  const standard = await chatPi("a");
  assert.deepEqual(standard.errors, []);
  assert.deepEqual(standard.tools, []);
  assert.deepEqual(await standard.handlers[0].handler({ type: "resources_discover", reason: "startup" }, {}), { skillPaths: ["/skills/a/startup"] });
  await standard.commands[0].handler("there", {});
  assert.equal(standard.commands[0].description, "Says hello.");
  await until(() => status("focuser").lines.includes("[extension focuser] hello there"), "its command ran");

  const { tools: [focus] } = await chatPi("m");
  assert.deepEqual(
    { name: focus.name, guard: focus.guard, offByDefault: focus.offByDefault, parameters: focus.parameters, renderCall: focus.renderCall },
    { name: "focus", guard: { acts: ["persist"] }, offByDefault: true, parameters: { type: "object", properties: { n: { type: "number" } } }, renderCall: undefined },
  );
  const updates = [];
  assert.deepEqual(await focus.execute("call-1", { n: 2 }, undefined, (update) => updates.push(update), {}), { content: [{ type: "text", text: "focused 2 in call-1, with no ctx" }], details: { n: 2 } });
  assert.deepEqual(updates, [{ content: [{ type: "text", text: "half way" }] }]);
  const going = new AbortController();
  const aborted = focus.execute("call-2", { n: 0 }, going.signal, () => {}, {}).then(() => "resolved", (e) => e.message);
  setTimeout(() => going.abort(), 50);
  assert.equal(await aborted, "it was aborted");
});

test("what a factory of chats.extend cannot do is the chat's load error: a throw, the time running out, a function pi would be given, and a name of pi's own", async () => {
  await host.syncServerHalves([
    half("thrower", `portal.chats.extend(() => { throw new Error("no tools today"); });`),
    half("slow", `portal.chats.extend(() => new Promise(() => {}));`),
    half("preparer", `portal.chats.extend((pi) => pi.registerTool({ name: "p", label: "p", description: "p", parameters: {}, prepareArguments: (args) => args, async execute() { return { content: [] }; } }));`),
    half("shadow", `portal.chats.extend((pi) => pi.registerTool({ name: "find", label: "find", description: "Finds.", parameters: {}, async execute() { return { content: [] }; } }));`),
    half("fine", `portal.chats.extend((pi) => pi.registerTool({ name: "fine", label: "fine", description: "Fine.", parameters: {}, async execute() { return { content: [] }; } }));`),
  ]);
  const { tools, errors } = await chatPi("a");
  assert.deepEqual(tools.map((tool) => tool.name), ["fine"]);
  assert.deepEqual(errors, [
    "thrower: Error: no tools today",
    "slow: Error: It had not finished adding to a chat's pi after 5 seconds",
    "preparer: TypeError: A tool's prepareArguments is a function, which a server half in a process of its own cannot give pi",
    `shadow: TypeError: "find" is one of pi's own tools: give the tool another name`,
  ]);
  await host.syncServerHalves([]);
});

test("a chat's pi that stops, or a chat deleted, lets go of what the half gave that pi, there and in its process", async () => {
  await host.syncServerHalves([
    half("keeper", `
      const kept = new Map();
      portal.chats.extend((pi, chat) => {
        kept.set(chat.id, pi);
        pi.registerTool({ name: "kept", label: "kept", description: "Kept.", parameters: {}, async execute() { return { content: [{ type: "text", text: "here" }] }; } });
      });
      portal.router.post("/say/:id", (req, res) => { kept.get(req.params.id).sendMessage({ customType: "said", content: "to " + req.params.id, display: true }); res.json({}); });
    `),
  ]);
  const said = { a: [], m: [] };
  const load = async (chatId) => {
    const tools = [];
    for (const { factory } of host.hostExtensions(chatId)) await factory({ registerTool: (t) => tools.push(t), on() {}, registerCommand() {}, sendMessage: (message) => said[chatId].push(message.content) });
    return tools;
  };
  const [inA] = await load("a");
  const [inM] = await load("m");
  assert.deepEqual(await inA.execute("1", {}, undefined, undefined, {}), { content: [{ type: "text", text: "here" }] });
  await get("/api/x/keeper/say/a", { method: "POST" });
  await until(() => said.a.length === 1, "a's pi was asked for a turn");
  host.chatLife("stopped", "a");
  host.chatLife("deleted", "m");
  const gone = "Nothing of this server half answers to it any more: the chat has what the half gives now at its next step";
  await assert.rejects(inA.execute("2", {}, undefined, undefined, {}), { message: gone });
  await assert.rejects(inM.execute("3", {}, undefined, undefined, {}), { message: gone });
  // What it asks of a pi let go of is not done; asked of m's pi loaded again, it is, and by one channel in order.
  await get("/api/x/keeper/say/a", { method: "POST" });
  await load("m");
  await get("/api/x/keeper/say/m", { method: "POST" });
  await until(() => said.m.length === 1, "m's pi loaded again was asked for a turn");
  assert.deepEqual(said, { a: ["to a"], m: ["to m"] });
  await host.syncServerHalves([]);
});

test("a chat that kept its tools from before a restart is answered at once that the half was stopped; so is a call it was waiting on, which is no crash", async () => {
  const body = (n) => `portal.chats.extend((pi) => {
    pi.registerTool({ name: "n", label: "n", description: "Says its revision.", parameters: {}, async execute() { return { content: [{ type: "text", text: "${n}" }] }; } });
    pi.registerTool({ name: "wait", label: "wait", description: "Waits.", parameters: {}, execute: () => new Promise(() => {}) });
  });`;
  await host.syncServerHalves([half("restarts", body(1))]);
  const before = (await chatPi("a")).tools;
  const waiting = before.find((tool) => tool.name === "wait").execute("1", {}, undefined, undefined, {}).then(() => "resolved", (e) => e.message);
  await host.syncServerHalves([half("restarts", body(2))]);
  const stopped = "Its server half was stopped; the chat has the new one at its next step";
  assert.equal(await waiting, stopped);
  const at = Date.now();
  await assert.rejects(before.find((tool) => tool.name === "n").execute("2", {}, undefined, undefined, {}), { message: stopped });
  assert.ok(Date.now() - at < 500, "at once");
  assert.deepEqual(await (await chatPi("a")).tools.find((tool) => tool.name === "n").execute("3", {}, undefined, undefined, {}), { content: [{ type: "text", text: "2" }] });
  assert.equal(status("restarts").crash, undefined);
  await host.syncServerHalves([]);
});

test("a start that never yields is ended once its process stops answering, as its crash, and held", async () => {
  const stuck = half("stuck", `portal.log("stuck"); for (;;) {}`);
  const at = Date.now();
  await host.syncServerHalves([stuck]);
  const took = Date.now() - at;
  assert.ok(took > HANG - 1000 && took < HANG + 3000, `ended once the time it was given was up, not its time to start: ${took} ms`);
  const { running, crash, failure } = status("stuck");
  assert.equal(running, false);
  assert.equal(crash.error, HUNG);
  assert.equal(failure, `It crashed as it started: ${HUNG}`);
  const again = Date.now();
  await host.syncServerHalves([stuck]);
  assert.equal(host.isServing("stuck"), false);
  assert.ok(Date.now() - again < 1000, `held, not started again: ${Date.now() - again} ms`);
  assert.equal(HELD.exec(status("stuck").failure)?.[1], HUNG);
  await host.syncServerHalves([]);
});

test("what it prints with no line break is kept to a line's length, and what follows that line is read", async () => {
  await host.syncServerHalves([half("chatty", `portal.router.get("/say", (req, res) => { process.stdout.write("#".repeat(20000)); process.stdout.write("$".repeat(20000) + "tail\\nafter\\n"); res.json({}); });`)]);
  await get("/api/x/chatty/say");
  await until(() => status("chatty").lines.includes("after"), "the line after it was read");
  const { lines } = status("chatty");
  assert.equal(lines[lines.indexOf("after") - 1], "#".repeat(8000));
  await host.syncServerHalves([]);
});

test("a line is kept to that length however the pipe hands it on, its line break in the same part as the rest of it too", async () => {
  const { lines } = await import("../dist/isolated-half.js");
  const read = async (...parts) => {
    const stream = new PassThrough();
    const got = [];
    lines(stream, (line) => got.push(line), 8000);
    for (const part of parts) stream.write(part);
    stream.end();
    await once(stream, "end");
    return got;
  };
  assert.deepEqual(await read("#".repeat(9000) + "\nnext\n"), ["#".repeat(8000), "next"], "ended in the part it came in");
  assert.deepEqual(await read("#".repeat(5000), "#".repeat(4000) + "\nnext\n"), ["#".repeat(8000), "next"], "begun in one part, ended in the next");
  assert.deepEqual(await read("#".repeat(9000), "#".repeat(1000) + "\nnext\n"), ["#".repeat(8000), "next"], "cut before its line break came");
});

test("what it starts in a chat's folder is no job of the chat's agent (Linux, where the jobs are read)", { skip: !LINUX && "only Linux lists an agent's jobs" }, async () => {
  // As the portal runs (server.ts): what it starts is marked as the agents' work, the half's process too.
  process.env.PITHAGORAS_AGENT = "1";
  const { spawn } = await import("node:child_process");
  // An agent's job, for what the list finds: a session of its own, in the chat's folder.
  const job = spawn("sleep", ["300"], { cwd: work, stdio: "ignore", detached: true });
  try {
    await host.syncServerHalves([
      half("spawner", `
        const { spawn } = await import("node:child_process");
        const sleeper = spawn("sleep", ["300"], { cwd: portal.chats.folder("a"), stdio: "ignore" });
        portal.router.get("/pid", (req, res) => res.json({ sleeper: sleeper.pid }));
      `),
    ]);
    const { sleeper } = (await get("/api/x/spawner/pid")).body;
    assert.equal(ended(sleeper), false);
    const jobs = await listJobs(work, false, true);
    assert.ok(jobs.some((one) => one.pids.includes(job.pid)), "an agent's job is listed");
    assert.deepEqual(jobs.filter((one) => one.pids.includes(sleeper)), []);
    await host.syncServerHalves([]);
    await until(() => ended(sleeper), "the half's own job ended with its process");
  } finally {
    job.kill("SIGKILL");
    delete process.env.PITHAGORAS_AGENT;
  }
});

test("a loop that never ends ends its process: its request is answered with the crash, the rest answers on, and it is held until switched off and on", async () => {
  const looper = (body) => half("looper", `
    portal.router.get("/hello", (req, res) => res.json({ hello: true }));
    portal.router.get("/loop", () => { portal.log("looping"); for (;;) {} });
    portal.chats.extend((pi) => pi.registerTool({ name: "spin", label: "spin", description: "Spins.", parameters: {}, async execute() { ${body} } }));
  `);
  const looping = looper(`portal.log("spinning"); for (;;) {}`);
  const other = half("other", `portal.router.get("/hello", (req, res) => res.json({ other: true }));`);
  const inside = half("inside", `portal.router.get("/hello", (req, res) => res.json({ inside: true }));`, { isolated: false });
  await host.syncServerHalves([looping, other, inside]);
  assert.deepEqual(await get("/api/x/looper/hello"), { status: 200, body: { hello: true } });
  const at = Date.now();
  const loop = get("/api/x/looper/loop");
  await until(() => status("looper").lines.includes("[extension looper] looping"), "it is looping");
  assert.deepEqual(await get("/api/x/other/hello"), { status: 200, body: { other: true } }, "another half in a process of its own answers");
  assert.deepEqual(await get("/api/x/inside/hello"), { status: 200, body: { inside: true } }, "and one in the portal's");
  assert.deepEqual(await loop, { status: 503, body: { error: `Its server half crashed: ${HUNG}` } });
  const took = Date.now() - at;
  // Counted from its last answer, which can be up to a second before the loop began.
  assert.ok(took > HANG - 1000 && took < HANG + 3000, `ended once the time it was given was up: ${took} ms`);
  await host.serversSettled();
  const crashed = status("looper");
  assert.equal(crashed.running, false);
  assert.equal(crashed.crash.error, HUNG);
  assert.equal(crashed.crash.stack, undefined, "the portal's own stack would say nothing of the half");
  assert.equal(HELD.exec(crashed.failure)?.[1], HUNG);
  await host.syncServerHalves([looping, other, inside]);
  assert.equal(host.isServing("looper"), false, "the revision that crashed is held");
  await host.syncServerHalves([other, inside]);
  await host.syncServerHalves([looping, other, inside]);
  assert.equal(host.isServing("looper"), true, "switched off and on, it starts");

  const { tools } = await chatPi("a");
  const call = await tools.find((tool) => tool.name === "spin").execute("1", {}, undefined, undefined, {}).then(() => "resolved", (e) => e.message);
  assert.match(call, new RegExp(`^The server half of looper crashed: ${HUNG.replace(/[()]/g, "\\$&")}\\. The call was not answered\\. It is off until another revision of it is installed, or it is switched off and on\\.\\n\\nIts last lines:\\n`));
  assert.match(call, /INFO {2}\[extension looper\] spinning\n/);
  await host.serversSettled();
  await host.syncServerHalves([looper(`return { content: [{ type: "text", text: "spun" }] };`), other, inside]);
  assert.equal(host.isServing("looper"), true, "another revision starts");
  const spun = await (await chatPi("a")).tools.find((tool) => tool.name === "spin").execute("2", {}, undefined, undefined, {});
  assert.deepEqual(spun, { content: [{ type: "text", text: "spun" }] });
  await host.syncServerHalves([]);
});

test("a heap that grows without end ends its process (SIGABRT), in each shape, and the portal goes on", async () => {
  // A heap near its limit can keep a process busy collecting for seconds on a slow machine: the hang check must not end it first.
  host.setLimits(10_000, 1_000, { heapMb: 64, hang: 60_000 });
  const shapes = {
    grows: `const a = []; for (let i = 0; ; i++) a[i] = i;`,
    parses: `const text = "[" + "1.5,".repeat(2 ** 24) + "1]"; portal.log("parsed " + JSON.parse(text).length);`,
    fills: `portal.log("filled " + new Array(2 ** 28).fill(0).length);`,
    pushes: `const a = []; for (;;) a.push({ n: a.length, text: "x" + a.length });`,
  };
  const halves = Object.entries(shapes).map(([name, body]) => half(`heap-${name}`, `portal.router.get("/blow", () => { ${body} });`));
  await host.syncServerHalves(halves);
  host.setLimits(10_000, 1_000, { heapMb: 512 });
  const answers = await Promise.all(halves.map((h) => get(`/api/x/${h.name}/blow`)));
  await host.serversSettled();
  for (const [i, h] of halves.entries()) {
    assert.deepEqual(answers[i], { status: 503, body: { error: "Its server half crashed: Error: Its process ended by SIGABRT" } }, h.name);
    const { crash, lines } = status(h.name);
    assert.equal(crash.error, "Error: Its process ended by SIGABRT", h.name);
    assert.ok(lines.some((line) => /heap out of memory|Allocation failed|invalid table size|invalid array length/i.test(line)), `${h.name}: V8 said why\n${lines.join("\n")}`);
  }
  assert.deepEqual(await get("/api/x/nobody/"), { status: 404, body: { error: "No such API route: GET /api/x/nobody/" } }, "the portal answers");
  host.setLimits(10_000, 1_000, { hang: HANG });
});

test("its memory over the limit ends its process (Linux, where the system says it)", { skip: !LINUX && "only Linux says a process's memory in /proc" }, async () => {
  host.setLimits(10_000, 1_000, { rssMb: 200 });
  await host.syncServerHalves([
    half("buffers", `const kept = []; portal.router.get("/grow", (req, res) => { setInterval(() => kept.push(Buffer.alloc(16 * 1024 * 1024, 1)), 10); res.json({ growing: true }); });`),
    half("floats", `const kept = []; portal.router.get("/grow", (req, res) => { setInterval(() => kept.push(new Float64Array(2 * 1024 * 1024).fill(1)), 10); res.json({ growing: true }); });`),
  ]);
  host.setLimits(10_000, 1_000, { rssMb: 1024 });
  for (const name of ["buffers", "floats"]) assert.deepEqual(await get(`/api/x/${name}/grow`), { status: 200, body: { growing: true } });
  await until(() => !host.isServing("buffers") && !host.isServing("floats"), "both were ended");
  await host.serversSettled();
  for (const name of ["buffers", "floats"]) assert.equal(status(name).crash.error, "Error: Its process used more than 200 MB of memory, so it was ended", name);
});

test("a throw in a timer is its crash, with its stack; so is process.exit(); a start that throws is a failure, and not held", async () => {
  const failing = half("bad-start", `portal.log("starting"); throw new Error("cannot start");`);
  await host.syncServerHalves([
    half("timer", `setTimeout(() => { throw new Error("thrown in a timer"); }, 100);`),
    half("exiter", `setTimeout(() => process.exit(3), 100);`),
    failing,
  ]);
  assert.equal(host.serverFailure("bad-start"), "cannot start");
  await until(() => !host.isServing("timer") && !host.isServing("exiter"), "both crashed");
  await host.serversSettled();
  const timer = status("timer");
  assert.equal(timer.crash.error, "Error: thrown in a timer");
  assert.match(timer.crash.stack, /halves\/timer\/server\.js:2/);
  assert.equal(status("exiter").crash.error, "Error: Its process ended with code 3");
  assert.equal(status("bad-start").crash, undefined);
  const starts = () => status("bad-start").lines.filter((line) => line === "[extension bad-start] starting").length;
  const before = starts();
  await host.syncServerHalves([failing]);
  assert.equal(starts(), before + 1, "not held: started again");
  await host.syncServerHalves([]);
});

test("stopping it ends what it started; a CommonJS file it requires is read again at its next start", async () => {
  const helper = (n) => ({ files: { "helper.cjs": `module.exports = () => ${n};\n` } });
  const body = `
    const { spawn } = await import("node:child_process");
    const { createRequire } = await import("node:module");
    const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
    const helper = createRequire(import.meta.url)("./helper.cjs");
    portal.router.get("/now", (req, res) => res.json({ sleeper: sleeper.pid, helper: helper() }));
  `;
  await host.syncServerHalves([half("starter", body, helper(1))]);
  const first = (await get("/api/x/starter/now")).body;
  assert.equal(first.helper, 1);
  assert.equal(ended(first.sleeper), false, "its sleep runs");
  await host.syncServerHalves([half("starter", body, helper(2))]);
  assert.equal(ended(first.sleeper), true, "its sleep was ended with it");
  assert.equal((await get("/api/x/starter/now")).body.helper, 2, "its CommonJS file changed is the one it runs");
  await host.syncServerHalves([]);
});

test("what a page that opens a chat is told first: on the chat's stream, and as openingFor answers", async () => {
  await host.syncServerHalves([
    half("opener", `portal.chats.onOpen((chatId) => (chatId === "m" ? undefined : { for: chatId, pid: process.pid })); portal.chats.onOpen(() => new Promise(() => {}));`),
  ]);
  const [first] = await host.openingFor("a", "opener");
  assert.equal(first.for, "a");
  assert.notEqual(first.pid, process.pid);
  assert.deepEqual(await host.openingFor("m", "opener"), []);
  const going = new AbortController();
  const stream = await fetch(`${base}/api/sessions/a/events`, { signal: going.signal });
  const reader = stream.body.getReader();
  let text = "";
  await until(async () => {
    const { value } = await reader.read();
    text += Buffer.from(value).toString();
    return text.includes("event: extension");
  }, "the stream had what it was told first");
  assert.match(text, /event: extension\ndata: \{"extension":"opener","data":\{"for":"a","pid":\d+\}\}\n\n/);
  going.abort();
  await host.syncServerHalves([]);
});

test("what the portal asks of it synchronously follows it: the tools it offers, and whether it holds the agent's memory", async () => {
  await host.syncServerHalves([
    half("mirrors", `
      let offered = [{ name: "first" }];
      let holds = false;
      portal.tools.offer(() => offered);
      portal.memory.hold({ label: "Mirror", rule: "Ask the mirror.", on: () => holds });
      portal.router.post("/change", (req, res) => { offered = [{ name: "second", description: "The second." }]; holds = true; res.json({}); });
    `),
  ]);
  assert.deepEqual(host.offeredTools().get("mirrors"), [{ name: "first" }]);
  assert.equal(memoryHolder(), undefined);
  await get("/api/x/mirrors/change", { method: "POST" });
  await until(() => host.offeredTools().get("mirrors")?.[0]?.name === "second" && memoryHolder()?.label === "Mirror", "the mirror followed");
  await host.syncServerHalves([]);
  assert.equal(memoryHolder(), undefined, "let go of when it stops");
});

test("it builds on an extension in the portal's process: a callback and an error's status cross, and it restarts with it; nothing builds on it", async () => {
  const provider = (n) =>
    half("provider", `portal.provide((consumer) => ({
      version: ${n},
      greet: async (who, onStep) => { await onStep("half way"); return "hello " + who + " from " + consumer.name; },
      fail: async () => { throw Object.assign(new Error("not today"), { status: 418 }); },
      nested: { deep: async () => 42 },
      gives: async () => ({ stop() {} }),
      keys: async (value) => Object.keys(value),
    }));`, { isolated: false });
  const consumer = half("consumer", `
    const api = portal.extensions.use("provider");
    portal.log("started with provider " + api.version);
    portal.router.get("/use", async (req, res) => {
      const steps = [];
      const greeting = await api.greet("you", (step) => steps.push(step));
      const failed = await api.fail().catch((e) => ({ message: e.message, status: e.status }));
      const refused = await api.gives().catch((e) => e.name + ": " + e.message);
      // A key "__proto__" in what it passes is a key, not a prototype.
      const keys = await api.keys(JSON.parse('{"__proto__": {"x": 1}, "a": 1}'));
      res.json({ greeting, steps, failed, deep: await api.nested.deep(), refused, keys });
    });
    // Asked by hand for what every object has, not what the provider gave: refused.
    portal.router.get("/inherited", (req, res) => {
      const id = 1e9;
      const heard = (message) => {
        if (message.t !== "result" || message.id !== id) return;
        process.off("message", heard);
        res.json(message.error ? { error: message.error.name + ": " + message.error.message } : { value: message.value });
      };
      process.on("message", heard);
      process.send({ t: "api", id, of: "provider", path: ["__proto__", "__defineGetter__"], args: ["polluted", 1] });
    });
  `, { requires: { provider: "^1.0.0" } });
  const lone = half("lone", `portal.log("up");`);
  const needs = half("needs-lone", `portal.log("up");`, { isolated: false, requires: { lone: "^1.0.0" } });
  const likes = half("likes-lone", `portal.log("with lone: " + (portal.extensions.use("lone") !== undefined));`, { isolated: false, optional: { lone: "^1.0.0" } });
  await host.syncServerHalves([provider(1), consumer, lone, needs, likes]);
  assert.deepEqual((await get("/api/x/consumer/use")).body, {
    greeting: "hello you from consumer",
    steps: ["half way"],
    failed: { message: "not today", status: 418 },
    deep: 42,
    refused: "TypeError: What gives of provider answered has a function at stop, which a server half in a process of its own cannot be given",
    keys: ["__proto__", "a"],
  });
  assert.deepEqual((await get("/api/x/consumer/inherited")).body, { error: "TypeError: What provider gives has no function at __proto__.__defineGetter__" });
  assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
  await host.syncServerHalves([provider(2), consumer, lone, needs, likes]);
  assert.deepEqual(status("consumer").lines.filter((line) => line.startsWith("[extension consumer] started")), ["[extension consumer] started with provider 1", "[extension consumer] started with provider 2"]);
  assert.equal(host.serverFailure("needs-lone"), "It needs lone, whose server half runs in a process of its own and gives nothing to build on");
  assert.ok(status("likes-lone").lines.includes("[extension likes-lone] with lone: false"));
  await host.syncServerHalves([]);
});

test("what it cannot have says so: provide, voice, pi beyond what a factory registers with, a registration once its factory is done", async () => {
  await host.syncServerHalves([
    half("unsupported", `
      const out = {};
      const attempt = (what, fn) => { try { fn(); out[what] = "ran"; } catch (e) { out[what] = e.name + ": " + e.message; } };
      attempt("provide", () => portal.provide(() => ({})));
      attempt("voice.provide", () => portal.voice.provide({}));
      attempt("voice.choose", () => portal.voice.choose(true));
      attempt("voice.chosen", () => portal.voice.chosen());
      attempt("modes.provide", () => portal.modes.provide({ id: "Not An Id" }));
      let kept;
      portal.chats.extend((pi) => { kept = pi; attempt("pi.exec", () => pi.exec("ls")); attempt("pi.events", () => pi.events); });
      portal.router.get("/out", (req, res) => { attempt("late", () => kept.registerTool({ name: "late" })); res.json(out); });
    `),
  ]);
  await chatPi("a");
  const unavailable = (what) => `Error: ${what} is not available to a server half in a process of its own`;
  assert.deepEqual((await get("/api/x/unsupported/out")).body, {
    provide: unavailable("provide"),
    "voice.provide": unavailable("voice.provide"),
    "voice.choose": unavailable("voice.choose"),
    "voice.chosen": unavailable("voice.chosen"),
    "modes.provide": 'TypeError: provide takes { id, label, description, confirm? }: an id of lower-case letters, digits and "-", and texts',
    "pi.exec": unavailable("pi.exec"),
    "pi.events": unavailable("pi.events"),
    late: "Error: pi.registerTool is taken only while a factory of chats.extend runs, in a server half in a process of its own",
  });
  await host.syncServerHalves([]);
});

test("a row in Audit, at once with its TypeError, and an install and where an extension stands, answered later", async () => {
  await host.syncServerHalves([
    half("auditor", `
      portal.audit.record({ subject: "made · extensions/x", reason: "Installed", chatId: "a" });
      let refused;
      try { portal.audit.record({ subject: "" }); } catch (e) { refused = e.name; }
      portal.router.get("/asked", async (req, res) => res.json({
        refused,
        status: (await portal.extensions.status("nobody")) ?? null,
        install: await portal.extensions.install("/nowhere").catch((e) => e.message),
      }));
    `),
  ]);
  const { kind, tool, subject, reason, session_id } = listAudit(1)[0];
  assert.deepEqual({ kind, tool, subject, reason, session_id }, { kind: "extension", tool: "auditor", subject: "made · extensions/x", reason: "Installed", session_id: "a" });
  const asked = (await get("/api/x/auditor/asked")).body;
  assert.deepEqual({ ...asked, install: undefined }, { refused: "TypeError", status: null, install: undefined });
  assert.match(asked.install, /ENOENT.*\/nowhere/);
  await host.syncServerHalves([]);
});

test("a child chat made, run, stopped and removed from its process, as the package that made it, and no other chat", async () => {
  // The session manager is not loaded here: what it is asked, and as which package, is written down.
  const asked = [];
  host.setChatBridge({
    tell: async () => false,
    offers: () => undefined,
    reload: async () => ({ reloaded: 0, waiting: 0 }),
    model: async () => undefined,
    create: (options, creator) => {
      asked.push(["create", options.parent, creator]);
      createSession({ id: "kid", title: options.title, workspace: work, executor: "host", parent_id: options.parent, listed: 0, creator });
      return getSession("kid");
    },
    run: async (id, message, options) => {
      asked.push(["run", id, message, options]);
      return { status: "done", answer: "42" };
    },
    abort: async (id) => void asked.push(["abort", id]),
    remove: async (id) => void asked.push(["remove", id]),
  });
  await host.syncServerHalves([
    half("maker", `
      portal.router.post("/go", async (req, res) => {
        const child = portal.chats.create({ parent: "a", title: "Helper", listed: false });
        const run = await portal.chats.prompt(child.id, "Answer", { steer: true });
        await portal.chats.abort(child.id);
        const found = portal.chats.children("a");
        const theirs = await portal.chats.remove("a").catch((e) => e.message);
        await portal.chats.remove(child.id);
        res.json({ child, run, theirs, found });
      });
    `),
  ]);
  assert.deepEqual((await get("/api/x/maker/go", { method: "POST" })).body, {
    child: { id: "kid", title: "Helper", workspace: work, status: "idle", parent: "a", listed: false },
    run: { status: "done", answer: "42" },
    theirs: "a is no child chat",
    found: [{ id: "kid", title: "Helper", workspace: work, status: "idle", parent: "a", listed: false }],
  });
  assert.deepEqual(asked, [["create", "a", "maker"], ["run", "kid", "Answer", { steer: true }], ["abort", "kid"], ["remove", "kid"]]);
  await host.syncServerHalves([]);
});

test("a command run as a chat's agent, from its process: its input and output as bytes, and an abort", async () => {
  await host.syncServerHalves([
    half("runner", `
      portal.router.get("/run", async (req, res) => {
        const ran = await portal.sandbox.run("a", ["cat"], { input: Buffer.from("bytes in") });
        const going = new AbortController();
        const at = Date.now();
        const slept = portal.sandbox.run("a", ["sleep", "10"], { signal: going.signal });
        setTimeout(() => going.abort(), 100);
        const stopped = await slept;
        res.json({ out: ran.stdout.toString(), buffer: Buffer.isBuffer(ran.stdout), code: ran.code, aborted: stopped.code !== 0, took: Date.now() - at });
      });
    `),
  ]);
  const { body } = await get("/api/x/runner/run");
  assert.deepEqual({ ...body, took: undefined }, { out: "bytes in", buffer: true, code: 0, aborted: true, took: undefined });
  assert.ok(body.took < 5000, `the sleep was ended by the abort: ${body.took} ms`);
  await host.syncServerHalves([]);
});

test("a portal that stalls does not end the halves whose answers waited for it", async () => {
  await host.syncServerHalves([half("patient", `portal.router.get("/hello", (req, res) => res.json({ hello: true }));`)]);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, HANG + 1500);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(host.isServing("patient"), true);
  assert.equal(status("patient").crash, undefined);
  assert.deepEqual(await get("/api/x/patient/hello"), { status: 200, body: { hello: true } });
  await host.syncServerHalves([]);
});

test("what its process runs loads nothing of the portal's database or extension host", () => {
  const dist = fileURLToPath(new URL("../dist/", import.meta.url));
  const reached = new Set();
  const walk = (file) => {
    if (reached.has(file)) return;
    reached.add(file);
    for (const [, spec] of readFileSync(file, "utf8").matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g)) walk(path.join(path.dirname(file), spec));
  };
  walk(path.join(dist, "half-runtime.js"));
  const names = [...reached].map((file) => path.relative(dist, file));
  assert.ok(names.includes("folder-files.js") && names.includes("send-file.js"), names.join(", "));
  assert.ok(!names.includes("db.js") && !names.includes("extension-host.js"), names.join(", "));
});

/** A scenario of the child's, in a home of its own: what only the end of the portal's process shows. */
async function scenario(name) {
  const { code, out, err } = await runToEnd([CHILD, name], serverEnv(testHome("isolated-halves-child-"), 0));
  const line = out.split("\n").find((l) => l.startsWith("RESULT "));
  return { code, out, err, result: line && JSON.parse(line.slice("RESULT ".length)) };
}

test("an error of its pi half, known by its stack, ends the half in its process and not the portal", async () => {
  const { code, err, result } = await scenario("piHalf");
  assert.equal(code, 0, err);
  assert.equal(result.crash, "Error: its pi extension's own bug");
  assert.equal(result.running, false);
});

test("an error of the portal's own whose message names a half's folder is not that half's crash", async () => {
  const { code, out, err, result } = await scenario("notWhose");
  assert.equal(code, 1, "given back to Node, which ends the process");
  assert.equal(result, undefined);
  assert.match(err, /Error: ENOENT: no such file or directory, open '.*halves\/named\/server\.js'/);
  assert.doesNotMatch(out + err, /its server half crashed/);
});

test("the portal's process ending ends every half's process, and what each started", async () => {
  const { code, err, result } = await scenario("portalEnds");
  assert.equal(code, 0, err);
  await until(() => ended(result.child) && ended(result.sleeper), "both ended", 5_000);
});

/**
 * What runs in a process of its own by the folder it is installed from: a package an extension's data folder holds,
 * however it was installed. With a stand-in pi that installs, removes and lists folders as pi 1.1.0 does, and that can
 * be told to wait once it has written pi's settings, before the install goes on.
 */
const agent = process.env.PI_CODING_AGENT_DIR;
const settings = path.join(agent, "settings.json");
const hold = path.join(home, "pi-hold");
mkdirSync(agent, { recursive: true });
writeFileSync(settings, JSON.stringify({ packages: [] }));
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
const hold = ${JSON.stringify(hold)};
const all = JSON.parse(fs.readFileSync(file, "utf8"));
const source = (p) => (typeof p === "string" ? p : p.source);
const where = (p) => path.resolve(agent, source(p));
if (command === "list") {
  process.stdout.write("User packages:\\n" + all.packages.map((p) => "  " + source(p) + "\\n    " + where(p) + "\\n").join(""));
} else if (command === "install") {
  if (!all.packages.some((p) => where(p) === path.resolve(arg))) all.packages.push(path.relative(agent, path.resolve(arg)) || ".");
  fs.writeFileSync(file, JSON.stringify(all));
  if (fs.existsSync(hold)) {
    fs.writeFileSync(hold + ".written", "");
    while (!fs.existsSync(hold + ".go")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
} else if (command === "remove") {
  all.packages = all.packages.filter((p) => where(p) !== path.resolve(arg));
  fs.writeFileSync(file, JSON.stringify(all));
}
`,
);
chmodSync(path.join(bin, "pi"), 0o755);
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

/** A package in `dir`: its package.json says `pithagoras`, and its server half answers which process it runs in. */
function packageAt(dir, name, pithagoras = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", type: "module", pi: {}, pithagoras: { server: "./server.js", ...pithagoras } }));
  writeFileSync(path.join(dir, "server.js"), `export default function (portal) {\n  portal.router.get("/pid", (req, res) => res.json({ pid: process.pid }));\n}\n`);
  return dir;
}
const pidOf = async (name) => (await get(`/api/x/${name}/pid`)).body?.pid;

test("isolated by its manifest, or by the folder it is in: an extension's data folder, installed by path in Settings or by the extension", async () => {
  assert.equal(serverHalf(packageAt(path.join(home, "packages", "flagged"), "flagged", { isolated: true })).isolated, true);
  assert.equal(serverHalf(packageAt(path.join(home, "packages", "plain"), "plain")).isolated, undefined);

  // The test's own installer, in a folder of its own: it runs in the portal's process, and keeps its portal for the test.
  const installer = packageAt(path.join(home, "packages", "installer"), "test-installer");
  writeFileSync(path.join(installer, "server.js"), `export default function (portal) {\n  globalThis.installer = portal;\n  portal.router.get("/pid", (req, res) => res.json({ pid: process.pid }));\n}\n`);
  assert.equal((await get("/api/packages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ spec: installer }) })).status, 200);
  assert.equal(await pidOf("test-installer"), process.pid);
  const data = globalThis.installer.dataDir();

  // A folder of its data, which the person installs by its path: no note, and still in a process of its own.
  const byPath = packageAt(path.join(data, "made", "by-path"), "by-path");
  assert.equal((await get("/api/packages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ spec: byPath }) })).status, 200);
  const pid = await pidOf("by-path");
  assert.ok(pid && pid !== process.pid, `by-path runs in ${pid}, the portal in ${process.pid}`);
  const listed = (await get("/api/extensions")).body.extensions.find((ext) => ext.name === "by-path");
  assert.deepEqual(listed.installedFrom, { extension: "test-installer" });

  // An install of the extension's own, with the halves brought in line by someone else after pi wrote its settings and
  // before the install wrote its note: already then the half runs apart.
  const early = packageAt(path.join(data, "made", "early"), "early");
  writeFileSync(hold, "");
  const installing = globalThis.installer.extensions.install(early, { note: "made early" });
  await until(() => existsSync(`${hold}.written`), "pi wrote its settings");
  await followPackages();
  const earlyPid = await pidOf("early");
  const spec = path.relative(agent, early);
  assert.ok(earlyPid && earlyPid !== process.pid, `early runs in ${earlyPid}, the portal in ${process.pid}`);
  assert.equal(installNotes()[spec], undefined, "before the note was written");
  writeFileSync(`${hold}.go`, "");
  const installed = await installing;
  assert.equal(installed.installedFrom.note, "made early");
  assert.equal(await pidOf("early"), earlyPid, "and the install's own bringing in line left it as it was");
  for (const name of ["by-path", "early", "test-installer"]) {
    const ext = (await get("/api/extensions")).body.extensions.find((e) => e.name === name);
    assert.equal((await get("/api/packages", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ spec: ext.spec }) })).status, 200, name);
  }
});
