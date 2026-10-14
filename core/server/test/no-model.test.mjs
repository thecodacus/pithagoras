import assert from "node:assert/strict";
import test from "node:test";
import { freePort, serverEnv, startServer, testHome } from "./server-harness.mjs";

// A chat with no model to answer it (the provider of the default was removed, or none is set up) says so in the portal's
// words, not with pi's text that sends the reader to its /login and to files in node_modules.

const home = testHome("pithagoras-no-model-");
const { base } = await startServer(serverEnv(home, await freePort()));

const call = async (method, url, body) => {
  const res = await fetch(`${base}${url}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

test("a prompt with no model to answer it is refused in the portal's words, and the chat says the same", async () => {
  const chat = (await call("POST", "/api/sessions", {})).body;
  const sent = await call("POST", `/api/sessions/${chat.id}/prompt`, { message: "hello" });
  assert.equal(sent.status, 500);
  assert.match(sent.body.error, /^There is no model to answer with/);
  assert.match(sent.body.error, /Settings → Models/);
  assert.doesNotMatch(sent.body.error, /\/login|node_modules/);
  const after = (await call("GET", `/api/sessions/${chat.id}`)).body;
  assert.equal(after.status, "error");
  assert.equal(after.last_error, sent.body.error);
});
