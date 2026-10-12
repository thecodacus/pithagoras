import { timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import express, { type Router } from "express";
import { fetch as modelFetch } from "undici";
import { waitsAgent, waitMs } from "./fetch-waits.js";
import { chatModel, getSession } from "./db.js";
import { modelRuntime } from "./api/providers.js";
import { UNDERSTORY } from "./features.js";
import { existingLlmToken } from "./extensions/understory-service.js";

/**
 * The model Understory thinks with, when it is "the chat's": the one the
 * chat asking it is on, already loaded, rather than a second one kept in
 * memory beside it.
 *
 * Understory is given the portal as its model server (see
 * understory-service.ts); what it sends is passed on to the model of the chat
 * whose memory tool is running — which the portal knows, since it watches
 * every tool call. With none running — a tidy-up at night — to the chat that
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
export function noteToolCall(sessionId: string, call: string, toolName: unknown, phase: "start" | "end"): void {
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
export function subagentGone(sessionId: string, subagent: string): void {
  const had = asking.get(sessionId);
  if (!had) return;
  for (const call of [...had.calls]) if (call.startsWith(`${subagent}:`)) had.calls.delete(call);
  if (!had.calls.size) asking.delete(sessionId);
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

/** For the tests: nobody has asked. */
export function forgetAsking(): void {
  asking.clear();
  lastAsked = undefined;
}

type ModelOf = (sessionId: string) => Promise<{ provider: string; id: string } | undefined>;

/** The provider and model a request goes to. */
export async function chosenModel(modelOf: ModelOf): Promise<{ provider: string; id: string; chat?: string }> {
  const chat = askingChat();
  if (chat) {
    const live = await modelOf(chat).catch(() => undefined);
    if (live) return { ...live, chat };
    const row = getSession(chat);
    if (row) {
      const { provider, model } = chatModel(row);
      if (model) return { provider, id: model, chat };
    }
  }
  const { provider, model } = chatModel({});
  return { provider, id: model };
}

class Refused extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

/** A wait as it will be said — seconds when whole, milliseconds when finer. */
const sayWait = (ms: number): string => (ms % 1000 === 0 ? `${ms / 1000} seconds` : `${Math.round(ms)} milliseconds`);

/** The model's own waits — long enough for one answer by default, settable from where the portal starts. A
 * local model thinking past Node's five quiet minutes used to die mid-generation and be retried; these give it
 * its full run, and when one of them does come round the error says so (a timeout), not like a failure of the
 * model's server. The knife — whole milliseconds only, `0` being no wait at all — is the shared one. */
const waitOf = (): { headers: number; body: number } => ({
  // Until the model's answer reaches us — its headers. An answer that does not stream sends none until it is
  // done, which is what Understory gets while it asks without streaming, so this is the whole answer there.
  headers: waitMs(process.env.UNDERSTORY_LLM_HEADERS_TIMEOUT_MS, 30 * 60_000),
  body: waitMs(process.env.UNDERSTORY_LLM_BODY_TIMEOUT_MS, 30 * 60_000), // between the bytes of a streaming answer
});

// The waits change only at startup, so the agent is made once with them — the same waits for the
// agent and for what is said when one of them comes round. It takes its routing from the process's own
// rule (fetch-waits): a model reached through a proxy must not be the one address the portal cannot
// reach. Exposed so a test can close it — its keep-alive sockets outlive the servers.
const upstreamWaits = waitOf();
export const upstream = {
  waits: upstreamWaits,
  agent: waitsAgent(upstreamWaits),
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
  const rt = await modelRuntime();
  const model = rt.getModel(provider, id);
  if (!model) throw new Refused(`The chat's model ${provider}/${id} is not one pi knows`);
  if (model.api !== "openai-completions") {
    throw new Refused(
      `The chat's model ${provider}/${id} speaks ${model.api}, not OpenAI chat completions, which is what Understory sends. Give Understory a model of its own in Settings → Add-ons → Memory.`,
    );
  }
  const auth = (await rt.getAuth(model).catch(() => undefined))?.auth ?? {};
  const base = String(auth.baseUrl ?? model.baseUrl ?? "").replace(/\/+$/, "");
  if (!base) throw new Refused(`The chat's model ${provider}/${id} has no address`);
  return {
    url: `${base}/chat/completions`,
    headers: {
      "content-type": "application/json",
      ...(model.headers ?? {}),
      ...(auth.headers ?? {}),
      ...(auth.apiKey ? { authorization: `Bearer ${auth.apiKey}` } : {}),
    },
  };
}

/** Mounted outside /api: Understory signs in with its own token, not a portal session. */
export function memoryLlmRouter(modelOf: ModelOf): Router {
  const router = express.Router();
  // Compared in constant time, and never against a key made for the asking:
  // none is there until Understory is set up to think with the chat's model.
  const signedIn = (req: express.Request) => {
    const key = existingLlmToken();
    const said = req.headers.authorization;
    if (!key || typeof said !== "string") return false;
    const want = Buffer.from(`Bearer ${key}`);
    const got = Buffer.from(said);
    return got.length === want.length && timingSafeEqual(got, want);
  };

  router.get("/understory-llm/v1/models", (req, res) => {
    if (!signedIn(req)) return res.status(401).json({ error: { message: "Not signed in" } });
    res.json({ object: "list", data: [{ id: "auto", object: "model", owned_by: "pithagoras" }] });
  });

  // Signed in first: a conversation-sized body is read only for Understory,
  // never for whoever can reach the port.
  const onlyUnderstory: express.RequestHandler = (req, res, next) =>
    signedIn(req) ? next() : res.status(401).json({ error: { message: "Not signed in" } });

  router.post("/understory-llm/v1/chat/completions", onlyUnderstory, express.json({ limit: "50mb" }), async (req, res) => {
    try {
      const { provider, id, chat } = await chosenModel(modelOf);
      const { url, headers } = await endpointOf(provider, id);
      console.log(`[portal] understory thinks with ${provider}/${id}${chat ? ` for ${chat}` : " (no chat asking)"}`);
      // Stopped with the request: Understory giving up is the model's cue to stop too.
      const stop = new AbortController();
      res.on("close", () => !res.writableEnded && stop.abort());
      // Through an agent carrying the model waits (UNDERSTORY_LLM_*): its own pair, said differently when
      // they come round — not the process-wide ones fetch-waits installed for everyone else in here.
      const answer = await modelFetch(url, { method: "POST", headers, body: JSON.stringify({ ...req.body, model: id }), signal: stop.signal, dispatcher: upstream.agent });
      res.status(answer.status);
      const type = answer.headers.get("content-type");
      if (type) res.setHeader("content-type", type);
      if (!answer.body) return res.end();
      // Not through pipeline, which on an error of the body tears down Understory's socket before
      // anyone has said what happened. By hand instead: while no byte has gone yet, there is time to
      // give a quiet model its own saying; once bytes have moved, there is no undoing.
      const body = Readable.fromWeb(answer.body as any);
      body.on("error", (e) => {
        if (stop.signal.aborted) return; // Understory hung up: the answer ends here, quietly.
        const waited = timedOut(e);
        if (!res.headersSent) {
          res.removeHeader("content-type");
          return waited
            ? res.status(504).json({ error: { message: `The model began to answer, then went quiet past its wait of ${sayWait(upstream.waits.body)}; try again, or give the wait more time — UNDERSTORY_LLM_BODY_TIMEOUT_MS.` } })
            : res.status(502).json({ error: { message: `The model's answer ended before any of it came: ${(e as Error).message}` } });
        }
        console.error(
          waited ? `[portal] the wait on the model's answer came round (UNDERSTORY_LLM_BODY_TIMEOUT_MS): ` : "[portal] the model's answer ended midway: ",
          (e as Error).message,
        );
        // A cut-off answer must fail on Understory's side, not end cleanly and read as finished:
        // half a JSON object is no answer.
        res.destroy(e);
      });
      res.on("close", () => !res.writableEnded && body.destroy());
      body.pipe(res);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      if (!res.headersSent && timedOut(e)) {
        const waited = sayWait(upstream.waits.headers);
        console.error(`[portal] the model's answer did not come within ${waited} (UNDERSTORY_LLM_HEADERS_TIMEOUT_MS); giving it up as a timeout`);
        return res.status(504).json({ error: { message: `The model did not answer within ${waited}; give the wait more time — UNDERSTORY_LLM_HEADERS_TIMEOUT_MS — or Understory a faster model.` } });
      }
      const status = e instanceof Refused ? e.status : 502;
      if (!res.headersSent) res.status(status).json({ error: { message: (e as Error).message } });
      else res.end();
    }
  });

  return router;
}
