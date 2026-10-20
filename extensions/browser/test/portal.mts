import { after } from "node:test";
import { once } from "node:events";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { fakeDocker } from "../../docker/test/fake-docker.ts";

/**
 * Browser as the portal runs it, in the process of a test: its server half started by the portal's own extension
 * host, after Docker's, which it requires, each from its own package as the portal reads it, and Docker speaking to a
 * daemon of the tests' own (Docker's fake-docker.ts), never to one on the machine. Its routes are served as the portal
 * serves an extension's, under /api/x/pithagoras-browser, and its streams as the portal hands an extension its upgrades.
 *
 * Call inProcessHome before: the portal's modules read where everything is as they load. A database the test put in
 * the home before is the one the portal opens, and upgrades, before the halves start, as the portal does.
 */

const core = (file: string) => new URL(`../../../core/server/dist/${file}`, import.meta.url).href;

/** A server half of a package in extensions/, from its source unless `file` names another, with what its package.json says it requires. */
async function half(folder: string, file = "src/server.ts") {
  const { requiresOf } = await import(core("extension-ui.js"));
  const meta = JSON.parse(readFileSync(new URL(`../../${folder}/package.json`, import.meta.url), "utf8"));
  const at = fileURLToPath(new URL(`../../${folder}/${file}`, import.meta.url));
  if (!existsSync(at)) throw new Error(`${at} is not there: npm run build makes it`);
  return { name: meta.name as string, version: meta.version as string, file: at, rev: meta.version as string, requires: requiresOf(meta) };
}

/**
 * `built`: Browser's half as the portal runs it, built (server.js), rather than from its source: what tsx runs from the
 * source names the functions inside a script it sends a page (the cursor's), and the page has nothing of that name.
 */
export async function startBrowser({ built = false } = {}) {
  const docker = await fakeDocker();
  process.env.DOCKER_SOCKET = docker.socket;
  const host = await import(core("extension-host.js"));
  const db = await import(core("db.js"));
  // The portal's database first, upgraded, as the portal opens it before it starts the server halves.
  db.getDb();
  const halves = { docker: await half("docker"), browser: await half("browser", built ? "server.js" : undefined) };
  after(async () => {
    await host.stopServerHalves();
    await docker.close();
  });
  return {
    host,
    db,
    docker,
    /** The two server halves, to start with `host.syncServerHalves`. */
    halves,
  };
}

/** Docker's and Browser's server halves started, and Browser's routes and streams served as the portal serves them. */
export async function serveBrowser(options: { built?: boolean } = {}) {
  // No login to ask for: the portal checks it before an extension's routes and streams are reached (auth tests).
  process.env.PORTAL_PASSWORD = "";
  process.env.PORTAL_ALLOW_NO_PASSWORD = "1";
  const started = await startBrowser(options);
  const { host, db, halves } = started;
  await host.syncServerHalves([halves.docker, halves.browser]);
  const failed = host.serverFailure("pithagoras-browser");
  if (failed) throw new Error(`Browser's server half did not start: ${failed}`);
  const { attachUpgrades } = await import(core("upgrades.js"));
  const app = express()
    .use("/api/x", host.extensionRoutes)
    // What a route did not catch, in JSON with its message, as the portal's own handler says it.
    .use((err: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => void res.status(err.status ?? 500).json({ error: err.message }));
  const server = http.createServer(app);
  attachUpgrades(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  return {
    ...started,
    port,
    /** Where Browser's routes are. */
    at: `http://127.0.0.1:${port}/api/x/pithagoras-browser`,
    /** Browser's own folder in the portal's data folder, as it is given it. */
    data: realpathSync(path.join(process.env.DATA_DIR!, "extension-data", "pithagoras-browser")),
    /** A chat of the portal's that works in `workspace`. */
    chat: (id: string, workspace = process.env.WORKSPACE_ROOT!) => db.createSession({ id, title: "A chat", workspace, executor: "host" }),
    /** The tools a chat's pi is given as it loads, by name, as the portal gives them. */
    tools: (chatId: string): Record<string, any> => {
      const tools: Record<string, any> = {};
      for (const { factory } of host.hostExtensions(chatId)) factory({ registerTool: (tool: any) => (tools[tool.name] = tool) });
      return tools;
    },
  };
}
