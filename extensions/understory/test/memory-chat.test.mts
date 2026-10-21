import { test } from "node:test";
import assert from "node:assert/strict";
import { applyChunk, eventReader, history, textOf, usedTools, type ChatMessage, type Turn } from "../src/web/memory-chat.ts";

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
