import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";

// What the tests of video generation share: two tiny real clips, and a fake stable-diffusion.cpp server.

export const WEBM = readFileSync(new URL("./fixtures/clip.webm", import.meta.url));
export const MP4 = readFileSync(new URL("./fixtures/clip.mp4", import.meta.url));
/**
 * The clip as stable-diffusion.cpp writes one: the same file, with the EBML document type `matroska` where it had `webm`
 * (the header is four bytes longer for it). Checked on a real clip from a test server: `1a 45 df a3 … 42 82 88 "matroska"`.
 */
export const MATROSKA = (() => {
  const at = WEBM.indexOf(Buffer.from([0x42, 0x82, 0x84]));
  if (at < 5 || at > 64 || WEBM[4] !== 0x9f) throw new Error("the fixture clip has no header of the shape this makes a matroska one of");
  return Buffer.concat([WEBM.subarray(0, 4), Buffer.from([0x9f + 4]), WEBM.subarray(5, at), Buffer.from([0x42, 0x82, 0x88]), Buffer.from("matroska"), WEBM.subarray(at + 7)]);
})();
export const KEY = "sk-video-0123456789";
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

/** What a stable-diffusion.cpp server answers to `capabilities` when its video model takes a first and a last frame (`features_by_mode.vid_gen`). */
export const TAKES_END_IMAGE = { supported_modes: ["vid_gen"], features_by_mode: { vid_gen: { init_image: true, end_image: true, cancel_queued: true } } };

export interface Seen { method?: string; url?: string; auth?: string; body?: any; type?: string }
export interface FakeSd {
  origin: string;
  seen: Seen[];
  server: Server;
  /** The requests for one route, in order. */
  to: (method: string, route: string) => Seen[];
}
export type Job = { status: string; queue_position?: number; result?: unknown; error?: unknown };
/**
 * A fake stable-diffusion.cpp server (its native /sdcpp/v1 API). `jobs` is what each question of how a job is doing
 * is answered with, in order, the last one for good; `capabilities` is its answer to what it can do.
 */
export async function fakeSd(options: { jobs?: Job[]; capabilities?: unknown; capabilitiesStatus?: number; submit?: { status: number; body: unknown }; poll?: (n: number, res: ServerResponse) => boolean } = {}): Promise<FakeSd> {
  const seen: Seen[] = [];
  // Each job is asked about in its own turn: the first is job_1, the next job_2.
  let made = 0;
  const asked = new Map<string, number>();
  const jobs = options.jobs ?? [{ status: "completed", result: { output_format: "webm", mime_type: "video/webm", fps: 16, frame_count: 33, b64_json: WEBM.toString("base64") } }];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body: any;
      try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body, type: req.headers["content-type"] });
      const json = (status: number, answer: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(answer));
      const path = new URL(req.url!, "http://x").pathname;
      if (req.method === "GET" && path.endsWith("/sdcpp/v1/capabilities")) {
        if (options.capabilitiesStatus) return json(options.capabilitiesStatus, { error: "unavailable" });
        return options.capabilities === undefined ? json(404, { error: "not found" }) : json(200, options.capabilities);
      }
      if (req.method === "POST" && path.endsWith("/sdcpp/v1/vid_gen")) {
        const id = `job_${++made}`;
        const sub = options.submit ?? { status: 202, body: { id, kind: "vid_gen", status: "queued", created: 1, poll_url: `/sdcpp/v1/jobs/${id}` } };
        return json(sub.status, sub.body);
      }
      if (req.method === "GET" && /\/sdcpp\/v1\/jobs\/[\w-]+$/.test(path)) {
        const id = path.split("/").pop()!;
        const n = asked.get(id) ?? 0;
        asked.set(id, n + 1);
        if (options.poll?.(n, res)) return;
        const job = jobs[Math.min(n, jobs.length - 1)];
        return json(200, { id, kind: "vid_gen", created: 1, started: null, completed: null, queue_position: 0, result: null, error: null, ...job });
      }
      if (req.method === "POST" && /\/sdcpp\/v1\/jobs\/[\w-]+\/cancel$/.test(path)) return json(200, { id: path.split("/").at(-2), status: "cancelled" });
      json(404, { error: "no such route" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { origin, seen, server, to: (method, route) => seen.filter((s) => s.method === method && s.url!.endsWith(route)) };
}


/** A finished job's answer, with `extra` changed in its result. */
export const completed = (extra: Record<string, unknown> = {}) => ({ status: "completed", result: { output_format: "webm", mime_type: "video/webm", fps: 16, frame_count: 33, b64_json: WEBM.toString("base64"), ...extra } });
