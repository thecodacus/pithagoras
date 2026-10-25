import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fakeModel } from "./fake-model.mjs";
import { inProcessHome } from "./server-harness.mjs";

/**
 * Child chats (child-chats.ts): a server half makes a chat of a chat with `portal.chats.create`, runs it with
 * `chats.prompt` and waits for its answer, stops it with `chats.abort`, and deletes it with `chats.remove`. Real pi and
 * the portal's own session manager, with a model that plays the script; two server halves in the portal's process.
 */
const home = inProcessHome("pithagoras-child-chats-");

// "Answer" is answered in a sentence; "Hold" is held until the test lets it go; a message about kites is noted; anything else is done.
let held = [];
const model = await fakeModel((request) => {
  const last = JSON.stringify(request.messages.at(-1)?.content ?? "");
  if (last.includes("kites")) return "Kites noted.";
  if (last.includes("Hold")) return new Promise((resolve) => held.push(() => resolve("Held, and done.")));
  if (last.includes("Answer")) return "The answer is 42.";
  return "Done.";
});
const letGo = () => {
  for (const release of held.splice(0)) release();
};
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify(model.models()));

const host = await import("../dist/extension-host.js");
const { createCustomMode, createSession, eventsSince, getDb, getSession, getSettings, listChatSessions, listSessions, setSettings, updateCustomMode, updateSession } = await import("../dist/db.js");
const { SESSION_ROOT, sessions } = await import("../dist/session-manager.js");
setSettings({ ...getSettings(), provider: "fake", model: "m" });

/** Two server halves in the portal's process, each keeping its portal, and what each heard of the chats. */
globalThis.portals = {};
globalThis.heard = [];
function half(name) {
  const dir = path.join(home, "packages", name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "server.js");
  writeFileSync(file, `export default function (portal) {
  globalThis.portals[${JSON.stringify(name)}] = portal;
  portal.chats.on("deleted", (id) => globalThis.heard.push(${JSON.stringify(name)} + " " + id));
}
`);
  return { name, version: "1.0.0", file, rev: `${statSync(file).size}` };
}
// A third half offers a mode that asks the person first, for what a child may be put in.
const moded = (() => {
  const dir = path.join(home, "packages", "moded");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "server.js");
  writeFileSync(file, `export default function (portal) {
  portal.modes.provide({ id: "focus", label: "Focus mode", description: "Asks first.", confirm: "Focus mode works with fewer checks." });
}
`);
  return { name: "moded", version: "1.0.0", file, rev: `${statSync(file).size}` };
})();
await host.syncServerHalves([half("helper"), half("other"), moded]);
const helper = globalThis.portals.helper;
const other = globalThis.portals.other;
test.after(async () => {
  letGo();
  for (const id of [...sessions.live.keys()]) await sessions.stop(id);
  await host.stopServerHalves();
  getDb().close();
});

let count = 0;
function chat(extra = {}) {
  const id = `chat${++count}`;
  createSession({ id, title: id, workspace: process.env.WORKSPACE_ROOT, executor: "host", kind: "task", ...extra });
  return id;
}

async function until(check, what) {
  for (let i = 0; i < 1500; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test("a server half makes a child chat in its parent's folder; one made unlisted is out of the chat lists and found by its id", () => {
  const parent = chat();
  const hidden = helper.chats.create({ parent, title: "  Look it\nup  ", listed: false });
  assert.deepEqual(hidden, { id: hidden.id, title: "Look it up", workspace: process.env.WORKSPACE_ROOT, status: "idle", parent, listed: false });
  const row = getSession(hidden.id);
  assert.deepEqual([row.kind, row.parent_id, row.listed, row.creator, row.executor], ["task", parent, 0, "helper", "host"]);
  const ids = (rows) => rows.map((one) => one.id);
  assert.ok(!ids(listChatSessions()).includes(hidden.id), "not in the chat list");
  assert.ok(!ids(listSessions()).includes(hidden.id));
  assert.ok(!ids(helper.chats.list()).includes(hidden.id));
  assert.deepEqual(helper.chats.get(hidden.id), hidden, "found by its id");

  const shown = helper.chats.create({ parent, title: "Write it down" });
  assert.equal(shown.listed, true, "listed unless said");
  assert.ok(ids(listChatSessions()).includes(shown.id), "in the chat list");
  assert.equal(helper.chats.list().find((one) => one.id === shown.id).parent, parent, "with its parent");
  assert.ok(ids(listChatSessions()).includes(parent));
  assert.equal(helper.chats.get(parent).parent, undefined, "a chat of its own has none");
});

test("a child of a child is refused, and so is a parent that is not there, a child with no title, and a model that is not one", () => {
  const parent = chat();
  const child = helper.chats.create({ parent, title: "First" });
  assert.throws(() => helper.chats.create({ parent: child.id, title: "Second" }), /cannot have children of its own/);
  assert.throws(() => helper.chats.create({ parent: "nowhere", title: "Lost" }), /There is no chat nowhere/);
  assert.throws(() => helper.chats.create({ parent, title: " \n " }), /needs a title/);
  assert.throws(() => helper.chats.create({ parent, title: "Odd", model: { provider: "fake" } }), /provider and an id/);
  assert.throws(() => helper.chats.create({ parent, title: "Odd", mode: "nonsense" }), /no mode "nonsense"/);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM sessions WHERE parent_id = ?").get(parent).n, 1, "nothing else was made");
});

test("a child takes its parent's role, last speaker, model and tool switches; the mode and model it is asked for; and no mode a colleague's chat may not have", () => {
  const parent = chat();
  updateSession(parent, { provider: "fake", model: "m", thinking_level: "high" });
  getDb().prepare("UPDATE sessions SET tools_off = 'bash', tools_on = 'web_search' WHERE id = ?").run(parent);
  const plain = getSession(helper.chats.create({ parent, title: "Plain" }).id);
  assert.deepEqual(
    [plain.role, plain.provider, plain.model, plain.thinking_level, plain.tools_off, plain.tools_on, plain.mode],
    ["primary", "fake", "m", "high", "bash", "web_search", null],
  );
  const coded = helper.chats.create({ parent, title: "Coded", mode: "code", model: { provider: "other", id: "big" } });
  assert.equal(coded.mode, "code");
  assert.deepEqual([getSession(coded.id).provider, getSession(coded.id).model], ["other", "big"]);
  assert.equal(helper.chats.create({ parent, title: "Standard", mode: "standard" }).mode, undefined);

  const theirs = chat();
  getDb().prepare("UPDATE sessions SET role = 'colleague', last_person_key = 'tg:7' WHERE id = ?").run(theirs);
  const child = getSession(helper.chats.create({ parent: theirs, title: "Theirs" }).id);
  assert.deepEqual([child.role, child.last_person_key], ["colleague", "tg:7"]);
  assert.throws(() => helper.chats.create({ parent: theirs, title: "Coded", mode: "code" }), /no mode "code"/);
});

test("prompt resolves with the child's last answer once its run is over, sent as the person its parent last heard from", async () => {
  const parent = chat();
  sessions.setSpeaker(parent, { key: "tg:9", name: "Sam", role: "colleague" });
  const child = helper.chats.create({ parent, title: "Ask" });
  const run = await helper.chats.prompt(child.id, "Answer the question");
  assert.deepEqual(run, { status: "done", answer: "The answer is 42." });
  assert.equal(getSession(child.id).status, "idle");
  assert.equal(sessions.speakerRole(child.id), "colleague", "held to the person who asked");
  assert.equal(getSession(child.id).role, "colleague", "and it stays as low as that");
  assert.deepEqual(
    eventsSince(child.id).filter((e) => e.type === "portal_prompt").map((e) => JSON.parse(e.payload).message),
    ["Answer the question"],
    "in its own transcript",
  );
  assert.equal(eventsSince(parent).length, 0, "and nothing of it in its parent's");
});

test("a steer reaches a running child, and both prompts resolve with the run's last answer; while it runs it is its parent's background work", async () => {
  const parent = chat();
  const child = helper.chats.create({ parent, title: "Long one" });
  const asked = model.requests.length;
  const first = helper.chats.prompt(child.id, "Hold on a while");
  await until(() => held.length === 1, "the child's run to be held at the model");
  assert.equal(sessions.backgroundWork(parent), true, "its parent's pi is held while it works");
  const steer = helper.chats.prompt(child.id, "and mind the kites", { steer: true });
  await until(() => eventsSince(child.id).some((e) => e.type === "portal_prompt" && JSON.parse(e.payload).steer), "the steer to wait in the run");
  letGo();
  assert.deepEqual(await steer, { status: "done", answer: "Kites noted." });
  assert.deepEqual(await first, { status: "done", answer: "Kites noted." });
  assert.match(JSON.stringify(model.requests.slice(asked).at(-1).messages), /mind the kites/, "the model read it in the same run");
  assert.equal(sessions.backgroundWork(parent), false);
});

test("abort stops a child's run, and its prompt resolves as stopped", async () => {
  const parent = chat();
  const child = helper.chats.create({ parent, title: "Stopped one" });
  const run = helper.chats.prompt(child.id, "Hold this");
  await until(() => held.length === 1, "the child's run to be held at the model");
  await helper.chats.abort(child.id);
  const ended = await run;
  assert.equal(ended.status, "stopped");
  assert.equal(getSession(child.id).status, "idle");
  letGo();
});

test("deleting the parent deletes its children, their transcripts and files, and the server halves hear each deleted", async () => {
  const parent = chat();
  const child = helper.chats.create({ parent, title: "Goes with it", listed: false });
  const kept = chat();
  assert.equal((await helper.chats.prompt(child.id, "Answer this")).status, "done");
  assert.ok(eventsSince(child.id).length > 0);
  assert.ok(existsSync(path.join(SESSION_ROOT, child.id)), "its pi kept its conversation");
  globalThis.heard.length = 0;
  await sessions.deleteChat(parent);
  assert.equal(getSession(parent), undefined);
  assert.equal(getSession(child.id), undefined, "the child is gone");
  assert.equal(eventsSince(child.id).length, 0, "and its transcript");
  assert.equal(existsSync(path.join(SESSION_ROOT, child.id)), false, "and pi's files of it");
  assert.equal(sessions.isLoaded(child.id), false, "and its pi");
  assert.ok(getSession(kept), "another chat stays");
  assert.deepEqual(globalThis.heard.filter((one) => one.startsWith("helper ")).sort(), [`helper ${child.id}`, `helper ${parent}`].sort());
});

test("a child running as its parent is deleted is stopped first, and its prompt resolves as stopped", async () => {
  const parent = chat();
  const child = helper.chats.create({ parent, title: "Busy" });
  const run = helper.chats.prompt(child.id, "Hold it");
  await until(() => held.length === 1, "the child's run to be held at the model");
  await sessions.deleteChat(parent);
  assert.equal((await run).status, "stopped");
  assert.equal(getSession(child.id), undefined);
  letGo();
});

test("only the package that made a child prompts, stops or removes it, and none of that is done to a chat of its own", async () => {
  const parent = chat();
  const child = helper.chats.create({ parent, title: "Mine" });
  await assert.rejects(other.chats.remove(child.id), /made by another package/);
  await assert.rejects(other.chats.prompt(child.id, "Answer"), /made by another package/);
  await assert.rejects(other.chats.abort(child.id), /made by another package/);
  await assert.rejects(helper.chats.prompt(parent, "Answer"), /is no child chat/);
  await assert.rejects(helper.chats.remove(parent), /is no child chat/);
  assert.ok(getSession(child.id), "still there");
  globalThis.heard.length = 0;
  await helper.chats.remove(child.id);
  assert.equal(getSession(child.id), undefined);
  assert.ok(getSession(parent), "its parent stays");
  assert.ok(globalThis.heard.includes(`other ${child.id}`), "every half hears it was deleted");
});

test("a child cannot be made of a chat that is being deleted", async () => {
  const parent = chat();
  const deleting = sessions.discard(parent);
  assert.throws(() => helper.chats.create({ parent, title: "Too late" }), /being deleted/);
  await deleting;
  sessions.reopen([parent]);
  assert.equal(helper.chats.create({ parent, title: "In time" }).parent, parent);
});

test("a child the last portal left running is marked interrupted on the next start, as any chat is", () => {
  const parent = chat();
  const child = helper.chats.create({ parent, title: "Cut off" });
  updateSession(child.id, { status: "running" });
  sessions.recoverOrphans();
  assert.equal(getSession(child.id).status, "interrupted");
});

/** The names of the tools a request declared to the model. */
const declared = (request) => (request.tools ?? []).map((t) => t.function?.name ?? t.name);

test("a child of a heartbeat is refused: the heartbeat is held to reading by a role its row does not carry", () => {
  const heartbeat = chat({ kind: "heartbeat" });
  assert.throws(() => helper.chats.create({ parent: heartbeat, title: "Sneaky" }), /heartbeat cannot have child chats/);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM sessions WHERE parent_id = ?").get(heartbeat).n, 0);
});

test("a child asks, and opens dialogs, only where its parent's people can answer: not for a channel conversation or a routine run", async () => {
  const asks = async (id) => (await sessions.getTools(id)).tools.some((tool) => tool.name === "ask_question");
  const plain = helper.chats.create({ parent: chat(), title: "On the page" });
  assert.equal(await asks(plain.id), true, "a chat of the person's pages asks");
  const viaChannel = helper.chats.create({ parent: chat({ kind: "agent", channel_slug: "telegram", channel_key: "42" }), title: "From a channel" });
  assert.equal(await asks(viaChannel.id), false, "nobody answers on /s/<child> for a conversation on a channel");
  const routine = helper.chats.create({ parent: chat({ kind: "routine", routine_slug: "nightly" }), title: "From a routine" });
  assert.equal(await asks(routine.id), false, "nor for a routine run");
  const agentPage = helper.chats.create({ parent: chat({ kind: "agent" }), title: "From the agent's page" });
  assert.equal(await asks(agentPage.id), true, "the agent's own page is the person's");
  // And no mode is offered where the person cannot say yes to it.
  assert.throws(() => helper.chats.create({ parent: chat({ kind: "agent", channel_slug: "telegram", channel_key: "43" }), title: "Moded", mode: "code" }), /no mode "code"/);
});

test("prompts with the same words are told apart by the line each was recorded as, not found by their words", async () => {
  const child = helper.chats.create({ parent: chat(), title: "Twins" });
  const row = (type, payload) => sessions.record(child.id, type, payload);
  const prompt = sessions.prompt;
  // Another caller's message with the same words is recorded first, and its run ends before this one's is taken in.
  sessions.prompt = async (id, message, options) => {
    row("portal_prompt", { message });
    const mine = row("portal_prompt", { message, queued: true });
    options.onRecorded(mine.seq, true);
    row("message_end", { message: { role: "assistant", content: [{ type: "text", text: "the other's answer" }] } });
    row("portal_status", { status: "idle" });
    setTimeout(() => {
      row("portal_taken", { seq: mine.seq });
      row("message_end", { message: { role: "assistant", content: [{ type: "text", text: "my answer" }] } });
      row("portal_status", { status: "idle" });
    }, 20);
    return true;
  };
  try {
    assert.deepEqual(await helper.chats.prompt(child.id, "same words"), { status: "done", answer: "my answer" });
  } finally {
    sessions.prompt = prompt;
  }
});

test("a child takes its parent's mode unless it is asked into another, and its pi is started in it", async () => {
  const parent = chat();
  updateSession(parent, { mode: "code" });
  const inherited = helper.chats.create({ parent, title: "Same mode" });
  assert.equal(inherited.mode, "code");
  assert.equal(helper.chats.create({ parent, title: "Standard", mode: "standard" }).mode, undefined, "asked for Standard, it is in none");
  const asked = model.requests.length;
  assert.equal((await helper.chats.prompt(inherited.id, "Answer please")).status, "done");
  const tools = declared(model.requests[asked]);
  assert.ok(tools.includes("codemode"), "the code tool is declared");
  assert.ok(!tools.includes("bash"), "and the chat's own tools are behind it");
});

test("a mode that asks the person first is for a child only where its parent is in it; a mode with a model gives it to the child", () => {
  const parent = chat();
  assert.throws(() => helper.chats.create({ parent, title: "Focus", mode: "moded/focus" }), /asks the person first/);
  const focused = chat();
  updateSession(focused, { mode: "moded/focus" });
  assert.equal(helper.chats.create({ parent: focused, title: "Focus", mode: "moded/focus" }).mode, "moded/focus");

  const mine = createCustomMode({ label: "Careful", description: "Thinks a lot" });
  updateCustomMode(mine.id, { provider: "fake", model: "careful", thinking_level: "high" });
  const careful = `custom/${mine.id}`;
  updateSession(parent, { provider: "fake", model: "m", thinking_level: "low" });
  const fromMode = getSession(helper.chats.create({ parent, title: "Careful", mode: careful }).id);
  assert.deepEqual([fromMode.mode, fromMode.provider, fromMode.model, fromMode.thinking_level], [careful, "fake", "careful", "high"], "its mode's model and effort, over its parent's");
  const given = getSession(helper.chats.create({ parent, title: "Given", mode: careful, model: { provider: "other", id: "big" } }).id);
  assert.deepEqual([given.provider, given.model, given.thinking_level], ["other", "big", "high"], "a model it is given, over its mode's");
});

test("a command a child's speaker may not run resolves as an error, not as done", async () => {
  const parent = chat();
  getDb().prepare("UPDATE sessions SET role = 'colleague', last_person_key = 'tg:7' WHERE id = ?").run(parent);
  const child = helper.chats.create({ parent, title: "Theirs" });
  const run = await helper.chats.prompt(child.id, "/compact");
  assert.equal(run.status, "error");
  assert.match(run.error, /primary user/);
});

test("children finds the ones a package made, listed or not, and no other's", () => {
  const parent = chat();
  const elsewhere = chat();
  const shown = helper.chats.create({ parent, title: "Shown" });
  const hidden = helper.chats.create({ parent, title: "Hidden", listed: false });
  other.chats.create({ parent, title: "Theirs" });
  helper.chats.create({ parent: elsewhere, title: "Elsewhere" });
  assert.deepEqual(helper.chats.children(parent).map((one) => one.id), [shown.id, hidden.id]);
  assert.deepEqual(helper.chats.children("nowhere"), []);
});

test("a child removed as its parent is deleted is deleted, and heard so, once", async () => {
  const parent = chat();
  const child = helper.chats.create({ parent, title: "Twice" });
  const run = helper.chats.prompt(child.id, "Hold it");
  await until(() => held.length === 1, "the child's run to be held at the model");
  globalThis.heard.length = 0;
  const deleting = sessions.deleteChat(parent);
  // The parent's delete has the child; the half's own is refused rather than racing it.
  await assert.rejects(helper.chats.remove(child.id), /being deleted/);
  await deleting;
  assert.equal((await run).status, "stopped");
  assert.equal(getSession(child.id), undefined);
  assert.deepEqual(globalThis.heard.filter((one) => one.startsWith("helper ")).sort(), [`helper ${child.id}`, `helper ${parent}`].sort());
  letGo();
});

test("a child's delete that is under way as its parent's begins is heard once too", async () => {
  const parent = chat();
  const child = helper.chats.create({ parent, title: "Under way" });
  const run = helper.chats.prompt(child.id, "Hold it");
  await until(() => held.length === 1, "the child's run to be held at the model");
  globalThis.heard.length = 0;
  const removing = helper.chats.remove(child.id);
  const deleting = sessions.deleteChat(parent);
  await Promise.all([removing, deleting]);
  assert.equal((await run).status, "stopped");
  assert.deepEqual(globalThis.heard.filter((one) => one.startsWith("helper ")).sort(), [`helper ${child.id}`, `helper ${parent}`].sort());
  letGo();
});
