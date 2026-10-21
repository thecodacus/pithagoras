import { after } from "node:test";
import { once } from "node:events";
import { readFileSync, realpathSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { voiceDocker } from "./service.mts";

/**
 * Voice as the portal runs it, in the process of a test: its server half started by the portal's own extension host,
 * after Docker's, which it requires, each from its own package as the portal reads it, and Docker speaking to a daemon
 * of the tests' own (Docker's fake-docker.ts, with the machine around it of service.mts), never to one on the machine.
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

export async function startVoice() {
  const machine = await voiceDocker();
  const host = await import(core("extension-host.js"));
  const db = await import(core("db.js"));
  // The portal's database first, upgraded, as the portal opens it before it starts the server halves.
  db.getDb();
  const halves = { docker: await half("docker"), voice: await half("voice") };
  after(() => host.stopServerHalves());
  return {
    host,
    db,
    /** The daemon, nvidia-smi and the voice processes (service.mts). */
    machine,
    docker: machine.daemon,
    /** The two server halves, to start with `host.syncServerHalves`. */
    halves,
  };
}

/**
 * Docker's and Voice's server halves started, and Voice's routes served as the portal serves them, beside voice mode's
 * own (`/api/voice`, core's), where the service is chosen as its source.
 */
export async function serveVoice() {
  // No login to ask for: the portal checks it before an extension's routes are reached (auth tests).
  process.env.PORTAL_PASSWORD = "";
  process.env.PORTAL_ALLOW_NO_PASSWORD = "1";
  const started = await startVoice();
  const { host, halves } = started;
  const { voiceRouter } = await import(core("api/voice.js"));
  await host.syncServerHalves([halves.docker, halves.voice]);
  const failed = host.serverFailure("pithagoras-voice");
  if (failed) throw new Error(`Voice's server half did not start: ${failed}`);
  const app = express()
    .use("/api/x", host.extensionRoutes)
    .use("/api", express.json(), voiceRouter())
    // What a route did not catch, in JSON with its message, as the portal's own handler says it.
    .use((err: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => void res.status(err.status ?? 500).json({ error: err.message }));
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    ...started,
    /** Where Voice's routes are. */
    at: `${base}/api/x/pithagoras-voice`,
    /** Where the portal's own are: voice mode's settings. */
    api: `${base}/api`,
    /** Voice's own folder in the portal's data folder, as it is given it. */
    data: realpathSync(path.join(process.env.DATA_DIR!, "extension-data", "pithagoras-voice")),
  };
}
