import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// Issue #336: a tool that is switched off was refused when called, but the `mcp` tool still listed it, searched for
// it, connected its server and described it in its own description, all from the adapter's cache.
const home = inProcessHome("pithagoras-mcp-hide-");
const agent = process.env.PI_CODING_AGENT_DIR;
writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages: ["npm:pi-mcp-adapter@2.18.0"] }));
const mcpFile = (config) => writeFileSync(path.join(agent, "mcp.json"), JSON.stringify(config));
const cacheFile = (servers) => writeFileSync(path.join(agent, "mcp-cache.json"), JSON.stringify({ version: 1, servers }));

const { mcpView, setToolDefaultsOff } = await import("../dist/db.js");
setToolDefaultsOff([]);
const { guardExtension } = await import("../dist/pi/guard.js");
const { describedWithoutSwitchedOff, switchedOffServer, withoutSwitchedOff } = await import("../dist/pi/mcp-hide.js");
const { SdkPiClient } = await import("../dist/pi/sdk-client.js");

mock.method(console, "warn", () => {});

cacheFile({
  jira: { tools: [{ name: "search", description: "Search issues" }, { name: "create_issue", description: "Create an issue" }, { name: "admin.delete" }] },
  notes: { tools: [{ name: "read" }, { name: "write" }], instructions: "Notes are kept per person." },
  "brave-search": { tools: [{ name: "web_search" }, { name: "news" }] },
});
mcpFile({ mcpServers: { jira: { command: "j" }, notes: { command: "n" }, "brave-search": { command: "b", directTools: true } } });

const view = () => mcpView();
const text = (result) => result.content.map((part) => part.text).join("\n");

// What pi-mcp-adapter 2.18.0 answers (proxy-modes.ts), word for word.
const list = {
  content: [{ type: "text", text: "jira (3 tools, not connected, cached):\n\n- jira_search - Search issues\n- jira_create_issue - Create an issue\n- jira_admin_delete" }],
  details: { mode: "list", server: "jira", tools: ["jira_search", "jira_create_issue", "jira_admin_delete"], count: 3, hasInstructions: false },
};
const search = {
  content: [{
    type: "text",
    text:
      'Found 3 tools matching "issue":\n\n' +
      "jira_search\n  Search issues\n\n  Shape:\n    { query: string }\n\n" +
      "jira_create_issue\n  Create an issue\n\n  Shape:\n    { title: string }\n\n" +
      "jira_admin_delete\n  (no description)\n\n  Shape:\n    { id: string }",
  }],
  details: { mode: "search", matches: ["jira_search", "jira_create_issue", "jira_admin_delete"].map((tool) => ({ server: "jira", tool, score: 1 })), count: 3, hasMore: false, nextOffset: null, query: "issue" },
};
const status = {
  content: [{ type: "text", text: "MCP: 0/3 servers, 7 tools\n\n○ jira (3 tools, cached)\n○ notes (2 tools, cached)\n○ brave-search (2 tools, cached)\n\nmcp({ server: \"name\" }) to list tools, mcp({ search: \"...\" }) to search" }],
  details: {
    mode: "status",
    servers: [{ name: "jira", status: "cached", toolCount: 3 }, { name: "notes", status: "cached", toolCount: 2 }, { name: "brave-search", status: "cached", toolCount: 2 }],
    totalTools: 7,
    connectedCount: 0,
    disabledCount: 0,
  },
};

test("a list says nothing of a tool that is off, and counts the rest", () => {
  const shown = withoutSwitchedOff(list, new Set(["jira_create_issue"]), view());
  assert.equal(text(shown), "jira (2 tools, not connected, cached):\n\n- jira_search - Search issues\n- jira_admin_delete");
  assert.deepEqual(shown.details.tools, ["jira_search", "jira_admin_delete"]);
  assert.equal(shown.details.count, 2);
  assert.equal(withoutSwitchedOff(list, new Set(["bash"]), view()), undefined, "nothing of this server is off");
  assert.equal(withoutSwitchedOff(list, new Set(), view()), undefined);
});

test("a tool's description that runs over lines goes with it, and the server's instructions stay", () => {
  const long = {
    content: [{ type: "text", text: "jira (2 tools):\n\n- jira_search - Search\nissues by text\n\nand more\n- jira_create_issue - Create\n\nServer instructions:\nUse with care." }],
    details: { mode: "list", server: "jira", tools: ["jira_search", "jira_create_issue"], count: 2 },
  };
  assert.equal(text(withoutSwitchedOff(long, new Set(["jira_search"]), view())), "jira (1 tool):\n\n- jira_create_issue - Create\n\nServer instructions:\nUse with care.");
});

test("a list of a server with every tool off is a server that is off", () => {
  const shown = withoutSwitchedOff(list, new Set(["jira_search", "jira_create_issue", "jira_admin_delete"]), view());
  assert.match(text(shown), /switched off in this conversation/);
  assert.doesNotMatch(text(shown), /jira_/);
});

test("a search leaves out the tools that are off with their parameters", () => {
  const shown = withoutSwitchedOff(search, new Set(["jira_create_issue"]), view());
  assert.equal(
    text(shown),
    'Found 2 tools matching "issue":\n\n' + "jira_search\n  Search issues\n\n  Shape:\n    { query: string }\n\n" + "jira_admin_delete\n  (no description)\n\n  Shape:\n    { id: string }",
  );
  assert.deepEqual(shown.details.matches.map((m) => m.tool), ["jira_search", "jira_admin_delete"]);
  const none = withoutSwitchedOff(search, new Set(["jira_search", "jira_create_issue", "jira_admin_delete"]), view());
  assert.equal(text(none), 'No tools matching "issue"');
});

test("a search that pages keeps its footer true to the page", () => {
  const paged = {
    content: [{ type: "text", text: 'Found 5 tools matching "a":\n\n- jira_search - x\n- jira_create_issue - y\n\n2 of 5 — offset: 2 for more' }],
    details: { mode: "search", matches: [{ server: "jira", tool: "jira_search" }, { server: "jira", tool: "jira_create_issue" }], count: 5, hasMore: true, nextOffset: 2, query: "a" },
  };
  assert.equal(text(withoutSwitchedOff(paged, new Set(["jira_create_issue"]), view())), 'Found 4 tools matching "a":\n\n- jira_search - x\n\n1 of 4 — offset: 2 for more');
});

test("the status counts what is on, and names a server with every tool off as off", () => {
  const shown = withoutSwitchedOff(status, new Set(["jira_create_issue", "notes_read", "notes_write"]), view());
  assert.equal(
    text(shown),
    'MCP: 0/2 servers, 4 tools (1 disabled)\n\n○ jira (2 tools, cached)\n⊘ notes (switched off)\n○ brave-search (2 tools, cached)\n\nmcp({ server: "name" }) to list tools, mcp({ search: "..." }) to search',
  );
  assert.equal(shown.details.totalTools, 4);
  assert.equal(shown.details.servers.find((s) => s.name === "jira").toolCount, 2);
});

test("a suggestion does not name a tool that is off", () => {
  const miss = { content: [{ type: "text", text: 'Tool "jira_serch" not found. Use mcp({ search: "..." }) to search. Did you mean: jira_search, jira_create_issue' }], details: { mode: "describe", error: "tool_not_found", suggestions: ["jira_search", "jira_create_issue"] } };
  const shown = withoutSwitchedOff(miss, new Set(["jira_create_issue"]), view());
  assert.match(text(shown), /Did you mean: jira_search$/);
  assert.deepEqual(shown.details.suggestions, ["jira_search"]);
  assert.doesNotMatch(text(withoutSwitchedOff(miss, new Set(["jira_search", "jira_create_issue"]), view())), /Did you mean/);
});

test("a server whose tools are all off is not listed, searched, connected or read the instructions of", () => {
  const off = new Set(["notes_read", "notes_write"]);
  assert.equal(switchedOffServer({ connect: "notes" }, off, view()), "notes");
  assert.equal(switchedOffServer({ server: "notes" }, off, view()), "notes");
  assert.equal(switchedOffServer({ search: "x", server: "notes" }, off, view()), "notes");
  assert.equal(switchedOffServer({ instructions: "notes" }, off, view()), "notes");
  assert.equal(switchedOffServer({ connect: "jira" }, off, view()), undefined, "another server");
  assert.equal(switchedOffServer({ search: "x" }, off, view()), undefined, "a search over every server is filtered, not refused");
  assert.equal(switchedOffServer({ describe: "notes_read", server: "notes" }, off, view()), undefined, "describe is refused by name");
  assert.equal(switchedOffServer({ connect: "notes" }, new Set(["notes_read"]), view()), undefined, "one tool is still on");
  assert.equal(switchedOffServer({ connect: "notes" }, new Set(), view()), undefined);
});

/** The guard as pi runs it: the hooks it registers, in the order it registers them. */
function guard(off) {
  const hooks = { tool_call: [], tool_result: [] };
  guardExtension("t", () => ({ role: "primary" }), "s", () => new Set(), () => ({ allowed: true, allowlist: [] }), undefined, [], () => off)({ on: (kind, fn) => hooks[kind]?.push(fn) });
  return {
    call: (toolName, input) => hooks.tool_call[0]({ toolName, input }),
    // Each hook is given what the one before it made of the result, as pi does.
    result: async (toolName, input, result) => {
      let event = { toolName, toolCallId: "c1", input, isError: false, ...result };
      for (const hook of hooks.tool_result) event = { ...event, ...((await hook(event)) ?? {}) };
      return event;
    },
  };
}

test("the guard refuses to connect or list a server that is off, and gives the rest of a list without the tools that are off", async () => {
  const g = guard(new Set(["jira_create_issue", "notes_read", "notes_write"]));
  const refused = g.call("mcp", { connect: "notes" });
  assert.equal(refused?.block, true);
  assert.match(refused.reason, /every tool of the MCP server "notes" is switched off/);
  assert.equal(g.call("mcp", { server: "notes" })?.block, true);
  assert.equal(g.call("mcp", { server: "jira" }), undefined);
  assert.equal(g.call("mcp", {}), undefined);

  const listed = await g.result("mcp", { server: "jira" }, list);
  assert.doesNotMatch(text(listed), /create_issue|Create an issue/);
  assert.match(text(listed), /jira_search/);
  const connected = await g.result("mcp", { connect: "jira" }, list);
  assert.doesNotMatch(text(connected), /create_issue/);
  assert.doesNotMatch(text(await g.result("mcp", { search: "issue" }, search)), /create_issue|title: string/);
  const counted = text(await g.result("mcp", {}, status));
  assert.doesNotMatch(counted, /notes \(\d|7 tools/);
  assert.match(counted, /⊘ notes \(switched off\)/);
});

test("nothing is changed in a chat where nothing is off, nor in the result of another tool", async () => {
  const g = guard(new Set());
  // Whatever the guard makes of an mcp result (it is outside content, and wrapped as such) it holds all of the text.
  assert.ok(text(await g.result("mcp", { server: "jira" }, list)).includes(text(list)));
  const other = guard(new Set(["jira_create_issue"]));
  assert.equal(text(await other.result("web_search", {}, list)), text(list), "only the mcp tool's words are read");
  assert.ok(text(await other.result("mcp", { server: "jira" }, { ...list, isError: true })).includes(text(list)));
});

const description =
  "MCP gateway - connect to MCP servers and call their tools. Non-MCP Pi tools should be called directly, not through mcp.\n" +
  "\nDirect tools available (call as normal tools): brave-search (2)\n" +
  "\nServers: jira (3 tools), notes (2 tools)\n" +
  "\nServer instructions (truncated - full text via mcp({ instructions: \"name\" })):\n  notes: Notes are kept per person.\n" +
  "\nUsage:\n  mcp({ })                              → Show server status\n";

test("the description names no server and no tool that is off, and counts the rest", () => {
  const some = describedWithoutSwitchedOff(description, new Set(["jira_create_issue", "brave_search_news"]), view());
  assert.match(some, /Direct tools available \(call as normal tools\): brave-search \(1\)\n/);
  assert.match(some, /Servers: jira \(2 tools\), notes \(2 tools\)\n/);
  assert.match(some, /notes: Notes are kept per person/);

  const gone = describedWithoutSwitchedOff(description, new Set(["notes_read", "notes_write", "brave_search_web_search", "brave_search_news"]), view());
  assert.doesNotMatch(gone, /notes|brave-search|Direct tools|Server instructions/);
  assert.match(gone, /Servers: jira \(3 tools\)\n\nUsage:/);
  assert.equal(describedWithoutSwitchedOff(description, new Set(), view()), description);
  assert.equal(describedWithoutSwitchedOff(description, new Set(["bash"]), view()), description);
});

/** A pi session as far as the declared tools go: the loadout is what the model is given. */
function fakeSession() {
  const registry = [{ name: "bash", description: "Run" }, { name: "mcp", description }];
  const session = {
    agent: { state: { tools: [] } },
    getAllTools: () => registry,
    getToolDefinition: () => undefined,
    getActiveToolNames: () => registry.map((t) => t.name),
    _applyToolLoadout(names) {
      const tools = registry.filter((t) => names.includes(t.name));
      session.agent.state.tools = tools;
      return tools;
    },
    _setActiveTools(names) {
      session.declared = session._applyToolLoadout(names);
    },
    _bindExtensionCore() {},
  };
  return session;
}

test("the mcp tool is declared to the model without what is switched off, and with it again when it is switched on", async () => {
  const session = fakeSession();
  const client = new SdkPiClient(session, {}, () => {});
  await client.setToolsOff(["notes_read", "notes_write"]);
  const declared = () => session.agent.state.tools.find((t) => t.name === "mcp").description;
  assert.doesNotMatch(declared(), /notes/);
  assert.match(declared(), /jira \(3 tools\)/);
  assert.equal(session.declared.find((t) => t.name === "mcp").description, declared(), "the loadout is what the activation returned");
  await client.setToolsOff([]);
  assert.equal(declared(), description);
});
