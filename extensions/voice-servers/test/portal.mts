import { after } from "node:test";
import { once } from "node:events";
import { readFileSync, realpathSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

/**
 * Voice servers as the portal runs it, in the process of a test: its server half started by the portal's own extension
 * host, from its package as the portal reads it, and its routes served as the portal serves them, beside voice mode's
 * own (`/api/voice`, core's).
 *
 * Call inProcessHome before: the portal's modules read where everything is as they load.
 */

const core = (file: string) => new URL(`../../../core/server/dist/${file}`, import.meta.url).href;

export async function serveVoiceServers() {
  // No login to ask for: the portal checks it before an extension's routes are reached (auth tests).
  process.env.PORTAL_PASSWORD = "";
  process.env.PORTAL_ALLOW_NO_PASSWORD = "1";
  const host = await import(core("extension-host.js"));
  const db = await import(core("db.js"));
  const { requiresOf } = await import(core("extension-ui.js"));
  const { voiceRouter } = await import(core("api/voice.js"));
  // The portal's database first, upgraded, as the portal opens it before it starts the server halves.
  db.getDb();
  const meta = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const half = { name: meta.name as string, version: meta.version as string, file: fileURLToPath(new URL("../src/server.ts", import.meta.url)), rev: meta.version as string, requires: requiresOf(meta) };
  after(() => host.stopServerHalves());
  await host.syncServerHalves([half]);
  const failed = host.serverFailure(half.name);
  if (failed) throw new Error(`Voice servers' server half did not start: ${failed}`);
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
    host,
    db,
    /** Where Voice servers' routes are. */
    at: `${base}/api/x/pithagoras-voice-servers`,
    /** Where the portal's own are: voice mode. */
    api: `${base}/api`,
    /** Voice servers' own folder in the portal's data folder, as it is given it. */
    data: realpathSync(path.join(process.env.DATA_DIR!, "extension-data", half.name)),
  };
}

/** A request as a speech server got it. */
export interface Heard {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** What the speech server answers a path with: a status, a type, other headers and a body, and what it answers after it. */
export interface Answer {
  status?: number;
  type?: string;
  headers?: Record<string, string>;
  body: Buffer | string;
  /** Answered from the next request on, where it is given: a server busy once, say. */
  next?: Answer;
}

/**
 * A speech server on the loopback, standing in for the person's own: it keeps every request it gets, and answers each
 * path with what `answers` holds for it, or 404.
 */
export async function speechServer() {
  const heard: Heard[] = [];
  const answers = new Map<string, Answer>();
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    heard.push({ method: req.method!, path: req.url!, headers: req.headers, body: Buffer.concat(chunks) });
    const answer = answers.get(req.url!);
    if (!answer) return res.writeHead(404).end();
    if (answer.next) answers.set(req.url!, answer.next);
    res.writeHead(answer.status ?? 200, { ...answer.headers, ...(answer.type ? { "content-type": answer.type } : {}) }).end(answer.body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { at: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, heard, answers };
}

/** The fields of a multipart form as a speech server got it: each text field's value, and each file's name, type and bytes. */
export async function formOf(heard: Heard) {
  const form = await new Response(new Uint8Array(heard.body), { headers: { "content-type": heard.headers["content-type"]! } }).formData();
  return Object.fromEntries(
    await Promise.all(
      [...form.entries()].map(async ([key, value]) => [key, typeof value === "string" ? value : { name: value.name, type: value.type, bytes: Buffer.from(await value.arrayBuffer()) }] as const),
    ),
  );
}

/** A WAV of 16-bit mono samples at `rate`. */
export function wav(samples: Buffer, rate: number): Buffer {
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(36 + samples.length, 4);
  head.write("WAVEfmt ", 8, "ascii");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36, "ascii");
  head.writeUInt32LE(samples.length, 40);
  return Buffer.concat([head, samples]);
}
