import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// Issue #95: a tool the MCP adapter's configuration says no to was still listed, still loaded in a running
// chat, and a switched-off one was still reachable through the adapter's own `mcp` tool from its cache.
const home = inProcessHome("pithagoras-mcp-offer-");
const agent = process.env.PI_CODING_AGENT_DIR;
writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages: ["npm:pi-mcp-adapter@2.18.0"] }));
const mcpFile = (config) => writeFileSync(path.join(agent, "mcp.json"), JSON.stringify(config));
const cacheFile = (servers) => writeFileSync(path.join(agent, "mcp-cache.json"), JSON.stringify({ version: 1, servers }));

const { mcpCatalogue, mcpDirect, mcpOffer } = await import("../dist/mcp-offer.js");
const { switchedOffVia, guardExtension } = await import("../dist/pi/guard.js");
const { createSession, rememberTools, setToolDefaultsOff, shownTools, withdrawnMcpTools } = await import("../dist/db.js");
// Nothing off by default, not even code mode, which a new install has off: what is off here is the servers' doing.
setToolDefaultsOff([]);
const { sessions } = await import("../dist/session-manager.js");
const { onMcpWritten, writeMcpFile } = await import("../dist/api/mcp.js");

mock.method(console, "warn", () => {});

const cache = {
  jira: { tools: [{ name: "search" }, { name: "create_issue" }, { name: "admin.delete" }], resources: [{ name: "Project List" }] },
  "brave-search": { tools: [{ name: "web_search" }] },
};

test("a server's tool is offered while its configuration registers it, and from the cache while the server starts only when used", () => {
  const offer = mcpOffer({ mcpServers: { jira: { command: "j", directTools: true }, "brave-search": { command: "b", directTools: true, lifecycle: "eager" } } }, { servers: cache });
  assert.equal(offer("jira_search"), "cached", "lazy is the adapter's default");
  assert.equal(offer("jira_admin_delete"), "cached", "a dotted name is registered with underscores");
  assert.equal(offer("jira_read_project_list"), "cached", "a resource is a tool too");
  assert.equal(offer("brave_search_web_search"), "offered", "an eager server is started with the chat");
  assert.equal(offer("mcp"), undefined, "the adapter's own");
});

test("a server switched off, a tool left out or no longer there is withdrawn", () => {
  const servers = (jira) => ({ mcpServers: { jira: { command: "j", directTools: true, ...jira } } });
  assert.equal(mcpOffer(servers({ disabled: true }), { servers: cache })("jira_search"), "withdrawn");
  assert.equal(mcpOffer(servers({ excludeTools: ["create_*"] }), { servers: cache })("jira_create_issue"), "withdrawn");
  assert.equal(mcpOffer(servers({ excludeTools: ["jira_create_issue"] }), { servers: cache })("jira_create_issue"), "withdrawn", "by its full name as well");
  assert.equal(mcpOffer(servers({ includeTools: ["search"] }), { servers: cache })("jira_create_issue"), "withdrawn");
  assert.equal(mcpOffer(servers({ includeTools: ["search"] }), { servers: cache })("jira_search"), "cached");
  assert.equal(mcpOffer(servers({}), { servers: cache })("jira_gone"), "withdrawn", "the cache is what the adapter registers from");
  assert.equal(mcpOffer(servers({}), null)("jira_gone"), "offered", "without a cache there is nothing to go by");
  assert.equal(mcpOffer(servers({}), { servers: { jira: { tools: [] } } })("jira_search"), "offered", "nor with an entry that lists nothing");
  assert.equal(mcpOffer(servers({ includeTools: ["admin.delete"] }), { servers: cache })("jira_admin_delete"), "cached", "by the server's own name for it, dots and all");
  assert.equal(mcpOffer(servers({ excludeTools: ["admin.*"] }), { servers: cache })("jira_admin_delete"), "withdrawn");
});

test("a server's tools are listed whether the model is offered them one by one or through the mcp tool", () => {
  const config = (jira, settings) => ({ mcpServers: { jira: { command: "j", ...jira }, "brave-search": { command: "b", disabled: true } }, settings });
  const names = (c) => mcpCatalogue(c, { servers: cache }).map((t) => t.name);
  assert.deepEqual(names(config({})), ["jira_search", "jira_create_issue", "jira_admin_delete", "jira_read_project_list"], "behind the proxy only");
  assert.deepEqual(names(config({ directTools: true })), names(config({})), "registered one by one: the same tools");
  assert.deepEqual(names(config({ excludeTools: ["create_issue"], exposeResources: false })), ["jira_search", "jira_admin_delete"], "less what the configuration says no to");
  assert.deepEqual(names({ mcpServers: { jira: { command: "j", toolPrefix: "short" } } }), [], "a prefix it cannot read is not listed");
  assert.equal(mcpCatalogue(config({}), { servers: cache })[0].offer, "cached");
  assert.equal(mcpCatalogue(config({}), null).length, 0, "a server that never ran has nothing to list");
  assert.equal(mcpOffer(config({}), { servers: cache })("jira_search"), "cached", "not registered one by one is no reason to withdraw it");
});

test("the mcp tool does not reach a tool that is switched off, by any of its names", () => {
  const off = new Set(["jira_create_issue", "brave_search_web_search", "bash"]);
  const mcp = { servers: ["jira", "brave-search", "shell"], serverTool: (name) => name !== "bash" };
  assert.equal(switchedOffVia("mcp", { tool: "jira_create_issue" }, off, mcp), "jira_create_issue");
  assert.equal(switchedOffVia("mcp", { tool: "jira-create-issue" }, off, mcp), "jira_create_issue", "the adapter takes hyphens for underscores");
  assert.equal(switchedOffVia("mcp", { tool: "create_issue", server: "jira" }, off, mcp), "jira_create_issue");
  assert.equal(switchedOffVia("mcp", { tool: "web_search", server: "brave-search" }, off, mcp), "brave_search_web_search");
  assert.equal(switchedOffVia("mcp", { describe: "jira_create_issue" }, off, mcp), "jira_create_issue");
  assert.equal(switchedOffVia("mcp", { tool: "jira_search" }, off, mcp), undefined, "what is on stays reachable");
  assert.equal(switchedOffVia("mcp", { search: "jira" }, off, mcp), undefined);
  assert.equal(switchedOffVia("jira_search", {}, off, mcp), undefined);
  assert.equal(switchedOffVia("mcp", { tool: "jira_create_issue" }, new Set(), mcp), undefined);
  assert.equal(switchedOffVia("mcp", { tool: "jira_create.issue" }, off, mcp), "jira_create_issue", "dots as the adapter writes them");
  assert.equal(switchedOffVia("mcpScript", {}, off, mcp), "jira_create_issue");
  assert.equal(switchedOffVia("mcp", { tool: "bash", server: "shell" }, off, mcp), undefined, "pi's bash switched off is not a server's shell_bash");
  assert.equal(switchedOffVia("mcp_script", {}, new Set(["bash"]), mcp), undefined, "nor any script's");
});

test("the guard refuses it before anything could allow it, and an MCP script while a server's tool is off", () => {
  cacheFile(cache);
  mcpFile({ mcpServers: { jira: { command: "j", directTools: true, excludeTools: ["admin.delete"] }, web: { command: "w" } } });
  let off = new Set(["jira_create_issue"]);
  const h = {};
  guardExtension("t", () => ({ role: "primary" }), "s", () => new Set(), () => ({ allowed: true, allowlist: [] }), undefined, [], () => off)({ on: (k, f) => (h[k] = f) });
  const refused = h.tool_call({ toolName: "mcp", input: { tool: "jira_create_issue", args: {} } });
  assert.equal(refused?.block, true);
  assert.match(refused.reason, /switched off in this conversation/);
  assert.equal(h.tool_call({ toolName: "mcp", input: { tool: "jira_search" } }), undefined);
  assert.equal(h.tool_call({ toolName: "mcp_script", input: { code: "await tools.jira_search({})" } })?.block, true);
  off = new Set(["bash"]);
  assert.equal(h.tool_call({ toolName: "mcp", input: { tool: "jira_create_issue" } }), undefined, "read at each call");
  assert.equal(h.tool_call({ toolName: "mcp_script", input: { code: "" } }), undefined, "no server's tool is off");
  off = new Set(["jira_admin_delete", "web_search"]);
  assert.equal(h.tool_call({ toolName: "mcp_script", input: { code: "" } }), undefined, "one the configuration leaves out, or another extension's that starts like a server's name, is no script's");
});

const names = (list) => list.map((t) => t.name).sort();
/** Tools as a chat reports them, by name alone. */
const named = (...list) => list.map((name) => ({ name }));
test("what the configuration says no to is not listed, is off in pi, and what comes from the cache is marked", async () => {
  cacheFile(cache);
  mcpFile({ mcpServers: { jira: { command: "j", directTools: true, excludeTools: ["create_issue"] }, "brave-search": { command: "b", disabled: true } } });
  rememberTools([
    { name: "jira_search", source: "pi-mcp-adapter", package: "npm:pi-mcp-adapter@2.18.0" },
    { name: "jira_create_issue", source: "pi-mcp-adapter", package: "npm:pi-mcp-adapter@2.18.0" },
    { name: "brave_search_web_search", source: "pi-mcp-adapter", package: "npm:pi-mcp-adapter@2.18.0" },
    { name: "mcp", source: "pi-mcp-adapter", package: "npm:pi-mcp-adapter@2.18.0" },
    { name: "bash", source: "built in", package: null },
  ]);
  const shown = shownTools();
  // jira's other tools are listed from the cache, as every server's are; create_issue is excluded, brave-search is off.
  assert.deepEqual(names(shown), ["bash", "jira_admin_delete", "jira_read_project_list", "jira_search", "mcp"]);
  assert.equal(shown.find((t) => t.name === "jira_search").cached, true);
  assert.equal(shown.find((t) => t.name === "bash").cached, undefined);
  assert.deepEqual(withdrawnMcpTools(), ["brave_search_web_search", "jira_create_issue"]);

  createSession({ id: "idle", title: "idle", workspace: home, executor: "host" });
  const { tools } = await sessions.getTools("idle");
  assert.deepEqual(names(tools), ["bash", "jira_admin_delete", "jira_read_project_list", "jira_search", "mcp"]);
  assert.equal(tools.find((t) => t.name === "jira_search").cached, true);
  // What pi is told is off includes them; what the page is told, and what is written down, does not.
  assert.deepEqual(sessions.piOff("idle"), ["brave_search_web_search", "jira_create_issue"]);
  assert.deepEqual(sessions.offFor("idle"), []);
  await sessions.setTools("idle", ["bash"]);
  assert.deepEqual(sessions.offFor("idle"), ["bash"]);

  // Allowed again: listed again, and nothing was written down against it meanwhile.
  mcpFile({ mcpServers: { jira: { command: "j", directTools: true }, "brave-search": { command: "b", directTools: true } } });
  assert.deepEqual(names(shownTools()), ["bash", "brave_search_web_search", "jira_admin_delete", "jira_create_issue", "jira_read_project_list", "jira_search", "mcp"]);
  assert.deepEqual(sessions.piOff("idle"), ["bash"]);
});

test("a server behind the mcp tool only is switched like any other: whole, or tool by tool, and the switch holds through mcp", async () => {
  cacheFile(cache);
  mcpFile({ mcpServers: { jira: { command: "j" } } });
  createSession({ id: "proxy", title: "proxy", workspace: home, executor: "host" });
  const listed = (await sessions.getTools("proxy")).tools.filter((t) => t.name.startsWith("jira_"));
  assert.deepEqual(names(listed), ["jira_admin_delete", "jira_create_issue", "jira_read_project_list", "jira_search"]);
  assert.ok(listed.every((t) => t.source === "jira" && t.enabled));

  // One tool off: off for pi, and so for the guard, which holds the mcp tool to it. brave-search, taken out of the file
  // above by hand, is no server the adapter has: the tool the portal remembers of it is withdrawn, and off for pi too.
  await sessions.setTools("proxy", ["jira_create_issue"]);
  assert.deepEqual(sessions.piOff("proxy"), ["brave_search_web_search", "jira_create_issue"]);
  assert.equal(switchedOffVia("mcp", { tool: "jira_create_issue" }, new Set(sessions.piOff("proxy"))), "jira_create_issue");
  assert.equal(switchedOffVia("mcp", { tool: "jira_search" }, new Set(sessions.piOff("proxy"))), undefined);

  // The whole server off, as the group's switch sends it.
  const all = listed.map((t) => t.name);
  await sessions.setTools("proxy", all);
  assert.deepEqual(sessions.piOff("proxy"), [...all, "brave_search_web_search"].sort());
  assert.ok((await sessions.getTools("proxy")).tools.filter((t) => t.name.startsWith("jira_")).every((t) => !t.enabled));
});

test("a server that was removed has its tools off in a chat still running with it, whoever wrote the file", () => {
  let told = 0;
  const stop = onMcpWritten(() => told++);
  writeMcpFile({ mcpServers: { jira: { command: "j" }, notes: { command: "n" } } });
  // As an extension does when it switches its server off (portal.mcp.set): the file written without the panel's routes.
  writeMcpFile({ mcpServers: { jira: { command: "j" } } });
  assert.equal(told, 2, "the running chats are told after every write");
  // And brave-search's, remembered from a chat and no longer configured.
  assert.deepEqual(withdrawnMcpTools(named("notes_read", "jira_search", "mcp", "bash")), ["brave_search_web_search", "notes_read"]);
  // A tool of the portal's inline extensions is no server's, whatever its name starts with: a server half's, say.
  assert.deepEqual(withdrawnMcpTools([{ name: "notes_read" }, { name: "notes_board", inline: true }]), ["brave_search_web_search", "notes_read"]);
  writeMcpFile({ mcpServers: { jira: { command: "j" }, notes: { command: "n" } } });
  assert.deepEqual(withdrawnMcpTools(named("notes_read")), ["brave_search_web_search"], "configured again");
  stop();
});

test("a configuration that cannot be read is taken as it last could be", () => {
  // brave-search's remembered tool is withdrawn throughout: no file here configures it.
  mcpFile({ mcpServers: { jira: { command: "j", disabled: true } } });
  assert.deepEqual(withdrawnMcpTools(named("jira_search")), ["brave_search_web_search", "jira_create_issue", "jira_search"]);
  writeFileSync(path.join(agent, "mcp.json"), "{ not json");
  assert.deepEqual(withdrawnMcpTools(named("jira_search")), ["brave_search_web_search", "jira_create_issue", "jira_search"], "a typo hands nothing back");
  // Fixed by a write that leaves a server out: the servers it had are the ones it last could be read with.
  mcpFile({ mcpServers: { jira: { command: "j" }, notes: { command: "n" } } });
  withdrawnMcpTools();
  writeFileSync(path.join(agent, "mcp.json"), "{ not json either");
  writeMcpFile({ mcpServers: { jira: { command: "j" } } });
  assert.deepEqual(withdrawnMcpTools(named("notes_read")), ["brave_search_web_search", "notes_read"], "the server left out is one that was removed");
});

test("a server's tools from the cache go with the adapter's package, whatever it was installed from", () => {
  cacheFile(cache);
  mcpFile({ mcpServers: { jira: { command: "j" } } });
  const source = "git:github.com/someone/pi-mcp-adapter";
  writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages: [source] }));
  // One no chat has registered one by one: listed from the cache alone.
  assert.ok(names(shownTools()).includes("jira_admin_delete"));
  writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages: [{ source, extensions: [] }] }));
  assert.ok(!names(shownTools()).includes("jira_admin_delete"), "switched off");
  writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages: ["npm:something-else"] }));
  assert.ok(!names(shownTools()).includes("jira_admin_delete"), "not installed: nothing would register them");
  writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages: ["npm:pi-mcp-adapter@2.18.0"] }));
});

test("a server's tool is registered one by one only where its directTools or the adapter-wide one says so; else it is lazy, through mcp", () => {
  const direct = (config) => mcpDirect(config, { servers: cache });
  const jira = (entry, settings) => ({ mcpServers: { jira: { command: "j", ...entry }, "brave-search": { command: "b" } }, settings });
  // The adapter's default, and a server that says no.
  assert.equal(direct(jira({}))("jira_search"), false);
  assert.equal(direct(jira({ directTools: false }))("jira_search"), false);
  assert.equal(direct(jira({ directTools: [] }))("jira_search"), false);
  assert.equal(direct(jira({ directTools: true }))("jira_search"), true);
  assert.equal(direct(jira({ directTools: true }))("jira_read_project_list"), true, "resources too");
  // A list names the tools the server has, by their own names: dots and all, and `read_<resource>` for a resource.
  const some = direct(jira({ directTools: ["search", "admin.delete", "read_project_list"] }));
  assert.deepEqual(["jira_search", "jira_create_issue", "jira_admin_delete", "jira_read_project_list"].map(some), [true, false, true, true]);
  // The adapter-wide setting is for a server that says nothing, and a server's own word wins.
  const wide = direct(jira({ directTools: false }, { directTools: true }));
  assert.equal(wide("jira_search"), false);
  assert.equal(wide("brave_search_web_search"), true);
  assert.equal(direct(jira({}, { directTools: true }))("jira_search"), true);
  // Not a server's tool, or a server whose names are not read here.
  assert.equal(direct(jira({}))("bash"), undefined);
  assert.equal(mcpDirect({ mcpServers: { jira: { command: "j", toolPrefix: "short", directTools: true } } }, { servers: cache })("jira_search"), undefined);
  // Without a cache entry there is the registered name to go by.
  assert.equal(mcpDirect(jira({ directTools: ["search"] }), null)("jira_search"), true);
});

// As on a portal whose Tools page listed 27 `browser_browser_*` tools under pi-mcp-adapter: a Playwright server called
// `browser`, taken out of mcp.json by hand, left its entry in the adapter's cache and its tools in what the portal
// remembers. The adapter registers a server's tools only for a server its configuration has, so it had none of them.
const stale = { ...cache, browser: { tools: [{ name: "browser_navigate" }, { name: "browser_click" }] } };

test("a tool of a server no longer configured is withdrawn, whatever the cache still has of it; the adapter's own tools and a configured server's stay", () => {
  const config = { mcpServers: { jira: { command: "j" } } };
  const offer = mcpOffer(config, { servers: stale });
  assert.equal(offer("browser_browser_navigate"), "withdrawn");
  assert.equal(offer("notes_read"), "withdrawn", "one the cache never had as well");
  assert.equal(offer("jira_search"), "cached", "a configured server's tool is judged as ever");
  for (const own of ["mcp", "mcp_script"]) assert.equal(offer(own), undefined, `${own} is the adapter's, whatever servers there are`);
  assert.equal(mcpOffer({}, null)("browser_browser_navigate"), "withdrawn", "with no server at all");
  assert.equal(mcpOffer({}, null)("mcp"), undefined);
  assert.ok(!mcpCatalogue(config, { servers: stale }).some((t) => t.server === "browser"), "nor is it in the catalogue");
});

test("while a server is named another way than the default, a name no server claims is not judged", () => {
  const offer = (config) => mcpOffer(config, { servers: stale });
  // `none` registers a server's tools under their own names, which no server's name tells.
  const unprefixed = offer({ mcpServers: { jira: { command: "j" }, gh: { command: "g", toolPrefix: "none" } } });
  assert.equal(unprefixed("browser_browser_navigate"), undefined);
  assert.equal(unprefixed("jira_search"), "cached", "a server named the default way is judged as ever");
  assert.equal(offer({ mcpServers: { jira: { command: "j" } }, settings: { toolPrefix: "short" } })("browser_browser_navigate"), undefined, "nor with the adapter-wide prefix");
  assert.equal(offer({ mcpServers: { jira: { command: "j", toolPrefix: "server" } } })("browser_browser_navigate"), "withdrawn", "the default, said, is the default");
});

test("what the portal remembers of a server no longer configured is not listed, and is off in a chat", async () => {
  cacheFile(stale);
  mcpFile({ mcpServers: { jira: { command: "j" } } });
  const adapter = (name) => ({ name, source: "pi-mcp-adapter", package: "npm:pi-mcp-adapter@2.18.0" });
  rememberTools([adapter("browser_browser_navigate"), adapter("browser_browser_click"), adapter("mcp"), { name: "browser_open", source: "browser", package: null, inline: true }]);
  const shown = names(shownTools());
  assert.deepEqual(shown.filter((name) => name.startsWith("browser_")), ["browser_open"], "another extension's tool is not the adapter's");
  assert.ok(shown.includes("mcp") && shown.includes("jira_search"));
  createSession({ id: "stale", title: "stale", workspace: home, executor: "host" });
  assert.ok(!(await sessions.getTools("stale")).tools.some((t) => t.name.startsWith("browser_browser_")), "nor in a chat's list");
  const off = sessions.piOff("stale");
  assert.ok(off.includes("browser_browser_navigate") && off.includes("browser_browser_click"));
  assert.equal(switchedOffVia("mcp_script", {}, new Set(off)), undefined, "a script is not refused over a tool no server has");
  // Remembered all the same: configured again, the server has them back.
  mcpFile({ mcpServers: { jira: { command: "j" }, browser: { command: "b" } } });
  assert.ok(names(shownTools()).includes("browser_browser_navigate"));
});
