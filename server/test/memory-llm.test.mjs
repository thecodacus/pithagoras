import test, { after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import net from "node:net";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// The model Understory thinks with, against a home of its own and an upstream
// of the test's own: one that answers only when it is told to, in whole — not
// in a stream, as Node's fetch gives up on after five quiet minutes.
inProcessHome("pithagoras-memory-llm-");
// The wait the proxy keeps, set short: long enough for what answers quickly,
// and short of the five minutes that killed a local model mid-answer in the field.
process.env.UNDERSTORY_LLM_HEADERS_TIMEOUT_MS = "500";
process.env.UNDERSTORY_LLM_BODY_TIMEOUT_MS = "500";

// A port that was and is not now: a refusal at once, on loopback — no route or sandbox between.
const darkPort = await (async () => {
  const s = net.createServer();
  await once(s.listen(0, "127.0.0.1"), "listening");
  const p = s.address().port;
  await once(s.close(), "close");
  return p;
})();

const requests = [];
let delay = 0;
let mode = "answer"; // or "silent": the answer begins (its headers) and then nothing comes of it
const upstream = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => {
    if (req.method !== "POST" || req.url !== "/chat/completions") return res.writeHead(500).end("not the model");
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    if (mode === "silent") {
      // The answer has begun — its headers are out, flushed as the first byte would be — and will say nothing else.
      res.writeHead(200, { "content-type": "application/json" });
      return res.flushHeaders();
    }
    // A whole answer at once, as a non-streaming one comes: no byte until it is done.
    setTimeout(() => res.end(JSON.stringify({
      id: "c", object: "chat.completion", model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "the answer" }, finish_reason: "stop" }],
    })), delay);
  });
});
await once(upstream.listen(0, "127.0.0.1"), "listening");

// The one above reads it when the catalogue is built; no /v1 in its address —
// the proxy itself adds /chat/completions.
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({
  providers: {
    fake: {
      baseUrl: `http://127.0.0.1:${upstream.address().port}`, api: "openai-completions", apiKey: "none",
      models: [{ id: "m", name: "M", reasoning: false, input: ["text"], contextWindow: 10000, maxTokens: 100 }],
    },
    // No one answers there now, and a refusal on loopback is the same plain failure an address
    // nowhere to be reached would be — the wait out for an answer is not that.
    dark: {
      baseUrl: `http://127.0.0.1:${darkPort}`, api: "openai-completions", apiKey: "none",
      models: [{ id: "m", name: "M", reasoning: false, input: ["text"], contextWindow: 10000, maxTokens: 100 }],
    },
  },
}));

const express = (await import("express")).default;
const { memoryLlmRouter, noteToolCall, forgetAsking, upstream: llm } = await import("../dist/memory-llm.js");
const { putSetting } = await import("../dist/db.js");
// Its keep-alive sockets would outlive the servers of the test, so the agent goes too.
after(() => { upstream.close(); http.close(); forgetAsking(); llm.agent.close().catch(() => {}); });

putSetting("understory_llm_token", "test-key");
// A chat asking: the request goes to its model, which the test names.
noteToolCall("asking-chat", "call-1", "understory_remember", "start");

let target = { provider: "fake", id: "m" };
const app = express();
app.use(memoryLlmRouter(async () => target));
const http = app.listen(0, "127.0.0.1");
await once(http, "listening");
const base = `http://127.0.0.1:${http.address().port}`;

const ask = (auth) => fetch(`${base}/understory-llm/v1/chat/completions`, {
  method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
});

test("the asking chat's model is asked, and its whole answer passes through", async () => {
  delay = 30;
  const r = await ask("test-key");
  assert.equal(r.status, 200);
  assert.equal((await r.json()).choices[0].message.content, "the answer");
  // To the model it was given, under its own name, and signed for.
  assert.equal(requests.at(-1).body.model, "m");
  assert.equal(requests.at(-1).headers.authorization, "Bearer none");
});

test("when the wait comes round, the answer is a timeout that says so — not 'fetch failed' as a 502", async () => {
  delay = 1500; // longer than the 500ms of above; where Node's own five minutes would cut it
  const r = await ask("test-key");
  assert.equal(r.status, 504);
  const said = (await r.json()).error.message;
  assert.match(said, /within \d+ (?:seconds|milliseconds)/);
  assert.doesNotMatch(said, /fetch failed/);
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

test("a stranger does not reach the model", async () => {
  delay = 30;
  const before = requests.length;
  const r = await ask("not-the-key");
  assert.equal(r.status, 401);
  assert.equal(requests.length, before);
});

// The wait out for an answer is not the waiting on an address no one answers at: however that
// refusal comes — refused, or timed out of itself — it must stay a plain failure, not be said as
// "did not answer within the wait" with the hint to give the wait more time.
test("an address no one answers is not 'the wait came round' — it stays a plain failure", async () => {
  target = { provider: "dark", id: "m" };
  const r = await ask("test-key");
  assert.equal(r.status, 502);
  assert.doesNotMatch((await r.json()).error.message, /did not answer within/);
  target = { provider: "fake", id: "m" };
});
