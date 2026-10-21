import { after } from "node:test";
import { once } from "node:events";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { fakeDocker, type FakeContainer, type FakeExec } from "../../docker/test/fake-docker.ts";
import { freePort } from "../../../tests/helpers.mts";

/**
 * Understory as the portal runs it, in the process of a test: its server half started by the portal's own extension
 * host, after Docker's, which it requires, each from its own package as the portal reads it, and Docker speaking to a
 * daemon of the tests' own (Docker's fake-docker.ts), never to one on the machine. Understory itself is a server of the
 * test's own on the loopback (`understory`), where the Understory the portal runs answers (`UNDERSTORY_PORT`), and the
 * scripts run in its container say what the test has them say (`scripts`).
 *
 * Call inProcessHome before: the portal's modules read where everything is as they load.
 */

const core = (file: string) => new URL(`../../../core/server/dist/${file}`, import.meta.url).href;

/** A server half of a package in extensions/, from its source, with what its package.json says it requires. */
async function half(folder: string) {
  const { requiresOf } = await import(core("extension-ui.js"));
  const meta = JSON.parse(readFileSync(new URL(`../../${folder}/package.json`, import.meta.url), "utf8"));
  return { name: meta.name as string, version: meta.version as string, file: fileURLToPath(new URL(`../../${folder}/src/server.ts`, import.meta.url)), rev: meta.version as string, requires: requiresOf(meta) };
}

export const CONTAINER = "pithagoras-understory";
export const VOLUME = "pithagoras_understory-memory";
export const IMAGE = "ghcr.io/thecodacus/understory:latest";

/** Which of the scripts the portal runs in Understory's container a command is, by what is in it. */
export function scriptOf(e: FakeExec): string {
  if (e.Cmd[0] === "pkill") return "pkill";
  const text = e.Cmd[2] ?? "";
  for (const [name, mark] of [
    ["dream", "runDream"],
    ["repair", "runMutation"],
    ["save", "kb.writeConcept"],
    ["delete", "kb.deleteConcept"],
    ["reindex", "pruneEmptyDirs"],
    ["wipe", "fs.readdir(root)"],
    ["clearLog", '".traces"'],
  ]) {
    if (text.includes(mark)) return name;
  }
  return "health";
}

/** A container's environment as names and values. */
export const envOf = (c: FakeContainer) => Object.fromEntries(((c.made?.Env as string[] | undefined) ?? []).map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));

/** Understory's own web server, as the test has it answer: its read API, its librarian, and whether it answers at all. */
async function understoryServer() {
  const seen: { method: string; url: string; auth?: string; body?: any }[] = [];
  const state = {
    /** Nothing answers: as while it starts again. */
    down: false,
    /** What a read answers, by its path (`/api/tree`), else an empty list. */
    reads: {} as Record<string, { status?: number; body: unknown }>,
    /** How the librarian answers: whole, hanging until `finish`, refusing, or cut off midway. */
    chat: "answer" as "answer" | "hang" | "refuse" | "cut",
    finish: undefined as (() => void) | undefined,
    closed: false,
  };
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, ...(raw ? { body: JSON.parse(raw) } : {}) });
    if (state.down) return void req.socket.destroy();
    const route = req.url!.split("?")[0];
    if (route === "/api/chat") {
      if (state.chat === "refuse") return res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "no model" }));
      res.on("close", () => (state.closed = !res.writableFinished));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse({ type: "start" }));
      if (state.chat === "answer") return void res.end(sse({ type: "text-delta", id: "t", delta: "Hi" }, "[DONE]"));
      // Understory restarting in the middle of a sentence, with an event half written.
      if (state.chat === "cut") return void setTimeout(() => (res.write('data: {"type":"text-del'), res.destroy()), 20);
      state.finish = () => res.end(sse("[DONE]"));
      return;
    }
    const read = state.reads[route];
    res.writeHead(read?.status ?? 200, { "content-type": "application/json" });
    res.end(typeof read?.body === "string" ? read.body : JSON.stringify(read ? read.body : route === "/api/validate" ? { conformant: true, issues: [] } : []));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { port: (server.address() as AddressInfo).port, seen, state };
}

/** Server-sent events, as the librarian's stream has them. */
export const sse = (...chunks: unknown[]) => chunks.map((c) => `data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`).join("");

export async function startUnderstory() {
  const docker = await fakeDocker();
  process.env.DOCKER_SOCKET = docker.socket;
  process.env.PORTAL_CONTAINER_NAME = "portal-test";
  process.env.UNDERSTORY_LLM_PORT = String(await freePort());
  delete process.env.MEMORY_UNDERSTORY_URL;
  delete process.env.UNDERSTORY_VOLUME;
  const understory = await understoryServer();
  process.env.UNDERSTORY_PORT = String(understory.port);
  /** What the scripts run in the container say, by script (`scriptOf`): a report as their last line, unless a test says. */
  const scripts: Record<string, () => { out?: string; code?: number }> = {};
  docker.runs.onExec = (e) => {
    const name = scriptOf(e);
    if (scripts[name]) return scripts[name]();
    return { out: name === "pkill" ? "" : `${JSON.stringify({ health: { healthy: true, orphans: [], brokenLinks: [], issues: [] } })}\n` };
  };
  const host = await import(core("extension-host.js"));
  const db = await import(core("db.js"));
  // The portal's database first, upgraded, as the portal opens it before it starts the server halves.
  db.getDb();
  const halves = { docker: await half("docker"), understory: await half("understory") };
  after(async () => {
    await host.stopServerHalves();
    await docker.close();
  });

  const agentDir = process.env.PI_CODING_AGENT_DIR!;
  mkdirSync(agentDir, { recursive: true });
  const machine = {
    /** The portal's own container, running under the name the portal is told (PORTAL_CONTAINER_NAME), with this id. */
    portalIs(id: string) {
      const at = docker.containers.findIndex((c) => c.Name === "portal-test");
      if (at >= 0) docker.containers.splice(at, 1);
      docker.containers.push({ Id: id, Name: "portal-test", Image: "pithagoras-portal:latest", State: "running", Labels: {}, Tty: false, out: "", err: "" });
    },
    /** Understory's container as Docker has it now. */
    understory: (): FakeContainer | undefined => docker.containers.find((c) => c.Name === CONTAINER),
    /** Understory's containers made, in the order they were. */
    made: () => docker.created.filter((c) => c.Name === CONTAINER),
    /** A container by Understory's name, in place of one there is: as an earlier portal made it unless `container` says. */
    putUnderstory(container: Partial<FakeContainer>) {
      const at = docker.containers.findIndex((c) => c.Name === CONTAINER);
      if (at >= 0) docker.containers.splice(at, 1);
      docker.containers.push({ Id: "old".padEnd(64, "0"), Name: CONTAINER, Image: IMAGE, State: "running", Labels: { "pithagoras.addon": "understory" }, Tty: false, out: "", err: "", ...container });
    },
    /** As the tests began: the portal's container running as `portal-one`, Understory's image there, and nothing else. */
    reset() {
      docker.containers.length = 0;
      docker.volumes.length = 0;
      docker.execs.length = 0;
      for (const list of [docker.created, docker.starts, docker.pulls]) list.length = 0;
      docker.failing.clear();
      docker.images.clear();
      docker.images.add(IMAGE);
      docker.hold.pull = undefined;
      docker.hold.exec = undefined;
      for (const name of Object.keys(scripts)) delete scripts[name];
      this.portalIs("portal-one");
      understory.state.down = false;
    },
    /** The scripts run in the container, by name (`scriptOf`), in the order they ran. */
    ran: () => docker.execs.map(scriptOf),
  };
  return {
    host,
    db,
    docker,
    understory,
    scripts,
    machine,
    /** The two server halves, to start with `host.syncServerHalves`. */
    halves,
    /** pi's own folder: its mcp.json and its settings. */
    agentDir,
    /** pi-mcp-adapter installed and on, as pi's settings say: the agent's MCP servers are its tools. */
    adapterOn: () => writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-mcp-adapter"] })),
    /** The servers in pi's mcp.json. */
    servers: (): Record<string, any> => JSON.parse(readFileSync(path.join(agentDir, "mcp.json"), "utf8")).mcpServers,
    /** pi's mcp.json with these servers. */
    putServers: (servers: Record<string, unknown>) => writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: servers })),
  };
}

/**
 * Docker's and Understory's server halves started, and Understory's routes served as the portal serves them, beside the
 * portal's flags (`/api/features/flags`), which say what holds the agent's memory.
 */
export async function serveUnderstory() {
  const started = await startUnderstory();
  const { host, halves } = started;
  started.machine.reset();
  const { featuresRouter } = await import(core("api/features.js"));
  await host.syncServerHalves([halves.docker, halves.understory]);
  const failed = host.serverFailure("pithagoras-understory");
  if (failed) throw new Error(`Understory's server half did not start: ${failed}`);
  const app = express()
    .use("/api/x", host.extensionRoutes)
    .use("/api", express.json(), featuresRouter())
    // What a route did not catch, in JSON with its message, as the portal's own handler says it.
    .use((err: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => void res.status(err.status ?? 500).json({ error: err.message }));
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    ...started,
    /** Where Understory's routes are. */
    at: `${base}/api/x/pithagoras-understory`,
    /** Where the portal's own are. */
    api: `${base}/api`,
    /** Understory's own folder in the portal's data folder, as it is given it. */
    data: realpathSync(path.join(process.env.DATA_DIR!, "extension-data", "pithagoras-understory")),
  };
}
