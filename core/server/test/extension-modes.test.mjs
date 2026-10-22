import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fakeModel } from "./fake-model.mjs";
import { inProcessHome } from "./server-harness.mjs";

/**
 * Modes an extension offers (`portal.modes.provide`): listed after the portal's own and the person's for the chats that
 * may choose, put only after a yes where the mode asks first, with an audit row for it; what a mode does is the
 * extension's, in its `chats.extend` factory, which finds the chat's mode on `chat.mode` (in a stand-in pi, and in a
 * chat's own pi with a fake model); and a mode goes when its server half stops, while the chats started in it keep it.
 */
const home = inProcessHome("extension-modes-");
const said = [];
const log = console.log;
console.log = (...args) => {
  said.push(args.join(" "));
  log(...args);
};
test.after(() => (console.log = log));
const model = await fakeModel();
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify(model.models()));

const host = await import("../dist/extension-host.js");
const { providedModes } = await import("../dist/chat-modes.js");
const { createCustomMode, createSession, deleteCustomMode, getDb, getSession, getSettings, setSettings } = await import("../dist/db.js");
const { sessions } = await import("../dist/session-manager.js");
const { modesRouter } = await import("../dist/api/modes.js");
const { default: express } = await import("express");
setSettings({ ...getSettings(), provider: "fake", model: "m" });
test.after(() => host.stopServerHalves());
test.after(() => {
  for (const id of [...sessions.live.keys()]) sessions.live.get(id).client.dispose();
});

// As server.ts has it: JSON parsed for every route.
const server = express().use(express.json()).use("/api", modesRouter()).listen(0, "127.0.0.1");
await once(server, "listening");
test.after(() => server.close());
const base = `http://127.0.0.1:${server.address().port}/api`;
const get = async (id) => (await fetch(`${base}/sessions/${id}/modes`)).json();
const put = async (id, body) => {
  const res = await fetch(`${base}/sessions/${id}/modes`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

let revs = 0;
/** A server half in a folder of its own, its module's default export's body written anew. */
function half(name, body) {
  const dir = path.join(home, "packages", name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `server-${++revs}.js`);
  writeFileSync(file, `export default function (portal) {\nglobalThis.portals[${JSON.stringify(name)}] = portal;\n${body}\n}\n`);
  return { name, version: "1.0.0", file, rev: `${statSync(file).size.toString(36)}-${revs}` };
}
globalThis.portals = {};

const WARNING = "The agent can change what is installed in this chat. Use it only with what you would install yourself.";
/** The stand-in: Focus mode, which asks first and gives its chats a tool of its own, and Plain mode, which does neither. */
const standIn = () =>
  half(
    "stand-in",
    `globalThis.focus = portal.modes.provide({ id: "focus", label: "Focus mode", description: "Works with the focus tool.", confirm: ${JSON.stringify(WARNING)} });
portal.modes.provide({ id: "plain", label: "Plain mode", description: "Asks nothing first." });
portal.chats.extend((pi, chat) => {
  if (chat.mode !== globalThis.focus) return;
  pi.registerTool({ name: "focus_only", label: "Focus only", description: "Only in Focus mode", parameters: { type: "object", properties: {} }, async execute() { return { content: [], details: {} }; } });
});`,
  );

let count = 0;
function chat() {
  const id = `ext-modes${++count}`;
  createSession({ id, title: id, workspace: process.env.WORKSPACE_ROOT, executor: "host", kind: "task" });
  return id;
}
const ids = (modes) => modes.map((mode) => mode.id);
/** The tools the server halves register in a chat's pi, as a stand-in pi takes them. */
function registered(chatId) {
  const tools = [];
  for (const { factory } of host.hostExtensions(chatId)) factory({ registerTool: (tool) => tools.push(tool.name), on() {}, registerCommand() {} });
  return tools;
}
const audit = () => getDb().prepare("SELECT kind, subject, reason, session_id FROM audit WHERE kind = 'mode' ORDER BY id").all();
/** The names of the tools the model was offered in the request a message in the chat made. */
async function offered(id) {
  const asked = model.requests.length;
  await sessions.prompt(id, "Hello");
  for (let i = 0; getSession(id).status === "running"; i++) {
    assert.ok(i < 1500, "timed out waiting for the run to end");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return (model.requests[asked].tools ?? []).map((tool) => tool.function?.name ?? tool.name);
}

test("an extension's modes come after the portal's own and the person's, with what they ask first and whose they are", async () => {
  await host.syncServerHalves([standIn()]);
  assert.equal(globalThis.focus, "stand-in/focus");
  const mine = createCustomMode({ label: "Research", description: "" });
  const { modes } = await get(chat());
  deleteCustomMode(mine.id);
  assert.deepEqual(ids(modes), ["standard", "code", `custom/${mine.id}`, "stand-in/focus", "stand-in/plain"]);
  assert.deepEqual(modes[3], { id: "stand-in/focus", label: "Focus mode", description: "Works with the focus tool.", confirm: WARNING, extension: "stand-in" });
  assert.deepEqual(modes[4], { id: "stand-in/plain", label: "Plain mode", description: "Asks nothing first.", extension: "stand-in" });
  // The portal's own and the person's say neither.
  for (const mode of modes.slice(0, 3)) assert.equal("confirm" in mode || "extension" in mode, false);
});

test("a mode that asks first is put only with the person's yes, which is in the audit log; one that does not ask writes no row", async () => {
  const id = chat();
  assert.deepEqual(await put(id, { mode: "stand-in/focus" }), {
    status: 409,
    body: { error: "This mode asks first: send confirmed: true once the person has said yes to its text.", confirm: WARNING },
  });
  assert.deepEqual(await put(id, { mode: "stand-in/focus", confirmed: "yes" }), {
    status: 409,
    body: { error: "This mode asks first: send confirmed: true once the person has said yes to its text.", confirm: WARNING },
  });
  assert.equal(getSession(id).mode, null);
  assert.deepEqual(audit(), []);

  assert.deepEqual(await put(id, { mode: "stand-in/focus", confirmed: true }), { status: 200, body: { mode: "stand-in/focus" } });
  assert.equal(getSession(id).mode, "stand-in/focus");
  assert.deepEqual(audit(), [{ kind: "mode", subject: "Focus mode", reason: "stand-in/focus", session_id: id }]);

  const plain = chat();
  assert.deepEqual(await put(plain, { mode: "stand-in/plain" }), { status: 200, body: { mode: "stand-in/plain" } });
  assert.equal(getSession(plain).mode, "stand-in/plain");
  // Nor does going back to Standard.
  assert.deepEqual(await put(id, { mode: "standard" }), { status: 200, body: { mode: "standard" } });
  assert.equal(audit().length, 1);
});

test("the extension's factory finds the chat's mode, and gives its tool only to the chats in its mode", async () => {
  const focused = chat();
  const plain = chat();
  await put(focused, { mode: "stand-in/focus", confirmed: true });
  assert.deepEqual(registered(focused), ["focus_only"]);
  assert.deepEqual(registered(plain), []);
  const portal = globalThis.portals["stand-in"];
  assert.equal(portal.chats.get(focused).mode, "stand-in/focus");
  assert.equal("mode" in portal.chats.get(plain), false);
  assert.equal(portal.chats.list().find((one) => one.id === focused).mode, "stand-in/focus");
});

test("in a chat's pi, the model is offered the extension's tool in a chat in its mode, and not in another", async () => {
  const focused = chat();
  const plain = chat();
  await put(focused, { mode: "stand-in/focus", confirmed: true });
  assert.ok((await offered(focused)).includes("focus_only"));
  const standard = await offered(plain);
  assert.ok(standard.includes("bash"));
  assert.ok(!standard.includes("focus_only"));
});

test("a mode goes when its server half stops, and the chats in it keep it; started again, it is offered again", async () => {
  const id = chat();
  await put(id, { mode: "stand-in/focus", confirmed: true });
  const fresh = chat();
  await host.syncServerHalves([]);
  assert.deepEqual(ids(providedModes()), []);
  assert.deepEqual(ids((await get(id)).modes), ["standard", "code"]);
  assert.equal(getSession(id).mode, "stand-in/focus");
  assert.deepEqual(await put(fresh, { mode: "stand-in/focus", confirmed: true }), { status: 400, body: { error: 'There is no mode "stand-in/focus" for this chat.' } });
  assert.equal(getSession(fresh).mode, null);

  await host.syncServerHalves([standIn()]);
  assert.deepEqual(ids((await get(fresh)).modes), ["standard", "code", "stand-in/focus", "stand-in/plain"]);
  assert.deepEqual(registered(id), ["focus_only"]);
});

test("a mode of the wrong shape, one offered twice, and one of a package called custom throw; a half no longer running offers nothing", async () => {
  const { modes } = globalThis.portals["stand-in"];
  const good = { id: "other", label: "Other mode", description: "Another one." };
  for (const mode of [undefined, { ...good, label: undefined }, { ...good, label: " " }, { ...good, id: "Other" }, { ...good, id: "a/b" }, { ...good, id: "-x" }, { ...good, description: 3 }, { ...good, confirm: "" }]) {
    assert.throws(() => modes.provide(mode), (e) => e instanceof TypeError && /^provide takes \{ id, label, description, confirm\? \}/.test(e.message), JSON.stringify(mode));
  }
  assert.throws(() => modes.provide({ ...good, id: "focus" }), { name: "TypeError", message: 'stand-in offers the mode "focus" already' });
  assert.deepEqual(ids(providedModes()), ["stand-in/focus", "stand-in/plain"]);

  await host.syncServerHalves([half("custom", "")]);
  assert.throws(() => globalThis.portals.custom.modes.provide(good), {
    name: "TypeError",
    message: 'A package called "custom" cannot offer modes: its modes would be taken for the person\'s own',
  });

  // Stopped, and offering from a timer it left behind.
  await host.syncServerHalves([half("once", "")]);
  await host.syncServerHalves([]);
  said.length = 0;
  assert.equal(globalThis.portals.once.modes.provide(good), "once/other");
  assert.ok(said.includes("[extension once] cannot offer the mode other: its server half is not running"), said.join("\n"));
  assert.deepEqual(ids(providedModes()), []);
});
