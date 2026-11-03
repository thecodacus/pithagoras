import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import { fakeModel } from "./fake-model.mjs";
import { inProcessHome } from "./server-harness.mjs";

/**
 * The temperature of a mode the person made (Settings → Modes): saved through the routes, refused with a message when out
 * of range, and sent with every request of the chats in the mode, over the model's own `samplingParams` of models.json.
 * A chat in no such mode, or in one without a temperature, sends none: the server's own default applies. Real pi and the
 * portal's own session manager, with a model server that keeps the requests pi sends.
 */
inProcessHome("pithagoras-chat-modes-params-");

const model = await fakeModel(() => "Done.");
// `m` has no sampling parameters of its own; `own` sets a temperature and a top_k, as a person would for a local model.
const models = model.models();
models.providers.fake.models.push({ ...models.providers.fake.models[0], id: "own", name: "Own", samplingParams: { temperature: 0.7, top_k: 40, repeat_penalty: 1.1 } });
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify(models));

const { createSession, getSession, getSettings, setSettings, updateSession } = await import("../dist/db.js");
const { sessions } = await import("../dist/session-manager.js");
const { modesRouter } = await import("../dist/api/modes.js");
setSettings({ ...getSettings(), provider: "fake", model: "m" });

const server = express().use(express.json()).use("/api", modesRouter()).listen(0, "127.0.0.1");
await once(server, "listening");
test.after(() => {
  server.close();
  for (const id of [...sessions.live.keys()]) sessions.live.get(id).client.dispose();
});
const base = `http://127.0.0.1:${server.address().port}/api`;
async function call(method, at, body) {
  const res = await fetch(`${base}${at}`, { method, ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() };
}
async function made(label, fields = {}) {
  const { status, body } = await call("POST", "/chat-modes", { label });
  assert.equal(status, 200, JSON.stringify(body));
  if (Object.keys(fields).length) assert.equal((await call("PUT", `/chat-modes/${body.id}`, fields)).status, 200);
  return body.id;
}
const choose = (id, mode) => call("PUT", `/sessions/${id}/modes`, { mode });

let count = 0;
function chat(on) {
  const id = `par${++count}`;
  createSession({ id, title: id, workspace: process.env.WORKSPACE_ROOT, executor: "host", kind: "task" });
  if (on) updateSession(id, { provider: "fake", model: on });
  return id;
}
async function until(check, what) {
  for (let i = 0; i < 1500; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}
/** The request pi sent for `message` in the chat: what it carries of the sampling parameters. */
async function sent(id, message = "Hello") {
  await sessions.client(id);
  const asked = model.requests.length;
  await sessions.prompt(id, message);
  await until(() => getSession(id).status !== "running", "the run to end");
  const request = model.requests[asked];
  return {
    temperature: request.temperature,
    top_p: request.top_p,
    top_k: request.top_k,
    min_p: request.min_p,
    repeat_penalty: request.repeat_penalty,
    // Named by the API's compat: max_tokens, or max_completion_tokens. Always the model's own here.
    limit: request.max_tokens ?? request.max_completion_tokens,
  };
}
const NONE = { temperature: undefined, top_p: undefined, top_k: undefined, min_p: undefined, repeat_penalty: undefined, limit: 100 };

test("a mode's temperature is saved, listed, cleared with null, and refused with a message when out of range or not a number", async () => {
  const id = await made("Tuned");
  const set = await call("PUT", `/chat-modes/${id}`, { temperature: 0.2 });
  assert.equal(set.status, 200);
  assert.deepEqual({ ...set.body, createdAt: undefined, updatedAt: undefined }, {
    id, label: "Tuned", description: "", codemode: false, instructions: "", provider: null, model: null, thinkingLevel: null,
    temperature: 0.2, createdAt: undefined, updatedAt: undefined,
  });
  // A field left out stays; null leaves it to the model; zero is a value.
  assert.equal((await call("PUT", `/chat-modes/${id}`, { instructions: "x" })).body.temperature, 0.2);
  assert.equal((await call("PUT", `/chat-modes/${id}`, { temperature: 0 })).body.temperature, 0, "zero is a value, not none");
  assert.equal((await call("PUT", `/chat-modes/${id}`, { temperature: null })).body.temperature, null);
  await call("PUT", `/chat-modes/${id}`, { temperature: 0 });

  // The other parameters are not the portal's to send: they are not read, not stored and not listed.
  const other = await call("PUT", `/chat-modes/${id}`, { topP: 0.9, topK: 20, minP: 0.05, maxTokens: 512 });
  assert.equal(other.status, 200);
  assert.deepEqual(Object.keys(other.body).filter((k) => /top|min|max/i.test(k)), []);

  // The chat's picker is told what each mode sets, and a mode that sets nothing says nothing.
  const none = await made("Plain");
  const chatId = chat();
  const listed = (await call("GET", `/sessions/${chatId}/modes`)).body.modes;
  assert.deepEqual(listed.find((m) => m.id === `custom/${id}`).params, { temperature: 0 });
  assert.equal("params" in listed.find((m) => m.id === `custom/${none}`), false);
  assert.equal("params" in listed.find((m) => m.id === "code"), false);

  const refusals = [
    [{ temperature: -0.1 }, /Temperature must be between 0 and 2/],
    [{ temperature: 2.5 }, /Temperature must be between 0 and 2/],
    [{ temperature: "0.5" }, /Temperature must be a number/],
    [{ temperature: true }, /Temperature must be a number/],
  ];
  for (const [body, message] of refusals) {
    const refused = await call("PUT", `/chat-modes/${id}`, { label: "Changed", ...body });
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.match(refused.body.error, message);
  }
  const after = (await call("GET", "/chat-modes")).body.modes.find((m) => m.id === id);
  assert.deepEqual([after.label, after.temperature], ["Tuned", 0], "nothing written by a refusal, not even the label sent beside it");
});

test("the requests of a chat in the mode carry its temperature, and a chat in Standard or Code mode sends none", async () => {
  const mode = await made("Cool", { temperature: 0.2 });
  const id = chat();
  await choose(id, `custom/${mode}`);
  assert.deepEqual(await sent(id), { ...NONE, temperature: 0.2 });

  const standard = chat();
  assert.deepEqual(await sent(standard), NONE, "nothing of the portal's own: the server's default applies");
  const code = chat();
  await choose(code, "code");
  assert.deepEqual(await sent(code), NONE);
  const bare = await made("Bare");
  const other = chat();
  await choose(other, `custom/${bare}`);
  assert.deepEqual(await sent(other), NONE, "a mode that sets nothing changes nothing");
});

test("the mode's temperature wins over the model's own, and the rest of the model's own stays", async () => {
  const mode = await made("Warm", { temperature: 1.1 });
  const id = chat("own");
  await choose(id, `custom/${mode}`);
  // `own` has temperature 0.7, top_k 40 and repeat_penalty 1.1 of its own in models.json.
  assert.deepEqual(await sent(id), { ...NONE, temperature: 1.1, top_k: 40, repeat_penalty: 1.1 });
  const plain = chat("own");
  assert.deepEqual(await sent(plain), { ...NONE, temperature: 0.7, top_k: 40, repeat_penalty: 1.1 }, "the model's, without the mode");
});

test("an edit of the mode reaches a running chat at its next request, and deleting the mode takes the temperature away", async () => {
  const mode = await made("Live", { temperature: 0.3 });
  const id = chat();
  await choose(id, `custom/${mode}`);
  assert.equal((await sent(id)).temperature, 0.3);
  await call("PUT", `/chat-modes/${mode}`, { temperature: 0.9 });
  assert.equal((await sent(id, "Again")).temperature, 0.9);
  await call("PUT", `/chat-modes/${mode}`, { temperature: null });
  assert.deepEqual(await sent(id, "Again"), NONE, "a cleared field goes back to the server's default");
  await call("PUT", `/chat-modes/${mode}`, { temperature: 0.4 });
  assert.equal((await sent(id, "Again")).temperature, 0.4);
  assert.equal((await call("DELETE", `/chat-modes/${mode}`)).status, 200);
  assert.deepEqual(await sent(id, "Again"), NONE, "a mode that is gone sets nothing");
});

test("a subagent's chat in its parent's mode has the mode's temperature", async () => {
  const mode = await made("Inherited", { temperature: 0.6 });
  const parent = chat();
  await choose(parent, `custom/${mode}`);
  const child = sessions.createChild({ parent, title: "Helper" }, "test-package");
  assert.equal(getSession(child.id).mode, `custom/${mode}`);
  assert.equal((await sent(child.id)).temperature, 0.6);
});
