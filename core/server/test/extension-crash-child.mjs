import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Server halves that crash, in a process of their own, as the portal runs them: the console kept, and what the portal
 * does about a crash in place. Run by extension-crashes.test.mjs, one scenario a process, with the test's home in its
 * environment; it prints what it found as `RESULT <json>` and ends. One where the error is the process's own ends as
 * Node ends a process.
 */
const { installLogCapture } = await import("../dist/logs.js");
installLogCapture();
const host = await import("../dist/extension-host.js");
const { createSession } = await import("../dist/db.js");
const { default: express } = await import("express");
host.catchExtensionCrashes();
host.setLimits(5_000, 1_000);

let revs = 0;
/** A server half in a folder of its own, its module's default export's body written anew: a revision of its own. */
function half(name, body, more = {}) {
  const dir = path.join(process.env.DATA_DIR, "halves", name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "server.js");
  writeFileSync(file, `export default async function (portal) {\n${body}\n}\n`);
  return { name, version: "1.0.0", file, rev: `r${++revs}`, ...more };
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
  app.use("/api", (req, res) => res.status(404).json({ error: `No such API route: ${req.method} ${req.originalUrl}` }));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const get = async (p) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`);
    return { status: res.status, body: await res.json() };
  };
  return { get, close: () => (server.closeAllConnections(), server.close()) };
}

const scenarios = {
  /**
   * One throws in a timer: held, with one that requires it stopped too and one that does not left running. The same
   * revision is not started again; another one is. One whose timer throws in Node's own code, with nothing of it in the
   * stack, is known by the code that set the timer. One whose error comes by a way Node does not follow (a microtask)
   * is known by its folder.
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
    const all = [crashy, needs, likes, other, parser, micro];
    await host.syncServerHalves(all);
    const started = all.map((h) => host.isServing(h.name));
    await until(() => !host.isServing("crashy") && !host.isServing("parser") && !host.isServing("micro"), "all three crashed");
    await host.serversSettled();
    const after = { crashy: status("crashy"), needs: status("needs-crashy"), likes: host.isServing("likes-crashy"), other: host.isServing("other"), parser: status("parser"), micro: status("micro") };
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
   * A tool's call into a half that crashes while the call is pending: answered at once with the crash and the half's
   * last lines; a later call, without its code running; a new revision's tool works.
   */
  async tool() {
    createSession({ id: "c", title: "A chat", workspace: path.join(process.env.WORKSPACE_ROOT, "c"), executor: "host" });
    const tool = (body) => `
      portal.chats.extend((pi) => pi.registerTool({
        name: "slow_tool", label: "slow_tool", description: "Takes its time.", parameters: { type: "object", properties: {} },
        async execute() { ${body} },
      }));
    `;
    const tooly = half("tooly", tool(`
      (globalThis.calls ??= []).push("called");
      portal.log("working on it");
      setTimeout(() => { throw new Error("the tool's timer threw"); }, 100);
      return new Promise(() => {});
    `));
    await host.syncServerHalves([tooly]);
    const registered = () => {
      const tools = [];
      for (const { factory } of host.hostExtensions("c")) factory({ registerTool: (t) => tools.push(t), on: () => {} });
      return tools;
    };
    const [slow] = registered();
    const at = Date.now();
    const pending = await slow.execute("1", {}, undefined, undefined, {}).then(() => "resolved", (e) => e.message);
    const took = Date.now() - at;
    await host.serversSettled();
    const later = await slow.execute("2", {}, undefined, undefined, {}).then(() => "resolved", (e) => e.message);
    const calls = globalThis.calls.length;
    const held = { serving: host.isServing("tooly"), tools: registered().length };
    await host.syncServerHalves([half("tooly", tool(`return { content: [{ type: "text", text: "done" }], details: {} };`))]);
    const fixed = await registered()[0].execute("3", {}, undefined, undefined, {});
    return { pending, took, later, calls, held, fixed };
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
