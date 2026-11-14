import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fakeModel, resultsIn } from "./fake-model.mjs";
import { freePort, inProcessHome, serverEnv, startServer } from "./server-harness.mjs";

/**
 * Lazy tools (#106, #361): a set or a single tool is marked `lazy` or `direct`, and what has no mark is `auto`: the
 * threshold decides, by what the model's list costs. A lazy tool is on like any other, but is not in the model's
 * prompt; the model reaches it through `tool_search` instead (tool-search.test.mjs runs that end to end). Laziness
 * is no switch: it never changes whether a tool is on, and a tool that is off is off for good. What a chat is told of its
 * lazy tools is made when it first starts and is its own from then on. Against the whole server: what Settings → Tools
 * reads and writes, what a chat, a project and a later registration make of it. The last test runs real chats against a
 * model that is scripted, to see what the model is sent.
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
/** The tools a page marks as reached through `tool_search`. */
const lazyOf = (r) => r.tools.filter((t) => t.lazy).map((t) => t.name).sort();

/** The MCP adapter's configuration: the servers there are. */
const writeMcp = (servers) => writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "mcp.json"), JSON.stringify({ mcpServers: servers }));

beforeEach(async () => {
  db.getDb().exec("DELETE FROM settings WHERE key IN ('tools_seen', 'tools_off_default', 'tool_marks', 'lazy_limits', 'lazy_resolved', 'lazy_notice'); DELETE FROM project_tools; DELETE FROM agent_tools; UPDATE routines SET tools_off = '', tools_on = ''");
  writeMcp({});
  db.rememberTools([...heavy, ...light]);
});

/** What the chat froze about its lazy tools: the sets and tools that are lazy in it. */
const headOf = (id) => sessions.lazyHeadFor(id);
const mark = (marks) => json("/api/tools/marks", "PUT", { marks });
/** A tool as a session reports it, with what its declaration costs the model's list. */
const sized = (name, source, tokens, extra = {}) => db.remembered({ name, source, tokens, ...extra });
/** The names of the tools of the tools page that are lazy now by a mark or by the threshold. */
const lazyNow = () => [...db.lazyToolNames()].sort();

test("nothing is lazy until somebody says so, or the list gets long: no mark, no set, nothing for a chat to be told", async () => {
  const page = await json("/api/tools");
  assert.deepEqual(page.marks, {});
  assert.deepEqual(page.resolved, { lazy: [], over: false });
  assert.deepEqual(page.limits, { tokens: 3000, tools: 20 });
  assert.deepEqual(page.off, []);
  assert.deepEqual(lazyOf(page), []);
  const chat = await json("/api/sessions", "POST", {});
  const listed = await json(`/api/sessions/${chat.id}/tools`);
  assert.deepEqual(states(listed), { heavy_open: true, heavy_read: true, web_search: true });
  assert.deepEqual(lazyOf(listed), []);
  assert.deepEqual(headOf(chat.id).lazy, []);
  assert.equal(headOf(chat.id).hint, "");
  assert.deepEqual(db.lazyToolNames(), new Set());
});

test("a default tool is never lazy by a mark that is not its own: a tool nobody marked is offered one by one, whatever else is marked", async () => {
  await mark({ "pi-heavy": "lazy" });
  const chat = await json("/api/sessions", "POST", {});
  const listed = await json(`/api/sessions/${chat.id}/tools`);
  assert.equal(lazyOf(listed).includes("web_search"), false);
  assert.equal(states(listed).web_search, true);
  assert.deepEqual(headOf(chat.id).lazy, ["pi-heavy"]);
  assert.deepEqual(lazyNow(), ["heavy_open", "heavy_read"]);
  assert.deepEqual(db.toolDefaultsOff(), []);
});

test("a lazy set stays on: marking switches nothing, and the other sets are not touched", async () => {
  const done = await mark({ "pi-heavy": "lazy" });
  assert.deepEqual(done.marks, { "pi-heavy": "lazy" });
  assert.equal(done.off, undefined);
  assert.deepEqual(db.toolDefaultsOff(), []);

  const page = await json("/api/tools");
  assert.deepEqual(page.marks, { "pi-heavy": "lazy" });
  assert.deepEqual(Object.fromEntries(page.tools.map((t) => [t.name, t.defaultOn])), { heavy_open: true, heavy_read: true, web_search: true });
  assert.deepEqual(lazyOf(page), ["heavy_open", "heavy_read"]);
  assert.deepEqual(page.tools.find((t) => t.name === "heavy_open").mark, "lazy");
  assert.equal(page.tools.find((t) => t.name === "web_search").auto, true, "no mark: the threshold decides");
  const chat = await json("/api/sessions", "POST", {});
  const listed = await json(`/api/sessions/${chat.id}/tools`);
  assert.deepEqual(states(listed), { heavy_open: true, heavy_read: true, web_search: true });
  assert.deepEqual(lazyOf(listed), ["heavy_open", "heavy_read"]);
  const head = headOf(chat.id);
  assert.deepEqual(head.lazy, ["pi-heavy"]);
  assert.match(head.hint, /^These tools are not in your list: pi-heavy \(heavy_open, heavy_read\)\. Search them with the tool_search tool/);
});

test("a tool's own mark is before its set's: a set that is lazy has a tool that is direct, and a set that is direct has a tool that is lazy", async () => {
  await mark({ "pi-heavy": "lazy", "<tool>heavy_read": "direct" });
  assert.deepEqual(lazyNow(), ["heavy_open"]);
  await mark({ "pi-heavy": "direct", "<tool>heavy_read": "lazy" });
  assert.deepEqual(lazyNow(), ["heavy_read"]);
  const chat = await json("/api/sessions", "POST", {});
  const head = headOf(chat.id);
  assert.deepEqual(head.lazy, ["<tool>heavy_read"]);
  assert.deepEqual(head.direct, ["pi-heavy"]);
});

test("a tool that is neither an MCP tool nor built in can be made lazy on its own", async () => {
  // An extension's own tool, like a custom one a user installed: no MCP server, no pi built-in.
  db.rememberTools([{ name: "custom_ping", source: "my-extension", package: null }]);
  const done = await mark({ [lazyToolEntry("custom_ping")]: "lazy" });
  assert.deepEqual(done.marks, { "<tool>custom_ping": "lazy" });
  const chat = await json("/api/sessions", "POST", {});
  const listed = await json(`/api/sessions/${chat.id}/tools`);
  assert.deepEqual(lazyOf(listed), ["custom_ping"]);
  assert.equal(states(listed).custom_ping, true);
  assert.deepEqual(headOf(chat.id).lazy, ["<tool>custom_ping"]);
  assert.match(headOf(chat.id).hint, /my-extension \(custom_ping\)/);
  // Its set-mates and the rest are untouched.
  assert.deepEqual(lazyOf(await json("/api/tools")), ["custom_ping"]);
  // A tool is marked on its own only: a set of the same name as a tool is not taken for it.
  assert.deepEqual([...db.lazyToolNames()], ["custom_ping"]);
});

test("a chat and a project switch a lazy tool off for themselves, and it is then off for good", async () => {
  await mark({ "pi-heavy": "lazy" });
  const chat = await json("/api/sessions", "POST", {});
  await json(`/api/sessions/${chat.id}/tools`, "PUT", { off: ["heavy_read"] });
  const listed = await json(`/api/sessions/${chat.id}/tools`);
  assert.deepEqual(states(listed), { heavy_open: true, heavy_read: false, web_search: true });
  assert.deepEqual(sessions.piOff(chat.id), ["heavy_read"]);

  // Another chat still has both.
  const other = await json("/api/sessions", "POST", {});
  assert.deepEqual(sessions.piOff(other.id), []);

  // Every lazy tool of a chat off at its start: nothing is lazy in it, there is nothing to reach, and no tool_search.
  await json("/api/projects/research/tools", "PUT", { off: ["heavy_open", "heavy_read"] });
  const inProject = await json("/api/sessions", "POST", { workspace: "research" });
  assert.deepEqual(sessions.piOff(inProject.id), ["heavy_open", "heavy_read"]);
  assert.deepEqual(headOf(inProject.id).lazy, []);
  // Switched on again, the chats that start are lazy again: the mark is the set's, the switch the project's.
  await json("/api/projects/research/tools", "PUT", { off: [] });
  const again = await json("/api/sessions", "POST", { workspace: "research" });
  assert.deepEqual(headOf(again.id).lazy, ["pi-heavy"]);
});

test("a tool switched off at any layer stays off for good: the portal-wide default, an agent, a project, a routine, a chat", async () => {
  await mark({ "pi-heavy": "lazy" });
  /** heavy_read is off and no way reaches it; heavy_open, which nobody switched off, is lazy as before. */
  const hardOff = async (id, layer) => {
    const off = sessions.piOff(id);
    assert.ok(off.includes("heavy_read"), `${layer}: off`);
    assert.deepEqual(headOf(id).lazy, ["pi-heavy"], `${layer}: the other one is lazy`);
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

test("what a chat froze about its lazy tools is its own: the marks changing later reach the chats that start afterwards, and the page says so", async () => {
  await mark({ "pi-heavy": "lazy" });
  const chat = await json("/api/sessions", "POST", {});
  const head = headOf(chat.id);
  assert.deepEqual(head.lazy, ["pi-heavy"]);
  assert.equal((await json(`/api/sessions/${chat.id}/tools`)).lazyStale, false);
  // The mark taken away, and another set made lazy: the chat is as it was, and a chat that starts now is not.
  await mark({ "pi-web-access": "lazy" });
  assert.deepEqual(headOf(chat.id), head, "the chat's own, also read again by a restart or a reload");
  const fresh = await json("/api/sessions", "POST", {});
  assert.deepEqual(headOf(fresh.id).lazy, ["pi-web-access"]);
  assert.equal((await json(`/api/sessions/${chat.id}/tools`)).lazyStale, true, "the page may offer to read the tools again");
  assert.deepEqual((await json(`/api/sessions/${chat.id}/tools`)).tools.find((t) => t.name === "web_search").lazy, undefined);
  // Read again, as the person asks: the head is what a chat that starts now has.
  const changed = await json(`/api/sessions/${chat.id}/tools/read-again`, "POST");
  assert.equal(changed.changed, true);
  assert.deepEqual(headOf(chat.id).lazy, ["pi-web-access"]);
  assert.equal((await json(`/api/sessions/${chat.id}/tools`)).lazyStale, false);
  assert.equal((await json(`/api/sessions/${chat.id}/tools/read-again`, "POST")).changed, false, "nothing changed since");
});

test("a chat's head says from its start what its lazy tools said of themselves when a chat last registered them, and has a tag of its own that a read again keeps", async () => {
  db.rememberTools([
    db.remembered({ name: "heavy_open", source: "pi-heavy", outside: true, voice: ["Say the heavy result in one sentence."] }),
    db.remembered({ name: "heavy_read", source: "pi-heavy", voice: ["Say the heavy result in one sentence.", "Spell the ids."] }),
    db.remembered({ name: "web_search", source: "pi-web-access", outside: true, voice: ["Not lazy, so not in the head."] }),
  ]);
  await mark({ "pi-heavy": "lazy" });
  const chat = await json("/api/sessions", "POST", {});
  const head = headOf(chat.id);
  assert.deepEqual(head.lazy, ["pi-heavy"]);
  assert.equal(head.outside, true, "a lazy tool returns outside content: said from the first request, not when it registers");
  assert.deepEqual(head.voice, ["Say the heavy result in one sentence.", "Spell the ids."]);
  assert.match(head.tag, /^[0-9a-f]{8}$/);
  assert.notEqual(headOf((await json("/api/sessions", "POST", {})).id).tag, head.tag, "each chat its own");
  // Read again, the tag stays: it says nothing of the tools.
  await mark({ "pi-heavy": "lazy", "<tool>heavy_read": "direct" });
  assert.equal((await json(`/api/sessions/${chat.id}/tools/read-again`, "POST")).changed, true);
  const again = headOf(chat.id);
  assert.equal(again.tag, head.tag);
  assert.deepEqual(again.voice, ["Say the heavy result in one sentence."], "heavy_read is in the list now");
  // A lazy group whose tools say nothing has nothing in the head.
  db.rememberTools([db.remembered({ name: "heavy_open", source: "pi-heavy" }), db.remembered({ name: "heavy_read", source: "pi-heavy" })]);
  await mark({ "pi-heavy": "lazy" });
  const quiet = headOf((await json("/api/sessions", "POST", {})).id);
  assert.equal(quiet.outside, false);
  assert.deepEqual(quiet.voice, []);
});

test("a head stored before heads had a tag is given one once, and keeps it", async () => {
  await mark({ "pi-heavy": "lazy" });
  const chat = await json("/api/sessions", "POST", {});
  const { tag, ...untagged } = headOf(chat.id);
  db.getDb().prepare("UPDATE sessions SET lazy_head = ? WHERE id = ?").run(JSON.stringify(untagged), chat.id);
  const given = headOf(chat.id);
  assert.match(given.tag, /^[0-9a-f]{8}$/);
  assert.notEqual(given.tag, tag);
  assert.deepEqual({ ...given, tag: undefined }, { ...untagged, tag: undefined }, "nothing else of it changes");
  assert.equal(headOf(chat.id).tag, given.tag, "and it is kept");
});

test("a chat switching its lazy tools off is no more out of date for it, and one that started with them off is not out of date either", async () => {
  await mark({ "pi-heavy": "lazy" });
  const chat = await json("/api/sessions", "POST", {});
  headOf(chat.id);
  await json(`/api/sessions/${chat.id}/tools`, "PUT", { off: ["heavy_open", "heavy_read"] });
  assert.equal(sessions.lazyHeadStale(chat.id), false);
  const off = await json("/api/sessions", "POST", {});
  await json(`/api/sessions/${off.id}/tools`, "PUT", { off: ["heavy_open", "heavy_read"] });
  assert.deepEqual(headOf(off.id).lazy, []);
  assert.equal(sessions.lazyHeadStale(off.id), false);
  await json(`/api/sessions/${off.id}/tools`, "PUT", { off: [] });
  assert.equal(sessions.lazyHeadStale(off.id), true, "switched on, they are lazy for a chat that starts now");
});

test("a tool switched off in the default is off for good: lazy does not bring it back", async () => {
  await json("/api/tools", "PUT", { off: ["heavy_read"] });
  await mark({ "pi-heavy": "lazy" });
  const chat = await json("/api/sessions", "POST", {});
  assert.deepEqual(sessions.piOff(chat.id), ["heavy_read"]);
  assert.deepEqual(headOf(chat.id).lazy, ["pi-heavy"]);
  assert.deepEqual(db.toolDefaultsOff(), ["heavy_read"]);
});

test("a running chat is told what is off, and a tool it switched off is among them", async () => {
  const told = [];
  const chat = await json("/api/sessions", "POST", {});
  sessions.live.set(chat.id, {
    client: {
      getTools: async () => [...heavy, ...light].map((t) => ({ name: t.name, source: t.source, enabled: true })),
      setToolsOff: async (...args) => { told.push(args); },
    },
  });
  try {
    await mark({ "pi-heavy": "lazy" });
    await sessions.applyToolDefaults();
    // What is lazy is not told: the chat froze it, and a mark reaches the chats that start afterwards.
    assert.deepEqual(told.at(-1), [[]]);
    await sessions.setTools(chat.id, ["web_search", "heavy_read"]);
    assert.deepEqual(told.at(-1), [["heavy_read", "web_search"]]);
  } finally {
    sessions.live.delete(chat.id);
  }
});

test("a mark cannot make an MCP server's tools or pi's built-in tools lazy: the first are lazy by their server's own setting, the others are always offered", async () => {
  writeMcp({ notes: {} });
  db.rememberTools([
    { name: "notes_read", source: "pi-mcp-adapter", package: null },
    { name: "mcp", source: "pi-mcp-adapter", package: null },
    { name: "bash", source: "built in", package: null },
    { name: "read", source: "built in", package: null },
  ]);
  for (const entry of ["notes", "built in", "pi-mcp-adapter", lazyToolEntry("notes_read"), lazyToolEntry("mcp"), lazyToolEntry("bash")]) {
    const res = await send("/api/tools/marks", "PUT", { marks: { [entry]: "lazy" } });
    assert.equal(res.status, 400, `${entry} is refused`);
    assert.equal((await res.json()).code, "lazy-refused");
  }
  // A server that is configured but has no tool seen yet is refused by its name too.
  writeMcp({ notes: {}, wiki: {} });
  assert.equal((await send("/api/tools/marks", "PUT", { marks: { wiki: "lazy" } })).status, 400);
  // Mixed with a mark that is fine, the whole request is refused and nothing is stored.
  assert.equal((await send("/api/tools/marks", "PUT", { marks: { "pi-heavy": "lazy", notes: "lazy" } })).status, 400);
  assert.deepEqual(db.toolMarks(), {});
  // `direct` is nothing to refuse: they are in the list anyway.
  assert.equal((await send("/api/tools/marks", "PUT", { marks: { bash: "direct" } })).status, 200);
  await mark({});

  // A mark that got in some other way (the database, an older portal) names tools that are not lazy.
  db.setToolMarks({ notes: "lazy", "built in": "lazy", [lazyToolEntry("bash")]: "lazy", "pi-heavy": "lazy" });
  assert.deepEqual([...db.lazyToolNames()].sort(), ["heavy_open", "heavy_read"]);
  const chat = await json("/api/sessions", "POST", {});
  // The portal's own tool has nothing of the server's: the adapter's `mcp` tool does that. The lists say it is lazy all the same.
  assert.deepEqual(lazyOf(await json(`/api/sessions/${chat.id}/tools`)), ["heavy_open", "heavy_read", "notes_read"]);
  // And such a mark does not stand in the way of an unrelated change to the list.
  const kept = await mark({ notes: "lazy", "built in": "lazy", "pi-heavy": "lazy", "pi-web-access": "lazy" });
  assert.deepEqual(Object.keys(kept.marks).sort(), ["built in", "notes", "pi-heavy", "pi-web-access"]);
});

test("a body that is not marks is refused", async () => {
  for (const marks of ["pi-heavy", ["pi-heavy"], { "pi-heavy": "yes" }, { "pi-heavy": true }]) {
    assert.equal((await send("/api/tools/marks", "PUT", { marks })).status, 400, JSON.stringify(marks));
  }
  assert.equal((await send("/api/tools/lazy-limits", "PUT", { tokens: -1, tools: 20 })).status, 400);
  assert.equal((await send("/api/tools/lazy-limits", "PUT", { tokens: 1.5, tools: 20 })).status, 400);
  assert.equal((await send("/api/tools/lazy-limits", "PUT", { tokens: "3000", tools: 20 })).status, 400);
});

test("pi's built-in tools stay out of reach of lazy when the sandbox registers them again under its own name", async () => {
  // Before the portal has seen one, the name alone tells it.
  assert.equal((await send("/api/tools/marks", "PUT", { marks: { [lazyToolEntry("ls")]: "lazy" } })).status, 400);
  // With the sandbox on, its inline extension brings bash, read and the rest once more, so pi files them under "sandbox", not "built in".
  const sandboxed = ["bash", "read", "write", "edit", "ls", "grep", "find"].map((name) => ({ name, source: "sandbox", package: null, inline: true }));
  db.rememberTools(sandboxed);
  // And an extension of the user's that overrides one under its own name.
  db.rememberTools([{ name: "write", source: "my-extension", package: null }]);
  db.rememberTools([{ name: "custom_ping", source: "my-extension", package: null }]);
  for (const tool of sandboxed) assert.equal(db.lazyAllowed(tool), false, `${tool.name} is built in, whoever registers it`);
  assert.equal(db.lazyAllowed({ name: "custom_ping", source: "my-extension", package: null }), true);

  for (const entry of ["sandbox", lazyToolEntry("bash"), lazyToolEntry("read")]) {
    const res = await send("/api/tools/marks", "PUT", { marks: { [entry]: "lazy" } });
    assert.equal(res.status, 400, `${entry} is refused`);
    assert.equal((await res.json()).code, "lazy-refused");
  }
  assert.deepEqual(db.toolMarks(), {});

  // A mark that got in some other way does nothing to them, and the page offers no mark for them.
  db.setToolMarks({ sandbox: "lazy", "my-extension": "lazy", [lazyToolEntry("bash")]: "lazy" });
  assert.deepEqual([...db.lazyToolNames()], ["custom_ping"]);
  const page = await json("/api/tools");
  assert.deepEqual(lazyOf(page), ["custom_ping"]);
  assert.deepEqual(page.tools.filter((t) => t.noLazy).map((t) => t.name).sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
  const chat = await json("/api/sessions", "POST", {});
  assert.deepEqual(lazyOf(await json(`/api/sessions/${chat.id}/tools`)), ["custom_ping"]);
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
  assert.deepEqual((await mark({ [lazyToolEntry("routine_run")]: "lazy" })).marks, { "<tool>routine_run": "lazy" });
  assert.deepEqual([...db.lazyToolNames()], ["routine_run"]);
  assert.deepEqual((await mark({ routines: "lazy" })).marks, { routines: "lazy" });
  assert.deepEqual([...db.lazyToolNames()].sort(), ["routine_run", "routines_list"]);
  const page = await json("/api/tools");
  assert.deepEqual(lazyOf(page), ["routine_run", "routines_list"]);
  assert.deepEqual(page.tools.filter((t) => t.noLazy).map((t) => t.name), []);
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
  // `tool_search` has none of them: they are reached through the adapter's `mcp` tool, and nothing is marked.
  assert.deepEqual(headOf(chat.id).lazy, []);
  assert.deepEqual(page.marks, {});
  assert.equal((await send("/api/tools/marks", "PUT", { marks: { notes: "lazy" } })).status, 400, "the server's own setting is the one switch");
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

test("a tool that turns up later in a lazy set is lazy, and the callers are told of what is off only; one seen before is not new", async () => {
  await mark({ "pi-heavy": "lazy" });
  const arrived = db.rememberTools([...heavy, { name: "heavy_write", source: "pi-heavy", package: null }, { name: "web_fetch", source: "pi-web-access", package: null }]);
  assert.deepEqual(arrived, []);
  assert.deepEqual(db.toolDefaultsOff(), []);
  assert.deepEqual([...db.lazyToolNames()].sort(), ["heavy_open", "heavy_read", "heavy_write"]);
  assert.deepEqual(db.rememberTools([...heavy, { name: "heavy_write", source: "pi-heavy", package: null }]), []);
});

test("without a mark a new tool is on and not lazy, as before, while the list is short", async () => {
  assert.deepEqual(db.rememberTools([{ name: "heavy_write", source: "pi-heavy", package: null }]), []);
  assert.deepEqual(db.toolDefaultsOff(), []);
  assert.deepEqual([...db.lazyToolNames()], []);
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
  await mark({ painter: "lazy", "pithagoras-browser": "lazy" });
  assert.deepEqual([...db.lazyToolNames()].sort(), ["browser_click", "browser_navigate", "paint", "sketch"]);
  assert.deepEqual(db.lazySetLabels(db.lazyToolNames()), [
    { label: "painter", tools: ["paint", "sketch"] },
    { label: "pithagoras-browser", tools: ["browser_click", "browser_navigate"] },
  ]);
  assert.deepEqual(db.toolDefaultsOff(), []);
});

test("a set that stops being lazy is offered one by one again, with its switches as they are", async () => {
  await mark({ "pi-heavy": "lazy" });
  const done = await mark({});
  assert.deepEqual(done.marks, {});
  assert.deepEqual(lazyOf(await json("/api/tools")), []);
  assert.deepEqual(db.toolDefaultsOff(), []);
});

// The threshold: what the model's list costs decides what has no mark.
const big = (prefix, source, count, tokens) => Array.from({ length: count }, (_, i) => sized(`${prefix}_${i}`, source, tokens));

test("a list over 3,000 tokens or 20 tools takes the largest group out of it, whole, and says so once", async () => {
  // Small ones: nothing happens. 10 tools of 100 tokens.
  db.rememberTools(big("small", "pi-small", 10, 100));
  assert.deepEqual([...db.lazyToolNames()], []);
  assert.deepEqual(db.lazyNotice(), []);
  // A browser's worth on top: 11 tools of 200, which is over 3,000 tokens with the rest.
  db.rememberTools(big("browser", "pi-browser", 11, 200));
  const names = [...db.lazyToolNames()].sort();
  assert.deepEqual(names, big("browser", "pi-browser", 11, 200).map((t) => t.name).sort(), "the largest group, whole");
  const page = await json("/api/tools");
  assert.deepEqual(page.resolved, { lazy: ["pi-browser"], over: false });
  assert.deepEqual(lazyOf(page).length, 11);
  assert.ok(page.tools.filter((t) => t.source === "pi-browser").every((t) => t.auto === true && t.lazy === true), "by size, no mark of the person's");
  assert.ok(page.listed.tokens <= 3000 && page.listed.tools <= 20, JSON.stringify(page.listed));
  assert.deepEqual(page.lazyNotice, ["pi-browser"]);
  // A chat that starts has it lazy; a mark of direct keeps it.
  const chat = await json("/api/sessions", "POST", {});
  assert.deepEqual(headOf(chat.id).lazy, ["pi-browser"]);
  await mark({ "pi-browser": "direct" });
  assert.deepEqual([...db.lazyToolNames()].sort(), big("small", "pi-small", 10, 100).map((t) => t.name).sort(), "the person's word is before the threshold's: another group goes instead");
  const kept = await json("/api/sessions", "POST", {});
  assert.deepEqual(headOf(kept.id).lazy, ["pi-small"]);
  assert.deepEqual(headOf(kept.id).direct, ["pi-browser"]);
  // The notice is dismissed, and not shown again for what it said.
  await send("/api/tools/lazy-notice", "DELETE");
  assert.deepEqual((await json("/api/tools")).lazyNotice, []);
});

test("a group that went lazy stays lazy until the list fits well within the limits without it", async () => {
  db.rememberTools([...big("a", "pi-a", 6, 250), ...big("b", "pi-b", 4, 250)]);
  // 2,500 tokens and the three tools of every test: within the limit.
  assert.deepEqual([...db.lazyToolNames()], []);
  db.rememberTools(big("c", "pi-c", 1, 500));
  assert.deepEqual([...db.lazyToolNames()].sort(), big("a", "pi-a", 6, 250).map((t) => t.name).sort(), "the largest of them goes");
  // The set shrinks a little, so that the list would fit with the group again, but not within 80 % of the limit: it stays lazy.
  db.rememberTools(big("a", "pi-a", 6, 200));
  assert.deepEqual((await json("/api/tools")).resolved.lazy, ["pi-a"]);
  // A group that goes away: the list is short, and the group is let back.
  db.getDb().prepare("UPDATE settings SET value = ? WHERE key = 'tools_seen'").run(JSON.stringify(db.knownTools().filter((t) => t.source !== "pi-b" && t.source !== "pi-c")));
  assert.deepEqual((await json("/api/tools")).resolved.lazy, [], "within 80 % of the limits without it, it comes back");
});

test("the limits are settings, and 0 turns a part off", async () => {
  db.rememberTools([...big("a", "pi-a", 5, 100), ...big("b", "pi-b", 5, 100)]);
  assert.deepEqual([...db.lazyToolNames()], []);
  assert.deepEqual((await json("/api/tools/lazy-limits", "PUT", { tokens: 700, tools: 20 })).limits, { tokens: 700, tools: 20 });
  assert.equal(db.lazyToolNames().size, 5, "one of the two groups, whole");
  await json("/api/tools/lazy-limits", "PUT", { tokens: 0, tools: 20 });
  assert.equal(db.lazyToolNames().size, 0, "tokens off: 10 tools are within 20");
  await json("/api/tools/lazy-limits", "PUT", { tokens: 0, tools: 9 });
  assert.equal(db.lazyToolNames().size, 5);
  const page = await json("/api/tools");
  assert.deepEqual(page.limits, { tokens: 0, tools: 9 });
  assert.deepEqual(page.defaultLimits, { tokens: 3000, tools: 20 });
});

test("the threshold does not take pi's own tools, or the portal's own small ones, out of the list, and counts what it cannot take", async () => {
  db.rememberTools([
    ...["bash", "read", "write", "edit"].map((name) => sized(name, "built in", 600)),
    sized("ask_question", "ask-question", 600, { inline: true }),
    sized("report", "report", 600, { inline: true }),
  ]);
  // Taking the others out does not make it fit; they are taken out all the same, as the list is shorter for it.
  assert.deepEqual([...db.lazyToolNames()].sort(), ["heavy_open", "heavy_read", "web_search"]);
  const page = await json("/api/tools");
  assert.equal(page.resolved.over, true, "6 x 600 is over 3,000, and nothing more can be done about it");
  assert.deepEqual(page.resolved.lazy, ["pi-heavy", "pi-web-access"]);
  assert.deepEqual(page.lazyNotice, ["pi-heavy", "pi-web-access"], "and the person is told");
  assert.ok(page.listed.tokens >= 3600, `what cannot be taken out is counted: ${page.listed.tokens}`);
  assert.equal(page.listed.tools, 6, "and only that is left");
});

test("a tool off by default does not count against the list", async () => {
  db.rememberTools(big("heavy", "pi-big", 8, 500));
  assert.equal(db.lazyToolNames().size, 8);
  await json("/api/tools", "PUT", { off: big("heavy", "pi-big", 8, 500).slice(0, 4).map((t) => t.name) });
  assert.equal(db.lazyToolNames().size, 0, "4 x 500 is within 3,000");
});

test("what a mode of the person's and an agent keep in the model's list stays there, whatever the threshold says", async () => {
  db.rememberTools(big("browser", "pi-browser", 11, 400));
  assert.equal(db.lazyToolNames().size, 11);
  const plain = await json("/api/sessions", "POST", {});
  assert.deepEqual(headOf(plain.id).lazy, ["pi-browser"]);

  const mode = await json("/api/chat-modes", "POST", { label: "Browsing", description: "" });
  assert.deepEqual((await json(`/api/chat-modes/${mode.id}/direct`, "PUT", { entries: ["pi-browser"] })).entries, ["pi-browser"]);
  assert.deepEqual((await json(`/api/chat-modes/${mode.id}/tools`)).keepDirect, ["pi-browser"]);
  const inMode = await json("/api/sessions", "POST", {});
  db.updateSession(inMode.id, { mode: `custom/${mode.id}` });
  const modeHead = headOf(inMode.id);
  assert.deepEqual(modeHead.lazy, []);
  assert.ok(modeHead.direct.includes("pi-browser"));

  const agent = await json("/api/agents", "POST", { name: "Surfer" });
  await json(`/api/agents/${agent.id}/direct`, "PUT", { entries: ["pi-browser"] });
  assert.deepEqual((await json(`/api/agents/${agent.id}/tools`)).keepDirect, ["pi-browser"]);
  const ofAgent = await json("/api/sessions", "POST", { agent: agent.id });
  assert.deepEqual(headOf(ofAgent.id).lazy, []);
  // Its exceptions to the tool switches do not take the pin with them.
  await json(`/api/agents/${agent.id}/tools`, "PUT", { off: [] });
  assert.deepEqual((await json(`/api/agents/${agent.id}/tools`)).keepDirect, ["pi-browser"]);
  // And the others are untouched.
  const other = await json("/api/sessions", "POST", {});
  assert.deepEqual(headOf(other.id).lazy, ["pi-browser"]);
  assert.equal((await send(`/api/agents/${agent.id}/direct`, "PUT", { entries: "x" })).status, 400);
});

test("the model of a real chat is sent no lazy tool and no tool_search until a tool is lazy for a chat that starts, and the hint only then", async () => {
  const offered = (request) => (request.tools ?? []).map((t) => t.function.name);
  const hint = /These tools are not in your list: probe \(probe_open, probe_read\)\. Search them with the tool_search tool/;
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

  // Nothing marked: every tool of the extension is offered one by one, there is no tool_search and no hint.
  const plain = await json("/api/sessions", "POST", {});
  const before = (await ask(plain.id)).first;
  assert.deepEqual(offered(before).filter((name) => name.startsWith("probe_") || name === "tool_search"), ["probe_open", "probe_read"]);
  assert.doesNotMatch(JSON.stringify(before), /Search them with the tool_search tool/);

  // The set is marked while that chat is running: it is as it was, as its head is its own, and says the tools can be read again.
  assert.deepEqual((await mark({ probe: "lazy" })).marks, { probe: "lazy" });
  const marked = (await ask(plain.id)).first;
  assert.deepEqual(offered(marked).filter((name) => name.startsWith("probe_")), ["probe_open", "probe_read"]);
  assert.ok(!offered(marked).includes("tool_search"));
  assert.equal((await json(`/api/sessions/${plain.id}/tools`)).lazyStale, true);
  // A chat that starts now is sent the tool_search and the hint, and not the tools.
  const fresh = await json("/api/sessions", "POST", {});
  const started = (await ask(fresh.id, [{ name: "tool_search", args: { action: "search", query: "probe" } }, { name: "tool_search", args: { action: "call", name: "probe_open", args: { id: "p1" } } }]));
  assert.deepEqual(offered(started.first).filter((name) => name.startsWith("probe_")), []);
  assert.ok(offered(started.first).includes("tool_search"));
  assert.match(JSON.stringify(started.first), hint);
  assert.doesNotMatch(JSON.stringify(started.first.tools), /Open a probe by its id/, "their descriptions are not in what the model is sent");
  // And it reaches them: a search finds them, a call runs the tool.
  assert.match(toolText(started.last), /probe_open\(id\?\): Open a probe by its id\./);
  assert.match(toolText(started.last), /probe_open ran for p1/);
  // What was sent first is the same in every request of the chat, the one after the search and the call included.
  const sent = (request) => JSON.stringify({ tools: request.tools, system: request.messages.find((m) => m.role === "system")?.content });
  assert.equal(sent(started.last), sent(started.first));

  // A project switches probe_read off: that tool is off for good, and tool_search neither lists nor runs it.
  await json("/api/projects/research/tools", "PUT", { off: ["probe_read"] });
  const project = await json("/api/sessions", "POST", { workspace: "research" });
  const inProject = await ask(project.id, [
    { name: "tool_search", args: { action: "search", query: "probe" } },
    { name: "tool_search", args: { action: "call", name: "probe_read", args: { id: "p2" } } },
  ]);
  assert.deepEqual(offered(inProject.first).filter((name) => name.startsWith("probe_")), []);
  assert.ok(offered(inProject.first).includes("tool_search"), "probe_open is still lazy there");
  const heard = toolText(inProject.last);
  assert.match(heard, /probe_open\(id\?\): Open a probe by its id\./);
  assert.doesNotMatch(heard, /probe_read\(/, "search does not list it");
  assert.match(heard, /switched off in this conversation/);
  assert.doesNotMatch(heard, /probe_read ran/);

  // Both off for a chat that starts there: nothing is lazy in it, so no tool_search and no hint.
  await json("/api/projects/research/tools", "PUT", { off: ["probe_open", "probe_read"] });
  const none = await json("/api/sessions", "POST", { workspace: "research" });
  const nothing = (await ask(none.id)).first;
  assert.ok(!offered(nothing).includes("tool_search"));
  assert.doesNotMatch(JSON.stringify(nothing), /Search them with the tool_search tool/);

  // Taking the mark away offers the tools one by one again to the chats that start; this one has its head, and the page offers to read it again.
  await json("/api/projects/research/tools", "PUT", { off: [] });
  await mark({});
  const back = await json("/api/sessions", "POST", {});
  const again = (await ask(back.id)).first;
  assert.deepEqual(offered(again).filter((name) => name.startsWith("probe_") || name === "tool_search"), ["probe_open", "probe_read"]);
  assert.doesNotMatch(JSON.stringify(again), /Search them with the tool_search tool/);
  assert.equal((await json(`/api/sessions/${fresh.id}/tools`)).lazyStale, true);
  // Read again, the chat is as a new one: the tools are offered one by one, and the way to them goes.
  assert.equal((await json(`/api/sessions/${fresh.id}/tools/read-again`, "POST")).changed, true);
  const reread = (await ask(fresh.id)).first;
  assert.deepEqual(offered(reread).filter((name) => name.startsWith("probe_") || name === "tool_search"), ["probe_open", "probe_read"]);
});
