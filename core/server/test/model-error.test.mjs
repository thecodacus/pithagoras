import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

const home = inProcessHome("pithagoras-model-error-");

const { createSession, eventsSince } = await import("../dist/db.js");
const { ModelErrors, plainFailure } = await import("../dist/model-errors.js");
const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
const { sessions } = await import("../dist/session-manager.js");

// The events below are in the order pi's agent-session emits them: message_end
// for each attempt, agent_end with willRetry, then auto_retry_* or compaction_*
// from the post-run handling, and agent_settled once the work is over.
const user = { role: "user", content: [{ type: "text", text: "hi" }] };
const failed = (errorMessage) => ({ role: "assistant", content: [], stopReason: "error", errorMessage });
const answered = { role: "assistant", content: [{ type: "text", text: "Hello" }], stopReason: "stop" };

/** One attempt: a run that closes on `message`. */
const attempt = (message, willRetry = false) => [
  { type: "agent_start" },
  { type: "message_end", message },
  { type: "agent_end", messages: [user, message], willRetry },
];

const busy = failed("model is busy");
const overflow = failed("prompt is too long");

const scenarios = {
  plain: [...attempt(busy), { type: "agent_settled" }],
  recoveredRetry: [
    ...attempt(busy, true),
    { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: "model is busy" },
    { type: "agent_start" },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello" } },
    { type: "message_end", message: answered },
    { type: "auto_retry_end", success: true, attempt: 1 },
    { type: "agent_end", messages: [user, answered], willRetry: false },
    { type: "agent_settled" },
  ],
  exhaustedRetries: [
    ...attempt(busy, true),
    { type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 1, errorMessage: "model is busy" },
    ...attempt(busy, true),
    { type: "auto_retry_start", attempt: 2, maxAttempts: 2, delayMs: 2, errorMessage: "model is busy" },
    ...attempt(busy, false),
    { type: "auto_retry_end", success: false, attempt: 2, finalError: "model is busy" },
    { type: "agent_settled" },
  ],
  cancelledRetry: [
    ...attempt(busy, true),
    { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "model is busy" },
    // Stop pressed during the backoff. Whatever pi calls it, it is not a failure.
    { type: "auto_retry_end", success: false, attempt: 1, finalError: "anything at all" },
    { type: "agent_settled" },
  ],
  recoveredOverflow: [
    ...attempt(overflow),
    { type: "compaction_start", reason: "overflow" },
    { type: "compaction_end", reason: "overflow", aborted: false, willRetry: true },
    { type: "agent_start" },
    { type: "message_end", message: answered },
    { type: "agent_end", messages: [user, answered], willRetry: false },
    { type: "agent_settled" },
  ],
  failedOverflow: [
    ...attempt(overflow),
    { type: "compaction_start", reason: "overflow" },
    { type: "compaction_end", reason: "overflow", aborted: false, willRetry: false, errorMessage: "Context overflow recovery failed: no model" },
    { type: "agent_settled" },
  ],
};

function notesFor(events) {
  const errors = new ModelErrors();
  return events.map((e) => errors.take("s", e)).filter(Boolean);
}

test("a failed model call pi does not retry is reported once", () => {
  assert.deepEqual(notesFor(scenarios.plain), ["Model error: model is busy"]);
});

test("a failure pi retries to success is not reported at all", () => {
  assert.deepEqual(notesFor(scenarios.recoveredRetry), []);
});

test("retries that never succeed are reported once, with the count", () => {
  assert.deepEqual(notesFor(scenarios.exhaustedRetries), ["Still failing after 2 retries: model is busy"]);
});

test("a retry cancelled during its backoff is not a failure, whatever pi calls it", () => {
  assert.deepEqual(notesFor(scenarios.cancelledRetry), []);
});

test("an overflow pi compacts and answers is not reported", () => {
  assert.deepEqual(notesFor(scenarios.recoveredOverflow), []);
});

test("an overflow pi cannot recover from says why", () => {
  assert.deepEqual(notesFor(scenarios.failedOverflow), [
    "Model error: prompt is too long — Context overflow recovery failed: no model",
  ]);
});

test("a failure with no message still gets the same fallback, retried or not", () => {
  const silent = failed(undefined);
  assert.deepEqual(notesFor([...attempt(silent), { type: "agent_settled" }]), ["Model error: the model failed to answer."]);
  assert.deepEqual(
    notesFor([
      ...attempt(silent, true),
      { type: "auto_retry_start", attempt: 1, maxAttempts: 1, delayMs: 1, errorMessage: "Unknown error" },
      ...attempt(silent, false),
      { type: "auto_retry_end", success: false, attempt: 1, finalError: undefined },
      { type: "agent_settled" },
    ]),
    ["Still failing after 1 retry: the model failed to answer."]
  );
});

test("an aborted turn is not presented as a model error", () => {
  const aborted = { role: "assistant", content: [], stopReason: "aborted" };
  assert.deepEqual(notesFor([...attempt(aborted), { type: "agent_settled" }]), []);
});

// Through the session manager, with a stand-in for pi: what reaches the
// transcript, and what reaches a channel waiting on ask().

class FakePi extends EventEmitter {
  running = true;
  async abort() {}
  dispose() {}
}

let pi;
SdkPiClient.create = async () => (pi = new FakePi());

/** Answers every prompt by playing `events` back, as pi would. */
function answerWith(events) {
  sessions.submit = async () => {
    setImmediate(() => events.forEach((e) => pi.emit("event", e)));
  };
}

function transcript(id) {
  return eventsSince(id).map((r) => ({ type: r.type, payload: JSON.parse(r.payload) }));
}

test("a failed model call is not answered by silence", async () => {
  // What PR #13 is about: llama-swap says "model is busy", pi closes the turn
  // as an empty assistant message with stopReason "error", and nothing else.
  createSession({ id: "busy", title: "busy model", workspace: home, executor: "host" });
  answerWith(scenarios.plain);
  const reply = await sessions.ask("busy", "hi", { streamText: false });

  assert.equal(reply, "Model error: model is busy");
  assert.deepEqual(
    transcript("busy").filter((r) => r.type === "portal_notice").map((r) => r.payload),
    [{ text: "Model error: model is busy", error: true }]
  );
});

test("a recovered retry reaches neither the transcript nor the channel as an error", async () => {
  createSession({ id: "recovered", title: "flaky", workspace: home, executor: "host" });
  answerWith(scenarios.recoveredRetry);
  const lines = [];
  const reply = await sessions.ask("recovered", "hi", { onReply: (l) => lines.push(l), streamText: true });

  assert.equal(reply, "");
  assert.deepEqual(lines, ["Hello"]);
  assert.deepEqual(transcript("recovered").filter((r) => r.type === "portal_notice"), []);
});

test("a final failure is in the transcript once, and is what the channel hears", async () => {
  createSession({ id: "exhausted", title: "down", workspace: home, executor: "host" });
  answerWith(scenarios.exhaustedRetries);
  const reply = await sessions.ask("exhausted", "hi", { streamText: false });

  assert.equal(reply, "Still failing after 2 retries: model is busy");
  const rows = transcript("exhausted");
  const notices = rows.filter((r) => r.type === "portal_notice");
  assert.deepEqual(notices.map((r) => r.payload), [{ text: "Still failing after 2 retries: model is busy", error: true }]);
  // Before the run is declared over, not after it.
  assert.ok(rows.indexOf(notices[0]) < rows.findIndex((r) => r.type === "agent_settled"));
});

test("a failure followed by a queued message is noted before the next run starts", async () => {
  createSession({ id: "queued", title: "queued", workspace: home, executor: "host" });
  answerWith([
    ...attempt(busy),
    { type: "agent_start" },
    { type: "message_end", message: answered },
    { type: "agent_end", messages: [user, answered], willRetry: false },
    { type: "agent_settled" },
  ]);
  await sessions.ask("queued", "hi", { streamText: false });

  const types = transcript("queued").map((r) => r.type).filter((t) => t === "portal_notice" || t === "agent_start");
  assert.deepEqual(types, ["agent_start", "portal_notice", "agent_start"]);
});

test("pi's texts for a chat with no model to answer it lose their pointers to /login and to files of pi's", () => {
  const help = "\n\nUse /login to log into a provider via OAuth or API key. See:\n  /srv/node_modules/pi/docs/providers.md";
  for (const text of ["No API key found for the selected model." + help, "No models available. Use /login to log in.", "No model selected." + help]) {
    assert.match(plainFailure(text), /^There is no model to answer with.*Settings → Models\.$/, text);
  }
  assert.equal(plainFailure("No API key found for example." + help), "example has no API key. Add one in Settings → Models, or pick another model.");
  // What is not about that is left as it is.
  for (const text of ["Connection error.", "Model error: 404 not found", "No API key for example/model"]) assert.equal(plainFailure(text), text);
});
