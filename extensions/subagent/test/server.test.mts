import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "../../../tests/helpers.mts";
import { describe } from "../src/pi.ts";
import { serveSubagent } from "./portal.mts";

/**
 * The subagent extension's server half, through the portal's own extension host: its settings and their checks at its
 * own address and at the portal's old one, and the tool it gives each chat's pi while it runs, with what they say.
 */

inProcessHome("pithagoras-subagent-server-");
const portal = await serveSubagent();
const { at, api } = portal;

const json = { "content-type": "application/json" };
const put = (url: string, body: unknown) => fetch(url, { method: "PUT", headers: json, body: JSON.stringify(body) });
const shown = async () => (await fetch(`${at}/settings`)).json();

test("the settings start as the tool does without being told, are saved for their owner alone, and reload the chats", async () => {
  assert.deepEqual(await shown(), { mode: "interrupt", maxParallel: 1, model: "auto", keep: false, inheritMode: true, maxParallelLimit: 16 });
  const saved = await put(`${at}/settings`, { mode: "background", maxParallel: 3, model: "llama-swap/model-b", keep: true, inheritMode: false });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { mode: "background", maxParallel: 3, model: "llama-swap/model-b", keep: true, inheritMode: false, maxParallelLimit: 16, reloaded: 0, waiting: 0 });
  assert.deepEqual(await shown(), { mode: "background", maxParallel: 3, model: "llama-swap/model-b", keep: true, inheritMode: false, maxParallelLimit: 16 });
  const file = path.join(portal.data, "settings.json");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { mode: "background", maxParallel: 3, model: "llama-swap/model-b", keep: true, inheritMode: false });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  // One change at a time keeps the rest; a default is left out of the file.
  await put(`${at}/settings`, { mode: "interrupt" });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { maxParallel: 3, model: "llama-swap/model-b", keep: true, inheritMode: false });
  await put(`${at}/settings`, { maxParallel: 1, model: "auto", keep: false, inheritMode: true });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {});
});

test("what is not a mode, a limit from 1 to 16, a model or a yes or no for keeping or the chat's mode is refused, and nothing is saved", async () => {
  const before = await shown();
  for (const [body, error] of [
    [{ mode: "sideways" }, "mode must be interrupt or background"],
    [{ maxParallel: 0 }, "maxParallel must be a whole number from 1 to 16"],
    [{ maxParallel: 17 }, "maxParallel must be a whole number from 1 to 16"],
    [{ maxParallel: 2.5 }, "maxParallel must be a whole number from 1 to 16"],
    [{ maxParallel: "3" }, "maxParallel must be a whole number from 1 to 16"],
    [{ model: "no-slash" }, 'model must be "auto" or provider/model'],
    [{ model: 3 }, 'model must be "auto" or provider/model'],
    [{ keep: "yes" }, "keep must be true or false"],
    [{ inheritMode: "yes" }, "inheritMode must be true or false"],
    // The switch is Settings → Extensions': off is not this address's to do.
    [{ enabled: false, mode: "background" }, "The subagent tool is switched off in Settings → Extensions (PUT /api/extensions/enabled)"],
  ] as const) {
    const answer = await put(`${at}/settings`, body);
    assert.deepEqual([answer.status, (await answer.json()).error], [400, error], JSON.stringify(body));
  }
  assert.deepEqual(await shown(), before);
  // On it is already, as it answers.
  assert.equal((await put(`${at}/settings`, { enabled: true })).status, 200);
});

test("the portal's old address for the settings sends to the extension's, the method and the body kept", async () => {
  const asked = await fetch(`${api}/features/subagent`, { redirect: "manual" });
  // Not a 308: a browser keeps that for good, and a version without the extension has nothing at the new address.
  assert.equal(asked.status, 307);
  assert.equal(asked.headers.get("location"), "/api/x/pithagoras-subagent/settings");
  const changed = await put(`${api}/features/subagent`, { maxParallel: 2 });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).maxParallel, 2);
  assert.equal((await (await fetch(`${api}/features/subagent`)).json()).maxParallel, 2);
  await put(`${at}/settings`, { maxParallel: 1, keep: false });
});

test("while it runs every chat's pi has the subagent tool, held to the guard's delegate rule, saying what the settings say; switched off, none has", async () => {
  portal.db.createSession({ id: "chat-1", title: "t", workspace: process.env.WORKSPACE_ROOT!, executor: "host", kind: "task" });
  await put(`${at}/settings`, { mode: "background", maxParallel: 3 });
  const tool = portal.toolsIn("chat-1").get("subagent");
  assert.ok(tool, "the chat's pi has it");
  assert.deepEqual(tool.guard, { acts: ["delegate"] });
  assert.equal(tool.description, describe("background", 3));

  // Settings → Extensions' switch (PUT /api/extensions/enabled), which brings the server halves in line with pi's settings.
  await portal.stop();
  assert.equal(portal.toolsIn("chat-1").size, 0, "off: nothing of it in the chat");
  assert.equal((await fetch(`${at}/settings`)).status, 404, "nor its address");
  assert.equal((await fetch(`${at}/chats/chat-1/model`)).status, 404, "nor the model menu's");

  await portal.start();
  assert.equal(portal.toolsIn("chat-1").get("subagent")?.description, describe("background", 3), "on again, with the settings it kept");
  await put(`${at}/settings`, { mode: "interrupt", maxParallel: 1 });
});

test("a child chat's pi has no subagent tool: its subagents would be a level the portal's child chats do not have", async () => {
  portal.db.createSession({ id: "chat-7", title: "t", workspace: process.env.WORKSPACE_ROOT!, executor: "host", kind: "task" });
  portal.db.createSession({ id: "chat-7-child", title: "t", workspace: process.env.WORKSPACE_ROOT!, executor: "host", kind: "task", parent_id: "chat-7", listed: 0 });
  assert.ok(portal.toolsIn("chat-7").get("subagent"));
  assert.equal(portal.toolsIn("chat-7-child").get("subagent"), undefined);
});

test("a heartbeat's pi has no subagent tool either: its child chat would be refused, and the tool would only cost tokens", async () => {
  portal.db.createSession({ id: "chat-beat", title: "t", workspace: process.env.WORKSPACE_ROOT!, executor: "host", kind: "heartbeat" });
  portal.db.createSession({ id: "chat-routine", title: "t", workspace: process.env.WORKSPACE_ROOT!, executor: "host", kind: "routine" });
  assert.equal(portal.toolsIn("chat-beat").get("subagent"), undefined);
  assert.ok(portal.toolsIn("chat-routine").get("subagent"), "a routine's run keeps it: its guard decides");
});

test("what a chat's subagents run on is kept for that chat at the extension's address, read as one starts, and the portal's old address sends there", async () => {
  portal.db.createSession({ id: "chat-2", title: "t", workspace: process.env.WORKSPACE_ROOT!, executor: "host", kind: "task" });
  const model = `${at}/chats/chat-2/model`;
  // Nothing said: the settings' model, for every chat.
  assert.deepEqual(await (await fetch(model)).json(), { model: null, default: "auto" });
  const said = await put(model, { model: "llama-swap/model-b" });
  assert.deepEqual([said.status, await said.json()], [200, { model: "llama-swap/model-b", default: "auto" }]);
  const file = path.join(portal.data, "chats.json");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { chats: { "chat-2": "llama-swap/model-b" } });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  // The tool asks as a subagent starts: what the chat's pi has is the extension's own, not the portal's.
  const started = await subagentStarts("chat-2");
  assert.equal(started, "llama-swap/model-b");

  // At the portal's old address: sent on, the method and the body kept.
  const old = `${api}/sessions/chat-2/subagent-model`;
  const asked = await fetch(old, { redirect: "manual" });
  assert.deepEqual([asked.status, asked.headers.get("location")], [307, "/api/x/pithagoras-subagent/chats/chat-2/model"]);
  assert.deepEqual(await (await put(old, { model: "auto" })).json(), { model: "auto", default: "auto" });
  assert.deepEqual(await (await fetch(old)).json(), { model: "auto", default: "auto" });

  // Back to the default: nothing said, and nothing kept.
  assert.deepEqual(await (await put(model, { model: null })).json(), { model: null, default: "auto" });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { chats: {} });
});

test("a chat's model that is no model, or a chat there is not, is refused", async () => {
  portal.db.createSession({ id: "chat-3", title: "t", workspace: process.env.WORKSPACE_ROOT!, executor: "host", kind: "task" });
  for (const model of ["no-slash", 3, ""]) {
    const answer = await put(`${at}/chats/chat-3/model`, { model });
    assert.deepEqual([answer.status, (await answer.json()).error], [400, 'model must be null, "auto" or provider/model'], JSON.stringify(model));
  }
  assert.equal((await fetch(`${at}/chats/nobody/model`)).status, 404);
  assert.equal((await put(`${at}/chats/nobody/model`, { model: "auto" })).status, 404);
  assert.deepEqual(await (await fetch(`${at}/chats/chat-3/model`)).json(), { model: null, default: "auto" });
});

test("a chat that is deleted takes what it said with it", async () => {
  portal.db.createSession({ id: "chat-4", title: "t", workspace: process.env.WORKSPACE_ROOT!, executor: "host", kind: "task" });
  await put(`${at}/chats/chat-4/model`, { model: "llama-swap/model-b" });
  portal.db.deleteSession("chat-4");
  portal.host.chatLife("deleted", "chat-4");
  assert.deepEqual(JSON.parse(readFileSync(path.join(portal.data, "chats.json"), "utf8")), { chats: {} });
});

test("a chat deleted while the extension was off is forgotten as it starts again", async () => {
  portal.db.createSession({ id: "chat-5", title: "t", workspace: process.env.WORKSPACE_ROOT!, executor: "host", kind: "task" });
  portal.db.createSession({ id: "chat-6", title: "t", workspace: process.env.WORKSPACE_ROOT!, executor: "host", kind: "task" });
  await put(`${at}/chats/chat-5/model`, { model: "auto" });
  await put(`${at}/chats/chat-6/model`, { model: "llama-swap/model-b" });
  await portal.stop();
  // No `deleted` reaches the half that is off.
  portal.db.deleteSession("chat-5");
  await portal.start();
  assert.deepEqual(JSON.parse(readFileSync(path.join(portal.data, "chats.json"), "utf8")), { chats: { "chat-6": "llama-swap/model-b" } });
  await put(`${at}/chats/chat-6/model`, { model: null });
});

test("a subagent's chat is asked for in its chat's mode, or in Standard when the setting says so; a chat in no mode asks for none", async () => {
  portal.db.createSession({ id: "chat-code", title: "t", workspace: process.env.WORKSPACE_ROOT!, executor: "host", kind: "task", mode: "code" });
  portal.db.createSession({ id: "chat-plain", title: "t", workspace: process.env.WORKSPACE_ROOT!, executor: "host", kind: "task" });
  assert.equal((await shown()).inheritMode, true, "on unless it is switched off");
  assert.equal((await subagentAsks("chat-code"))[0].mode, "code");
  assert.equal((await subagentAsks("chat-plain"))[0].mode, undefined);
  assert.equal((await put(`${at}/settings`, { inheritMode: false })).status, 200);
  assert.equal((await subagentAsks("chat-code"))[0].mode, "standard");
  assert.equal((await subagentAsks("chat-plain"))[0].mode, undefined, "Standard is what a chat in none has to start with");
  await put(`${at}/settings`, { inheritMode: true });
  assert.equal((await subagentAsks("chat-code"))[0].mode, "code", "the switch is read as a subagent starts");
});

test("a mode the portal will not put a child in is worked in as Standard", async () => {
  portal.db.createSession({ id: "chat-gone", title: "t", workspace: process.env.WORKSPACE_ROOT!, executor: "host", kind: "task", mode: "custom/gone" });
  const asked = await subagentAsks("chat-gone", (options) => {
    if (options.mode !== "standard") throw new TypeError('There is no mode "custom/gone" for this child chat');
  });
  assert.deepEqual(asked.map((o) => o.mode), ["custom/gone", "standard"]);
});

test("the chats are loaded again where the mode, the limit or keeping changed, not for what is read as a subagent starts", async () => {
  let reloads = 0;
  portal.host.setChatBridge(bridge({ reload: async () => (reloads++, { reloaded: 2, waiting: 1 }) }) as any);
  const change = async (body: unknown) => (await put(`${at}/settings`, body)).json();
  assert.deepEqual(await change({ inheritMode: false }), { ...(await shown()), reloaded: 0, waiting: 0 });
  await change({ model: "llama-swap/model-b" });
  await change({ mode: "interrupt", maxParallel: 1, keep: false });
  assert.equal(reloads, 0, "nothing the tool tells the model changed");
  assert.deepEqual(await change({ keep: true }), { ...(await shown()), reloaded: 2, waiting: 1 });
  await change({ maxParallel: 2 });
  await change({ mode: "background" });
  assert.equal(reloads, 3);
  await change({ mode: "interrupt", maxParallel: 1, keep: false, model: "auto", inheritMode: true });
});

/** The portal's side of the chat bridge, over stand-ins that make no chats: `over` replaces what it says. */
function bridge(over: Record<string, unknown> = {}) {
  return {
    tell: async () => false,
    offers: () => undefined,
    reload: async () => ({ reloaded: 0, waiting: 0 }),
    model: async () => undefined,
    create: () => {
      throw new Error("No child chats in this test");
    },
    run: async () => ({ status: "error", answer: "", error: "No child chats in this test" }),
    abort: async () => {},
    remove: async () => {},
    ...over,
  };
}

/**
 * What a subagent of `chatId` would ask the portal's child chats for, each time it asks (it asks again, in Standard,
 * where the portal refuses a mode), as the tool in the chat's pi
 * works it out: over a stand-in for pi, and with child chats that are asked for and not made. `refuse` is told each
 * request and throws where the portal would refuse it.
 */
async function subagentAsks(chatId: string, refuse: (options: any) => void = () => {}): Promise<any[]> {
  const asked: any[] = [];
  const pi = { registerTool: (tool: any) => (registered = tool), on: () => {}, events: { on: () => () => {}, emit: () => {} }, sendMessage: () => {} };
  let registered: any;
  for (const { name, factory } of portal.host.hostExtensions(chatId)) if (name === "pithagoras-subagent") factory(pi);
  portal.host.setChatBridge(
    bridge({
      create: (options: unknown) => {
        asked.push(options);
        refuse(options);
        throw new Error("No child chats in this test");
      },
    }) as any,
  );
  await registered.execute("call", { task: "x" }, undefined, undefined, { model: { provider: "p", id: "parent" } }).catch(() => undefined);
  return asked;
}

/** The model a subagent of `chatId` would start on. */
async function subagentStarts(chatId: string): Promise<string | undefined> {
  const model = (await subagentAsks(chatId))[0]?.model;
  return model ? `${model.provider}/${model.id}` : undefined;
}
