import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fakeModel, resultsIn } from "./fake-model.mjs";
import { inProcessHome } from "./server-harness.mjs";

/**
 * A chat that is working when the open chats are reloaded (a package installed, switched, a server half's
 * `chats.reload`) takes the change at its next step: between two requests of its run, so a tool installed by one
 * call can be called by the next. Not while a subagent works in the background or an extension holds the chat:
 * then once the run is over.
 */
const home = inProcessHome("pithagoras-reload-step-");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
let script = () => "Done.";
const model = await fakeModel((request) => script(request));
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify(model.models()));
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "m" }));

const host = await import("../dist/extension-host.js");
const { createSession, getSession, getSettings, setSettings } = await import("../dist/db.js");
const { sessions } = await import("../dist/session-manager.js");
setSettings({ ...getSettings(), provider: "fake", model: "m" });
test.after(() => host.stopServerHalves());

/** A package's server half, `server.js` as given, at a revision of its own. */
let revs = 0;
function half(name, code) {
  const dir = path.join(home, "packages", name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "server.js");
  writeFileSync(file, code);
  return { name, version: "1.0.0", file, rev: String(++revs) };
}
/** One that adds a tool to every chat's pi, which answers `done`. */
const withTool = (name, tool) =>
  half(name, `export default function (portal) {
  globalThis[${JSON.stringify(name)}] = portal;
  portal.chats.extend((pi) => pi.registerTool({
    name: ${JSON.stringify(tool)}, label: ${JSON.stringify(tool)}, description: "A tool of ${name}.",
    parameters: { type: "object", properties: {} },
    async execute() { return { content: [{ type: "text", text: "done" }], details: {} }; },
  }));
}
`);

const notes = withTool("notes", "notes_add");
const keeper = withTool("keeper", "keeper_look");
const board = withTool("board", "board_add");
const diary = withTool("diary", "diary_add");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const offered = (request) => (request.tools ?? []).map((t) => t.function.name);
const toolTexts = (request) => request.messages.filter((m) => m.role === "tool").map((m) => (typeof m.content === "string" ? m.content : m.content.map((c) => c.text).join("")));
async function until(ready, what) {
  for (let i = 0; !(await ready()); i++) {
    assert.ok(i < 400, `waited 10 s for ${what}`);
    await sleep(25);
  }
}
/** A chat of its own, with its pi started. */
async function chat(id) {
  const work = mkdtempSync(path.join(process.env.WORKSPACE_ROOT, `${id}-`));
  createSession({ id, title: id, workspace: work, executor: "host" });
  return sessions.ensureClient(id);
}
/** A message, and the requests of the run it started, once it is over. */
async function run(id, message) {
  const first = model.requests.length;
  await sessions.prompt(id, message);
  await until(() => model.requests.length > first && getSession(id).status !== "running", "the run to end");
  return model.requests.slice(first);
}
const hasTool = async (client, name) => (await client.getTools()).some((tool) => tool.name === name);

test("a chat that is working takes an install at its next step, and calls the new tool in the same run", async () => {
  const client = await chat("busy");
  let reloads;
  script = async (request) => {
    if (resultsIn(request) === 0) {
      await host.syncServerHalves([notes]);
      reloads = await sessions.reloadIdle();
      return { name: "bash", args: { command: "echo working" } };
    }
    if (resultsIn(request) === 1) return { name: "notes_add", args: {} };
    return "Done.";
  };
  const [first, second, third] = await run("busy", "Add a note");
  assert.deepEqual(reloads, { reloaded: 0, waiting: 1 }, "counted as waiting");
  assert.ok(!offered(first).includes("notes_add"));
  assert.ok(offered(second).includes("notes_add"), "offered at the next request of the run");
  assert.equal(toolTexts(third).at(-1), "done", "and it ran");
  assert.equal(client.reloadDue, false);
});

test("not while an extension holds the chat: then once the run is over", async () => {
  await host.syncServerHalves([keeper]);
  const client = await chat("held");
  let release;
  script = async (request) => {
    if (resultsIn(request) === 0) {
      release = globalThis.keeper.chats.hold("held");
      await host.syncServerHalves([keeper, board]);
      await sessions.reloadIdle();
      return { name: "bash", args: { command: "echo working" } };
    }
    release();
    return "Done.";
  };
  const [first, second] = await run("held", "Look");
  assert.ok(!offered(first).includes("board_add"));
  assert.ok(!offered(second).includes("board_add"), "not reloaded under the hold");
  await until(() => hasTool(client, "board_add"), "the reload once the run was over");
  assert.equal(client.reloadDue, false);
});

test("not while a subagent works in the background: due until a step can take it", async () => {
  const client = await chat("background");
  let subagents = 1;
  client.subagentsRunning = () => subagents;
  script = async (request) => {
    if (resultsIn(request) === 0) {
      await host.syncServerHalves([keeper, board, diary]);
      await sessions.reloadIdle();
      return { name: "bash", args: { command: "echo working" } };
    }
    return "Done.";
  };
  const [, second] = await run("background", "Go");
  assert.ok(!offered(second).includes("diary_add"), "not reloaded while the subagent works");
  await sleep(200);
  assert.equal(client.reloadDue, true, "nor once the run was over, while it still works");
  assert.equal(await hasTool(client, "diary_add"), false);

  subagents = 0;
  // The conversation holds the first run's call: this run's first request has one result in it.
  script = (request) => (resultsIn(request) === 1 ? { name: "bash", args: { command: "echo again" } } : "Done.");
  const [again, next] = await run("background", "Go on");
  assert.ok(!offered(again).includes("diary_add"));
  assert.ok(offered(next).includes("diary_add"), "at the next step of the next run");
  assert.equal(client.reloadDue, false);
});
