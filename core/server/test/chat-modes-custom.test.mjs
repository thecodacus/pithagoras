import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import { fakeModel } from "./fake-model.mjs";
import { inProcessHome } from "./server-harness.mjs";

/**
 * The modes the person makes (Settings → Modes): made, changed and deleted through their routes, offered to a chat
 * after the portal's own, and what one does in its chats: its tool layer, its instructions in the system prompt, the
 * model and effort it writes into a chat as it is put in it, and the code tool it can work through. Real pi and the
 * portal's own session manager, with a model that plays the script.
 */
inProcessHome("pithagoras-chat-modes-custom-");
mkdirSync(path.join(process.env.PI_CODING_AGENT_DIR, "extensions"), { recursive: true });
// A tool the portal marks lazy (below): reached through the `tools` tool, unless the chat works through the code tool.
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "extensions", "lazy.ts"), `
export default function (pi) {
  pi.registerTool({
    name: "lazy_one",
    label: "Lazy one",
    description: "Say that the lazy tool ran",
    parameters: { type: "object", properties: {} },
    async execute() {
      globalThis.lazyOneRan = (globalThis.lazyOneRan ?? 0) + 1;
      return { content: [{ type: "text", text: "lazy ran" }], details: {} };
    },
  });
}
`);

// Asked to run the script, the model writes one that calls the lazy tool; after its result, and to anything else, it answers in a word.
const SCRIPT = "Run the script";
const model = await fakeModel((request) => {
  const last = request.messages.at(-1);
  return last?.role === "user" && JSON.stringify(last.content).includes(SCRIPT)
    ? { name: "codemode", args: { code: "return await tools.lazy_one({});" } }
    : "Done.";
});
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify(model.models()));

const { createSession, getSession, getSettings, rememberTools, sessionTools, setLazyToolSets, setSessionTools, setSettings, setToolDefaultsOff, toolDefaultsOff, updateSession } = await import("../dist/db.js");
const { lazyToolEntry } = await import("../dist/tool-policy.js");
const { CodemodeHeld, sessions } = await import("../dist/session-manager.js");
const { modesRouter } = await import("../dist/api/modes.js");
setSettings({ ...getSettings(), provider: "fake", model: "m" });
rememberTools([{ name: "lazy_one", source: "lazy", package: null }]);
setLazyToolSets([lazyToolEntry("lazy_one")]);

// As server.ts has it: JSON parsed for every route.
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
/** Makes a mode, and says what else it holds: its id. */
async function made(label, fields = {}) {
  const { status, body } = await call("POST", "/chat-modes", { label });
  assert.equal(status, 200, JSON.stringify(body));
  if (Object.keys(fields).length) assert.equal((await call("PUT", `/chat-modes/${body.id}`, fields)).status, 200);
  return body.id;
}
const choose = (id, mode) => call("PUT", `/sessions/${id}/modes`, { mode });

let count = 0;
function chat() {
  const id = `own${++count}`;
  createSession({ id, title: id, workspace: process.env.WORKSPACE_ROOT, executor: "host", kind: "task" });
  return id;
}

async function until(check, what) {
  for (let i = 0; i < 1500; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** The names of the tools a request declared to the model. */
const declared = (request) => (request.tools ?? []).map((t) => t.function?.name ?? t.name);
/** The system prompt of a request, as pi sends the prompt as it is now. */
const told = (request) => request.messages.filter((m) => m.role === "system").map((m) => JSON.stringify(m.content)).join("\n");

/** Sends `message` in the chat with its pi up, and waits for the run to end: the requests it made and the results of the calls in it. */
async function say(id, message) {
  const client = await sessions.client(id);
  const results = [];
  const hear = (e) => {
    if (e?.type === "tool_execution_end") results.push(e);
  };
  client.on("event", hear);
  const asked = model.requests.length;
  try {
    await sessions.prompt(id, message);
    await until(() => getSession(id).status !== "running", "the run to end");
  } finally {
    client.off("event", hear);
  }
  return { requests: model.requests.slice(asked), results };
}
const tool = async (id, name) => (await sessions.getTools(id)).tools.find((t) => t.name === name);

test("a mode is made with an id from its name that no mode has and no chat stores, changed, and deleted", async () => {
  const first = await call("POST", "/chat-modes", { label: "  Deep   research ", description: "Reads first" });
  assert.equal(first.status, 200);
  assert.equal(first.body.id, "deep-research");
  assert.deepEqual(
    { ...first.body, createdAt: undefined, updatedAt: undefined },
    { id: "deep-research", label: "Deep research", description: "Reads first", codemode: false, instructions: "", provider: null, model: null, thinkingLevel: null, createdAt: undefined, updatedAt: undefined },
  );
  assert.equal((await call("POST", "/chat-modes", { label: "Deep research" })).body.id, "deep-research-2");

  // A chat keeps the mode of one that was deleted: a new mode of that name does not take it over.
  const gone = await made("Gone");
  const id = chat();
  assert.equal((await choose(id, `custom/${gone}`)).status, 200);
  assert.deepEqual(await call("DELETE", `/chat-modes/${gone}`), { status: 200, body: { ok: true } });
  assert.equal(await made("Gone"), "gone-2");

  const changed = await call("PUT", "/chat-modes/deep-research", { label: "Slow research", description: "", instructions: "  Read twice.\n", codemode: true, provider: " fake ", model: "m", thinkingLevel: "" });
  assert.equal(changed.status, 200);
  assert.deepEqual(
    { ...changed.body, createdAt: undefined, updatedAt: undefined },
    { id: "deep-research", label: "Slow research", description: "", codemode: true, instructions: "Read twice.", provider: "fake", model: "m", thinkingLevel: null, createdAt: undefined, updatedAt: undefined },
    "the id stays, and a blank is none",
  );
  assert.equal((await call("PUT", "/chat-modes/deep-research", { provider: null })).body.provider, null);

  for (const label of ["", "   ", "Two\nlines", "x".repeat(61)]) {
    const refused = await call("POST", "/chat-modes", { label });
    assert.equal(refused.status, 400, JSON.stringify(label));
    assert.match(refused.body.error, /name/);
  }
  assert.equal((await call("PUT", "/chat-modes/deep-research", { label: "" })).status, 400);
  assert.equal((await call("PUT", "/chat-modes/deep-research", { codemode: "yes" })).status, 400);
  assert.equal((await call("PUT", "/chat-modes/deep-research", { description: "a\nb" })).status, 400);
  assert.equal((await call("PUT", "/chat-modes/deep-research", { instructions: "x".repeat(8001) })).status, 400);
  assert.equal((await call("PUT", "/chat-modes/deep-research", { model: 3 })).status, 400);
  assert.equal((await call("GET", "/chat-modes")).body.modes.find((m) => m.id === "deep-research").label, "Slow research", "nothing written by a refusal");

  assert.deepEqual(await call("PUT", "/chat-modes/nope", { label: "A" }), { status: 404, body: { error: "Not found" } });
  assert.deepEqual(await call("DELETE", "/chat-modes/nope"), { status: 404, body: { error: "Not found" } });
  assert.deepEqual(await call("GET", "/chat-modes/nope/tools"), { status: 404, body: { error: "Not found" } });
  assert.deepEqual(await call("PUT", "/chat-modes/nope/tools", { off: [] }), { status: 404, body: { error: "Not found" } });
  for (const mode of (await call("GET", "/chat-modes")).body.modes) await call("DELETE", `/chat-modes/${mode.id}`);
});

test("a chat is offered the portal's modes, then the person's by their names, and stores one of theirs as custom/<id>", async () => {
  // Byte order would put "Zeta" first.
  const zeta = await made("Zeta");
  const alpha = await made("alpha", { description: "First of mine" });
  const id = chat();
  const { body } = await call("GET", `/sessions/${id}/modes`);
  assert.deepEqual(body.modes.map((m) => m.id), ["standard", "code", "custom/alpha", "custom/zeta"]);
  assert.deepEqual(body.modes[2], { id: "custom/alpha", label: "alpha", description: "First of mine" });
  assert.deepEqual(await choose(id, `custom/${alpha}`), { status: 200, body: { mode: "custom/alpha" } });
  assert.equal(getSession(id).mode, "custom/alpha");
  await call("DELETE", `/chat-modes/${zeta}`);
  await call("DELETE", `/chat-modes/${alpha}`);
});

test("a mode's model and effort are written into a chat put in it, and taken back by the next choice unless the person changed them", async () => {
  const mode = await made("Thinker", { provider: "fake", model: "m2", thinkingLevel: "high" });
  const modelOnly = await made("Model only", { model: "m3" });
  const id = chat();
  const row = () => {
    const { provider, model, thinking_level } = getSession(id);
    return { provider, model, thinking_level };
  };
  await choose(id, `custom/${mode}`);
  assert.deepEqual(row(), { provider: "fake", model: "m2", thinking_level: "high" });
  await choose(id, "standard");
  assert.deepEqual(row(), { provider: null, model: null, thinking_level: null });

  await choose(id, `custom/${mode}`);
  updateSession(id, { model: "m" });
  await choose(id, "code");
  assert.deepEqual(row(), { provider: "fake", model: "m", thinking_level: null }, "the model the person chose stays");

  await choose(id, `custom/${modelOnly}`);
  assert.deepEqual(row(), { provider: null, model: "m3", thinking_level: null }, "a mode that names no provider leaves the chat's");
  await choose(id, `custom/${mode}`);
  assert.deepEqual(row(), { provider: "fake", model: "m2", thinking_level: "high" }, "one mode's for another's");
});

test("a mode's tools are its chats' layer, and a change of them reaches its live chats and no others", async () => {
  const mode = await made("Quiet");
  const other = await made("Loud");
  const id = chat();
  const elsewhere = chat();
  await choose(id, `custom/${mode}`);
  await choose(elsewhere, `custom/${other}`);
  await sessions.client(id);
  await sessions.client(elsewhere);

  const listed = await call("GET", `/chat-modes/${mode}/tools`);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.live, false);
  assert.equal(listed.body.tools.find((t) => t.name === "bash").enabled, true);
  assert.ok(listed.body.off.includes("codemode"), "held against Settings → Tools, which has the code tool off");

  const saved = await call("PUT", `/chat-modes/${mode}/tools`, { off: [...listed.body.off, "bash"] });
  assert.deepEqual(saved, { status: 200, body: { off: [...listed.body.off, "bash"].sort(), applied: 1 } });
  assert.equal((await call("GET", `/chat-modes/${mode}/tools`)).body.tools.find((t) => t.name === "bash").enabled, false);
  const bash = await tool(id, "bash");
  assert.deepEqual([bash.enabled, bash.defaultOn], [false, false], "off by the mode's layer");
  assert.ok(sessions.piOff(id).includes("bash"));
  assert.ok(sessions.live.get(id).client.switchedOff.has("bash"), "the running chat was told");
  assert.ok(!sessions.piOff(elsewhere).includes("bash"));
  assert.ok(!sessions.live.get(elsewhere).client.switchedOff.has("bash"), "a chat in another mode was not");
  const { requests } = await say(id, "Hello");
  assert.ok(!declared(requests[0]).includes("bash"));
});

test("a mode's instructions are said in its chats' system prompt, and a change of them reaches a running chat", async () => {
  const mode = await made("Terse", { instructions: "Answer in haiku." });
  const id = chat();
  await choose(id, `custom/${mode}`);
  const first = await say(id, "Hello");
  assert.match(told(first.requests[0]), /Answer in haiku\./);
  const plain = chat();
  assert.doesNotMatch(told((await say(plain, "Hello")).requests[0]), /Answer in haiku/, "not in a chat in another mode");

  assert.equal((await call("PUT", `/chat-modes/${mode}`, { instructions: "Answer in limericks." })).status, 200);
  const next = await say(id, "Again");
  assert.match(told(next.requests[0]), /Answer in limericks\./);
  assert.doesNotMatch(told(next.requests[0]), /haiku/);
});

test("a mode made to work through the code tool has it on in its layer, and its chats are offered the code tool alone", async () => {
  const mode = await made("Scripted", { codemode: true });
  const tools = (await call("GET", `/chat-modes/${mode}/tools`)).body;
  assert.ok(!tools.off.includes("codemode"));
  assert.equal(tools.tools.find((t) => t.name === "codemode").enabled, true);
  assert.equal(tools.tools.find((t) => t.name === "lazy_one").lazy, undefined, "not called lazy on the mode's page, as in its chats");
  const id = chat();
  await choose(id, `custom/${mode}`);
  const ran = globalThis.lazyOneRan ?? 0;
  const { requests, results } = await say(id, SCRIPT);
  assert.deepEqual(declared(requests[0]), ["codemode"]);
  assert.equal(results.find((r) => r.toolName === "lazy_one")?.isError, false, "a lazy tool in a script's reach");
  assert.equal(globalThis.lazyOneRan, ran + 1);
  assert.equal((await tool(id, "lazy_one")).lazy, undefined);
});

test("in a mode of the person's whose tools switch the code tool on, a chat's switch cannot turn it off; where they leave it, it can", async () => {
  const mode = await made("Held", { codemode: true });
  const id = chat();
  await choose(id, `custom/${mode}`);
  const held = await tool(id, "codemode");
  assert.deepEqual([held.enabled, held.byMode], [true, true]);
  await assert.rejects(sessions.setTools(id, ["codemode"]), CodemodeHeld);
  assert.deepEqual(sessionTools(id), { off: [], on: [] });
  assert.equal((await tool(id, "codemode")).enabled, true);

  // The code tool switched on in the mode's tools, without working through it: the same layer, so held the same.
  const beside = await made("Beside");
  const listed = (await call("GET", `/chat-modes/${beside}/tools`)).body;
  await call("PUT", `/chat-modes/${beside}/tools`, { off: listed.off.filter((name) => name !== "codemode") });
  const other = chat();
  await choose(other, `custom/${beside}`);
  assert.equal((await tool(other, "codemode")).byMode, true);
  await assert.rejects(sessions.setTools(other, ["codemode"]), CodemodeHeld);

  // Switched off in the mode's tools later, it is not the mode's to hold: the chat's switch is its own again.
  await call("PUT", `/chat-modes/${mode}/tools`, { off: [...(await call("GET", `/chat-modes/${mode}/tools`)).body.off, "codemode"] });
  assert.deepEqual([(await tool(id, "codemode")).enabled, (await tool(id, "codemode")).byMode], [false, undefined]);
  await sessions.setTools(id, []);
  assert.equal((await tool(id, "codemode")).enabled, true);
  await sessions.setTools(id, ["codemode"]);
  assert.equal((await tool(id, "codemode")).enabled, false);
});

test("a started chat whose own switches have the code tool off is held once its mode is changed to work through it", async () => {
  const mode = await made("Later scripted");
  const id = chat();
  await choose(id, `custom/${mode}`);
  // Switched off in the chat, as a chat stores it where a layer under it has it on.
  setSessionTools(id, { off: ["codemode"], on: [] });
  await say(id, "Hello");
  assert.equal((await tool(id, "codemode")).enabled, false);

  assert.equal((await call("PUT", `/chat-modes/${mode}`, { codemode: true })).status, 200);
  const held = await tool(id, "codemode");
  assert.deepEqual([held.enabled, held.byMode], [true, true]);
  await assert.rejects(sessions.setTools(id, ["codemode"]), CodemodeHeld);
  assert.ok(!sessions.live.get(id).client.switchedOff.has("codemode"), "the running chat was told");
  assert.ok(declared((await say(id, "Again")).requests[0]).includes("codemode"));
});

test("a running chat's own code-tool off stays through another switch saved while its mode holds the tool, and counts again once the mode lets it go", async () => {
  // The code tool on under the mode, so that what keeps it off once the mode lets it go is the chat's own off.
  const defaults = toolDefaultsOff();
  setToolDefaultsOff(defaults.filter((name) => name !== "codemode"));
  try {
    const mode = await made("Held a while");
    const id = chat();
    await choose(id, `custom/${mode}`);
    await say(id, "Hello");
    await sessions.setTools(id, ["codemode"]);
    assert.equal((await tool(id, "codemode")).enabled, false);

    assert.equal((await call("PUT", `/chat-modes/${mode}`, { codemode: true })).status, 200);
    assert.equal((await tool(id, "codemode")).byMode, true);
    await sessions.setTools(id, ["bash"]);
    assert.equal(getSession(id).tools_off, "bash\ncodemode", "the page's list said nothing of the code tool");

    assert.equal((await call("PUT", `/chat-modes/${mode}`, { codemode: false })).status, 200);
    const codemode = await tool(id, "codemode");
    assert.deepEqual([codemode.enabled, codemode.byMode], [false, undefined]);
    const names = declared((await say(id, "Again")).requests[0]);
    for (const name of ["codemode", "bash"]) assert.ok(!names.includes(name), name);
  } finally {
    setToolDefaultsOff(defaults);
  }
});

test("a chat in a mode made to work through the code tool, whose tools then switch it off, has its tools declared, and its lazy tools lazy again", async () => {
  const mode = await made("Unscripted", { codemode: true });
  const layer = (await call("GET", `/chat-modes/${mode}/tools`)).body;
  await call("PUT", `/chat-modes/${mode}/tools`, { off: [...layer.off, "codemode"] });
  const id = chat();
  await choose(id, `custom/${mode}`);
  const { requests } = await say(id, "Hello");
  assert.equal(sessions.live.get(id).client.codemodeOnly, true, "started in pi's `only` presentation");
  const names = declared(requests[0]);
  for (const name of ["bash", "tools"]) assert.ok(names.includes(name), name);
  for (const name of ["codemode", "lazy_one"]) assert.ok(!names.includes(name), name);
  assert.equal((await tool(id, "lazy_one")).lazy, true);
  assert.equal((await tool(id, "codemode")).byMode, undefined);
});

test("the code-tool switch of a mode reaches a running chat at its next start; the code tool in its layer at once", async () => {
  // Started with the switch on, then off: the code tool goes from the mode's layer, as Settings → Tools has it (off),
  // and the running chat works as in Standard mode at once.
  const on = await made("Was scripted", { codemode: true });
  const a = chat();
  await choose(a, `custom/${on}`);
  await say(a, "Hello");
  assert.equal((await call("PUT", `/chat-modes/${on}`, { codemode: false })).status, 200);
  const layer = (await call("GET", `/chat-modes/${on}/tools`)).body;
  assert.ok(layer.off.includes("codemode"));
  assert.equal(layer.tools.find((t) => t.name === "lazy_one").lazy, true);
  assert.equal((await tool(a, "lazy_one")).lazy, true, "lazy again, with the code tool off");
  const plain = declared((await say(a, "Hello")).requests[0]);
  for (const name of ["tools", "bash"]) assert.ok(plain.includes(name), name);
  for (const name of ["codemode", "lazy_one"]) assert.ok(!plain.includes(name), name);

  // Started with it off, then on: the code tool is beside the others now, by the layer, and the lazy tool still lazy.
  const off = await made("Will be scripted");
  const b = chat();
  await choose(b, `custom/${off}`);
  const before = await say(b, "Hello");
  assert.ok(declared(before.requests[0]).includes("tools"));
  assert.ok(!declared(before.requests[0]).includes("lazy_one"));
  assert.ok(!declared(before.requests[0]).includes("codemode"));
  assert.equal((await call("PUT", `/chat-modes/${off}`, { codemode: true })).status, 200);
  assert.equal((await tool(b, "lazy_one")).lazy, true, "its pi was started with every tool offered one by one");
  const after = await say(b, "Hello");
  for (const name of ["tools", "bash", "codemode"]) assert.ok(declared(after.requests[0]).includes(name), name);
  assert.ok(!declared(after.requests[0]).includes("lazy_one"));

  // Started again, each is what its mode gives now.
  await sessions.stop(a);
  await sessions.stop(b);
  const a2 = declared((await say(a, "Hello")).requests[0]);
  for (const name of ["tools", "bash"]) assert.ok(a2.includes(name), name);
  for (const name of ["codemode", "lazy_one"]) assert.ok(!a2.includes(name), name);
  assert.deepEqual(declared((await say(b, "Hello")).requests[0]), ["codemode"]);
});

test("a deleted mode stays on its chats, which lose its tools and instructions at once, and no chat can be put in it", async () => {
  const mode = await made("Short lived", { instructions: "Speak like a pirate." });
  const listed = (await call("GET", `/chat-modes/${mode}/tools`)).body;
  await call("PUT", `/chat-modes/${mode}/tools`, { off: [...listed.off, "bash"] });
  const id = chat();
  await choose(id, `custom/${mode}`);
  const before = await say(id, "Hello");
  assert.match(told(before.requests[0]), /Speak like a pirate\./);
  assert.ok(!declared(before.requests[0]).includes("bash"));

  assert.deepEqual(await call("DELETE", `/chat-modes/${mode}`), { status: 200, body: { ok: true } });
  assert.equal(getSession(id).mode, `custom/${mode}`);
  assert.ok(!(await call("GET", "/chat-modes")).body.modes.some((m) => m.id === mode));
  assert.ok(!(await call("GET", `/sessions/${id}/modes`)).body.modes.some((m) => m.id === `custom/${mode}`));
  assert.ok(!sessions.live.get(id).client.switchedOff.has("bash"), "its layer went from the running chat");
  const after = await say(id, "Again");
  assert.doesNotMatch(told(after.requests[0]), /pirate/, "said no more after the delete");
  assert.ok(declared(after.requests[0]).includes("bash"));

  const fresh = chat();
  assert.deepEqual(await choose(fresh, `custom/${mode}`), { status: 400, body: { error: `There is no mode "custom/${mode}" for this chat.` } });
});
