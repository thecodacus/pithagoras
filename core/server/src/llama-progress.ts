import { LlamaSessionCache } from "./llama-session-cache.js";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";

/**
 * What llama.cpp is doing before the first token arrives.
 *
 * A long prompt on a local server spends most of a turn in prefill, and until
 * the first token there is nothing to show for it — the portal said "working"
 * for two minutes and left you guessing whether it had hung. llama-server knows
 * exactly where it is: ask for `return_progress` and the stream carries a
 * `prompt_progress` object every batch, which is what its own web UI draws.
 *
 * pi has no hook for that, so the portal sits in the middle: each session's
 * model is pointed at a loopback proxy that adds the flag on the way out and
 * reads the progress on the way back. The chunks are forwarded untouched — they
 * are ordinary empty deltas with one extra field, and pi ignores what it does
 * not recognise.
 */

export interface Prefill {
  /** Prompt tokens in total. */
  total: number;
  /** Already in the KV cache — the part that does not have to be processed again. */
  cache: number;
  processed: number;
  timeMs: number;
}

type OnProgress = (sessionId: string, prefill: Prefill) => void;

/**
 * What llama-server measured for one answer, from the `timings` on the last
 * chunk of its stream: how many prompt tokens it processed and how fast, how
 * many it took from the cache, how many it wrote and how fast. `draft*` only
 * with speculative decoding.
 */
export interface Timings {
  promptTokens: number;
  cachedTokens: number;
  promptMs: number;
  promptPerSecond: number;
  outputTokens: number;
  outputMs: number;
  outputPerSecond: number;
  draftTokens?: number;
  draftAccepted?: number;
}

type OnTimings = (sessionId: string, timings: Timings) => void;

/**
 * Whether a session's model is being loaded before it can answer.
 *
 * Behind llama-server's router or llama-swap, the first request for a model
 * that is not resident starts it — tens of seconds in which nothing streams and
 * the chat looked as if it were reading the prompt. `ready` follows the first
 * byte of the answer, and only after a `loading`.
 */
export interface ModelLoad {
  model: string;
  state: "loading" | "ready";
}

type OnModel = (sessionId: string, load: ModelLoad) => void;

/** Upstream origin per session, captured when the model is rewritten. */
const upstreams = new Map<string, string>();

let server: http.Server | undefined;
let port = 0;
let notify: OnProgress = () => {};
let notifyModel: OnModel = () => {};
let notifyTimings: OnTimings = () => {};

const PREFIX = "/s/";
const diskCache = new LlamaSessionCache();

function readProgress(text: string, sessionId: string): void {
  // SSE frames, one JSON object per `data:` line. Anything unparseable is not
  // ours to worry about — this is an observer, not the client.
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const body = line.slice(5).trim();
    if (!body || body === "[DONE]") continue;
    if (!body.includes("prompt_progress") && !body.includes("timings")) continue;
    try {
      const chunk = JSON.parse(body) as { prompt_progress?: Record<string, number>; timings?: Record<string, number> };
      const timings = readTimings(chunk.timings);
      if (timings) notifyTimings(sessionId, timings);
      const p = chunk.prompt_progress;
      if (!p || typeof p.total !== "number") continue;
      notify(sessionId, {
        total: p.total,
        cache: p.cache ?? 0,
        processed: p.processed ?? 0,
        timeMs: p.time_ms ?? 0,
      });
    } catch {
      // A frame split across two packets. The next one carries the same
      // running total, so nothing is lost by skipping it.
    }
  }
}

/** llama-server's `timings`, when they are there and say how fast the answer was written. */
export function readTimings(t: Record<string, number> | undefined): Timings | undefined {
  if (!t || typeof t.predicted_n !== "number" || typeof t.predicted_per_second !== "number") return undefined;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    promptTokens: num(t.prompt_n),
    cachedTokens: num(t.cache_n),
    promptMs: num(t.prompt_ms),
    promptPerSecond: num(t.prompt_per_second),
    outputTokens: num(t.predicted_n),
    outputMs: num(t.predicted_ms),
    outputPerSecond: num(t.predicted_per_second),
    ...(typeof t.draft_n === "number" ? { draftTokens: t.draft_n, draftAccepted: num(t.draft_n_accepted) } : {}),
  };
}

/**
 * A completion request, read once: the model it names, and the body to send on,
 * with `return_progress` added to a streaming one and anything else left alone.
 * The body is the whole conversation, pictures included, and every step of the
 * agent sends it again, so it is parsed no more than this.
 */
function withProgress(raw: Buffer): { body: Buffer; model: string } {
  try {
    const parsed = JSON.parse(raw.toString("utf8"));
    if (!parsed || typeof parsed !== "object") return { body: raw, model: "" };
    const model = typeof parsed.model === "string" ? parsed.model : "";
    if (parsed.stream !== true) return { body: raw, model };
    parsed.return_progress = true;
    return { body: Buffer.from(JSON.stringify(parsed)), model };
  } catch {
    return { body: raw, model: "" };
  }
}

/** The models whose chats keep their prompt cache on disk, as `LLAMA_DISK_CACHE_MODELS` names them; read again only when the variable has changed. */
let diskCached = { raw: "", models: new Set<string>() };
function diskCacheModels(): Set<string> {
  const raw = process.env.LLAMA_DISK_CACHE_MODELS ?? "";
  if (raw !== diskCached.raw) diskCached = { raw, models: new Set(raw.split(",").map((m) => m.trim()).filter(Boolean)) };
  return diskCached.models;
}

/** What `url` answers, or undefined; `denied` when it wanted a key it was not given. */
async function probe(url: URL, auth: Record<string, string>): Promise<{ data?: any; denied?: boolean }> {
  try {
    const response = await fetch(url, { headers: auth, signal: AbortSignal.timeout(2000) });
    if (!response.ok) {
      await response.body?.cancel();
      return { denied: response.status === 401 || response.status === 403 };
    }
    return { data: await response.json() };
  } catch {
    return {};
  }
}

/** The request's key, whichever way it was given, for asking the same server about it. */
export function authHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["authorization", "x-api-key"]) {
    const value = headers[name];
    if (typeof value === "string" && value) out[name] = value;
  }
  return out;
}

/**
 * Whether `model` is loaded on `upstream`: false when it is not, undefined when
 * the server does not say — a plain llama-server has one model, always loaded.
 */
export async function modelLoaded(upstream: string, model: string, auth: Record<string, string> = {}): Promise<boolean | undefined> {
  const now = Date.now();
  for (const key of [upstream, quietKey(upstream, model)]) {
    const quietUntil = silent.get(key);
    if (quietUntil !== undefined && quietUntil > now) return undefined;
  }
  // Loaded when last asked for, and asked for again soon enough that nothing
  // has had the time to unload it: every step of an agent's run is a request,
  // and asking the server each time would double them.
  const hot = warm.get(upstream);
  if (hot?.model === model && now - hot.at < WARM_MS) {
    hot.at = now;
    return true;
  }
  // llama-server's router: every preset, with its status. Asked with the
  // request's own key — a router or llama-swap started with one refuses
  // anything else.
  const models = await probe(new URL("/models", upstream), auth);
  const router = models.data;
  const entry = Array.isArray(router?.data) ? router.data.find((m: any) => m?.id === model) : undefined;
  const status = entry?.status?.value ?? entry?.status;
  if (typeof status === "string") return seen(upstream, model, status === "loaded");
  // llama-swap: the models that are up, and whether they are ready yet.
  const running = await probe(new URL("/running", upstream), auth);
  const swap = running.data;
  if (Array.isArray(swap?.running)) {
    const up = swap.running.find((m: any) => m?.model === model);
    if (up) return seen(upstream, model, up.state === undefined || up.state === "ready");
    // Not up under this name. Down, if it is one of llama-swap's models; an
    // alias of one is not listed there, nor running under its own name, and
    // what it stands for is not said: nothing is known of it.
    const listed = await probe(new URL("/v1/models", upstream), auth);
    if (Array.isArray(listed.data?.data) && listed.data.data.some((m: any) => m?.id === model)) return seen(upstream, model, false);
    if (!listed.denied) silent.set(quietKey(upstream, model), Date.now() + SILENT_MS);
    return undefined;
  }
  // Neither: a plain llama-server, which has its one model loaded and lists
  // it without a status. Asking it twice more on every request would learn
  // nothing new, so it is left alone for a while — a router put in front of
  // it later is noticed after that. A router that does not list this model —
  // an alias, say — speaks about the others, and is left alone about this one.
  // Refused for the key is not "says nothing": the next request may carry a good one.
  const routerSpeaks = Array.isArray(router?.data) && router.data.some((m: any) => m?.status !== undefined);
  if (!models.denied && !running.denied) silent.set(routerSpeaks ? quietKey(upstream, model) : upstream, Date.now() + SILENT_MS);
  return undefined;
}

/** Upstreams, or one model on one, that say nothing about loading, and until when they are not asked. */
const silent = new Map<string, number>();
const SILENT_MS = 10 * 60_000;
const quietKey = (upstream: string, model: string) => `${upstream} ${model}`;

/**
 * The model each upstream last had loaded, and when it was last asked for.
 * One per upstream: a request for another model may have swapped it out.
 */
const warm = new Map<string, { model: string; at: number }>();
const WARM_MS = 60_000;

/** Note what the server said, and pass it on. */
function seen(upstream: string, model: string, loaded: boolean): boolean {
  if (loaded) warm.set(upstream, { model, at: Date.now() });
  else if (warm.get(upstream)?.model === model) warm.delete(upstream);
  return loaded;
}

function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = req.url ?? "";
  if (!url.startsWith(PREFIX)) {
    res.writeHead(404).end();
    return;
  }
  const rest = url.slice(PREFIX.length);
  const slash = rest.indexOf("/");
  const sessionId = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? "/" : rest.slice(slash);
  const upstream = upstreams.get(sessionId);
  if (!upstream) {
    res.writeHead(502).end("unknown session");
    return;
  }

  const target = new URL(path, upstream);
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    // Only a chat completion is looked into: the other routes are passed on as they came.
    const { body, model } = req.method === "POST" && raw.length && target.pathname.endsWith("/chat/completions") ? withProgress(raw) : { body: raw, model: "" };
    const client = target.protocol === "https:" ? https : http;
    const headers = { ...req.headers, host: target.host };
    if (body.length) headers["content-length"] = String(body.length);

    const completion = !!model;

    // Asked alongside the request rather than before it: a loaded model must
    // not wait on the question, and the request is what starts the load.
    let answered = false;
    let loading = false;
    // `came` when the model has answered, rather than the request having ended.
    const answering = (came = false) => {
      if (answered) return;
      answered = true;
      if (!loading) return;
      notifyModel(sessionId, { model, state: "ready" });
      if (came) seen(upstream, model, true);
    };
    if (completion) {
      void modelLoaded(upstream, model, authHeaders(req.headers)).then(loaded => {
        if (loaded !== false || answered || res.destroyed) return;
        loading = true;
        notifyModel(sessionId, { model, state: "loading" });
      });
    }

    const controller = new AbortController();
    res.on("close", () => { controller.abort(); answering(); });
    const forward = () => new Promise<boolean>((resolve, reject) => {
      const out = client.request(
        { protocol: target.protocol, hostname: target.hostname, port: target.port,
          path: target.pathname + target.search, method: req.method, headers, signal: controller.signal },
        upstreamRes => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          const streaming = (upstreamRes.headers["content-type"] ?? "").includes("event-stream");
          let progressBuffer = "";
          upstreamRes.on("data", (c: Buffer) => {
            answering(upstreamRes.statusCode === 200);
            if (streaming) {
              progressBuffer += c.toString("utf8");
              const end = progressBuffer.lastIndexOf("\n");
              if (end >= 0) { readProgress(progressBuffer.slice(0, end), sessionId); progressBuffer = progressBuffer.slice(end + 1); }
            }
            res.write(c);
          });
          upstreamRes.on("error", reject);
          upstreamRes.on("end", () => { resolve(upstreamRes.statusCode === 200); });
        },
      );
      out.on("error", reject);
      out.end(body);
    });
    const enabled = completion && diskCacheModels().has(model);
    void (enabled ? diskCache.run(upstream, model, sessionId, controller.signal, forward) : forward())
      .finally(() => answering())
      .then(() => res.end())
      .catch(error => {
        if (res.destroyed) return;
        if (!res.headersSent) res.writeHead(502);
        res.end(String(error));
      });
  });
}

/** Loopback only: this exists for the pi process in front of it, nobody else. */
export function startLlamaProxy(onProgress: OnProgress, onModel?: OnModel, onTimings?: OnTimings): void {
  notify = onProgress;
  if (onModel) notifyModel = onModel;
  if (onTimings) notifyTimings = onTimings;
  if (server) return;
  server = http.createServer(handle);
  server.listen(0, "127.0.0.1", () => {
    port = (server!.address() as AddressInfo).port;
  });
  server.unref();
}

/**
 * Point one session's model at the proxy.
 *
 * Returns the rewritten base URL, or undefined when there is nothing to do —
 * no proxy yet, or a URL that is not a plain http(s) endpoint.
 */
export function proxyBaseUrl(sessionId: string, modelBaseUrl: string): string | undefined {
  if (!port) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(modelBaseUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  upstreams.set(sessionId, parsed.origin);
  return `http://127.0.0.1:${port}${PREFIX}${sessionId}${parsed.pathname.replace(/\/$/, "")}`;
}

export function forgetSession(sessionId: string): void {
  upstreams.delete(sessionId);
}
