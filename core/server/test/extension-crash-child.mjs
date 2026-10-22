import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

/**
 * Server halves that crash, in a process of their own, as the portal runs them: the console kept, and what the portal
 * does about a crash in place. Run by extension-crashes.test.mjs, one scenario a process, with the test's home in its
 * environment; it prints what it found as `RESULT <json>` and ends. One where the error is the process's own ends as
 * Node ends a process.
 */
const { installLogCapture } = await import("../dist/logs.js");
installLogCapture();
const host = await import("../dist/extension-host.js");
const { createSession, getSession, updateSession } = await import("../dist/db.js");
const { providedModes } = await import("../dist/chat-modes.js");
const { default: express } = await import("express");
host.catchExtensionCrashes();
host.setLimits(5_000, 1_000);

let revs = 0;
/** A file in the folder of a server half's. */
function file(name, rel, text) {
  const dir = path.join(process.env.DATA_DIR, "halves", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, rel), text);
  return path.join(dir, rel);
}
/** A server half in a folder of its own, its module's default export's body written anew: a revision of its own. */
function half(name, body, more = {}) {
  const at = file(name, "server.js", `export default async function (portal) {\n${body}\n}\n`);
  return { name, version: "1.0.0", file: at, rev: `r${++revs}`, ...more };
}

/** The tools, handlers and commands a chat's pi is given by the server halves, as a stand-in pi takes them. */
function chatPi(chatId, pi = {}) {
  const tools = [], handlers = [], commands = [];
  for (const { factory } of host.hostExtensions(chatId)) {
    factory({ registerTool: (t) => tools.push(t), on: (event, h) => handlers.push(h), registerCommand: (name, o) => commands.push(o), ...pi });
  }
  return { tools, handlers, commands };
}

async function until(done, what) {
  for (const end = Date.now() + 10_000; !done(); await new Promise((resolve) => setTimeout(resolve, 10))) {
    if (Date.now() > end) throw new Error(`timed out waiting until ${what}`);
  }
}

/** Where a half stands, with its lines as text. */
function status(name) {
  const { lines, ...rest } = host.serverHalfStatus(name);
  return { ...rest, lines: lines.map((line) => line.text) };
}

/** The extensions' routes, as the portal mounts them, on a port of their own. */
async function routes() {
  const app = express();
  app.use("/api/x", host.extensionRoutes);
  app.use("/api", (req, res) => {
    console.log(`the portal answered ${req.originalUrl} itself`);
    res.status(404).json({ error: `No such API route: ${req.method} ${req.originalUrl}` });
  });
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const get = async (p) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`);
    try {
      return { status: res.status, body: await res.json() };
    } catch (e) {
      return { status: res.status, cut: e.message };
    }
  };
  return { get, base: `http://127.0.0.1:${server.address().port}`, close: () => (server.closeAllConnections(), server.close()) };
}

const scenarios = {
  /**
   * One throws in a timer: held, with one that requires it stopped too and one that does not left running. The same
   * revision is not started again; another one is. One whose timer throws in Node's own code, with nothing of it in the
   * stack, is known by the code that set the timer. One whose error comes by a way Node does not follow (a microtask)
   * is known by its folder, as an address (its module) or as a path (a CommonJS file it requires); and so is an error of
   * a pi extension kept in that folder, which the portal did not run as the half's code.
   */
  async timer() {
    const crashy = half("crashy", `
      portal.log("starting");
      console.log("printed by its own code");
      setTimeout(() => { throw new Error("thrown in a timer"); }, 100);
    `);
    const needs = half("needs-crashy", `portal.log("up");`, { requires: { crashy: "^1.0.0" } });
    const likes = half("likes-crashy", `portal.log("up, with crashy: " + (portal.extensions.use("crashy") !== undefined));`, { optional: { crashy: "^1.0.0" } });
    const other = half("other", `portal.log("up");`);
    const parser = half("parser", `setTimeout(JSON.parse, 100, "{");`);
    const micro = half("micro", `setTimeout(() => queueMicrotask(() => { throw new Error("thrown in a microtask"); }), 100);`);
    file("cjs", "lib.cjs", `module.exports = () => setTimeout(() => queueMicrotask(() => { throw new Error("thrown in a CommonJS file"); }), 100);\n`);
    const cjs = half("cjs", `const { createRequire } = await import("node:module"); createRequire(import.meta.url)("./lib.cjs")();`);
    const piFile = file("with-pi", "pi.js", `setTimeout(() => { throw new Error("its pi extension's own bug"); }, 100);\n`);
    const withPi = half("with-pi", `portal.log("up");`);
    const all = [crashy, needs, likes, other, parser, micro, cjs, withPi];
    await host.syncServerHalves(all);
    const started = all.map((h) => host.isServing(h.name));
    // Loaded by something else than the portal's server halves, as a chat's pi loads it.
    await import(pathToFileURL(piFile).href);
    const crashing = ["crashy", "parser", "micro", "cjs", "with-pi"];
    await until(() => crashing.every((name) => !host.isServing(name)), "all five crashed");
    await host.serversSettled();
    const after = {
      crashy: status("crashy"),
      needs: status("needs-crashy"),
      likes: host.isServing("likes-crashy"),
      other: host.isServing("other"),
      parser: status("parser"),
      micro: status("micro"),
      cjs: status("cjs"),
      withPi: status("with-pi"),
    };
    await host.syncServerHalves(all);
    const sameRevision = host.isServing("crashy");
    const fixed = half("crashy", `portal.log("fixed");`);
    await host.syncServerHalves([fixed, needs, likes, other]);
    return { started, after, sameRevision, fixed: status("crashy"), needs: host.isServing("needs-crashy") };
  },

  /**
   * One whose promise rejects with nobody to hear it, from a route, in Node's own code (a fetch that fails): held; switched
   * off and on, it starts again.
   */
  async rejection() {
    const http = await routes();
    const crashy = half("rejecting", `
      portal.router.get("/later", (req, res) => { void fetch("http://127.0.0.1:1/"); res.json({ answered: true }); });
    `);
    await host.syncServerHalves([crashy]);
    const answered = await http.get("/api/x/rejecting/later");
    await until(() => !host.isServing("rejecting"), "it crashed");
    await host.serversSettled();
    const after = status("rejecting");
    const route = await http.get("/api/x/rejecting/later");
    await host.syncServerHalves([]);
    await host.syncServerHalves([crashy]);
    const again = host.isServing("rejecting");
    http.close();
    return { answered, after, route, again };
  },

  /** One that calls process.exit(), from a route and from a timer: each a crash of its own, and the process goes on. */
  async exit() {
    const http = await routes();
    const quitter = half("quitter", `portal.router.get("/quit", () => { process.exit(3); }); portal.router.get("/hello", (req, res) => res.json({ hello: true }));`);
    const timed = half("timed-quitter", `setTimeout(() => process.exit(4), 100);`);
    await host.syncServerHalves([quitter, timed]);
    const hello = await http.get("/api/x/quitter/hello");
    const quit = await http.get("/api/x/quitter/quit");
    await until(() => !host.isServing("quitter") && !host.isServing("timed-quitter"), "both crashed");
    await host.serversSettled();
    const after = await http.get("/api/x/quitter/hello");
    http.close();
    return { hello, quit, after, quitter: status("quitter"), timed: status("timed-quitter") };
  },

  /**
   * A half's code left going after it crashed, or after it was stopped, known only by its stack (a listener on an
   * emitter it does not own) or by the code that started it (a timer it left): each error of it is said, the portal
   * goes on, and the half running in its place is not stopped for it.
   */
  async left() {
    globalThis.bus = new EventEmitter();
    const listener = half("listener", `globalThis.bus.on("tick", (n) => { throw new Error("its listener threw " + n); });`);
    // Its first start leaves a timer going that throws once, after it has been started again.
    const leaky = half("leaky", `
      const gen = (globalThis.gen = (globalThis.gen ?? 0) + 1);
      let n = 0;
      if (gen === 1) setInterval(() => { if (++n === 30) throw new Error("left behind"); }, 10);
      portal.log("up, start " + gen);
    `, { optional: { dep: "^1.0.0" } });
    const dep = half("dep", `portal.log("up");`);
    await host.syncServerHalves([listener, leaky]);
    // Started again, as the one it builds on comes: its first start is stopped.
    await host.syncServerHalves([listener, leaky, dep]);
    setTimeout(() => globalThis.bus.emit("tick", 1), 10);
    await until(() => !host.isServing("listener"), "it crashed");
    await host.serversSettled();
    setTimeout(() => globalThis.bus.emit("tick", 2), 10);
    await new Promise((resolve) => setTimeout(resolve, 600));
    return { listener: status("listener"), leaky: status("leaky") };
  },

  /** One that crashes while it starts: given up on at once, not when the time to start is up. */
  async starting() {
    const at = Date.now();
    await host.syncServerHalves([half("slow-start", `setTimeout(() => { throw new Error("boom at start"); }, 50); await new Promise(() => {});`)]);
    const took = Date.now() - at;
    await host.serversSettled();
    return { took, status: status("slow-start") };
  },

  /**
   * Halves whose code runs only as the portal calls it, each of which starts a timer that throws in Node's own code,
   * or leaves a fetch failing with nobody to hear it, so nothing of the half is in the error's stack: from a tool's
   * call, a chat's event, a handler in a chat's pi, a chat's life, an upgrade, its socket's data, and a request and an
   * answer that close as the browser goes away. Each is held for its own crash.
   */
  async scoped() {
    createSession({ id: "c", title: "A chat", workspace: path.join(process.env.WORKSPACE_ROOT, "c"), executor: "host" });
    const http = await routes();
    const parse = `setTimeout(JSON.parse, 50, "{")`;
    const halves = [
      half("from-tool", `portal.chats.extend((pi) => pi.registerTool({ name: "t", label: "t", description: "t", parameters: { type: "object", properties: {} }, execute() { ${parse}; return new Promise(() => {}); } }));`),
      half("from-event", `portal.chats.onEvent(() => { ${parse}; });`),
      half("from-handler", `portal.chats.extend((pi) => pi.on("turn_start", () => { ${parse}; }));`),
      half("from-life", `portal.chats.on("started", () => { ${parse}; });`),
      half("from-upgrade", `portal.http.upgrade(() => { ${parse}; });`),
      half("from-socket", `portal.http.upgrade((req, socket) => socket.on("data", () => void fetch("http://127.0.0.1:1/")));`),
      half("from-request", `portal.router.get("/", (req) => { req.on("close", () => void fetch("http://127.0.0.1:1/")); globalThis.reached++; });`),
      half("from-answer", `portal.router.get("/", (req, res) => { res.on("close", () => void fetch("http://127.0.0.1:1/")); globalThis.reached++; });`),
    ];
    await host.syncServerHalves(halves);
    const { tools, handlers } = chatPi("c");
    const call = tools[0].execute("1", {}, undefined, undefined, {}).then(() => "resolved", (e) => e.message);
    host.chatEvent("c", { type: "turn_start" });
    await handlers[0]({ type: "turn_start" }, {});
    host.chatLife("started", "c");
    host.extensionUpgrade("/api/x/from-upgrade/")({ url: "/api/x/from-upgrade/", headers: {} }, new PassThrough(), Buffer.alloc(0));
    const socket = new PassThrough();
    host.extensionUpgrade("/api/x/from-socket/")({ url: "/api/x/from-socket/", headers: {} }, socket, Buffer.alloc(0));
    socket.emit("data", Buffer.from("hello"));
    globalThis.reached = 0;
    const going = new AbortController();
    const asked = ["from-request", "from-answer"].map((name) => fetch(`${http.base}/api/x/${name}/`, { signal: going.signal }).catch((e) => e.name));
    await until(() => globalThis.reached === 2, "the requests reached their routes");
    going.abort();
    const answered = await Promise.all(asked);
    await until(() => halves.every((h) => !host.isServing(h.name)), "all crashed");
    await host.serversSettled();
    http.close();
    return { call: await call, answered, crashes: Object.fromEntries(halves.map((h) => [h.name, status(h.name).crash])) };
  },

  /**
   * What a half said is kept for it, the latest lines up to a limit, whatever it says it is; a call its crash ends
   * carries the last few of them, with nothing in them that looks like a secret.
   */
  async lines() {
    createSession({ id: "c", title: "A chat", workspace: path.join(process.env.WORKSPACE_ROOT, "c"), executor: "host" });
    const chatty = half("chatty", `
      for (let i = 1; i <= 500; i++) portal.log("line " + i);
      console.log("[extension other] forged");
      portal.chats.extend((pi) => pi.registerTool({
        name: "t", label: "t", description: "t", parameters: { type: "object", properties: {} },
        execute() {
          portal.log("sending Bearer abcdefghijklmnop1234");
          setTimeout(() => { throw new Error("refused: Bearer abcdefghijklmnop1234"); }, 50);
          return new Promise(() => {});
        },
      }));
    `);
    await host.syncServerHalves([chatty, half("wordy", `for (let i = 1; i <= 150; i++) portal.log(i + " " + "x".repeat(1000));`)]);
    const kept = status("chatty").lines;
    const call = await chatPi("c").tools[0].execute("1", {}, undefined, undefined, {}).then(() => "resolved", (e) => e.message);
    await host.serversSettled();
    const wordy = status("wordy").lines;
    return { kept, other: status("other").lines, wordy: { count: wordy.length, chars: wordy.reduce((n, line) => n + line.length, 0), last: wordy.at(-1) }, call, crash: status("chatty").crash };
  },

  /**
   * What the portal does that a half asks for runs as the portal's own, not as the half's code: what it prints there is
   * not the half's. A chat told, the chats reloaded, a chat's model, a request its routes handed on, and a turn it asked
   * the chat's pi for.
   */
  async portalsOwn() {
    createSession({ id: "c", title: "A chat", workspace: path.join(process.env.WORKSPACE_ROOT, "c"), executor: "host" });
    host.setChatBridge({
      tell: async () => (console.log("the portal told the chat"), true),
      offers: () => undefined,
      reload: async () => (console.log("the portal reloaded the chats"), { reloaded: 0, waiting: 0 }),
      model: async () => (console.log("the portal looked up the model"), undefined),
    });
    const http = await routes();
    await host.syncServerHalves([half("asker", `
      portal.router.get("/ask", async (req, res, next) => {
        await portal.chats.tell("c", {});
        await portal.chats.reload();
        await portal.models.of("c");
        portal.log("asked");
        next();
      });
      portal.chats.extend((pi) => pi.registerTool({
        name: "t", label: "t", description: "t", parameters: { type: "object", properties: {} },
        execute() {
          pi.sendMessage({ customType: "note", content: "hi", display: true }, { triggerTurn: true });
          pi.sendUserMessage("hi");
          portal.log("sent");
          return { content: [], details: {} };
        },
      }));
    `)]);
    const asked = await http.get("/api/x/asker/ask");
    await chatPi("c", { sendMessage: () => console.log("pi ran a turn"), sendUserMessage: () => console.log("pi ran the user's turn") }).tools[0].execute("1", {}, undefined, undefined, {});
    http.close();
    return { asked, lines: status("asker").lines };
  },

  /** What a half's routes had not answered when it crashed is answered then: one not begun with an error, one begun cut off. */
  async pending() {
    const http = await routes();
    const later = `setTimeout(() => { throw new Error("thrown while a request waited"); }, 100)`;
    await host.syncServerHalves([
      half("waiter", `portal.router.get("/", () => { ${later}; });`),
      half("streamer", `portal.router.get("/", (req, res) => { res.write("["); ${later}; });`),
    ]);
    const [waited, streamed] = await Promise.all([http.get("/api/x/waiter/"), http.get("/api/x/streamer/")]);
    http.close();
    return { waited, streamed };
  },

  /**
   * A tool's call into a half that crashes while the call is pending, and a handler of it in a chat's pi that is pending
   * too: each answered at once with the crash and the half's last lines; a later call, and its command, without its
   * code running; a later event, without its handler. A new revision's tool works.
   */
  async tool() {
    createSession({ id: "c", title: "A chat", workspace: path.join(process.env.WORKSPACE_ROOT, "c"), executor: "host" });
    const tool = (body, more = "") => `
      portal.chats.extend((pi) => {
        pi.registerTool({
          name: "slow_tool", label: "slow_tool", description: "Takes its time.", parameters: { type: "object", properties: {} },
          async execute() { ${body} },
        });
        ${more}
      });
    `;
    const tooly = half("tooly", tool(`
      globalThis.calls.push("called");
      portal.log("working on it");
      setTimeout(() => { throw new Error("the tool's timer threw"); }, 100);
      return new Promise(() => {});
    `, `
      pi.on("tool_call", () => { globalThis.calls.push("handler"); return new Promise(() => {}); });
      pi.registerCommand("tooly", { description: "Says so.", handler: async () => { globalThis.calls.push("command"); } });
    `));
    globalThis.calls = [];
    await host.syncServerHalves([tooly]);
    const { tools: [slow], handlers: [handler], commands: [command] } = chatPi("c");
    const handling = handler({ type: "tool_call" }, {}).then(() => "resolved", (e) => e.message);
    const at = Date.now();
    const pending = await slow.execute("1", {}, undefined, undefined, {}).then(() => "resolved", (e) => e.message);
    const took = Date.now() - at;
    await host.serversSettled();
    const later = await slow.execute("2", {}, undefined, undefined, {}).then(() => "resolved", (e) => e.message);
    const laterHandler = await handler({ type: "tool_call" }, {});
    const laterCommand = await command.handler("", {}).then(() => "resolved", (e) => e.message);
    const calls = [...globalThis.calls];
    const held = { serving: host.isServing("tooly"), tools: chatPi("c").tools.length };
    await host.syncServerHalves([half("tooly", tool(`return { content: [{ type: "text", text: "done" }], details: {} };`))]);
    const fixed = await chatPi("c").tools[0].execute("3", {}, undefined, undefined, {});
    return { pending, handling: await handling, took, later, laterHandler: laterHandler ?? null, laterCommand, calls, held, fixed };
  },

  /** One that offers a chat mode and then crashes: its mode goes with it, and a chat started in it keeps it. */
  async mode() {
    createSession({ id: "c", title: "A chat", workspace: path.join(process.env.WORKSPACE_ROOT, "c"), executor: "host" });
    updateSession("c", { mode: "focuser/focus" });
    await host.syncServerHalves([half("focuser", `
      portal.modes.provide({ id: "focus", label: "Focus mode", description: "Works with the focus tool." });
      setTimeout(() => { throw new Error("thrown after it offered a mode"); }, 100);
    `)]);
    const before = providedModes().map((mode) => mode.id);
    await until(() => !host.isServing("focuser"), "it crashed");
    await host.serversSettled();
    return { before, after: providedModes().map((mode) => mode.id), stored: getSession("c").mode, crash: status("focuser").crash.error };
  },

  /** An error of the process's own, thrown: Node's end, as without the portal's handling. */
  async ownException() {
    await host.syncServerHalves([half("bystander", `portal.log("up");`)]);
    setTimeout(() => { throw new Error("the portal's own failure"); }, 50);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return { survived: true };
  },

  /** An error of the process's own, a rejection nobody heard: the same. */
  async ownRejection() {
    await host.syncServerHalves([half("bystander", `portal.log("up");`)]);
    setTimeout(() => void Promise.reject(new Error("the portal's own rejection")), 50);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return { survived: true };
  },
};

const result = await scenarios[process.argv[2]]();
await host.stopServerHalves();
console.log(`RESULT ${JSON.stringify(result)}`);
// The portal's own exit, which is the process's.
process.exit(0);
