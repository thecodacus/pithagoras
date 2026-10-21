import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";
import { Agent, EnvHttpProxyAgent, fetch as modelFetch } from "undici";
import { UNDERSTORY } from "./entry";
import { portal } from "./host";
import { setting } from "./store";

/**
 * The model Understory thinks with, when it is "the chat's": the one the
 * chat asking it is on, already loaded, rather than a second one kept in
 * memory beside it.
 *
 * Understory is given this as its model server (see service.ts): a server of
 * this half's own on the loopback it shares with the portal, at
 * `UNDERSTORY_LLM_PORT` (3801 unless said), not one of the portal's routes,
 * so it is the same whether or not the portal serves its own TLS. What
 * Understory sends is passed on to the model of the chat whose memory tool is
 * running — which this half knows, since it hears every chat's tool calls
 * (`chats.onEvent`). With none running — a tidy-up at night — to the chat that
 * asked last, and before any has, to the model new chats start on.
 *
 * Only models that speak OpenAI's chat completions: that is what Understory
 * speaks to its server, and nothing here translates.
 */

/** Chats with a memory tool running — by call — and in which order they started one: the newest is the one asking. */
const asking = new Map<string, { calls: Set<string>; since: number }>();
let lastAsked: string | undefined;
// A count, not a clock: two calls in the same millisecond are still one after the other.
let order = 0;

const isMemoryTool = (name: unknown) => typeof name === "string" && name.startsWith(`${UNDERSTORY}_`);

/**
 * A tool call in a chat, starting or ending — its subagents' included, which
 * are on its behalf, their calls named `<subagent>:<call>`.
 */
function noteToolCall(sessionId: string, call: string, toolName: unknown, phase: "start" | "end"): void {
  if (!isMemoryTool(toolName)) return;
  const had = asking.get(sessionId);
  if (phase === "start") {
    const calls = had?.calls ?? new Set<string>();
    calls.add(call);
    asking.set(sessionId, { calls, since: ++order });
    lastAsked = sessionId;
  } else if (had) {
    had.calls.delete(call);
    if (!had.calls.size) asking.delete(sessionId);
  }
}

/** A subagent ended — perhaps killed mid-call: whatever it was asking, it asks no more. */
function subagentGone(sessionId: string, subagent: string): void {
  const had = asking.get(sessionId);
  if (!had) return;
  for (const call of [...had.calls]) if (call.startsWith(`${subagent}:`)) had.calls.delete(call);
  if (!had.calls.size) asking.delete(sessionId);
}

/**
 * What a chat's pi said (`chats.onEvent`), for which chat is asking: its tool calls starting and ending, and those of
 * its subagents, which come wrapped in `portal_subagent` events, by `<subagent>:<call>`; a subagent's end ends its calls.
 */
export function noteEvent(sessionId: string, msg: Record<string, unknown>): void {
  const sub = msg.type === "portal_subagent" && msg.op === "event" ? ((msg.event ?? {}) as Record<string, unknown>) : undefined;
  const event = sub ?? msg;
  if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
    const call = `${sub ? `${msg.id}:` : ""}${String(event.toolCallId ?? "")}`;
    noteToolCall(sessionId, call, event.toolName, event.type === "tool_execution_start" ? "start" : "end");
  }
  if (msg.type === "portal_subagent" && msg.op === "end") subagentGone(sessionId, String(msg.id));
}

/** The chat a request from Understory is for. */
export function askingChat(): string | undefined {
  let newest: [string, number] | undefined;
  for (const [id, { since }] of asking) if (!newest || since > newest[1]) newest = [id, since];
  return newest?.[0] ?? lastAsked;
}

/**
 * A chat whose pi is gone — stopped, crashed, deleted — asks nothing any
 * more: a memory tool it was running never says it ended, and left there it
 * would stay "the chat asking" for good.
 */
export function forgetChat(sessionId: string): void {
  asking.delete(sessionId);
  if (lastAsked === sessionId) lastAsked = undefined;
}

/** Nobody has asked: as the half stops, since it hears nothing of the chats until it starts again. */
export function forgetAsking(): void {
  asking.clear();
  lastAsked = undefined;
}

/** The provider and model a request goes to. */
async function chosenModel(): Promise<{ provider: string; id: string; chat?: string }> {
  const { models } = portal();
  const chat = askingChat();
  const asked = chat ? await models.of(chat) : undefined;
  if (asked) return { ...asked, chat };
  const model = await models.of();
  if (!model) throw new Refused("No chat is asking, and new chats have no model chosen to think with");
  return model;
}

class Refused extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

/** A wait as it will be said — seconds when whole, milliseconds when finer. */
const sayWait = (ms: number): string => (ms % 1000 === 0 ? `${ms / 1000} seconds` : `${Math.round(ms)} milliseconds`);

/** How long an answer may take, as said: whole milliseconds, `0` being no wait at all; what is not a number stays the default. */
const waitMs = (raw: string | undefined, fallback: number): number => {
  if (raw == null) return fallback;
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return fallback;
  return Math.min(Number(t), 2_147_483_647);
};

/** The model's own waits — long enough for one answer by default, settable from where the portal starts. A
 * local model thinking past Node's five quiet minutes used to die mid-generation and be retried; these give it
 * its full run, and when one of them does come round the error says so (a timeout), not like a failure of the
 * model's server. */
const waitOf = (): { headers: number; body: number } => ({
  // Until the model's answer reaches us — its headers. An answer that does not stream sends none until it is
  // done, which is what Understory gets while it asks without streaming, so this is the whole answer there.
  headers: waitMs(process.env.UNDERSTORY_LLM_HEADERS_TIMEOUT_MS, 30 * 60_000),
  body: waitMs(process.env.UNDERSTORY_LLM_BODY_TIMEOUT_MS, 30 * 60_000), // between the bytes of a streaming answer
});

/** Whether node was asked to route through the environment's proxies, as the portal takes it: `1`, and nothing wider. */
const throughEnvProxies = (): boolean => (process.env.NODE_USE_ENV_PROXY ?? "").trim() === "1";

// The waits change only at startup, so the agent is made once with them — the same waits for the
// agent and for what is said when one of them comes round. It takes its routing from the process's own
// rule, as the portal's own fetches do: a model reached through a proxy must not be the one address
// Understory cannot reach. Exposed so a test can close it — its keep-alive sockets outlive the servers.
const upstreamWaits = waitOf();
export const upstream = {
  waits: upstreamWaits,
  agent: throughEnvProxies()
    ? new EnvHttpProxyAgent({ headersTimeout: upstreamWaits.headers, bodyTimeout: upstreamWaits.body })
    : new Agent({ headersTimeout: upstreamWaits.headers, bodyTimeout: upstreamWaits.body }),
};

/** Whether the failure is that wait coming round — the wait out for the answer's headers, or between a streaming
 * answer's bytes. An address no one answers at fails differently (a connect timeout) and stays a plain failure. */
const timedOut = (e: unknown): boolean => {
  for (let err = e; err instanceof Error; err = err.cause instanceof Error ? err.cause : undefined) {
    const code = (err as { code?: unknown }).code;
    if (code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") return true;
  }
  return false;
};

/** Where a model's chat completions go, and how to sign in there. */
async function endpointOf(provider: string, id: string): Promise<{ url: string; headers: Record<string, string> }> {
  const { api, baseUrl, headers, key } = await portal()
    .models.endpoint(provider, id)
    .catch((e) => {
      throw new Refused((e as Error).message);
    });
  if (api !== "openai-completions") {
    throw new Refused(
      `The chat's model ${provider}/${id} speaks ${api}, not OpenAI chat completions, which is what Understory sends. Give Understory a model of its own in Settings → Memory.`,
    );
  }
  if (!baseUrl) throw new Refused(`The chat's model ${provider}/${id} has no address`);
  return {
    url: `${baseUrl}/chat/completions`,
    headers: { "content-type": "application/json", ...headers, ...(key ? { authorization: `Bearer ${key}` } : {}) },
  };
}

/** The most of a conversation Understory sends in one request. */
const MOST_BODY = 50 * 1024 * 1024;

const answer = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/** The body of a request, once it is all there: refused (413) past `most` bytes, and what comes after is not kept. */
function bodyOf(req: http.IncomingMessage, most: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > most) return reject(new Refused(`A request to the model server is at most ${most / 1024 / 1024} MB`, 413));
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Signed in: the key Understory was given, compared in constant time, and
 * never against a key made for the asking: none is there until Understory is
 * set up to think with the chat's model.
 */
function signedIn(req: http.IncomingMessage): boolean {
  const key = setting("llmToken");
  const said = req.headers.authorization;
  if (!key || typeof said !== "string") return false;
  const want = Buffer.from(`Bearer ${key}`);
  const got = Buffer.from(said);
  return got.length === want.length && timingSafeEqual(got, want);
}

async function completions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    const raw = await bodyOf(req, MOST_BODY);
    const parsed = JSON.parse(raw.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Refused("A request to the model server is a JSON object", 400);
    body = parsed;
  } catch (e) {
    return answer(res, e instanceof Refused ? e.status : 400, { error: { message: (e as Error).message } });
  }
  // Stopped with the request: Understory giving up is the model's cue to stop too.
  const stop = new AbortController();
  res.on("close", () => !res.writableEnded && stop.abort());
  try {
    const { provider, id, chat } = await chosenModel();
    const { url, headers } = await endpointOf(provider, id);
    portal().log(`understory thinks with ${provider}/${id}${chat ? ` for ${chat}` : " (no chat asking)"}`);
    // Through an agent carrying the model waits (UNDERSTORY_LLM_*): its own pair, said differently when
    // they come round — not the process-wide ones the portal installed for everyone else in here.
    const answered = await modelFetch(url, { method: "POST", headers, body: JSON.stringify({ ...body, model: id }), signal: stop.signal, dispatcher: upstream.agent });
    const type = answered.headers.get("content-type");
    res.statusCode = answered.status;
    if (type) res.setHeader("content-type", type);
    if (!answered.body) return void res.end();
    // Not through pipeline, which on an error of the body tears down Understory's socket before
    // anyone has said what happened. By hand instead: while no byte has gone yet, there is time to
    // give a quiet model its own saying; once bytes have moved, there is no undoing.
    const stream = Readable.fromWeb(answered.body as any);
    stream.on("error", (e) => {
      if (stop.signal.aborted) return; // Understory hung up: the answer ends here, quietly.
      const waited = timedOut(e);
      if (!res.headersSent) {
        res.removeHeader("content-type");
        return waited
          ? answer(res, 504, { error: { message: `The model began to answer, then went quiet past its wait of ${sayWait(upstream.waits.body)}; try again, or give the wait more time — UNDERSTORY_LLM_BODY_TIMEOUT_MS.` } })
          : answer(res, 502, { error: { message: `The model's answer ended before any of it came: ${(e as Error).message}` } });
      }
      portal().log(`${waited ? "the wait on the model's answer came round (UNDERSTORY_LLM_BODY_TIMEOUT_MS)" : "the model's answer ended midway"}: ${(e as Error).message}`);
      // A cut-off answer must fail on Understory's side, not end cleanly and read as finished:
      // half a JSON object is no answer.
      res.destroy(e);
    });
    res.on("close", () => !res.writableEnded && stream.destroy());
    stream.pipe(res);
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
    if (!res.headersSent && timedOut(e)) {
      const waited = sayWait(upstream.waits.headers);
      portal().log(`the model's answer did not come within ${waited} (UNDERSTORY_LLM_HEADERS_TIMEOUT_MS); giving it up as a timeout`);
      return answer(res, 504, { error: { message: `The model did not answer within ${waited}; give the wait more time — UNDERSTORY_LLM_HEADERS_TIMEOUT_MS — or Understory a faster model.` } });
    }
    if (!res.headersSent) answer(res, e instanceof Refused ? e.status : 502, { error: { message: (e as Error).message } });
    else res.end();
  }
}

/** Where the model server listens: on the loopback, at `UNDERSTORY_LLM_PORT`, 3801 unless said. */
const llmPort = (): number => Number(process.env.UNDERSTORY_LLM_PORT) || 3801;

let server: http.Server | undefined;

/** Where the model server is, and whether it listens: it does not where its port was taken. */
export const modelServer = (): { port: number; listening: boolean } => ({ port: llmPort(), listening: server?.listening === true });

function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  const path = (req.url ?? "").split("?")[0];
  // Signed in first: a conversation-sized body is read only for Understory, never for whoever can reach the port.
  if ((path === "/v1/models" && req.method === "GET") || (path === "/v1/chat/completions" && req.method === "POST")) {
    if (!signedIn(req)) return answer(res, 401, { error: { message: "Not signed in" } });
    if (path === "/v1/models") return answer(res, 200, { object: "list", data: [{ id: "auto", object: "model", owned_by: "pithagoras" }] });
    return void completions(req, res);
  }
  answer(res, 404, { error: { message: "Not found" } });
}

/**
 * The model server listening, while the half runs: resolved once it listens, or once it could not, which the log says.
 * Returns what closes it, with every request it is answering cut off.
 */
export async function serveModels(): Promise<() => Promise<void>> {
  const listener = http.createServer(handle);
  server = listener;
  await new Promise<void>((resolve) => {
    listener.once("error", (e) => {
      portal().log(`the model server for Understory could not listen on 127.0.0.1:${llmPort()}: ${e.message}`);
      resolve();
    });
    listener.listen(llmPort(), "127.0.0.1", () => resolve());
  });
  return () =>
    new Promise<void>((resolve) => {
      if (server === listener) server = undefined;
      if (!listener.listening) return resolve();
      listener.close(() => resolve());
      listener.closeAllConnections();
    });
}
