import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeModel, resultsIn } from "./fake-model.mjs";
import { freePort, inProcessHome, serverEnv, startServer } from "./server-harness.mjs";

/**
 * An MCP server in real chats against the whole server, as the owner described it: a group of tools like any other, on or
 * off, and Auto, Lazy or Direct. pi connects the server; the portal remembers what a chat saw of its tools, and decides
 * from that, and from the mark, whether the next chat is sent them or finds them through tool_search.
 */
const home = inProcessHome("pithagoras-mcp-chats-");
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
const mark = (marks) => json("/api/tools/marks", "PUT", { marks });
const group = async () => (await json("/api/tools")).tools.filter((t) => t.mcp === "notes");

test("a server nothing has been seen of is lazy: the chat is told of it and finds its tools through tool_search; the chat's tools are then what the portal remembers of it", async () => {
  const ran = await chat([
    { name: "tool_search", args: { action: "search", query: "echo" } },
    { name: "tool_search", args: { action: "call", name: "mcp__notes__echo", args: { text: "first" } } },
  ]);
  assert.deepEqual(offered(ran.first).filter((name) => name.startsWith("mcp__")), [], "not in the model's list");
  assert.ok(offered(ran.first).includes("tool_search"));
  assert.match(JSON.stringify(ran.first), /These tools are not in your list: notes\. Search them with the tool_search tool/);
  assert.match(toolText(ran.last), /notes\/echo says .*first/);
  // What the chat saw of the server once the run was over: its tools are a group on the page, with the size the threshold goes by.
  const seen = await group();
  assert.deepEqual(seen.map((t) => t.name).sort(), ["mcp__notes__echo", "mcp__notes__ping"]);
  assert.ok(seen.every((t) => t.source === "notes" && t.auto === true), "a group like any other: auto");
  assert.ok(db.knownTools().filter((t) => t.mcp === "notes").every((t) => t.tokens > 0));
});

test("Auto: a server that is small is in the model's list, and called by its name", async () => {
  const ran = await chat([{ name: "mcp__notes__echo", args: { text: "second" } }]);
  assert.deepEqual(offered(ran.first).filter((name) => name.startsWith("mcp__")).sort(), ["mcp__notes__echo", "mcp__notes__ping"]);
  assert.doesNotMatch(JSON.stringify(ran.first), /not in your list: notes/);
  assert.match(toolText(ran.last), /notes\/echo says .*second/);
});

test("Lazy and Direct are marks on the server, as on any group, for the chats that start after", async () => {
  await mark({ notes: "lazy" });
  const lazy = await chat([{ name: "tool_search", args: { action: "call", name: "mcp__notes__ping", args: {} } }]);
  assert.deepEqual(offered(lazy.first).filter((name) => name.startsWith("mcp__")), []);
  assert.match(toolText(lazy.last), /notes\/ping says/);
  assert.equal((await group()).every((t) => t.lazy === true && t.mark === "lazy"), true);
  await mark({ notes: "direct" });
  const direct = await chat();
  assert.equal(offered(direct.first).filter((name) => name.startsWith("mcp__")).length, 2);
  await mark({});
});

test("Off: a tool switched off is not offered and not callable; a server whose tools are all off is still connected, so that its tools can be switched on again in the chat that has it", async () => {
  const one = await chat([{ name: "mcp__notes__ping", args: {} }]);
  assert.equal(offered(one.first).includes("mcp__notes__ping"), true);
  await json("/api/tools", "PUT", { off: ["mcp__notes__ping"] });
  const partly = await chat([{ name: "mcp__notes__ping", args: {} }]);
  assert.deepEqual(offered(partly.first).filter((name) => name.startsWith("mcp__")), ["mcp__notes__echo"]);
  assert.match(toolText(partly.last), /not found/);
  await json("/api/tools", "PUT", { off: ["mcp__notes__ping", "mcp__notes__echo"] });
  const none = await chat();
  assert.deepEqual(offered(none.first).filter((name) => name.startsWith("mcp__")), []);
  // The chat is live with every tool of the server off, and the server's tools are in its list: a reload (Settings -> MCP saves
  // reload the idle chats) keeps it so, and switching them on is a switch like any other's.
  const mcpTools = async () => (await json(`/api/sessions/${none.id}/tools`)).tools.filter((t) => t.name.startsWith("mcp__notes__"));
  const settled = async (count) => {
    // The chats are reloaded in the background after the write: until that is done the list is the one of a chat that is starting.
    for (let i = 0; i < 100 && (await mcpTools()).length !== count; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    return mcpTools();
  };
  assert.equal((await json(`/api/sessions/${none.id}/tools`)).live, true);
  assert.deepEqual((await mcpTools()).map((t) => [t.name, t.enabled]).sort(), [["mcp__notes__echo", false], ["mcp__notes__ping", false]]);
  const file = path.join(process.env.PI_CODING_AGENT_DIR, "mcp.json");
  const entry = JSON.parse(readFileSync(file, "utf8")).mcpServers.notes;
  const startsBefore = starts();
  assert.equal((await send("/api/mcp/servers/notes", "PUT", { entry: { ...entry }, from: "notes" })).status, 200);
  // The reload connects the server again: that is how it is known to be done.
  for (let i = 0; i < 100 && starts() === startsBefore; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(starts() > startsBefore, "the chat was reloaded, and its server connected again");
  assert.deepEqual((await settled(2)).map((t) => t.name).sort(), ["mcp__notes__echo", "mcp__notes__ping"], "still listed after the chats were reloaded");
  await json(`/api/sessions/${none.id}/tools`, "PUT", { off: [] });
  assert.deepEqual((await mcpTools()).map((t) => t.enabled), [true, true]);
  script = [{ name: "mcp__notes__ping", args: {} }];
  const before = model.requests.length;
  await json(`/api/sessions/${none.id}/prompt`, "POST", { message: "Again" });
  for (let i = 0; i < 600; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (model.requests.length > before && db.getSession(none.id).status !== "running") break;
  }
  const again = model.requests.slice(before).filter((request) => request.tools?.length);
  assert.ok(offered(again[0]).includes("mcp__notes__ping"), "offered to the model once switched on");
  await json("/api/tools", "PUT", { off: [] });
});

test("a server switched off in Settings -> MCP (enabled: false) is not connected and not listed; switched on again it is", async () => {
  const file = path.join(process.env.PI_CODING_AGENT_DIR, "mcp.json");
  const entry = JSON.parse(readFileSync(file, "utf8")).mcpServers.notes;
  assert.equal((await send("/api/mcp/servers/notes", "PUT", { entry: { ...entry, enabled: false }, from: "notes" })).status, 200);
  assert.deepEqual(await group(), []);
  const before = starts();
  const off = await chat();
  assert.deepEqual(offered(off.first).filter((name) => name.startsWith("mcp__")), []);
  assert.equal(starts(), before);
  assert.equal((await send("/api/mcp/servers/notes", "PUT", { entry, from: "notes" })).status, 200);
  assert.equal((await group()).length, 2);
});

test("a server that does not start stays unseen: it is named as a place to search, and no tool of it is listed", async () => {
  const file = path.join(process.env.PI_CODING_AGENT_DIR, "mcp.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  config.mcpServers.mute = { command: process.execPath, args: ["/nonexistent/server.mjs"] };
  writeFileSync(file, JSON.stringify(config));
  await mark({});
  const unseen = await chat();
  assert.match(JSON.stringify(unseen.first), /not in your list: mute/, "nothing has been seen of it yet");
  const next = await chat();
  assert.match(JSON.stringify(next.first), /not in your list: mute/, "and it still has not been, after a chat has tried it");
  assert.deepEqual((await json("/api/tools")).tools.filter((t) => t.mcp === "mute"), []);
  delete config.mcpServers.mute;
  writeFileSync(file, JSON.stringify(config));
});
