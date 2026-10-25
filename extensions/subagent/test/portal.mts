import { after } from "node:test";
import { once } from "node:events";
import { readFileSync, realpathSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

/**
 * The subagent extension as the portal runs it, in the process of a test: its server half started by the portal's own
 * extension host, from its package as the portal reads it, and its routes served as the portal serves them, beside the
 * portal's old address for its settings (`/api/features/…`, core's).
 *
 * Call inProcessHome before: the portal's modules read where everything is as they load. What pi's settings hold then
 * is what the portal's database upgrade finds as it is first opened here.
 */

const core = (file: string) => new URL(`../../../core/server/dist/${file}`, import.meta.url).href;

export async function serveSubagent() {
  // No login to ask for: the portal checks it before an extension's routes are reached (auth tests).
  process.env.PORTAL_PASSWORD = "";
  process.env.PORTAL_ALLOW_NO_PASSWORD = "1";
  const host = await import(core("extension-host.js"));
  const db = await import(core("db.js"));
  const { requiresOf } = await import(core("extension-ui.js"));
  const { featuresRouter } = await import(core("api/features.js"));
  // The portal's database first, upgraded, as the portal opens it before it starts the server halves.
  db.getDb();
  const meta = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const half = { name: meta.name as string, version: meta.version as string, file: fileURLToPath(new URL("../src/server.ts", import.meta.url)), rev: meta.version as string, requires: requiresOf(meta) };
  after(() => host.stopServerHalves());
  const start = async () => {
    await host.syncServerHalves([half]);
    const failed = host.serverFailure(half.name);
    if (failed) throw new Error(`The subagent extension's server half did not start: ${failed}`);
  };
  await start();
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

  /** What the half registers in a chat's pi as it is loaded, over a stand-in for pi: the tools, by their names. */
  const toolsIn = (chatId: string) => {
    const tools = new Map<string, any>();
    const pi = { registerTool: (tool: any) => tools.set(tool.name, tool), on: () => {}, events: { on: () => () => {}, emit: () => {} }, sendMessage: () => {} };
    for (const { name, factory } of host.hostExtensions(chatId)) if (name === half.name) factory(pi);
    return tools;
  };
  return {
    host,
    db,
    /** Where the extension's routes are. */
    at: `${base}/api/x/pithagoras-subagent`,
    /** Where the portal's own are. */
    api: `${base}/api`,
    /** Its own folder in the portal's data folder, as it is given it. */
    data: realpathSync(path.join(process.env.DATA_DIR!, "extension-data", half.name)),
    toolsIn,
    /** Switched off, as Settings → Extensions does, and on again: its server half stops and starts. */
    stop: () => host.syncServerHalves([]),
    start,
  };
}
