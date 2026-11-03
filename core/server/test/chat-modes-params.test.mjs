import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import { fakeModel } from "./fake-model.mjs";
import { inProcessHome } from "./server-harness.mjs";

/**
 * The model parameters of a mode the person made (Settings → Modes): saved through the routes, refused with a message
 * when out of range, and sent with every request of the chats in the mode, merged over the model's own `samplingParams`
 * of models.json. Real pi and the portal's own session manager, with a model server that keeps the requests pi sends.
 */
inProcessHome("pithagoras-chat-modes-params-");

const model = await fakeModel(() => "Done.");
// `m` has no sampling parameters of its own; `own` sets a temperature and a top_k, as a person would for a local model.
const models = model.models();
models.providers.fake.models.push({ ...models.providers.fake.models[0], id: "own", name: "Own", samplingParams: { temperature: 0.7, top_k: 40, repeat_penalty: 1.1 } });
// A model that can write more than the others, to tell the mode's cap from the model's.
models.providers.fake.models.push({ ...models.providers.fake.models[0], id: "wide", name: "Wide", maxTokens: 4000 });
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
/** The request pi sent for `message` in the chat: the parameters of it that the mode is about. */
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
    // Named by the API's compat: max_tokens, or max_completion_tokens.
    limit: request.max_tokens ?? request.max_completion_tokens,
  };
}
const NONE = { temperature: undefined, top_p: undefined, top_k: undefined, min_p: undefined, repeat_penalty: undefined };

test("a mode's parameters are saved, listed, cleared with null, and refused with a message when out of range or not a number", async () => {
  const id = await made("Tuned");
  const set = await call("PUT", `/chat-modes/${id}`, { temperature: 0.2, topP: 0.9, topK: 20, minP: 0.05, maxTokens: 512 });
  assert.equal(set.status, 200);
  assert.deepEqual({ ...set.body, createdAt: undefined, updatedAt: undefined }, {
    id, label: "Tuned", description: "", codemode: false, instructions: "", provider: null, model: null, thinkingLevel: null,
    temperature: 0.2, topP: 0.9, topK: 20, minP: 0.05, maxTokens: 512, createdAt: undefined, updatedAt: undefined,
  });
  // A field left out stays; null leaves that one to the model.
  const cleared = await call("PUT", `/chat-modes/${id}`, { topK: null, instructions: "x" });
  assert.deepEqual([cleared.body.temperature, cleared.body.topP, cleared.body.topK, cleared.body.minP, cleared.body.maxTokens], [0.2, 0.9, null, 0.05, 512]);
  assert.equal((await call("PUT", `/chat-modes/${id}`, { temperature: 0 })).body.temperature, 0, "zero is a value, not none");

  // The chat's picker is told what each mode sets, and a mode that sets nothing says nothing.
  const none = await made("Plain");
  const chatId = chat();
  const listed = (await call("GET", `/sessions/${chatId}/modes`)).body.modes;
  assert.deepEqual(listed.find((m) => m.id === `custom/${id}`).params, { temperature: 0, topP: 0.9, minP: 0.05, maxTokens: 512 });
  assert.equal("params" in listed.find((m) => m.id === `custom/${none}`), false);
  assert.equal("params" in listed.find((m) => m.id === "code"), false);

  const refusals = [
    [{ temperature: -0.1 }, /Temperature must be between 0 and 2/],
    [{ temperature: 2.5 }, /Temperature must be between 0 and 2/],
    [{ temperature: "0.5" }, /Temperature must be a number/],
    [{ topP: 1.5 }, /Top P must be between 0 and 1/],
    [{ topK: 2.5 }, /Top K must be a whole number/],
    [{ topK: 5000 }, /Top K must be between 0 and 1000/],
    [{ minP: -1 }, /Min P must be between 0 and 1/],
    [{ maxTokens: 0 }, /Max tokens must be between 1 and 1000000/],
    [{ maxTokens: 10.5 }, /Max tokens must be a whole number/],
    [{ maxTokens: true }, /Max tokens must be a number/],
  ];
  for (const [body, message] of refusals) {
    const refused = await call("PUT", `/chat-modes/${id}`, { label: "Changed", ...body });
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.match(refused.body.error, message);
  }
  const after = (await call("GET", "/chat-modes")).body.modes.find((m) => m.id === id);
  assert.deepEqual([after.label, after.temperature, after.maxTokens], ["Tuned", 0, 512], "nothing written by a refusal, not even the label sent beside it");
});

test("the requests of a chat in the mode carry its parameters, and a chat in Standard or Code mode sends none", async () => {
  const mode = await made("Cool and short", { temperature: 0.2, topP: 0.9, topK: 20, minP: 0.05, maxTokens: 50 });
  const id = chat();
  await choose(id, `custom/${mode}`);
  assert.deepEqual(await sent(id), { temperature: 0.2, top_p: 0.9, top_k: 20, min_p: 0.05, repeat_penalty: undefined, limit: 50 });

  const standard = chat();
  assert.deepEqual(await sent(standard), { ...NONE, limit: 100 }, "the model's own maximum, as before");
  const code = chat();
  await choose(code, "code");
  assert.deepEqual(await sent(code), { ...NONE, limit: 100 });
  const bare = await made("Bare");
  const other = chat();
  await choose(other, `custom/${bare}`);
  assert.deepEqual(await sent(other), { ...NONE, limit: 100 }, "a mode that sets nothing changes nothing");
});

test("a field the mode does not set leaves the model's own, and one it sets wins over it", async () => {
  const mode = await made("Warm", { temperature: 1.1 });
  const id = chat("own");
  await choose(id, `custom/${mode}`);
  // `own` has temperature 0.7, top_k 40 and repeat_penalty 1.1 of its own in models.json.
  assert.deepEqual(await sent(id), { temperature: 1.1, top_p: undefined, top_k: 40, min_p: undefined, repeat_penalty: 1.1, limit: 100 });
  const plain = chat("own");
  assert.deepEqual(await sent(plain), { temperature: 0.7, top_p: undefined, top_k: 40, min_p: undefined, repeat_penalty: 1.1, limit: 100 }, "the model's, without the mode");

  await call("PUT", `/chat-modes/${mode}`, { topK: 5 });
  assert.equal((await sent(id)).top_k, 5);
});

test("an edit of the mode reaches a running chat at its next request, and deleting the mode takes the parameters away", async () => {
  const mode = await made("Live", { temperature: 0.3 });
  const id = chat();
  await choose(id, `custom/${mode}`);
  assert.equal((await sent(id)).temperature, 0.3);
  await call("PUT", `/chat-modes/${mode}`, { temperature: 0.9, maxTokens: 20 });
  assert.deepEqual([(await sent(id, "Again")).temperature, (await sent(id, "Again")).limit], [0.9, 20]);
  await call("PUT", `/chat-modes/${mode}`, { temperature: null, maxTokens: null });
  assert.deepEqual(await sent(id, "Again"), { ...NONE, limit: 100 }, "cleared fields go back to the model's");
  await call("PUT", `/chat-modes/${mode}`, { temperature: 0.4 });
  assert.equal((await sent(id, "Again")).temperature, 0.4);
  assert.equal((await call("DELETE", `/chat-modes/${mode}`)).status, 200);
  assert.deepEqual(await sent(id, "Again"), { ...NONE, limit: 100 }, "a mode that is gone sets nothing");
});

test("the mode's maximum is held to what the chat's model can write", async () => {
  const mode = await made("Long", { maxTokens: 3000 });
  const narrow = chat();
  await choose(narrow, `custom/${mode}`);
  assert.equal((await sent(narrow)).limit, 100, "the model `m` writes 100 at most");
  const wide = chat("wide");
  await choose(wide, `custom/${mode}`);
  assert.equal((await sent(wide)).limit, 3000);
});

test("a subagent's chat in its parent's mode has the mode's parameters", async () => {
  const mode = await made("Inherited", { temperature: 0.6 });
  const parent = chat();
  await choose(parent, `custom/${mode}`);
  const child = sessions.createChild({ parent, title: "Helper" }, "test-package");
  assert.equal(getSession(child.id).mode, `custom/${mode}`);
  assert.equal((await sent(child.id)).temperature, 0.6);
});
