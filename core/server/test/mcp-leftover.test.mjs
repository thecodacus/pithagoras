import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeModel, resultsIn } from "./fake-model.mjs";
import { freePort, inProcessHome, serverEnv, startServer } from "./server-harness.mjs";

/**
 * A portal that came over from pi-mcp-adapter with its `mcp` tool off in the portal-wide default (Settings -> Tools), which
 * meant "no MCP" and which nothing renames. Against the whole server: the MCP tools stay off in the chats that are running
 * when a chat has seen them, the Tools page shows them off, and switching one on is possible there.
 */
const home = inProcessHome("pithagoras-mcp-leftover-");
mkdirSync(path.join(home, "ws"), { recursive: true });
const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));
const started = path.join(home, "starts.log");
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "mcp.json"), JSON.stringify({ mcpServers: { notes: { command: process.execPath, args: [FIXTURE, "notes", "--tools", "ping,echo", "--log", started] } } }));
let script = [];
const model = await fakeModel((request) => script[resultsIn(request)] ?? "Done.");
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify(model.models()));
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "m" }));

const db = await import("../dist/db.js");
// Opened (and migrated) here before the server opens it too: two processes making the schema at once lock each other out.
db.getDb();
db.setToolDefaultsOff(["mcp"]);
let base;
before(async () => {
  ({ base } = await startServer(serverEnv(home, await freePort())));
});
const send = (url, method, body) => fetch(base + url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (url, method = "GET", body) => {
  const res = await send(url, method, body);
  assert.ok(res.ok, `${url}: ${res.status} ${await res.clone().text()}`);
  return res.json();
};
const offered = (request) => (request.tools ?? []).map((t) => t.function.name);
const toolText = (request) => request.messages.filter((m) => m.role === "tool").map((m) => JSON.stringify(m.content)).join("\n");
const starts = () => (readFileSync(started, "utf8").match(/ start notes/g) ?? []).length;

/** A new chat, one message to it, and the first and the last request that carried tools. */
async function chat(calls = []) {
  script = calls;
  const { id } = await json("/api/sessions", "POST", {});
  const first = model.requests.length;
  await json(`/api/sessions/${id}/prompt`, "POST", { message: "Go on" });
  for (let i = 0; i < 600; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (model.requests.length > first && db.getSession(id).status !== "running") break;
  }
  const withTools = model.requests.slice(first).filter((request) => request.tools?.length);
  assert.ok(withTools.length, "the chat asked the model");
  return { id, first: withTools[0], last: withTools.at(-1) };
}
const group = async () => (await json("/api/tools")).tools.filter((t) => t.mcp === "notes");


/** One more message to a chat that is there, and the results of the tools it called. */
async function say(id, calls) {
  script = calls;
  const before = model.requests.length;
  await json(`/api/sessions/${id}/prompt`, "POST", { message: "Again" });
  for (let i = 0; i < 600; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (model.requests.length > before && db.getSession(id).status !== "running") break;
  }
  return model.requests.slice(before).filter((request) => request.tools?.length).at(-1);
}
const notes = async () => (await json("/api/tools")).tools.filter((t) => t.mcp === "notes");

let running;
test("the tools of a server nobody has seen are off in a chat under the leftover entry, and are still off in it once they are seen and its pi is reloaded", async () => {
  // The server is unseen, so lazy: its tools are reached through tool_search, which is how a tool that is on is called.
  const through = (text) => [{ name: "tool_search", args: { action: "call", name: "mcp__notes__echo", args: { text } } }];
  const first = await chat(through("one"));
  assert.deepEqual(offered(first.first).filter((name) => name.startsWith("mcp__")), []);
  assert.doesNotMatch(toolText(first.last), /notes\/echo says/);
  running = first.id;
  assert.equal(db.knownTools().filter((t) => t.mcp === "notes").length, 2, "the portal has seen them now");
  // Settings -> MCP saves reload the idle chats: the chat's pi is made again, and its switches are what they were told.
  const file = path.join(process.env.PI_CODING_AGENT_DIR, "mcp.json");
  const entry = JSON.parse(readFileSync(file, "utf8")).mcpServers.notes;
  const startsBefore = starts();
  assert.equal((await send("/api/mcp/servers/notes", "PUT", { entry: { ...entry }, from: "notes" })).status, 200);
  for (let i = 0; i < 100 && starts() === startsBefore; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(starts() > startsBefore, "the chat was reloaded");
  const again = await say(running, through("two"));
  assert.doesNotMatch(toolText(again), /notes\/echo says/);
});

test("a project's page under the leftover entry shows the MCP tools as off by default, and switching one on stores that one only", async () => {
  const made = await send("/api/projects", "POST", { name: "left" });
  assert.ok(made.ok, await made.clone().text());
  const page = await json("/api/projects/left/tools");
  const mine = page.tools.filter((t) => t.mcp === "notes");
  assert.deepEqual(mine.map((t) => [t.enabled, t.defaultOn]), [[false, false], [false, false]], "off, and not 'default on'");
  assert.ok(["mcp__notes__echo", "mcp__notes__ping"].every((name) => page.off.includes(name)));
  const saved = await json("/api/projects/left/tools", "PUT", { off: page.off.filter((name) => name !== "mcp__notes__echo") });
  assert.ok(!saved.off.includes("mcp__notes__echo") && saved.off.includes("mcp__notes__ping"));
  assert.deepEqual((await json("/api/projects/left/tools")).tools.filter((t) => t.mcp === "notes").map((t) => [t.name, t.enabled]).sort(), [["mcp__notes__echo", true], ["mcp__notes__ping", false]]);
});

test("the Tools page shows the defaults as they are, off, and switching one MCP tool on there is stored and reaches the chats", async () => {
  const page = await json("/api/tools");
  assert.deepEqual(page.tools.filter((t) => t.mcp === "notes").map((t) => t.defaultOn), [false, false]);
  assert.ok(["mcp__notes__echo", "mcp__notes__ping"].every((name) => page.off.includes(name)), "named one by one");
  const wanted = page.off.filter((name) => name !== "mcp__notes__echo");
  const saved = await json("/api/tools", "PUT", { off: wanted });
  assert.ok(!saved.off.includes("mcp__notes__echo") && saved.off.includes("mcp__notes__ping"));
  assert.deepEqual(db.toolDefaultsOff().filter((name) => name.startsWith("mcp")), ["mcp__notes__ping"], "the leftover entry is gone");
  const next = await chat([{ name: "mcp__notes__echo", args: { text: "three" } }, { name: "mcp__notes__ping", args: {} }]);
  assert.deepEqual(offered(next.first).filter((name) => name.startsWith("mcp__")), ["mcp__notes__echo"]);
  assert.match(toolText(next.last), /notes\/echo says .*three/);
  assert.match(toolText(next.last), /not found/, "ping is still off");
  assert.deepEqual((await notes()).map((t) => [t.name, t.defaultOn]).sort(), [["mcp__notes__echo", true], ["mcp__notes__ping", false]]);
});
