import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fakeDocker } from "./fake-docker.mts";
import { inProcessHome } from "./helpers.mts";
import { applyChunk, eventReader, history, textOf, usedTools, type ChatMessage, type Turn } from "../web/src/memory-chat.ts";

const home = inProcessHome("pitha-memory-chat-");
process.env.DOCKER_SOCKET = path.join(home, "docker.sock");
const agentDir = process.env.PI_CODING_AGENT_DIR!;
delete process.env.MEMORY_UNDERSTORY_URL;

const sse = (...chunks: unknown[]) => chunks.map((c) => `data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`).join("");
const run = (stream: string, pieces = 1): Turn => {
  const reader = eventReader();
  let turn: Turn = { message: { id: "a", role: "assistant", parts: [] } };
  const size = Math.ceil(stream.length / pieces);
  for (let i = 0; i < stream.length; i += size) for (const chunk of reader.feed(stream.slice(i, i + size))) turn = applyChunk(turn, chunk);
  return turn;
};

const answer = sse(
  { type: "start" },
  { type: "start-step" },
  { type: "tool-input-start", toolCallId: "c1", toolName: "search_knowledge" },
  { type: "tool-input-available", toolCallId: "c1", toolName: "search_knowledge", input: { query: "deploy" } },
  { type: "tool-output-available", toolCallId: "c1", output: { hits: 1 } },
  { type: "finish-step" },
  { type: "start-step" },
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: "Branches go " },
  { type: "text-delta", id: "t1", delta: "out with [the script](/deployment/branches.md)." },
  { type: "text-end", id: "t1" },
  { type: "finish" },
  "[DONE]",
);

test("the librarian's stream builds one message: steps, tool calls with their answers, and the text as it arrives", () => {
  for (const pieces of [1, 7, 500]) {
    const { message, error } = run(answer, pieces);
    assert.equal(error, undefined);
    assert.deepEqual(message.parts, [
      { type: "step-start" },
      { type: "tool-search_knowledge", toolCallId: "c1", state: "output-available", input: { query: "deploy" }, output: { hits: 1 } },
      { type: "step-start" },
      { type: "text", text: "Branches go out with [the script](/deployment/branches.md)." },
    ], `read in ${pieces} pieces`);
  }
  assert.equal(usedTools(run(answer).message), true);
  assert.equal(usedTools(run(sse({ type: "text-delta", id: "t", delta: "Hi" })).message), false, "a delta without its start opens the text itself");
});

test("a failed tool call and a failed turn are said, not swallowed", () => {
  const failed = run(sse({ type: "tool-input-available", toolCallId: "c", toolName: "write_concept", input: {} }, { type: "tool-output-error", toolCallId: "c", errorText: "no such folder" }, { type: "error", errorText: "model gone" }));
  assert.equal(failed.error, "model gone");
  assert.deepEqual(failed.message.parts[0], { type: "tool-write_concept", toolCallId: "c", state: "output-error", input: {}, errorText: "no such folder" });
  // What is not JSON, or not a chunk of this protocol, is let go.
  assert.deepEqual(run(sse("not json", { type: "data-whatever", data: 1 }, { type: "reasoning-delta", id: "r", delta: "hm" })).message.parts, []);
});

test("what goes up again is only what the model can be given back, and stays under the size the server takes", () => {
  const q = (id: string, text: string): ChatMessage => ({ id, role: "user", parts: [{ type: "text", text }] });
  const a = (id: string, parts: ChatMessage["parts"]): ChatMessage => ({ id, role: "assistant", parts });
  const sent = history([
    q("q1", "What is deployed?"),
    // Stopped mid-call: a tool call without its answer would make the model's API refuse everything after it.
    a("a1", [{ type: "step-start" }, { type: "tool-search_knowledge", toolCallId: "c", state: "input-available", input: {} }]),
    q("q2", "Again?"),
  ]);
  assert.deepEqual(sent.map((m) => m.id), ["q1", "q2"], "an answer with nothing usable in it is left out");
  const kept = history([q("q1", "x"), a("a1", [{ type: "step-start" }, { type: "text", text: "Done." }, { type: "tool-x", toolCallId: "d", state: "output-available", output: 1 }]), q("q2", "y")]);
  assert.equal(textOf(kept[1]), "Done.");
  assert.equal(kept[1].parts.length, 3, "answered calls and the steps before them stay");
  // A long conversation drops its oldest messages, never the question, and starts on a user's turn.
  const big = "x".repeat(400_000);
  const long = history([q("q1", big), a("a1", [{ type: "text", text: big }]), q("q2", big), a("a2", [{ type: "text", text: big }]), q("q3", "latest")]);
  assert.equal(long.at(-1)!.id, "q3");
  assert.equal(long[0].role, "user");
  assert.ok(JSON.stringify(long).length <= 1_000_000);
});

test("a conversation of many short messages is cut by count, one in a language of wide letters by its bytes, not its characters", () => {
  const q = (id: string, text: string): ChatMessage => ({ id, role: "user", parts: [{ type: "text", text }] });
  const a = (id: string, text: string): ChatMessage => ({ id, role: "assistant", parts: [{ type: "text", text }] });
  // 101 questions with 100 answers are 201 messages: more than the server takes, the 101st question would be refused.
  const many: ChatMessage[] = [];
  for (let n = 0; n < 100; n++) many.push(q(`q${n}`, "hi"), a(`a${n}`, "yes"));
  many.push(q("last", "again"));
  const sent = history(many);
  assert.ok(sent.length <= 100, `${sent.length} messages`);
  assert.equal(sent.at(-1)!.id, "last");
  assert.equal(sent[0].role, "user");
  // Nine 100k-letter turns are 900k UTF-16 units, but 2.7 MB on the wire.
  const wide = "字".repeat(100_000);
  const cjk = history([...Array.from({ length: 9 }, (_, n) => q(`w${n}`, wide)), q("last", "x")]);
  assert.ok(Buffer.byteLength(JSON.stringify({ messages: cjk })) <= 1_100_000, "what is sent stays well under the server's 2 MB");
  assert.equal(cjk.at(-1)!.id, "last");
});

// --- the route: only in the Understory the portal runs, handed on with its token, one run at a time ---

const understory = {
  seen: [] as { url: string; auth?: string; body: any }[],
  closed: false,
  mode: "answer" as "answer" | "hang" | "refuse" | "cut",
  /** Ends the hanging answer, as Understory's run finishing. */
  finish: undefined as (() => void) | undefined,
};
const upstream = createServer(async (req: IncomingMessage, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  understory.seen.push({ url: req.url!, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined });
  if (understory.mode === "refuse") return res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "no model" }));
  res.on("close", () => (understory.closed = !res.writableFinished));
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(sse({ type: "start" }));
  if (understory.mode === "answer") return res.end(sse({ type: "text-delta", id: "t", delta: "Hi" }, "[DONE]"));
  // Understory restarting in the middle of a sentence, with an event half written.
  if (understory.mode === "cut") return void setTimeout(() => (res.write('data: {"type":"text-del'), res.destroy()), 20);
  understory.finish = () => res.end(sse("[DONE]"));
});
await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
const upstreamPort = (upstream.address() as { port: number }).port;
process.env.UNDERSTORY_PORT = String(upstreamPort);

let container: "running" | "stopped" = "running";
const docker = await fakeDocker(process.env.DOCKER_SOCKET!, ({ url }) => {
  if (url === "/_ping") return { text: "OK" };
  if (url === "/containers/pithagoras-understory/json") {
    return { json: { Id: "u", State: { Running: container === "running" }, Config: { Labels: { "pithagoras.addon": "understory" } } } };
  }
  if (url.startsWith("/images/")) return { status: 404 };
  return undefined;
});
const express = (await import("express")).default;
const { memoryRouter, chatMessages } = await import("../server/src/api/memory.ts");
const { understoryEntry } = await import("../server/src/features.ts");
const { getDb } = await import("../server/src/db.js");
const portal = express().use(express.json()).use("/api", memoryRouter()).listen(0, "127.0.0.1");
await new Promise((r) => portal.once("listening", r));
after(() => {
  portal.close();
  upstream.close();
  getDb().close();
});
const at = `http://127.0.0.1:${(portal.address() as { port: number }).port}/api/memory/chat`;
const ask = (body: unknown, signal?: AbortSignal) => fetch(at, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
const question = { messages: [{ id: "q1", role: "user", parts: [{ type: "text", text: "What is deployed?" }], extra: "dropped" }] };
const mcp = (port: number) => writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { understory: understoryEntry(`http://127.0.0.1:${port}/mcp`, { tokenEnv: "MEMORY_UNDERSTORY_AUTH_TOKEN" }) } }));

test("a conversation is checked before it is passed on: user and assistant messages with parts, ending in the user's", () => {
  assert.equal(chatMessages(undefined), undefined);
  assert.equal(chatMessages([]), undefined);
  assert.equal(chatMessages([{ role: "system", parts: [] }]), undefined);
  assert.equal(chatMessages([{ role: "user" }]), undefined, "no parts");
  assert.equal(chatMessages([{ role: "user", parts: [] }, { role: "assistant", parts: [] }]), undefined, "it ends with the answer, not the question");
  assert.equal(chatMessages(Array.from({ length: 201 }, () => ({ role: "user", parts: [] }))), undefined);
  assert.deepEqual(chatMessages([{ role: "user", parts: [{ type: "text", text: "a" }], extra: 1 }]), [{ id: "m0", role: "user", parts: [{ type: "text", text: "a" }] }]);
});

test("the librarian is asked through the portal: its token, the conversation as it was cut, the stream handed on", async () => {
  process.env.MEMORY_UNDERSTORY_AUTH_TOKEN = "s3cret";
  mcp(upstreamPort);
  understory.mode = "answer";
  const res = await ask(question);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type")!, /text\/event-stream/);
  assert.equal(await res.text(), sse({ type: "start" }) + sse({ type: "text-delta", id: "t", delta: "Hi" }, "[DONE]"));
  assert.deepEqual(understory.seen.at(-1), { url: "/api/chat", auth: "Bearer s3cret", body: { messages: [{ id: "q1", role: "user", parts: [{ type: "text", text: "What is deployed?" }] }] } });

  assert.equal((await ask({ messages: [] })).status, 400);
  understory.mode = "refuse";
  const refused = await ask(question);
  assert.equal(refused.status, 502);
  assert.match((await refused.json()).error, /no model/);
  delete process.env.MEMORY_UNDERSTORY_AUTH_TOKEN;
});

test("the librarian is asked only in the Understory the portal runs, while it runs", async () => {
  understory.mode = "answer";
  const before = understory.seen.length;
  // Understory elsewhere: read, not written, and its librarian writes.
  mcp(upstreamPort + 1);
  assert.equal((await ask(question)).status, 409);
  mcp(upstreamPort);
  container = "stopped";
  assert.equal((await ask(question)).status, 409, "not while its container is stopped");
  writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
  container = "running";
  assert.equal((await ask(question)).status, 409, "not while it is not the memory");
  assert.equal(understory.seen.length, before, "nothing of that reached Understory");
});

test("only the fixed chat of the configured Understory is reached, and a conversation too long to send says so", async () => {
  mcp(upstreamPort);
  understory.mode = "answer";
  const before = understory.seen.length;
  // Whatever the page puts into the body, the target is Understory's own, from the server's config.
  const res = await ask({ ...question, url: "http://127.0.0.1:1/x", origin: "http://example.invalid", path: "/api/other", model: "other" });
  assert.equal(res.status, 200);
  await res.text();
  assert.equal(understory.seen.length, before + 1);
  assert.deepEqual(Object.keys(understory.seen.at(-1)!.body), ["messages"]);
  assert.equal(understory.seen.at(-1)!.url, "/api/chat");

  const long = await ask({ messages: Array.from({ length: 201 }, (_, n) => ({ role: n % 2 ? "assistant" : "user", parts: [] })) });
  assert.equal(long.status, 400);
  assert.match((await long.json()).error, /too long.*clear the chat/);
  assert.equal(understory.seen.length, before + 1, "it did not reach Understory");
});

test("Stop does not stop the librarian, so a new question waits until the run has ended", async () => {
  mcp(upstreamPort);
  understory.mode = "hang";
  understory.closed = false;
  const stop = new AbortController();
  const res = await ask(question, stop.signal);
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  await reader.read();
  stop.abort();
  await reader.read().catch(() => {});
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(understory.closed, false, "the portal does not pretend to cut a run Understory goes on with");
  const before = understory.seen.length;
  const busy = await ask(question);
  assert.equal(busy.status, 409);
  assert.match((await busy.json()).error, /still working on the previous question/);
  assert.equal(understory.seen.length, before, "a second librarian is not started on the same memory");
  understory.finish!();
  understory.mode = "answer";
  for (let n = 0; n < 200; n++) {
    const again = await ask(question);
    if (again.status === 200) return void (await again.text());
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("the librarian never became free again");
});

test("an answer cut off by Understory failing ends in an error chunk, so the page does not show half a sentence as whole", async () => {
  mcp(upstreamPort);
  understory.mode = "cut";
  const res = await ask(question);
  assert.equal(res.status, 200);
  const reader = eventReader();
  const chunks = reader.feed(await res.text());
  assert.deepEqual(chunks[0], { type: "start" });
  const last = chunks.at(-1) as { type: string; errorText: string };
  assert.equal(last.type, "error");
  assert.match(last.errorText, /^Understory stopped answering/);
  // The page's own reading of the stream ends with the error shown.
  assert.match(run(sse({ type: "start" }) + 'data: {"type":"text-del\n\n' + sse(last)).error!, /Understory stopped answering/);
  understory.mode = "answer";
});
