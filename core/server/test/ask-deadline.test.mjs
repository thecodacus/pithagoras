import { test } from "node:test";
import assert from "node:assert/strict";
import { inProcessHome } from "./server-harness.mjs";

// A routine's limit is the most its run can take (#319): waiting behind an
// earlier ask, and starting pi, count against it as the run itself does.
inProcessHome("pithagoras-ask-deadline-");
const { sessions } = await import("../dist/session-manager.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("an ask still queued at its deadline gives up there and sends nothing, and the next one still waits its turn", { timeout: 10_000 }, async () => {
  const sent = [];
  let release;
  const first = new Promise((resolve) => (release = resolve));
  const { askNow, waitForIdle } = sessions;
  sessions.waitForIdle = async () => {};
  sessions.askNow = async (_id, message) => {
    sent.push(message);
    if (message === "one") await first;
    return message;
  };
  try {
    const one = sessions.ask("queued", "one", { timeoutMs: 60_000 });
    const started = Date.now();
    await assert.rejects(sessions.ask("queued", "two", { timeoutMs: 200 }), /did not finish within/);
    assert.ok(Date.now() - started < 2_000, "it gave up at its own deadline, not when the first one ended");
    const three = sessions.ask("queued", "three", { timeoutMs: 60_000 });
    await sleep(100);
    assert.deepEqual(sent, ["one"], "two sent nothing, and three waits for one");
    release();
    assert.equal(await one, "one");
    assert.equal(await three, "three");
    assert.deepEqual(sent, ["one", "three"]);
  } finally {
    Object.assign(sessions, { askNow, waitForIdle });
  }
});

test("starting pi counts against the limit, and a run with nothing left sends nothing", { timeout: 10_000 }, async () => {
  let prompts = 0;
  const { ensureClient, prompt } = sessions;
  sessions.ensureClient = async () => sleep(300);
  sessions.prompt = async () => {
    prompts++;
    return true;
  };
  try {
    await assert.rejects(sessions.ask("slow-start", "hello", { timeoutMs: 100 }), /did not finish within/);
    assert.equal(prompts, 0, "nothing was sent after the deadline");
  } finally {
    Object.assign(sessions, { ensureClient, prompt });
  }
});
