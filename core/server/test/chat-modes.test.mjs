import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import { fakeModel } from "./fake-model.mjs";
import { inProcessHome } from "./server-harness.mjs";

/**
 * Chat modes: which chats may be put in one, that a mode is fixed once the chat has said something, that a change
 * lets a pi that has said nothing go and is held like an edit, and Code mode, whose chats work through the code tool
 * alone (pi's `only` presentation) with every tool that is on in a script's reach. Real pi and the portal's own
 * session manager, with a model that plays the script.
 */
inProcessHome("pithagoras-chat-modes-");
mkdirSync(path.join(process.env.PI_CODING_AGENT_DIR, "extensions"), { recursive: true });
// A tool the portal marks lazy (below): not offered one by one, and reached through the `tools` tool in a Standard chat.
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

const { appendEvent, createSession, getDb, getSession, getSettings, rememberTools, sessionTools, setLazyToolSets, setSessionTools, setSettings, toolExceptions, updateSession } = await import("../dist/db.js");
const { lazyToolEntry } = await import("../dist/tool-policy.js");
const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
const { CodemodeHeld, sessions } = await import("../dist/session-manager.js");
const { modesRouter } = await import("../dist/api/modes.js");
setSettings({ ...getSettings(), provider: "fake", model: "m" });
rememberTools([{ name: "lazy_one", source: "lazy", package: null }]);
setLazyToolSets([lazyToolEntry("lazy_one")]);

/** What each pi was started with; `hold()` keeps the next launch back until it is released. */
const launches = [];
let gate;
const create = SdkPiClient.create.bind(SdkPiClient);
SdkPiClient.create = async (opts) => {
  launches.push(opts);
  await gate?.promise;
  return create(opts);
};
function hold() {
  let release;
  gate = { promise: new Promise((resolve) => (release = resolve)) };
  return () => {
    gate = undefined;
    release();
  };
}

// As server.ts has it: JSON parsed for every route.
const server = express().use(express.json()).use("/api", modesRouter()).listen(0, "127.0.0.1");
await once(server, "listening");
test.after(() => {
  server.close();
  for (const id of [...sessions.live.keys()]) sessions.live.get(id).client.dispose();
});
const base = `http://127.0.0.1:${server.address().port}/api`;
const get = async (id) => {
  const res = await fetch(`${base}/sessions/${id}/modes`);
  return { status: res.status, body: await res.json() };
};
const put = async (id, mode) => {
  const res = await fetch(`${base}/sessions/${id}/modes`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) });
  return { status: res.status, body: await res.json() };
};

let count = 0;
/** A chat of `kind`, a task chat unless said. */
function chat(extra = {}) {
  const id = `modes${++count}`;
  createSession({ id, title: id, workspace: process.env.WORKSPACE_ROOT, executor: "host", kind: "task", ...extra });
  return id;
}
const stored = (id) => getSession(id).mode;

async function until(check, what) {
  for (let i = 0; i < 1500; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** The names of the tools a request declared to the model. */
const declared = (request) => (request.tools ?? []).map((t) => t.function?.name ?? t.name);
/** The description of the code tool in a request. */
const described = (request) => (request.tools ?? []).find((t) => (t.function?.name ?? t.name) === "codemode")?.function?.description ?? "";

/**
 * Sends `message` in the chat with its pi up, and waits for the run to end: the requests it made and the results of
 * the calls in it, the script's own calls among them.
 */
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
const lazyOf = async (id) => (await sessions.getTools(id)).tools.find((t) => t.name === "lazy_one");
const codemodeOf = async (id) => (await sessions.getTools(id)).tools.find((t) => t.name === "codemode");

test("a chat with the person on the portal's pages is offered Standard and Code mode, and no other chat is offered any", async () => {
  const task = chat();
  const page = chat({ kind: "agent", channel_slug: "browser", channel_key: "browser:1" });
  for (const id of [task, page]) {
    assert.deepEqual(await get(id), {
      status: 200,
      body: {
        modes: [
          { id: "standard", label: "Standard mode", description: "The agent as this chat would have it anyway: the tools that Settings → Tools, its agent and its project switch on." },
          { id: "code", label: "Code mode", description: "The model works through one tool: it writes a short JavaScript script that calls the chat's tools, and is given only what the script puts out." },
        ],
      },
    });
  }
  const colleague = chat();
  getDb().prepare("UPDATE sessions SET role = 'colleague' WHERE id = ?").run(colleague);
  const others = [
    chat({ kind: "routine", routine_slug: "nightly" }),
    chat({ kind: "heartbeat" }),
    chat({ kind: "agent", channel_slug: "telegram", channel_key: "telegram:1" }),
    colleague,
  ];
  for (const id of others) {
    assert.deepEqual(await get(id), { status: 200, body: { modes: [] } }, getSession(id).kind);
    assert.deepEqual(await put(id, "code"), {
      status: 409,
      body: { error: "Modes are for the chats you start on the portal's pages, where pi runs in the portal's own process." },
    });
    assert.equal(stored(id), null);
  }
  assert.deepEqual(await get("nobody"), { status: 404, body: { error: "Not found" } });
  assert.deepEqual(await put("nobody", "code"), { status: 404, body: { error: "Not found" } });
  assert.deepEqual(await put(task, "nope"), { status: 400, body: { error: 'There is no mode "nope" for this chat.' } });
  assert.equal(stored(task), null);
});

test("Code mode is stored by its name, and Standard as nothing", async () => {
  const id = chat();
  assert.deepEqual(await put(id, "code"), { status: 200, body: { mode: "code" } });
  assert.equal(stored(id), "code");
  assert.deepEqual(await put(id, "standard"), { status: 200, body: { mode: "standard" } });
  assert.equal(stored(id), null);
});

test("a chat that has said something keeps its mode; one whose every message was removed can choose again", async () => {
  const started = "This chat has started, and its mode is fixed: start a new chat for another one.";
  const prompted = chat();
  const { seq } = appendEvent(prompted, "portal_prompt", { message: "Hello" });
  assert.deepEqual(await put(prompted, "code"), { status: 409, body: { error: started } });
  const commanded = chat();
  appendEvent(commanded, "portal_command", { command: "/compact" });
  assert.deepEqual(await put(commanded, "code"), { status: 409, body: { error: started } });
  assert.deepEqual([stored(prompted), stored(commanded)], [null, null]);

  getDb().prepare("DELETE FROM events WHERE seq = ?").run(seq);
  assert.deepEqual(await put(prompted, "code"), { status: 200, body: { mode: "code" } });

  const running = chat();
  updateSession(running, { status: "running" });
  assert.deepEqual(await put(running, "code"), { status: 409, body: { error: started } });
  assert.equal(stored(running), null);
});

test("asking what a chat may be put in does not start its pi", async () => {
  const id = chat();
  await get(id);
  assert.equal(sessions.isRunning(id), false);
  assert.equal(sessions.isLoaded(id), false);
});

test("a pi that has said nothing is let go, and the next one starts in the mode chosen", async () => {
  const id = chat();
  await sessions.client(id);
  assert.equal(launches.at(-1).codemode, undefined);
  assert.deepEqual(await put(id, "code"), { status: 200, body: { mode: "code" } });
  assert.equal(sessions.isRunning(id), false);
  const { requests } = await say(id, "Hello");
  assert.equal(launches.at(-1).codemode, "only");
  assert.deepEqual(declared(requests[0]), ["codemode"]);
});

test("a change of mode is held like an edit: refused beside one, and a message sent during it starts in the mode chosen", async () => {
  const edited = chat();
  sessions.editing.set(edited, new Promise(() => {}));
  try {
    assert.deepEqual(await put(edited, "code"), { status: 409, body: { error: "This conversation is already being edited." } });
    assert.equal(stored(edited), null);
  } finally {
    sessions.editing.delete(edited);
  }

  const id = chat();
  const release = hold();
  const first = launches.length;
  const starting = sessions.client(id);
  const change = put(id, "code");
  // The change waits for that start, inside the lock; a message that comes now waits for the change.
  await until(() => sessions.editing.has(id), "the change to hold the chat");
  const sent = sessions.prompt(id, "Hello");
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();
  await starting;
  assert.deepEqual(await change, { status: 200, body: { mode: "code" } });
  assert.equal(await sent, true);
  await until(() => getSession(id).status !== "running", "the run to end");
  assert.deepEqual(launches.slice(first).map((opts) => opts.codemode), [undefined, "only"], "the pi let go, and the message's in Code mode");
});

test("in Code mode the code tool is on as the mode's layer, the chat is listed as one that differs, and its own switch cannot turn it off", async () => {
  const id = chat();
  const plain = chat();
  await put(id, "code");
  await sessions.client(id);
  const codemode = await codemodeOf(id);
  assert.deepEqual([codemode.enabled, codemode.defaultOn, codemode.byMode], [true, true, true]);
  // A Standard chat in the same folder that says something about tools, asked first (the newest): what it starts
  // with is not what the Code-mode chat starts with.
  getDb().prepare("UPDATE sessions SET tools_off = 'bash', updated_at = '2099-01-01 00:00:00' WHERE id = ?").run(plain);
  getDb().prepare("UPDATE sessions SET updated_at = '2000-01-01 00:00:00' WHERE id = ?").run(id);
  const differ = toolExceptions(["codemode"]).chats.map((row) => row.id);
  assert.ok(differ.includes(id));
  assert.ok(!differ.includes(plain));
  await assert.rejects(sessions.setTools(id, ["codemode"]), CodemodeHeld);
  assert.deepEqual(sessionTools(id), { off: [], on: [] });
  assert.equal((await codemodeOf(id)).enabled, true);
  assert.ok(!sessions.piOff(id).includes("codemode"), "pi still has it");
});

test("in Code mode only the code tool is declared, and a script reaches a lazy tool, also after a reload; in Standard the lazy tool is behind the tools tool", async () => {
  const id = chat();
  await put(id, "code");
  const ran = globalThis.lazyOneRan ?? 0;
  const { requests, results } = await say(id, SCRIPT);
  for (const name of ["bash", "read", "lazy_one", "tools"]) assert.ok(!declared(requests[0]).includes(name), name);
  assert.ok(declared(requests[0]).includes("codemode"));
  assert.match(described(requests[0]), /lazy_one/, "the code tool's description lists it");
  const call = results.find((r) => r.toolName === "lazy_one");
  assert.ok(call?.parentToolCallId, "the script's call of its own");
  assert.equal(call.isError, false, JSON.stringify(call.result));
  assert.equal(globalThis.lazyOneRan, ran + 1);
  assert.equal((await lazyOf(id)).lazy, undefined, "not called lazy where nothing is");

  // A reload activates every extension tool again: still none of them declared, and the lazy one still in a script's reach.
  await sessions.reloadIdle();
  const again = await say(id, SCRIPT);
  assert.deepEqual(declared(again.requests[0]).filter((name) => name !== "codemode"), []);
  assert.equal(again.results.find((r) => r.toolName === "lazy_one")?.isError, false);
  assert.equal(globalThis.lazyOneRan, ran + 2);

  const plain = chat();
  const standard = await say(plain, "Hello");
  assert.ok(declared(standard.requests[0]).includes("tools"), "the way to the lazy tools");
  assert.ok(!declared(standard.requests[0]).includes("lazy_one"));
  assert.ok(declared(standard.requests[0]).includes("bash"));
  assert.equal((await lazyOf(plain)).lazy, true);
});

test("a chat whose own switches had the code tool off before Code mode was chosen has it on and held, and its switch back in Standard", async () => {
  const id = chat();
  // Switched off in the chat before it was put in the mode, as a chat stores it where a layer under it has it on.
  setSessionTools(id, { off: ["codemode"], on: [] });
  await put(id, "code");
  const codemode = await codemodeOf(id);
  assert.deepEqual([codemode.enabled, codemode.byMode], [true, true]);
  assert.deepEqual(sessionTools(id), { off: [], on: [] }, "the chat's own off does not count");
  assert.ok(toolExceptions(["codemode"]).chats.some((row) => row.id === id), "listed with the code tool on");
  assert.ok(!sessions.piOff(id).includes("codemode"));
  await assert.rejects(sessions.setTools(id, ["codemode", "bash"]), CodemodeHeld);
  assert.equal(getDb().prepare("SELECT tools_off FROM sessions WHERE id = ?").get(id).tools_off, "codemode", "kept, and nothing of the list written");
  // Another switch saved while the mode holds the code tool: the page's list says nothing of it, and the stored off stays.
  await sessions.setTools(id, ["bash"]);
  assert.equal(getDb().prepare("SELECT tools_off FROM sessions WHERE id = ?").get(id).tools_off, "bash\ncodemode");

  // Standard chosen before the first message: the mode holds it no more, and the chat's own off counts again.
  await put(id, "standard");
  assert.deepEqual(sessionTools(id), { off: ["bash", "codemode"], on: [] });
  assert.equal((await codemodeOf(id)).byMode, undefined);

  // In Code mode again, the model is offered the code tool alone.
  await put(id, "code");
  const { requests } = await say(id, "Hello");
  assert.deepEqual(declared(requests[0]), ["codemode"]);
  assert.equal((await lazyOf(id)).lazy, undefined);
});
