import { after, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "../../../tests/helpers.mts";
import { startUnderstory } from "./portal.mts";

/**
 * The model Understory thinks with in "the chat's" mode: the model server of Understory's half, on a loopback port of
 * its own, against a home of its own and an upstream of the test's own: one that answers only when it is told to, in
 * whole — not in a stream, as Node's fetch gives up on after five quiet minutes — or as a stream. Which chat is asking
 * is what the half hears of the chats (`chats.onEvent`), and that chat's model is the one asked.
 */
inProcessHome("pithagoras-understory-llm-");
// The wait the server keeps, set short: long enough for what answers quickly,
// and short of the five minutes that killed a local model mid-answer in the field.
process.env.UNDERSTORY_LLM_HEADERS_TIMEOUT_MS = "500";
process.env.UNDERSTORY_LLM_BODY_TIMEOUT_MS = "500";

const { host, halves } = await startUnderstory();
// The model a chat's pi is on now, as the session manager would say it: the one the test names, for the chats it names.
let live: Record<string, { provider: string; id: string }> = {};
host.setChatBridge({ tell: async () => false, offers: () => undefined, reload: async () => ({ reloaded: 0, waiting: 0 }), model: async (id: string) => live[id] });
await host.syncServerHalves([halves.docker, halves.understory]);
const store = await import("../src/server/store.ts");
const llm = await import("../src/server/llm.ts");

// A port that was and is not now: a refusal at once, on loopback — no route or sandbox between.
const darkPort = await (async () => {
  const s = net.createServer();
  await once(s.listen(0, "127.0.0.1"), "listening");
  const p = (s.address() as AddressInfo).port;
  await once(s.close(), "close");
  return p;
})();

const requests: { url?: string; headers: Record<string, unknown>; body: any }[] = [];
let delay = 0;
// "answer" whole; "stream" in two pieces; "silent": the answer begins (its headers) and then nothing comes of it.
let mode: "answer" | "stream" | "silent" = "answer";
const upstream = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => {
    body += d;
  });
  req.on("end", () => {
    if (req.method !== "POST" || req.url !== "/chat/completions") return res.writeHead(500).end("not the model");
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    if (mode === "silent") {
      // The answer has begun — its headers are out, flushed as the first byte would be — and will say nothing else.
      res.writeHead(200, { "content-type": "application/json" });
      return res.flushHeaders();
    }
    if (mode === "stream") {
      res.setHeader("content-type", "text/event-stream");
      res.write('data: {"choices":[{"delta":{"content":"he"}}]}\n\n');
      return void setTimeout(() => res.end('data: {"choices":[{"delta":{"content":"llo"}}]}\n\ndata: [DONE]\n\n'), 30);
    }
    // A whole answer at once, as a non-streaming one comes: no byte until it is done.
    setTimeout(
      () =>
        res.end(
          JSON.stringify({
            id: "c",
            object: "chat.completion",
            model: "m",
            choices: [{ index: 0, message: { role: "assistant", content: "the answer" }, finish_reason: "stop" }],
          }),
        ),
      delay,
    );
  });
});
await once(upstream.listen(0, "127.0.0.1"), "listening");
// Its keep-alive sockets would outlive the servers of the test, so the agent goes too.
after(() => {
  upstream.closeAllConnections();
  upstream.close();
  llm.upstream.agent.close().catch(() => {});
});

const model = { name: "M", reasoning: false, input: ["text"], contextWindow: 10000, maxTokens: 100 };
// No /v1 in its address: the server itself adds /chat/completions.
writeFileSync(
  path.join(process.env.PI_CODING_AGENT_DIR!, "models.json"),
  JSON.stringify({
    providers: {
      fake: { baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, api: "openai-completions", apiKey: "sk-fake", models: [{ id: "m", ...model }] },
      // No one answers there now, and a refusal on loopback is the same plain failure an address
      // nowhere to be reached would be — the wait out for an answer is not that.
      dark: { baseUrl: `http://127.0.0.1:${darkPort}`, api: "openai-completions", apiKey: "none", models: [{ id: "m", ...model }] },
      claude: { baseUrl: "https://api.anthropic.com", api: "anthropic-messages", apiKey: "x", models: [{ id: "sonnet", ...model }] },
    },
  }),
);

store.putSettings({ llmToken: "test-key" });
const base = `http://127.0.0.1:${process.env.UNDERSTORY_LLM_PORT}/v1`;
const ask = (auth?: string, body: unknown = { messages: [{ role: "user", content: "hi" }] }, signal?: AbortSignal) =>
  fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal,
  });
/** A tool call of a chat, starting or ending, as its pi says it. */
const call = (chat: string, id: string, toolName: string, phase: "start" | "end") =>
  host.chatEvent(chat, { type: `tool_execution_${phase}`, toolCallId: id, toolName });

test("the chat asking is the one whose memory tool runs, the newest first, its subagents' calls its own, and none once its pi is gone", () => {
  llm.forgetAsking();
  call("chat-a", "r1", "read", "start");
  assert.equal(llm.askingChat(), undefined, "only the memory's tools count");
  call("chat-a", "a1", "understory_memory_add", "start");
  call("chat-b", "b1", "understory_memory_query", "start");
  assert.equal(llm.askingChat(), "chat-b", "the newest asking");
  call("chat-b", "b1", "understory_memory_query", "end");
  assert.equal(llm.askingChat(), "chat-a");
  call("chat-a", "a1", "understory_memory_add", "end");
  assert.equal(llm.askingChat(), "chat-b", "none asking now: the last that started asking");

  // A chat whose pi is gone asks nothing any more.
  call("chat-gone", "g1", "understory_memory_add", "start");
  assert.equal(llm.askingChat(), "chat-gone");
  host.chatLife("stopped", "chat-gone");
  assert.equal(llm.askingChat(), undefined, "nobody asking: the model new chats start on");
  // A subagent's calls are its chat's, under its own name; one killed mid-call asks no more.
  llm.forgetAsking();
  host.chatEvent("chat-s", { type: "portal_subagent", op: "event", id: "sub-1", event: { type: "tool_execution_start", toolCallId: "c1", toolName: "understory_memory_query" } });
  assert.equal(llm.askingChat(), "chat-s");
  host.chatEvent("chat-s", { type: "portal_subagent", op: "end", id: "sub-1" });
  call("chat-t", "t1", "understory_memory_query", "start");
  call("chat-t", "t1", "understory_memory_query", "end");
  assert.equal(llm.askingChat(), "chat-t", "chat-s is not held asking by a call that never ended");
  for (const life of ["deleted", "finished"] as const) {
    call("chat-x", "x1", "understory_memory_query", "start");
    host.chatLife(life, "chat-x");
    assert.equal(llm.askingChat(), undefined, life);
  }
});

test("the asking chat's model is asked with its key, and its whole answer passes through", async () => {
  llm.forgetAsking();
  live = { "asking-chat": { provider: "fake", id: "m" } };
  call("asking-chat", "call-1", "understory_memory_add", "start");
  mode = "answer";
  delay = 30;
  const r = await ask("test-key");
  assert.equal(r.status, 200);
  assert.equal((await r.json()).choices[0].message.content, "the answer");
  // To the model it was given, under its own name, and signed for.
  assert.equal(requests.at(-1)!.body.model, "m");
  assert.equal(requests.at(-1)!.headers.authorization, "Bearer sk-fake");
});

test("a streamed answer passes through as it comes, and Understory hanging up midway ends it there and nothing else", async () => {
  mode = "stream";
  const answer = await ask("test-key", { model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] });
  assert.equal(answer.status, 200);
  assert.match(answer.headers.get("content-type") ?? "", /event-stream/);
  assert.match(await answer.text(), /"he"[\s\S]*"llo"[\s\S]*\[DONE\]/);
  assert.deepEqual(requests.at(-1)!.body, { model: "m", stream: true, messages: [{ role: "user", content: "hi" }] });

  const hangUp = new AbortController();
  const cut = await ask("test-key", { model: "auto", stream: true, messages: [] }, hangUp.signal);
  await cut.body!.getReader().read();
  hangUp.abort();
  await new Promise((r) => setTimeout(r, 100));
  const again = await ask("test-key");
  assert.equal(again.status, 200, "still answering after one hung up");
  await again.text();
  mode = "answer";
});

test("the model's list, and a stranger: nothing read of what a stranger sends, and no key made for the asking", async () => {
  const before = requests.length;
  assert.equal((await ask("not-the-key")).status, 401);
  // Turned away before its body is read: what is not JSON is not even looked at.
  const unread = await ask(undefined, "{ not json");
  assert.deepEqual([unread.status, await unread.json()], [401, { error: { message: "Not signed in" } }]);
  assert.equal(requests.length, before);
  const list = await fetch(`${base}/models`, { headers: { authorization: "Bearer test-key" } });
  assert.deepEqual(await list.json(), { object: "list", data: [{ id: "auto", object: "model", owned_by: "pithagoras" }] });
  assert.equal((await fetch(`${base}/elsewhere`)).status, 404);
  // Signed in, what is not JSON is said to be so.
  assert.equal((await ask("test-key", "{ not json")).status, 400);

  // No key made yet: nobody is signed in, and asking does not make one.
  store.putSettings({ llmToken: undefined });
  assert.equal((await fetch(`${base}/models`, { headers: { authorization: "Bearer " } })).status, 401);
  assert.equal(store.setting("llmToken"), undefined);
  store.putSettings({ llmToken: "test-key" });
});

test("when the wait comes round, the answer is a timeout that says so — not 'fetch failed' as a 502", async () => {
  delay = 1500; // longer than the 500ms of above; where Node's own five minutes would cut it
  const r = await ask("test-key");
  assert.equal(r.status, 504);
  const said = (await r.json()).error.message;
  assert.match(said, /within \d+ (?:seconds|milliseconds)/);
  assert.doesNotMatch(said, /fetch failed/);
  delay = 30;
});

// A body that begins and then goes quiet: the headers have come, no byte has gone to Understory yet,
// so there is still time to give it its saying — the wait's, not a socket torn out from under it.
test("an answer that began and went quiet says so before the first byte — 504, not a broken socket", async () => {
  mode = "silent";
  const r = await ask("test-key");
  assert.equal(r.status, 504);
  const said = (await r.json()).error.message;
  assert.match(said, /went quiet/);
  assert.doesNotMatch(said, /fetch failed/);
  mode = "answer";
});

// The wait out for an answer is not the waiting on an address no one answers at: however that
// refusal comes — refused, or timed out of itself — it must stay a plain failure, not be said as
// "did not answer within the wait" with the hint to give the wait more time.
test("an address no one answers is not 'the wait came round' — it stays a plain failure", async () => {
  live = { "asking-chat": { provider: "dark", id: "m" } };
  const r = await ask("test-key");
  assert.equal(r.status, 502);
  assert.doesNotMatch((await r.json()).error.message, /did not answer within/);
});

test("a chat's model that does not speak OpenAI's chat completions is refused, saying what to do", async () => {
  live = { "asking-chat": { provider: "claude", id: "sonnet" } };
  const before = requests.length;
  const r = await ask("test-key");
  assert.equal(r.status, 502);
  assert.match((await r.json()).error.message, /speaks anthropic-messages, not OpenAI chat completions, which is what Understory sends\. Give Understory a model of its own in Settings → Memory/);
  assert.equal(requests.length, before);
});

// Last: it forgets the asking chat.
test("with no chat asking and no model for new chats, it is refused, saying so", async () => {
  llm.forgetAsking();
  const before = requests.length;
  const r = await ask("test-key");
  assert.equal(r.status, 502);
  assert.match((await r.json()).error.message, /No chat is asking, and new chats have no model chosen/);
  assert.equal(requests.length, before);
});
