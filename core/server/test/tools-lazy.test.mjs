import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fakeModel, resultsIn } from "./fake-model.mjs";
import { freePort, inProcessHome, serverEnv, startServer } from "./server-harness.mjs";

/**
 * Lazy tools (#106): opt-in, for a set or for a single tool. A lazy tool is on like any other, but is
 * not in the model's prompt; the model reaches it through the `tools` tool instead (tools-gateway
 * .test.mjs runs that end to end). Laziness is no switch: it never changes whether a tool is on, and a
 * tool that is off is off for good. Against the whole server: what Settings → Tools reads and writes,
 * what a chat, a project and a later registration make of it, and what a running chat is told. The last
 * test runs real chats against a model that is scripted, to see what the model is sent.
 */
const home = inProcessHome("pithagoras-tools-lazy-");
mkdirSync(path.join(home, "ws", "research"), { recursive: true });
mkdirSync(path.join(process.env.PI_CODING_AGENT_DIR, "extensions"), { recursive: true });
// A tool of an extension, which is neither an MCP server's nor pi's own: the kind that can be lazy.
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "extensions", "probe.ts"), `
const text = (t) => ({ content: [{ type: "text", text: t }], details: {} });
const tool = (name, description) => ({
  name,
  label: name,
  description,
  parameters: { type: "object", properties: { id: { type: "string" } } },
  async execute(_id, p) { return text(name + " ran for " + p.id); },
});
export default function (pi) {
  pi.registerTool(tool("probe_open", "Open a probe by its id."));
  pi.registerTool(tool("probe_read", "Read a probe by its id."));
}
`);
/** What the model does at each request, by how many tool results the conversation holds. */
let script = [];
const model = await fakeModel((request) => script[resultsIn(request)] ?? "Done.");
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify(model.models()));
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "m" }));

const db = await import("../dist/db.js");
const { lazyToolEntry } = await import("../dist/tool-policy.js");
const { sessions } = await import("../dist/session-manager.js");
const heavy = [
  { name: "heavy_open", source: "pi-heavy", package: null },
  { name: "heavy_read", source: "pi-heavy", package: null },
];
const light = [{ name: "web_search", source: "pi-web-access", package: null }];

let base;
before(async () => {
  ({ base } = await startServer(serverEnv(home, await freePort())));
});

const send = (url, method, body) =>
  fetch(base + url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (url, method = "GET", body) => {
  const res = await send(url, method, body);
  assert.ok(res.ok, `${url}: ${res.status} ${await res.clone().text()}`);
  return res.json();
};
const states = (r) => Object.fromEntries(r.tools.map((t) => [t.name, t.enabled]));
/** The tools a page marks as reached through the `tools` tool. */
const lazyOf = (r) => r.tools.filter((t) => t.lazy).map((t) => t.name).sort();

/** The MCP adapter's configuration: the servers there are. */
const writeMcp = (servers) => writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "mcp.json"), JSON.stringify({ mcpServers: servers }));

beforeEach(async () => {
  db.getDb().exec("DELETE FROM settings WHERE key IN ('tools_seen', 'tools_off_default', 'tools_lazy'); DELETE FROM project_tools; DELETE FROM agent_tools; UPDATE routines SET tools_off = '', tools_on = ''");
  writeMcp({});
  db.rememberTools([...heavy, ...light]);
});

test("nothing is lazy until somebody says so: no tool, no set, nothing for a chat to be told", async () => {
  const page = await json("/api/tools");
  assert.deepEqual(page.lazy, []);
  assert.deepEqual(page.off, []);
  assert.deepEqual(lazyOf(page), []);
  const chat = await json("/api/sessions", "POST", {});
  const listed = await json(`/api/sessions/${chat.id}/tools`);
  assert.deepEqual(states(listed), { heavy_open: true, heavy_read: true, web_search: true });
  assert.deepEqual(lazyOf(listed), []);
  assert.deepEqual(sessions.piLazy(sessions.piOff(chat.id)), { tools: [], sets: [] });
  assert.deepEqual(db.lazyToolNames(), new Set());
});

test("a default tool is never lazy: a tool nobody marked is offered one by one, whatever else is marked", async () => {
  const chat = await json("/api/sessions", "POST", {});
  assert.deepEqual(sessions.piLazy(sessions.piOff(chat.id)).tools, []);
  await json("/api/tools/lazy", "PUT", { lazy: ["pi-heavy"] });
  const listed = await json(`/api/sessions/${chat.id}/tools`);
  assert.equal(lazyOf(listed).includes("web_search"), false);
  assert.equal(states(listed).web_search, true);
  assert.deepEqual(sessions.piLazy(sessions.piOff(chat.id)).tools, ["heavy_open", "heavy_read"]);
  assert.deepEqual(db.toolDefaultsOff(), []);
});

test("a lazy set stays on: marking switches nothing, and the other sets are not touched", async () => {
  const done = await json("/api/tools/lazy", "PUT", { lazy: ["pi-heavy"] });
  assert.deepEqual(done.lazy, ["pi-heavy"]);
  assert.equal(done.off, undefined);
  assert.deepEqual(db.toolDefaultsOff(), []);

  const page = await json("/api/tools");
  assert.deepEqual(page.lazy, ["pi-heavy"]);
  assert.deepEqual(Object.fromEntries(page.tools.map((t) => [t.name, t.defaultOn])), { heavy_open: true, heavy_read: true, web_search: true });
  assert.deepEqual(lazyOf(page), ["heavy_open", "heavy_read"]);
  const chat = await json("/api/sessions", "POST", {});
  const listed = await json(`/api/sessions/${chat.id}/tools`);
  assert.deepEqual(states(listed), { heavy_open: true, heavy_read: true, web_search: true });
  assert.deepEqual(lazyOf(listed), ["heavy_open", "heavy_read"]);
  assert.deepEqual(sessions.piLazy(sessions.piOff(chat.id)), { tools: ["heavy_open", "heavy_read"], sets: ["pi-heavy"] });
});

test("a tool that is neither an MCP tool nor built in can be made lazy on its own", async () => {
  // An extension's own tool, like a custom one a user installed: no MCP server, no pi built-in.
  db.rememberTools([{ name: "custom_ping", source: "my-extension", package: null }]);
  const done = await json("/api/tools/lazy", "PUT", { lazy: [lazyToolEntry("custom_ping")] });
  assert.deepEqual(done.lazy, ["<tool>custom_ping"]);
  const chat = await json("/api/sessions", "POST", {});
  const listed = await json(`/api/sessions/${chat.id}/tools`);
  assert.deepEqual(lazyOf(listed), ["custom_ping"]);
  assert.equal(states(listed).custom_ping, true);
  assert.deepEqual(sessions.piLazy([]), { tools: ["custom_ping"], sets: ["my-extension"] });
  // Its set-mates and the rest are untouched.
  assert.deepEqual(lazyOf(await json("/api/tools")), ["custom_ping"]);
  // A tool is marked on its own only: a set of the same name as a tool is not taken for it.
  assert.deepEqual([...db.lazyToolNames()], ["custom_ping"]);
});

test("a chat and a project switch a lazy tool off for themselves, and it is then off for good", async () => {
  await json("/api/tools/lazy", "PUT", { lazy: ["pi-heavy"] });
  const chat = await json("/api/sessions", "POST", {});
  await json(`/api/sessions/${chat.id}/tools`, "PUT", { off: ["heavy_read"] });
  const listed = await json(`/api/sessions/${chat.id}/tools`);
  assert.deepEqual(states(listed), { heavy_open: true, heavy_read: false, web_search: true });
  assert.deepEqual(sessions.piLazy(sessions.piOff(chat.id)), { tools: ["heavy_open"], sets: ["pi-heavy"] });

  // Another chat still has both.
  const other = await json("/api/sessions", "POST", {});
  assert.deepEqual(sessions.piLazy(sessions.piOff(other.id)).tools, ["heavy_open", "heavy_read"]);

  await json("/api/projects/research/tools", "PUT", { off: ["heavy_open", "heavy_read"] });
  const inProject = await json("/api/sessions", "POST", { workspace: "research" });
  assert.deepEqual(sessions.piOff(inProject.id), ["heavy_open", "heavy_read"]);
  assert.deepEqual(sessions.piLazy(sessions.piOff(inProject.id)), { tools: [], sets: [] });
  // Switched on again, and lazy again: the mark is the set's, the switch the project's.
  await json("/api/projects/research/tools", "PUT", { off: [] });
  const again = await json("/api/sessions", "POST", { workspace: "research" });
  assert.deepEqual(sessions.piLazy(sessions.piOff(again.id)).tools, ["heavy_open", "heavy_read"]);
});

test("a tool switched off at any layer stays off for good: the portal-wide default, an agent, a project, a routine, a chat", async () => {
  await json("/api/tools/lazy", "PUT", { lazy: ["pi-heavy"] });
  /** heavy_read is off and no way reaches it; heavy_open, which nobody switched off, is lazy as before. */
  const hardOff = async (id, layer) => {
    const off = sessions.piOff(id);
    assert.ok(off.includes("heavy_read"), `${layer}: off`);
    assert.deepEqual(sessions.piLazy(off), { tools: ["heavy_open"], sets: ["pi-heavy"] }, `${layer}: the gateway is told of the other one only`);
    const listed = await json(`/api/sessions/${id}/tools`);
    assert.equal(states(listed).heavy_read, false, `${layer}: the page shows it off`);
    assert.equal(states(listed).heavy_open, true, `${layer}: and the other on`);
  };
  const chat = async (body = {}) => (await json("/api/sessions", "POST", body)).id;

  await json("/api/tools", "PUT", { off: ["heavy_read"] });
  await hardOff(await chat(), "portal-wide default");
  await json("/api/tools", "PUT", { off: [] });

  const agent = await json("/api/agents", "POST", { name: "Reader" });
  await json(`/api/agents/${agent.id}/tools`, "PUT", { off: ["heavy_read"] });
  await hardOff(await chat({ agent: agent.id }), "agent");

  await json("/api/projects/research/tools", "PUT", { off: ["heavy_read"] });
  await hardOff(await chat({ workspace: "research" }), "project");

  const routine = await json("/api/routines", "POST", { name: "Digest", schedule: "0 9 * * *", instructions: "Do it" });
  await json(`/api/routines/${routine.id}/tools`, "PUT", { off: ["heavy_read"] });
  const run = `run-${routine.slug}`;
  db.createSession({ id: run, title: routine.name, workspace: db.getSession(await chat()).workspace, executor: "host", kind: "routine", routine_slug: routine.slug });
  await hardOff(run, "routine");

  const own = await chat();
  await json(`/api/sessions/${own}/tools`, "PUT", { off: ["heavy_read"] });
  await hardOff(own, "chat");
});

test("a tool switched off in the default is off for good: lazy does not bring it back", async () => {
  await json("/api/tools", "PUT", { off: ["heavy_read"] });
  await json("/api/tools/lazy", "PUT", { lazy: ["pi-heavy"] });
  const chat = await json("/api/sessions", "POST", {});
  assert.deepEqual(sessions.piOff(chat.id), ["heavy_read"]);
  assert.deepEqual(sessions.piLazy(sessions.piOff(chat.id)), { tools: ["heavy_open"], sets: ["pi-heavy"] });
  assert.deepEqual(db.toolDefaultsOff(), ["heavy_read"]);
});

test("a running chat is told what is off and which of the rest is lazy, and a tool it switched off is not among them", async () => {
  const told = [];
  const chat = await json("/api/sessions", "POST", {});
  sessions.live.set(chat.id, {
    client: {
      getTools: async () => [...heavy, ...light].map((t) => ({ name: t.name, source: t.source, enabled: true })),
      setToolsOff: async (off, lazy) => { told.push({ off, lazy }); },
    },
  });
  try {
    db.setLazyToolSets(["pi-heavy"]);
    await sessions.applyToolDefaults();
    assert.deepEqual(told.at(-1), { off: [], lazy: { tools: ["heavy_open", "heavy_read"], sets: ["pi-heavy"] } });

    // heavy_read is off by the chat's own say-so: off for good, and the gateway is no way round that.
    await sessions.setTools(chat.id, ["web_search", "heavy_read"]);
    assert.deepEqual(told.at(-1), { off: ["heavy_read", "web_search"], lazy: { tools: ["heavy_open"], sets: ["pi-heavy"] } });

    // A set that stops being lazy is offered one by one again.
    db.setLazyToolSets([]);
    await sessions.applyToolDefaults();
    assert.deepEqual(told.at(-1), { off: ["heavy_read", "web_search"], lazy: { tools: [], sets: [] } });
  } finally {
    sessions.live.delete(chat.id);
  }
});

test("a mark cannot name an MCP server's tools or pi's built-in tools: the first are lazy by their server's own setting, the others are always offered", async () => {
  writeMcp({ notes: {} });
  db.rememberTools([
    { name: "notes_read", source: "pi-mcp-adapter", package: null },
    { name: "mcp", source: "pi-mcp-adapter", package: null },
    { name: "bash", source: "built in", package: null },
    { name: "read", source: "built in", package: null },
  ]);
  for (const mark of ["notes", "built in", "pi-mcp-adapter", lazyToolEntry("notes_read"), lazyToolEntry("mcp"), lazyToolEntry("bash")]) {
    const res = await send("/api/tools/lazy", "PUT", { lazy: [mark] });
    assert.equal(res.status, 400, `${mark} is refused`);
    assert.equal((await res.json()).code, "lazy-refused");
  }
  // A server that is configured but has no tool seen yet is refused by its name too.
  writeMcp({ notes: {}, wiki: {} });
  assert.equal((await send("/api/tools/lazy", "PUT", { lazy: ["wiki"] })).status, 400);
  // Mixed with a mark that is fine, the whole request is refused and nothing is stored.
  assert.equal((await send("/api/tools/lazy", "PUT", { lazy: ["pi-heavy", "notes"] })).status, 400);
  assert.deepEqual(db.lazyToolSets(), []);

  // A mark that got in some other way (the database, an older portal) names tools that are not lazy.
  db.setLazyToolSets(["notes", "built in", lazyToolEntry("bash"), "pi-heavy"]);
  assert.deepEqual([...db.lazyToolNames()].sort(), ["heavy_open", "heavy_read"]);
  const chat = await json("/api/sessions", "POST", {});
  // The portal's own gateway has nothing of the server's: the adapter's `mcp` tool does that. The lists say it is lazy all the same.
  assert.deepEqual(sessions.piLazy(sessions.piOff(chat.id)), { tools: ["heavy_open", "heavy_read"], sets: ["pi-heavy"] });
  assert.deepEqual(lazyOf(await json(`/api/sessions/${chat.id}/tools`)), ["heavy_open", "heavy_read", "notes_read"]);
  // And such a mark does not stand in the way of an unrelated change to the list.
  const kept = await json("/api/tools/lazy", "PUT", { lazy: ["notes", "built in", "pi-heavy", "pi-web-access"] });
  assert.deepEqual(kept.lazy, ["built in", "notes", "pi-heavy", "pi-web-access"]);
});

test("pi's built-in tools stay out of reach of lazy when the sandbox registers them again under its own name", async () => {
  // Before the portal has seen one, the name alone tells it.
  assert.equal((await send("/api/tools/lazy", "PUT", { lazy: [lazyToolEntry("ls")] })).status, 400);
  // With the sandbox on, its inline extension brings bash, read and the rest once more, so pi files them under "sandbox", not "built in".
  const sandboxed = ["bash", "read", "write", "edit", "ls", "grep", "find"].map((name) => ({ name, source: "sandbox", package: null, inline: true }));
  db.rememberTools(sandboxed);
  // And an extension of the user's that overrides one under its own name.
  db.rememberTools([{ name: "write", source: "my-extension", package: null }]);
  db.rememberTools([{ name: "custom_ping", source: "my-extension", package: null }]);
  for (const tool of sandboxed) assert.equal(db.lazyAllowed(tool), false, `${tool.name} is built in, whoever registers it`);
  assert.equal(db.lazyAllowed({ name: "custom_ping", source: "my-extension", package: null }), true);

  for (const mark of ["sandbox", lazyToolEntry("bash"), lazyToolEntry("read")]) {
    const res = await send("/api/tools/lazy", "PUT", { lazy: [mark] });
    assert.equal(res.status, 400, `${mark} is refused`);
    assert.equal((await res.json()).code, "lazy-refused");
  }
  assert.deepEqual(db.lazyToolSets(), []);

  // A mark that got in some other way does nothing to them, and the page offers no mark for them.
  db.setLazyToolSets(["sandbox", "my-extension", lazyToolEntry("bash")]);
  assert.deepEqual([...db.lazyToolNames()], ["custom_ping"]);
  const page = await json("/api/tools");
  assert.deepEqual(lazyOf(page), ["custom_ping"]);
  assert.deepEqual(page.tools.filter((t) => t.noLazy).map((t) => t.name).sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
  const chat = await json("/api/sessions", "POST", {});
  const listed = await json(`/api/sessions/${chat.id}/tools`);
  assert.deepEqual(lazyOf(listed), ["custom_ping"]);
  assert.deepEqual(sessions.piLazy(sessions.piOff(chat.id)).tools, ["custom_ping"]);
});

test("a tool the portal registers itself can be lazy, on its own and with the rest of its set", async () => {
  // The portal's own routine tools: an inline extension's tool under any other name is a server half's, listed only
  // while its package is switched on (extension-tools-switched.test.mjs).
  db.rememberTools([
    { name: "routines_list", source: "routines", package: null, inline: true },
    { name: "routine_run", source: "routines", package: null, inline: true },
  ]);
  assert.equal(db.lazyAllowed({ name: "routine_run", source: "routines", package: null, inline: true }), true);
  // On its own, and with its set: the mark is taken.
  assert.deepEqual((await json("/api/tools/lazy", "PUT", { lazy: [lazyToolEntry("routine_run")] })).lazy, ["<tool>routine_run"]);
  assert.deepEqual([...db.lazyToolNames()], ["routine_run"]);
  assert.deepEqual((await json("/api/tools/lazy", "PUT", { lazy: ["routines"] })).lazy, ["routines"]);
  assert.deepEqual([...db.lazyToolNames()].sort(), ["routine_run", "routines_list"]);
  const page = await json("/api/tools");
  assert.deepEqual(lazyOf(page), ["routine_run", "routines_list"]);
  assert.deepEqual(page.tools.filter((t) => t.noLazy).map((t) => t.name), []);
  const chat = await json("/api/sessions", "POST", {});
  assert.deepEqual(sessions.piLazy(sessions.piOff(chat.id)).tools, ["routine_run", "routines_list"]);
});

const adapter = (...names) => names.map((name) => ({ name, source: "pi-mcp-adapter", package: null }));
/** The MCP adapter's configuration as written, and read back. */
const mcpFileOf = () => JSON.parse(readFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "mcp.json"), "utf8"));

test("an MCP server's tools are lazy unless the server registers them directly: the setting is the server's, and a mark cannot name it", async () => {
  writeMcp({
    notes: { command: "n" },
    // As Understory's extension writes it: its tools registered directly.
    understory: { url: "http://localhost:3800/mcp", lifecycle: "lazy", directTools: true },
    wiki: { command: "w", directTools: ["page"] },
    legacy: { command: "l", directTools: false },
  });
  db.rememberTools(adapter("notes_read", "understory_memory_recall", "wiki_page", "wiki_edit", "legacy_ping"));
  const page = await json("/api/tools");
  // The adapter's default is the proxy: lazy. Understory, written with its tools registered, stays as it was.
  assert.deepEqual(lazyOf(page), ["legacy_ping", "notes_read", "wiki_edit"]);
  assert.deepEqual(Object.fromEntries(page.tools.filter((t) => t.mcp).map((t) => [t.name, t.mcp])), {
    notes_read: "notes", understory_memory_recall: "understory", wiki_page: "wiki", wiki_edit: "wiki", legacy_ping: "legacy",
  });
  assert.deepEqual(page.tools.filter((t) => t.noLazy).map((t) => t.name), [], "an MCP server's tool has a lazy state; the adapter's own tools are not in this list");
  // A chat is shown the same, and so is a project's list.
  const chat = await json("/api/sessions", "POST", {});
  assert.deepEqual(lazyOf(await json(`/api/sessions/${chat.id}/tools`)), ["legacy_ping", "notes_read", "wiki_edit"]);
  assert.deepEqual(lazyOf(await json("/api/projects/research/tools")), ["legacy_ping", "notes_read", "wiki_edit"]);
  // The portal's own gateway has none of them: they are reached through the adapter's `mcp` tool, and nothing is marked.
  assert.deepEqual(sessions.piLazy(sessions.piOff(chat.id)), { tools: [], sets: [] });
  assert.deepEqual(page.lazy, []);
  assert.equal((await send("/api/tools/lazy", "PUT", { lazy: ["notes"] })).status, 400, "the server's own setting is the one switch");
  // The adapter-wide setting is the default of a server that says nothing, and a server's own word wins.
  writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "mcp.json"), JSON.stringify({ settings: { directTools: true }, mcpServers: { notes: { command: "n" }, legacy: { command: "l", directTools: false } } }));
  assert.deepEqual(lazyOf(await json("/api/tools")), ["legacy_ping"]);
});

test("Register tools directly of an MCP server is what makes its tools lazy: one setting, changed from the Tools page", async () => {
  const entry = { command: "n", env: { KEEP: "this" } };
  writeMcp({ notes: entry, other: { command: "o" } });
  db.rememberTools(adapter("notes_read", "other_ping"));
  const direct = (name, body) => send(`/api/mcp/servers/${name}/direct`, "PUT", body);
  assert.deepEqual(lazyOf(await json("/api/tools")), ["notes_read", "other_ping"]);

  assert.equal((await direct("notes", { direct: true })).status, 200);
  assert.deepEqual(mcpFileOf().mcpServers.notes, { ...entry, directTools: true }, "only that key changed");
  assert.deepEqual(mcpFileOf().mcpServers.other, { command: "o" });
  assert.deepEqual(lazyOf(await json("/api/tools")), ["other_ping"]);

  assert.equal((await direct("notes", { direct: false })).status, 200);
  assert.deepEqual(mcpFileOf().mcpServers.notes, entry, "lazy is no key at all: the adapter's default");
  assert.deepEqual(lazyOf(await json("/api/tools")), ["notes_read", "other_ping"]);

  // Where the adapter-wide setting registers tools directly, lazy has to say no to it.
  writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "mcp.json"), JSON.stringify({ settings: { directTools: true }, mcpServers: { notes: entry } }));
  assert.deepEqual(lazyOf(await json("/api/tools")), []);
  await direct("notes", { direct: false });
  assert.deepEqual(mcpFileOf().mcpServers.notes, { ...entry, directTools: false });
  assert.deepEqual(mcpFileOf().settings, { directTools: true });
  assert.deepEqual(lazyOf(await json("/api/tools")), ["notes_read"]);

  assert.equal((await direct("nobody", { direct: true })).status, 404);
  assert.equal((await direct("notes", { direct: "yes" })).status, 400);
  assert.equal((await direct("notes", {})).status, 400);
});

test("the page is told which tools cannot be lazy, so it offers no mark for them", async () => {
  writeMcp({ notes: {} });
  db.rememberTools([
    { name: "notes_read", source: "pi-mcp-adapter", package: null },
    { name: "bash", source: "built in", package: null },
    { name: "browser_navigate", source: "pithagoras-browser", package: null, inline: true },
  ]);
  const page = await json("/api/tools");
  // Only pi's own: an MCP server's tool has a lazy state, set on its server.
  assert.deepEqual(page.tools.filter((t) => t.noLazy).map((t) => t.name).sort(), ["bash"]);
  assert.equal(page.tools.find((t) => t.name === "notes_read").mcp, "notes");
});

test("a tool that turns up later in a lazy set is lazy, and the callers are told; one seen before is not new", async () => {
  await json("/api/tools/lazy", "PUT", { lazy: ["pi-heavy"] });
  const arrived = db.rememberTools([...heavy, { name: "heavy_write", source: "pi-heavy", package: null }, { name: "web_fetch", source: "pi-web-access", package: null }]);
  assert.deepEqual(arrived, ["heavy_write"]);
  assert.deepEqual(db.toolDefaultsOff(), []);
  assert.deepEqual([...db.lazyToolNames()].sort(), ["heavy_open", "heavy_read", "heavy_write"]);
  assert.deepEqual(db.rememberTools([...heavy, { name: "heavy_write", source: "pi-heavy", package: null }]), []);
});

test("without the mark a new tool is on and not lazy, as before", async () => {
  assert.deepEqual(db.rememberTools([{ name: "heavy_write", source: "pi-heavy", package: null }]), []);
  assert.deepEqual(db.toolDefaultsOff(), []);
});

test("a server half's tools are not lazy until marked, and are sets that can be", async () => {
  db.rememberTools([
    // Two server halves', filed under their packages' names as the portal files an inline extension's.
    { name: "paint", source: "painter", package: null, inline: true },
    { name: "sketch", source: "painter", package: null, inline: true },
    { name: "browser_navigate", source: "pithagoras-browser", package: null, inline: true },
    { name: "browser_click", source: "pithagoras-browser", package: null, inline: true },
  ]);
  // Nobody has marked them: on and offered one by one, as they always were.
  assert.deepEqual([...db.lazyToolNames()], []);
  assert.deepEqual(sessions.piLazy([]), { tools: [], sets: [] });
  await json("/api/tools/lazy", "PUT", { lazy: ["painter", "pithagoras-browser"] });
  assert.deepEqual([...db.lazyToolNames()].sort(), ["browser_click", "browser_navigate", "paint", "sketch"]);
  assert.deepEqual(db.lazySetLabels(db.lazyToolNames()), ["painter", "pithagoras-browser"]);
  assert.deepEqual(db.toolDefaultsOff(), []);
});

test("a set that stops being lazy is offered one by one again, with its switches as they are", async () => {
  await json("/api/tools/lazy", "PUT", { lazy: ["pi-heavy"] });
  const done = await json("/api/tools/lazy", "PUT", { lazy: [] });
  assert.deepEqual(done.lazy, []);
  assert.deepEqual(lazyOf(await json("/api/tools")), []);
  assert.deepEqual(db.toolDefaultsOff(), []);
});

test("a list that is not strings is refused", async () => {
  const res = await send("/api/tools/lazy", "PUT", { lazy: "pi-heavy" });
  assert.equal(res.status, 400);
});

test("the model of a real chat is sent no lazy tool and no gateway until a tool is lazy, and the hint only then", async () => {
  const offered = (request) => (request.tools ?? []).map((t) => t.function.name);
  const hint = /You have probe tools; search for them with the tools tool\./;
  const toolText = (request) => request.messages.filter((m) => m.role === "tool").map((m) => JSON.stringify(m.content)).join("\n");
  /** One message to the chat; the last request that carried tools, which is the one the model answered. */
  async function ask(id, calls = []) {
    script = calls;
    const first = model.requests.length;
    await json(`/api/sessions/${id}/prompt`, "POST", { message: "Go on" });
    for (let i = 0; i < 400; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (model.requests.length > first && db.getSession(id).status !== "running") break;
    }
    const withTools = model.requests.slice(first).filter((request) => request.tools?.length);
    assert.ok(withTools.length, "the chat asked the model");
    return { first: withTools[0], last: withTools.at(-1) };
  }

  // Nothing marked: every tool of the extension is offered one by one, there is no gateway and no hint.
  const plain = await json("/api/sessions", "POST", {});
  const before = (await ask(plain.id)).first;
  assert.deepEqual(offered(before).filter((name) => name.startsWith("probe_") || name === "tools"), ["probe_open", "probe_read"]);
  assert.doesNotMatch(JSON.stringify(before), /search for them with the tools tool|Search them with the tools tool/);

  // The set is marked while that chat is running: its next request has the gateway and the hint, and not the tools.
  assert.deepEqual((await json("/api/tools/lazy", "PUT", { lazy: ["probe"] })).lazy, ["probe"]);
  const marked = (await ask(plain.id)).first;
  assert.deepEqual(offered(marked).filter((name) => name.startsWith("probe_")), []);
  assert.ok(offered(marked).includes("tools"));
  assert.match(JSON.stringify(marked), hint);
  assert.doesNotMatch(JSON.stringify(marked), /Open a probe by its id/, "their descriptions are not in what the model is sent");
  // A chat that starts now is sent the same.
  const fresh = await json("/api/sessions", "POST", {});
  const started = (await ask(fresh.id, [{ name: "tools", args: { action: "search", query: "probe" } }, { name: "tools", args: { action: "call", name: "probe_open", args: { id: "p1" } } }]));
  assert.deepEqual(offered(started.first).filter((name) => name.startsWith("probe_")), []);
  assert.match(JSON.stringify(started.first), hint);
  // And it reaches them: a search finds them, a call runs the tool.
  assert.match(toolText(started.last), /probe_open: Open a probe by its id\./);
  assert.match(toolText(started.last), /probe_open ran for p1/);

  // A project switches probe_read off: that tool is off for good, and the gateway neither lists nor runs it.
  await json("/api/projects/research/tools", "PUT", { off: ["probe_read"] });
  const project = await json("/api/sessions", "POST", { workspace: "research" });
  const inProject = await ask(project.id, [
    { name: "tools", args: { action: "search", query: "probe" } },
    { name: "tools", args: { action: "call", name: "probe_read", args: { id: "p2" } } },
  ]);
  assert.deepEqual(offered(inProject.first).filter((name) => name.startsWith("probe_")), []);
  assert.ok(offered(inProject.first).includes("tools"), "probe_open is still lazy there");
  const heard = toolText(inProject.last);
  assert.match(heard, /probe_open: Open a probe by its id\./);
  assert.doesNotMatch(heard, /probe_read: /, "search does not list it");
  assert.match(heard, /switched off in this conversation/);
  assert.doesNotMatch(heard, /probe_read ran/);

  // Both off there: nothing is lazy in that conversation, so no gateway and no hint.
  await json("/api/projects/research/tools", "PUT", { off: ["probe_open", "probe_read"] });
  const none = (await ask(project.id)).first;
  assert.ok(!offered(none).includes("tools"));
  assert.doesNotMatch(JSON.stringify(none), /search for them with the tools tool/);

  // Taking the mark away offers the tools one by one again, and the gateway goes.
  await json("/api/projects/research/tools", "PUT", { off: [] });
  await json("/api/tools/lazy", "PUT", { lazy: [] });
  const back = (await ask(plain.id)).first;
  assert.deepEqual(offered(back).filter((name) => name.startsWith("probe_") || name === "tools"), ["probe_open", "probe_read"]);
  assert.doesNotMatch(JSON.stringify(back), /search for them with the tools tool/);
});
