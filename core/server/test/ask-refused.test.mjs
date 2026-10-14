import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

const home = inProcessHome("pithagoras-ask-");

const { createSession, getSession } = await import("../dist/db.js");
const { sessions } = await import("../dist/session-manager.js");

test("a message pi refuses fails the ask without an unhandled rejection", async () => {
  // A channel message while the model is down. The refusal is published as an
  // error before prompt() throws, and that used to reject a promise nobody was
  // waiting on yet — which Node answers by ending the process.
  createSession({ id: "down", title: "down", workspace: home, executor: "host" });
  sessions.ensureClient = async () => ({});
  sessions.submit = async () => {
    throw new Error("model is down");
  };

  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    await assert.rejects(sessions.ask("down", "hello"), /model is down/);
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }

  assert.deepEqual(unhandled, []);
  assert.equal(getSession("down").status, "error");
});
