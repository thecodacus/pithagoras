import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fakeModel, resultsIn } from "./fake-model.mjs";
import { inProcessHome } from "./server-harness.mjs";

/**
 * The ask_question tool as pi runs it (issue #114): which chats get it, what a model's call comes to once pi
 * has checked it, that it waits until it is answered, and what a page that opens while the question waits is shown.
 */
const home = inProcessHome("pithagoras-ask-question-");

/** What the model does at its next request: a call of ask_question with `call`, then an answer. */
let call;
const model = await fakeModel((request) => (resultsIn(request) > 0 ? "Done." : { name: "ask_question", args: call }));
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify(model.models()));

const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
const { createSession, getDb, rememberTools } = await import("../dist/db.js");
const { sessions } = await import("../dist/session-manager.js");

let n = 0;
/** A client for a chat of the kind `opts` say, its events kept. */
async function open(opts = {}) {
  const sessionId = `ask-${++n}`;
  const client = await SdkPiClient.create({
    cwd: mkdtempSync(path.join(process.env.WORKSPACE_ROOT, "chat-")), sessionDir: mkdtempSync(path.join(home, "chat-")),
    provider: "fake", modelId: "m", sessionId, questions: true, ...opts,
  });
  const events = [];
  client.on("event", (e) => events.push(e));
  return { client, events };
}
const named = async (client) => (await client.getTools()).map((t) => t.name);
const until = async (check) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 25)); assert.ok(check(), "it came"); };

test("the tool is registered only for a client that is told to", async () => {
  for (const [what, opts, has] of [
    ["a chat", {}, true],
    ["a client not told to", { questions: false }, false],
  ]) {
    const { client } = await open(opts);
    try {
      assert.equal((await named(client)).includes("ask_question"), has, what);
    } finally {
      client.dispose();
    }
  }
});

/** Whether the pi the portal starts for this kind of conversation has the tool. */
async function offered(id, kind, extra = {}) {
  const { getSettings, setSettings } = await import("../dist/db.js");
  setSettings({ ...getSettings(), provider: "fake", model: "m" });
  const { role, ...row } = extra;
  createSession({ id, title: id, workspace: process.env.WORKSPACE_ROOT, executor: "host", kind, ...row });
  if (role) getDb().prepare("UPDATE sessions SET role = ? WHERE id = ?").run(role, id);
  const client = await sessions.ensureClient(id);
  try {
    return (await named(client)).includes("ask_question");
  } finally {
    client.dispose();
  }
}

test("a chat someone talks to in the browser is offered the tool", async () => {
  assert.equal(await offered("kind-chat", "task"), true);
});

test("a conversation started on the Agent page is offered the tool, as it is a chat a person answers in the web UI", async () => {
  assert.equal(await offered("kind-agent-page", "agent", { channel_slug: "browser", channel_key: "abc12345" }), true);
});

test("a routine run is not offered the tool", async () => {
  assert.equal(await offered("kind-routine", "routine", { routine_slug: "nightly" }), false);
});

test("a heartbeat look is not offered the tool", async () => {
  assert.equal(await offered("kind-heartbeat", "heartbeat"), false);
});

test("a chat reached through a channel is not offered the tool", async () => {
  assert.equal(await offered("kind-channel", "agent", { channel_slug: "telegram", channel_key: "telegram:1" }), false);
});

test("a browser chat for a lower role than the owner's is not offered the tool", async () => {
  assert.equal(await offered("kind-guest", "task", { role: "guest" }), false);
  assert.equal(await offered("kind-guest-agent-page", "agent", { channel_slug: "browser", channel_key: "guest123", role: "guest" }), false);
});

test("an idle chat shows the tool in its list where it would get it, and not where it would not", async () => {
  // As a chat that has run in the portal leaves it behind: the tool is a remembered one.
  rememberTools([{ name: "ask_question", source: "ask-question", inline: true }]);
  const make = (id, kind, extra = {}) => createSession({ id, title: id, workspace: process.env.WORKSPACE_ROOT, executor: "host", kind, ...extra });
  make("idle-task", "task");
  make("idle-routine", "routine", { routine_slug: "nightly" });
  make("idle-heartbeat", "heartbeat");
  make("idle-agent-page", "agent", { channel_slug: "browser", channel_key: "page1234" });
  make("idle-channel", "agent", { channel_slug: "telegram", channel_key: "telegram:2" });
  const listed = async (id) => (await sessions.getTools(id)).tools.map((t) => t.name).includes("ask_question");
  assert.equal(await listed("idle-task"), true);
  assert.equal(await listed("idle-agent-page"), true);
  for (const id of ["idle-routine", "idle-heartbeat", "idle-channel"]) assert.equal(await listed(id), false, id);
});

test("a question waits for a page that opens later, and is answered through the dialog route", async () => {
  // Bare-string options and ids that are inherited object keys: pi must pass the call, and the answer must be the person's.
  call = { questions: [{ id: "constructor", question: "Pick", options: ["A", "B"] }, { id: "__proto__", question: "Several", kind: "multiple", options: ["x", "y"], optional: true }] };
  const { client, events } = await open();
  try {
    await client.prompt("Ask me");
    await until(() => events.some((e) => e.type === "extension_ui_request"));
    const request = events.find((e) => e.type === "extension_ui_request");
    assert.equal(request.method, "questions");
    assert.deepEqual(request.questions[0].options, [{ label: "A" }, { label: "B" }]);
    // What a page attaching now is shown: the same request, under the same id.
    assert.deepEqual(client.openDialogRequests(), [request]);

    assert.equal(client.respondUi(request.id, { value: JSON.parse('{"constructor":"B","__proto__":["y"]}') }), true);
    assert.deepEqual(client.openDialogRequests(), [], "answered: nothing left to show");
    await until(() => events.some((e) => e.type === "agent_settled"));
    const result = events.find((e) => e.type === "tool_execution_end");
    assert.equal(result.isError, false);
    const text = result.result.content[0].text;
    assert.match(text, /1\. Pick\n\s+Chosen: B/);
    assert.match(text, /2\. Several\n\s+Chosen: y/);
  } finally {
    client.dispose();
  }
});

test("a question nobody answers has no answer, rather than one the object it is kept in has", async () => {
  call = { questions: [{ id: "constructor", question: "Pick", options: ["A", "B"], optional: true }] };
  const { client, events } = await open();
  try {
    await client.prompt("Ask me");
    await until(() => events.some((e) => e.type === "extension_ui_request"));
    client.respondUi(events.find((e) => e.type === "extension_ui_request").id, { value: {} });
    await until(() => events.some((e) => e.type === "agent_settled"));
    const text = events.find((e) => e.type === "tool_execution_end").result.content[0].text;
    assert.match(text, /No answer \(it was optional\)/);
    assert.doesNotMatch(text, /native code/);
  } finally {
    client.dispose();
  }
});

test("Stop closes the dialog on every page that has it, and nothing is left to show a page that opens later", async () => {
  call = { questions: [{ question: "Pick", options: ["A", "B"] }] };
  const { client, events } = await open();
  try {
    await client.prompt("Ask me");
    await until(() => events.some((e) => e.type === "extension_ui_request"));
    const { id } = events.find((e) => e.type === "extension_ui_request");
    await client.abort();
    await until(() => events.some((e) => e.type === "extension_ui_cancel" && e.id === id));
    assert.deepEqual(client.openDialogRequests(), []);
  } finally {
    client.dispose();
  }
});

test("a page that opens a chat with a question waiting is sent it before the stream is caught up", async () => {
  const { default: express } = await import("express");
  const { eventsRouter } = await import("../dist/api/events.js");
  const { appendEvent } = await import("../dist/db.js");
  createSession({ id: "waiting", title: "waiting", workspace: process.env.WORKSPACE_ROOT, executor: "host" });
  const asked = { id: "q-1", questions: [{ id: "q1", question: "Pick", kind: "single", options: [{ label: "A" }], other: false, optional: false }] };
  const request = { type: "extension_ui_request", method: "questions", ...asked };
  // Kept with the chat, and waited on by its run, which still has the request as a dialog of its own.
  appendEvent("waiting", "portal_question", asked);
  sessions.live.set("waiting", { client: { openDialogRequests: () => [request] } });
  const app = express().use("/api", eventsRouter());
  const server = app.listen(0);
  const abort = new AbortController();
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/waiting/events`, { signal: abort.signal });
    let text = "";
    const reader = res.body.getReader();
    while (!text.includes("event: caught-up")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    // A stored event comes with its id first.
    const frames = text.split("\n\n").map((f) => f.split("\n").find((l) => l.startsWith("data: "))).filter(Boolean).map((l) => JSON.parse(l.slice(6)));
    const sent = frames.filter((f) => f.type === "portal_question");
    assert.equal(sent.length, 2, "the question came: as it is stored, and again for a page whose loaded end does not reach it");
    assert.ok(sent[0].seq > 0 && sent[1].seq < 0, "the copy is live only: it never moves the page's cursor");
    for (const f of sent) assert.deepEqual(f.payload, asked);
    assert.equal(frames.filter((f) => f.type === "extension_ui_request").length, 0, "not as a dialog over the page");
    assert.ok(text.lastIndexOf("portal_question") < text.indexOf("event: caught-up"));
  } finally {
    abort.abort();
    sessions.live.delete("waiting");
    server.close();
  }
});

test("a question waits until it is answered by default, and for the minutes the setting gives, then closes as a timeout", async () => {
  const { setQuestionWaitMinutes } = await import("../dist/db.js");
  const real = global.setTimeout;
  const timers = [];
  // Only the dialog's wait is of interest: a timer set by the portal's dialog code, kept instead of started.
  global.setTimeout = (fn, ms, ...rest) => (new Error().stack.includes("dist/pi/sdk-client") && ms >= 60_000 ? (timers.push({ fn, ms }), { unref() {} }) : real(fn, ms, ...rest));
  try {
    call = { questions: [{ question: "Pick", options: ["A", "B"] }] };

    const idle = await open();
    try {
      await idle.client.prompt("Ask me");
      await until(() => idle.events.some((e) => e.type === "extension_ui_request"));
      assert.deepEqual(timers, [], "no timer for a question by default");
    } finally {
      idle.client.dispose();
    }

    assert.equal(setQuestionWaitMinutes(15), 15);
    const timed = await open();
    try {
      await timed.client.prompt("Ask me");
      await until(() => timed.events.some((e) => e.type === "extension_ui_request"));
      const { id } = timed.events.find((e) => e.type === "extension_ui_request");
      assert.deepEqual(timers.map((t) => t.ms), [15 * 60_000], "read when the question is asked");
      timers[0].fn();
      await until(() => timed.events.some((e) => e.type === "extension_ui_cancel" && e.id === id));
      await until(() => timed.events.some((e) => e.type === "agent_settled"));
      assert.match(timed.events.find((e) => e.type === "tool_execution_end").result.content[0].text, /time allowed for answering ran out/);
    } finally {
      timed.client.dispose();
    }
  } finally {
    global.setTimeout = real;
    setQuestionWaitMinutes(0);
  }
});

test("the wait setting takes only the offered minutes", async () => {
  const { questionWaitMinutes, setQuestionWaitMinutes } = await import("../dist/db.js");
  assert.equal(questionWaitMinutes(), 0, "until answered by default");
  for (const bad of [-1, 7, "15", null, NaN]) assert.equal(setQuestionWaitMinutes(bad), undefined);
  assert.equal(questionWaitMinutes(), 0);
  assert.equal(setQuestionWaitMinutes(60), 60);
  assert.equal(questionWaitMinutes(), 60);
  setQuestionWaitMinutes(0);
});
