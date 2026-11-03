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
const { guardExtension, switchedOffVia } = await import("../dist/pi/guard.js");
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
  content: [{ type: "text", text: "jira (3 tools (not connected, cached)):\n\n- jira_search - Search issues\n- jira_create_issue - Create an issue\n- jira_admin_delete" }],
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
  assert.equal(text(shown), "jira (2 tools (not connected, cached)):\n\n- jira_search - Search issues\n- jira_admin_delete");
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
  assert.equal(text(withoutSwitchedOff(long, new Set(["jira_search"]), view())), "jira (1 tools):\n\n- jira_create_issue - Create\n\nServer instructions:\nUse with care.");
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

const paged = (tools, hasMore = true) => ({
  content: [{
    type: "text",
    text: `Found 30 tools matching "a":\n\n${tools.map((tool) => `- ${tool} - x`).join("\n")}${hasMore ? `\n\n${tools.length} of 30 — offset: ${tools.length} for more` : ""}`,
  }],
  details: { mode: "search", matches: tools.map((tool) => ({ server: tool.split("_")[0], tool })), count: 30, hasMore, nextOffset: hasMore ? tools.length : null, query: "a" },
});

test("a search that pages says how many it shows, not a total that counts what is off on its other pages", () => {
  assert.equal(text(withoutSwitchedOff(paged(["jira_search", "jira_create_issue"]), new Set(["jira_create_issue"]), view())), 'Tools matching "a":\n\n- jira_search - x\n\n1 shown — offset: 2 for more');
  // Nothing that is off on this page, but there may be on the others: the count would tell of them.
  const first = withoutSwitchedOff(paged(["jira_search", "notes_read"]), new Set(["jira_create_issue"]), view());
  assert.equal(text(first), 'Tools matching "a":\n\n- jira_search - x\n- notes_read - x\n\n2 shown — offset: 2 for more');
  assert.equal(first.details.count, undefined);
  assert.equal(text(withoutSwitchedOff(paged(["jira_create_issue"]), new Set(["jira_create_issue"]), view())), 'No tools matching "a" on this page — offset: 1 for more', "a page with nothing on says so");
  const last = withoutSwitchedOff(paged(["jira_search"], false), new Set(["jira_create_issue"]), view(), { search: "a", offset: 29 });
  assert.equal(text(last), 'Tools matching "a":\n\n- jira_search - x', "the last page too");
  assert.equal(withoutSwitchedOff(paged(["jira_search"]), new Set(["bash"]), view()), undefined, "no server's tool is off");
  assert.equal(withoutSwitchedOff(paged(["jira_search"], false), new Set(["jira_create_issue"]), view()), undefined, "one page has every match");
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

test("a call that finds no such tool does not name the server's tools that are off", () => {
  const miss = (hint) => ({ content: [{ type: "text", text: `Tool "jira_serch" not found.${hint}` }], details: { mode: "call", error: "tool_not_found" } });
  const has = ' Server "jira" has: jira_search, jira_create_issue, jira_admin_delete Did you mean: jira_search, jira_create_issue';
  const off = new Set(["jira_create_issue", "jira_admin_delete"]);
  assert.equal(text(withoutSwitchedOff(miss(has), off, view())), 'Tool "jira_serch" not found. Server "jira" has: jira_search Did you mean: jira_search');
  assert.equal(text(withoutSwitchedOff(miss(has), new Set(["jira_search", "jira_create_issue", "jira_admin_delete"]), view())), 'Tool "jira_serch" not found. Use mcp({ search: "..." }) to search.');
  const after = { content: [{ type: "text", text: 'Tool "x" not found on "jira" after reconnect. Available tools on "jira": jira_search, jira_create_issue' }], details: { mode: "call", error: "tool_not_found_after_reconnect" } };
  assert.equal(text(withoutSwitchedOff(after, new Set(["jira_create_issue"]), view())), 'Tool "x" not found on "jira" after reconnect. Available tools on "jira": jira_search');
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

// Review round 1.

test("the status takes a server for switched off only where every tool of it is off, whatever its live count", () => {
  const live = (notes) => ({
    content: [{ type: "text", text: "adapter text" }],
    details: {
      mode: "status",
      servers: [{ name: "jira", status: "connected", toolCount: 3 }, { name: "notes", toolCount: 0, failedAgo: null, ...notes }],
      totalTools: 3,
      connectedCount: 1,
      disabledCount: 0,
    },
  });
  // notes has not run in this process, so the adapter counts none of its tools; one of them is still on.
  const some = withoutSwitchedOff(live({ status: "not connected" }), new Set(["jira_search", "notes_read"]), view());
  assert.equal(text(some), 'MCP: 1/2 servers, 2 tools\n\n✓ jira (2 tools)\n○ notes (not connected)\n\nmcp({ server: "name" }) to list tools, mcp({ search: "..." }) to search');
  assert.equal(some.details.servers.find((s) => s.name === "notes").switchedOff, undefined);
  assert.equal(some.details.disabledCount, 0);
  // Every tool of it off: switched off in any state, its line too, and counted out of the header.
  const all = withoutSwitchedOff(live({ status: "failed", failedAgo: 4 }), new Set(["notes_read", "notes_write"]), view());
  assert.equal(text(all), 'MCP: 1/1 servers, 3 tools (1 disabled)\n\n✓ jira (3 tools)\n⊘ notes (switched off)\n\nmcp({ server: "name" }) to list tools, mcp({ search: "..." }) to search');
  assert.equal(withoutSwitchedOff(live({ status: "not connected" }), new Set(["bash"]), view()), undefined);
});

test("a server's own answer to a call is not rewritten, whatever names it holds", () => {
  const answer = { content: [{ type: "text", text: "Weather for Berlin. Did you mean: jira_create_issue, Paris" }], details: { mode: "call", server: "jira", tool: "search" } };
  assert.equal(withoutSwitchedOff(answer, new Set(["jira_create_issue"]), view()), undefined);
});

test("a call of a server whose tools are all off is refused, by its name or by the start of the tool's", () => {
  const off = new Set(["notes_read", "notes_write"]);
  assert.equal(switchedOffServer({ tool: "notes_anything" }, off, view()), "notes", "the adapter would connect notes to look for it");
  assert.equal(switchedOffServer({ tool: "x", server: "notes" }, off, view()), "notes");
  assert.equal(switchedOffServer({ tool: "notes-anything" }, off, view()), "notes", "hyphens for underscores");
  assert.equal(switchedOffServer({ tool: "jira_anything" }, off, view()), undefined, "another server");
  assert.equal(switchedOffServer({ tool: "notes_write" }, new Set(["notes_read"]), view()), undefined, "one tool is still on");
  assert.equal(switchedOffServer({ action: "auth-start", tool: "notes_x", server: "notes" }, off, view()), undefined, "an action is not a call");
  const g = guard(off);
  assert.equal(g.call("mcp", { tool: "notes_anything", args: {} })?.block, true);
  assert.equal(g.call("mcp", { tool: "jira_search", args: {} }), undefined);
});

// A server named otherwise than the default (`toolPrefix`), or brought by a configuration the portal does not read: its
// tools are known here only as the adapter registered them, one by one.
const short = {
  catalogue: [],
  servers: ["docs-mcp"],
  direct: () => undefined,
  naming: () => "short",
  registered: (name) => ["docs_search", "docs_open", "proj_find"].includes(name),
};

test("a tool of a server in another naming, or of one the portal does not configure, is refused and left out when it is off", () => {
  const off = new Set(["docs_search", "proj_find"]);
  assert.equal(switchedOffVia("mcp", { tool: "docs_search" }, off, short), "docs_search", "by the server's naming");
  assert.equal(switchedOffVia("mcp", { tool: "search", server: "docs-mcp" }, off, short), "docs_search", "and the server's own name for it");
  assert.equal(switchedOffVia("mcp", { tool: "proj_find" }, off, { servers: [], serverTool: () => false }, (name) => short.registered(name)), "proj_find", "one the adapter registered");
  assert.equal(switchedOffVia("mcp_script", {}, new Set(["proj_find"]), { servers: [], serverTool: () => false }, (name) => short.registered(name)), "proj_find");
  assert.equal(switchedOffVia("mcp", { tool: "docs_open" }, off, short), undefined, "what is on stays reachable");

  const list = {
    content: [{ type: "text", text: "docs-mcp (2 tools):\n\n- docs_search - Search the docs\n- docs_open - Open a page" }],
    details: { mode: "list", server: "docs-mcp", tools: ["docs_search", "docs_open"], count: 2 },
  };
  assert.equal(text(withoutSwitchedOff(list, off, short)), "docs-mcp (1 tools):\n\n- docs_open - Open a page");
  const described = describedWithoutSwitchedOff("MCP gateway.\n\nDirect tools available (call as normal tools): docs-mcp (2)\n\nServers: docs-mcp (3 tools)\n\nUsage:\n  x\n", off, short);
  assert.match(described, /Direct tools available \(call as normal tools\): docs-mcp \(1\)\n/);
  assert.match(described, /Servers: docs-mcp \(3 tools\)/, "what it has behind mcp is not known here, so it is not taken for off");
  assert.equal(switchedOffServer({ connect: "docs-mcp" }, new Set(["docs_search", "docs_open"]), short), undefined, "nor the whole server");
});

test("a search keeps the parameters of a tool that is off out, though its description names a tool that is on", () => {
  const sneaky = {
    content: [{
      type: "text",
      text:
        'Found 2 tools matching "x":\n\n' +
        "jira_admin_delete\n  Deletes. Usage:\njira_search\n\n  Shape:\n    { id: string; force: boolean }\n\n" +
        "jira_search\n  Search issues\n\n  Shape:\n    { query: string }",
    }],
    details: { mode: "search", matches: [{ server: "jira", tool: "jira_admin_delete" }, { server: "jira", tool: "jira_search" }], count: 2, hasMore: false, nextOffset: null, query: "x" },
  };
  assert.equal(text(withoutSwitchedOff(sneaky, new Set(["jira_admin_delete"]), view())), 'Found 1 tool matching "x":\n\njira_search\n  Search issues\n\n  Shape:\n    { query: string }');
});

test("a list keeps the server's instructions whole, though they name a tool that is off", () => {
  const list = {
    content: [{
      type: "text",
      text: "jira (2 tools):\n\n- jira_search - Search\n- jira_admin_delete\n\n\nServer instructions:\nUse these tools:\n- jira_admin_delete - admins only\nAlways log in first.\nRate limit 10/s.",
    }],
    details: { mode: "list", server: "jira", tools: ["jira_search", "jira_admin_delete"], count: 2, hasInstructions: true },
  };
  assert.equal(
    text(withoutSwitchedOff(list, new Set(["jira_admin_delete"]), view())),
    "jira (1 tools):\n\n- jira_search - Search\n\n\nServer instructions:\nUse these tools:\n- jira_admin_delete - admins only\nAlways log in first.\nRate limit 10/s.",
  );
});

test("what cannot be read as the adapter writes it is answered with what is on, not passed on", async () => {
  // Another package's hook ran first and reworded the list.
  const reworded = { content: [{ type: "text", text: "[compacted] jira: jira_search (Search issues); jira_create_issue (Create an issue)" }], details: list.details };
  assert.equal(text(withoutSwitchedOff(reworded, new Set(["jira_create_issue"]), view())), "jira (2 tools):\n\n- jira_search\n- jira_admin_delete");
  const found = { content: [{ type: "text", text: "[compacted] jira_search, jira_create_issue, jira_admin_delete" }], details: search.details };
  assert.equal(text(withoutSwitchedOff(found, new Set(["jira_create_issue"]), view())), 'Found 2 tools matching "issue":\n\n- jira_search\n- jira_admin_delete');
  const status2 = { ...status, content: [{ type: "text", text: "[compacted] jira 3, notes 2, brave-search 2" }] };
  const counted = text(withoutSwitchedOff(status2, new Set(["notes_read", "notes_write"]), view()));
  assert.doesNotMatch(counted, /notes \(\d|notes 2/);
  assert.match(counted, /⊘ notes \(switched off\)/);
  // A description worded otherwise keeps nothing of any server.
  const otherwise = "MCP gateway - connect.\n\nServers here: notes (2 tools), jira (3 tools)\n\nUsage:\n  mcp({ })  → status\n";
  assert.equal(describedWithoutSwitchedOff(otherwise, new Set(["notes_read", "notes_write"]), view()), "MCP gateway - connect.\n\nUsage:\n  mcp({ })  → status\n");
  // And a result the guard's hook cannot read at all is not passed on.
  const g = guard(new Set(["jira_create_issue"]));
  const broken = await g.result("mcp", {}, { content: [{ type: "text", text: "jira_create_issue" }], details: { get mode() { throw new Error("unreadable"); } } });
  assert.doesNotMatch(text(broken), /jira_create_issue/);
  assert.match(text(broken), /left out/);
});
