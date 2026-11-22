import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

/**
 * pi-mcp-adapter's configuration carried over to pi's own MCP support, once, as the portal starts: the servers in pi's
 * dialect, the adapter out of pi's packages, and one line in the log. What pi has no word for is left off, and named.
 */
const home = inProcessHome("pithagoras-mcp-migration-");
// The home the adapter's shared files are looked for in: the test's own, not the developer's.
process.env.HOME = home;
const agent = process.env.PI_CODING_AGENT_DIR;
const mcpFile = path.join(agent, "mcp.json");
const settingsFile = path.join(agent, "settings.json");
const ADAPTER = "npm:pi-mcp-adapter@2.18.0";

const db = await import("../dist/db.js");
const { moveFromAdapter, carryOver } = await import("../dist/mcp-migration.js");
const { piMcp } = await import("../dist/pi/mcp-config.js");

const ADAPTER_FILE = JSON.stringify({
  mcpServers: {
    notes: { command: "node", args: ["n.js"], env: { A: "1" }, lifecycle: "lazy", directTools: true, idleTimeout: 5, debug: true, trace: true, toolPrefix: "short" },
    paused: { command: "node", disabled: true },
    plain: { url: "https://p.example.test/mcp", auth: "oauth", requestTimeoutMs: 5000, headers: { "X-Org": "a" } },
    keepsOwnHeader: { url: "https://n.example.test/mcp", oauth: false, headers: { Authorization: "Bearer ${NOTION}" } },
    ownAuth: { url: "https://o.example.test/mcp", auth: { provider: "someone" } },
    docs: { url: "https://docs.example.test/mcp", auth: "bearer", bearerTokenEnv: "DOCS_TOKEN" },
    gated: { command: "node", approveTools: true },
    sock: { socket: "/run/x.sock" },
    filtered: { command: "f", excludeTools: ["delete_*"] },
    envish: { command: "node", env: { KEY: "$env:KEY" } },
    blocked: { url: "https://b.example.test/mcp", oauth: { clientId: "x" } },
    "docs.v2": { command: "d" },
    nothing: null,
  },
  settings: { toolPrefix: "server", directTools: true },
  imports: ["cursor", "claude-code"],
});
const listed = (packages) => writeFileSync(settingsFile, JSON.stringify({ packages }));
const reset = () => {
  db.putSetting("mcp_adapter_moved", "");
  for (const table of ["project_tools", "agent_tools", "chat_modes", "routines"]) db.getDb().prepare(`DELETE FROM ${table}`).run();
  db.getDb().prepare("DELETE FROM sessions WHERE id LIKE 'mig-%'").run();
  db.setToolDefaultsOff([]);
};
const logs = [];
const original = console.log;
console.log = (...args) => (/^\[portal\] MCP:/.test(String(args[0])) ? logs.push(String(args[0])) : original(...args));
const readFile = () => JSON.parse(readFileSync(mcpFile, "utf8"));

test("the adapter's servers are put into pi's words: its keys go, on and off stay, and what pi has no word for is left off as it was", async () => {
  const pi = await piMcp();
  const moved = carryOver(pi, ADAPTER_FILE, false);
  assert.equal(moved.error, undefined);
  const s = moved.file.mcpServers;
  assert.deepEqual(s.notes, { command: "node", args: ["n.js"], env: { A: "1" } }, "lifecycle, directTools, idleTimeout, debug, trace and toolPrefix are gone");
  assert.deepEqual(s.paused, { command: "node", enabled: false }, "off as it was");
  assert.deepEqual(s.plain, { url: "https://p.example.test/mcp", headers: { "X-Org": "a" } }, "pi signs in by itself where the server asks");
  assert.deepEqual(s.keepsOwnHeader, { url: "https://n.example.test/mcp", headers: { Authorization: "Bearer ${NOTION}" } }, "oauth: false is the adapter's word and loses nothing");
  assert.deepEqual(s.ownAuth.auth, { provider: "someone" }, "pi's own auth key is kept");
  assert.deepEqual(moved.carried.sort(), ["docs", "keepsOwnHeader", "notes", "ownAuth", "paused", "plain"]);
  assert.deepEqual(moved.left.map((l) => l.name).sort(), ["blocked", "docs.v2", "envish", "filtered", "gated", "nothing", "sock"]);
  for (const name of ["blocked", "docs.v2", "envish", "filtered", "gated", "sock"]) assert.equal(s[name].enabled, false, `${name} is off`);
  assert.deepEqual(s.docs, { url: "https://docs.example.test/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } }, "the bearer variable is an Authorization header in pi's words, and the adapter's keys are gone");
  assert.deepEqual(s.gated, { command: "node", approveTools: true, enabled: false }, "as it was, nothing of it lost");
  assert.equal("nothing" in s, false, "an entry that is no server is only named");
  assert.match(moved.left.find((l) => l.name === "gated").why, /ask before each call/);
  assert.match(moved.left.find((l) => l.name === "envish").why, /\$env:NAME/);
  assert.match(moved.left.find((l) => l.name === "filtered").why, /leaves out/);
  assert.match(moved.left.find((l) => l.name === "docs.v2").why, /name/);
  assert.equal("settings" in moved.file || "imports" in moved.file, false);
  assert.deepEqual(moved.imports, ["cursor", "claude-code"]);
  // Where nothing ran under the adapter, nothing starts now.
  assert.equal(carryOver(pi, ADAPTER_FILE, true).file.mcpServers.notes.enabled, false);
});

test("the adapter's setting that asks before every call leaves every server it covers off, with the setting written into its entry, and one server's own false takes it out", async () => {
  const pi = await piMcp();
  const moved = carryOver(pi, JSON.stringify({ mcpServers: { a: { command: "a" }, b: { command: "b", approveTools: false }, "c.d": { command: "c" } }, settings: { approveTools: true } }), false);
  assert.deepEqual(moved.left.map((l) => l.name), ["a", "c.d"]);
  assert.deepEqual(moved.carried, ["b"]);
  // Switched on again later, the entry still says it: the page refuses to switch a server on with a key pi ignores (see config-routes).
  assert.deepEqual(moved.file.mcpServers.a, { command: "a", approveTools: true, enabled: false });
  assert.deepEqual(moved.file.mcpServers["c.d"], { command: "c", approveTools: true, enabled: false });
});

test("the entry Understory's extension wrote before the move, with its bearer token, becomes pi's header, and the file is then one pi accepts", async () => {
  const pi = await piMcp();
  const written = { url: "http://127.0.0.1:3800/mcp", lifecycle: "lazy", directTools: true, auth: "bearer", bearerToken: "tok123" };
  const moved = carryOver(pi, JSON.stringify({ mcpServers: { understory: written, fromEnv: { ...written, bearerToken: undefined, bearerTokenEnv: "MEMORY_UNDERSTORY_AUTH_TOKEN" } } }), false);
  assert.deepEqual(moved.left, []);
  assert.deepEqual(moved.file.mcpServers.understory, { url: "http://127.0.0.1:3800/mcp", headers: { Authorization: "Bearer tok123" } });
  assert.deepEqual(moved.file.mcpServers.fromEnv, { url: "http://127.0.0.1:3800/mcp", headers: { Authorization: "Bearer ${MEMORY_UNDERSTORY_AUTH_TOKEN}" } });
  for (const [name, entry] of Object.entries(moved.file.mcpServers)) assert.equal(typeof pi.validateMcpServerConfig(name, entry), "object", `pi takes ${name}`);
  // An Authorization header of its own as well is a choice the person makes.
  const both = carryOver(pi, JSON.stringify({ mcpServers: { x: { url: "https://x.example.test/mcp", bearerToken: "a", headers: { authorization: "Bearer b" } } } }), false);
  assert.match(both.left[0].why, /Authorization header both/);
});

test("a value of env or headers that pi reads another way than the adapter did leaves the server off: a `$`, a leading `!!`", async () => {
  const pi = await piMcp();
  const one = (env) => carryOver(pi, JSON.stringify({ mcpServers: { x: { command: "srv", env, lifecycle: "lazy" } } }), false);
  for (const value of ["pa$word", "pa$$word", "!!literal", "cost$", "$NAME"]) {
    const moved = one({ PASSWORD: value });
    assert.equal(moved.left.length, 1, value);
    assert.match(moved.left[0].why, /`\$` or a leading `!!`/);
    assert.equal(moved.file.mcpServers.x.enabled, false);
  }
  for (const value of ["plain", "${TOKEN}", "a${B}c", "x!y"]) assert.deepEqual(one({ PASSWORD: value }).left, [], value);
  const header = carryOver(pi, JSON.stringify({ mcpServers: { x: { url: "https://x.example.test/mcp", headers: { "X-Key": "pa$word" } } } }), false);
  assert.equal(header.left.length, 1);
  // pi's own resolver is the judge of the difference: a `$word` is a variable to it, and `!!x` is a command.
  const { resolveConfigValueOrThrow } = await import(new URL("./core/resolve-config-value.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
  assert.throws(() => resolveConfigValueOrThrow("pa$word", "x"), /environment variable/);
  assert.throws(() => resolveConfigValueOrThrow("!!literal", "x"), /shell command/);
});

test("a file that is already pi's is not changed, and one that cannot be read is no file at all", async () => {
  const pi = await piMcp();
  const native = JSON.stringify({ mcpServers: { a: { command: "x", enabled: false, exposure: "direct" }, b: { url: "https://b.example.test/mcp", auth: { provider: "p" } } }, autoEnableCodemode: false });
  const same = carryOver(pi, native, false);
  assert.equal(same.changed, false);
  assert.equal(same.dialect, false, "pi's own auth is not the adapter's");
  assert.deepEqual(same.file, JSON.parse(native));
  assert.ok(carryOver(pi, "{ nope", false).error);
  assert.ok(carryOver(pi, '{ // a comment\n "mcpServers": {} }', false).error, "pi cannot read comments either");
  assert.ok(carryOver(pi, "[1]", false).error);
  assert.deepEqual(carryOver(pi, "", false).file, { mcpServers: {} });
});

test("on the first start: the file is carried over, the adapter leaves pi's packages and its cache files go, and the log says so once", async () => {
  reset();
  logs.length = 0;
  writeFileSync(mcpFile, ADAPTER_FILE);
  listed([{ source: ADAPTER, extensions: ["extensions/index.ts"] }, "npm:pi-other"]);
  db.rememberTools([db.remembered({ name: "notes_read", source: "pi-mcp-adapter", package: ADAPTER }), db.remembered({ name: "other_tool", source: "pi-other", package: "npm:pi-other" })]);
  mkdirSync(path.join(home, ".config", "mcp"), { recursive: true });
  writeFileSync(path.join(home, ".config", "mcp", "mcp.json"), "{}");
  writeFileSync(path.join(agent, "mcp-cache.json"), "{}");
  writeFileSync(path.join(agent, "mcp-npx-cache.json"), "{}");

  await moveFromAdapter();
  assert.equal(existsSync(path.join(agent, "mcp-cache.json")) || existsSync(path.join(agent, "mcp-npx-cache.json")), false, "the adapter's own cache files go");
  const file = readFile();
  assert.deepEqual(file.mcpServers.notes, { command: "node", args: ["n.js"], env: { A: "1" } });
  assert.deepEqual(file.mcpServers.docs.headers, { Authorization: "Bearer ${DOCS_TOKEN}" });
  assert.equal(file.mcpServers["docs.v2"].enabled, false, "what pi cannot take stays in the file, off");
  assert.equal(statSync(mcpFile).mode & 0o777, 0o600);
  assert.equal(existsSync(`${mcpFile}.adapter`), false, "no copy beside it");
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")).packages, ["npm:pi-other"], "the adapter is out of pi's packages, and the rest is as it was");
  assert.equal(db.knownTools().some((t) => t.name === "notes_read"), false, "what the adapter registered is forgotten");
  assert.ok(db.knownTools().some((t) => t.name === "other_tool"));

  assert.equal(logs.length, 1, "one line");
  assert.match(logs[0], /6 servers .*carried over/);
  assert.match(logs[0], /pi-mcp-adapter taken out of pi's packages/);
  assert.match(logs[0], /Left off, as they were.*sock \(a Unix socket/);
  assert.match(logs[0], /gated \(tools that ask before each call/);
  assert.match(logs[0], /docs\.v2 \(pi does not take its name/);
  assert.match(logs[0], /nothing \(it is not a server\)/);
  assert.ok(logs[0].includes("what the adapter imported from cursor"), "the adapter's imports are named");
  assert.ok(logs[0].includes(path.join(home, ".config", "mcp", "mcp.json")), "and so is a shared file it read, which pi does not");
  assert.doesNotMatch(logs[0], /Switched off, whatever they were/, "no list names the adapter's tools: the servers are as they were");

  // Once: another start does nothing, and a file edited since is not touched.
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: { later: { command: "x", lifecycle: "eager" } } }));
  await moveFromAdapter();
  assert.deepEqual(readFile().mcpServers.later, { command: "x", lifecycle: "eager" });
  assert.equal(logs.length, 1);
});

test("a list that had the adapter's `mcp` tool off has every server's tools off by name now, the entry goes, a list that had it on only loses the entry, and a server with no tool to name is switched off", async () => {
  const pi = await piMcp();
  const tool = (server, name) => pi.createMcpToolName(server, name);
  const mine = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource", tool("notes", "read"), tool("notes", "write-it"), tool("gh", "list")];
  reset();
  logs.length = 0;
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: { notes: { command: "node", lifecycle: "lazy" }, gh: { command: "gh", directTools: true }, quiet: { command: "q" }, paused: { command: "p", disabled: true } } }));
  writeFileSync(path.join(agent, "mcp-cache.json"), JSON.stringify({ servers: { notes: { tools: [{ name: "read" }, { name: "write-it" }] }, gh: { tools: [{ name: "list" }] } } }));
  listed([{ source: ADAPTER, extensions: ["extensions/index.ts"] }]);
  const sql = db.getDb();
  sql.prepare("INSERT INTO project_tools (project, tools_off, tools_on) VALUES ('off', ?, ''), ('on', 'bash', ?), ('script', 'mcp_script\nwrite', ''), ('plain', 'bash', 'read')").run("mcp\nbash", "mcp\nread");
  sql.prepare("INSERT INTO agent_tools (agent, tools_off, tools_on) VALUES ('a', 'mcp', '')").run();
  sql.prepare("INSERT INTO chat_modes (id, label, tools_off, tools_on) VALUES ('m', 'M', 'mcpScript', '')").run();
  sql.prepare("INSERT INTO routines (id, slug, name, tools_off, tools_on) VALUES ('r', 'r', 'R', 'mcp', '')").run();
  db.createSession({ id: "mig-chat", title: "c", workspace: process.env.WORKSPACE_ROOT ?? home, executor: "host", tools_off: "mcp", tools_on: "mcp" });
  db.setToolDefaultsOff(["mcp", "web"]);
  const project = (name) => sql.prepare("SELECT tools_off, tools_on FROM project_tools WHERE project = ?").get(name);
  const lines = (text) => text.split("\n").filter(Boolean);

  await moveFromAdapter();
  const file = readFile();
  assert.equal(file.mcpServers.notes.enabled, undefined, "a server whose tools are named stays as it was");
  assert.equal(file.mcpServers.gh.enabled, undefined);
  assert.equal(file.mcpServers.paused.enabled, false);
  assert.equal(file.mcpServers.quiet.enabled, false, "no tool of it to name where MCP was off: it comes over off, not reachable there");
  assert.deepEqual(lines(project("off").tools_off), [...mine, "bash"].sort());
  assert.deepEqual(lines(project("script").tools_off), [...mine, "write"].sort(), "mcp_script is the same switch");
  assert.deepEqual(lines(project("on").tools_off), ["bash"], "a list with `mcp` on switches nothing off");
  assert.deepEqual(lines(project("on").tools_on), ["read"], "and its entry goes, the rest of the list stays");
  assert.deepEqual(project("plain"), { tools_off: "bash", tools_on: "read" }, "a list that does not name it is not touched");
  assert.deepEqual(lines(sql.prepare("SELECT tools_off FROM agent_tools WHERE agent = 'a'").get().tools_off), [...mine].sort());
  assert.deepEqual(lines(sql.prepare("SELECT tools_off FROM chat_modes WHERE id = 'm'").get().tools_off), [...mine].sort());
  assert.deepEqual(lines(sql.prepare("SELECT tools_off FROM routines WHERE id = 'r'").get().tools_off), [...mine].sort());
  const chat = sql.prepare("SELECT tools_off, tools_on FROM sessions WHERE id = 'mig-chat'").get();
  assert.deepEqual([lines(chat.tools_off), lines(chat.tools_on)], [[...mine].sort(), []], "a chat's own list as well; both entries go");
  assert.deepEqual(db.toolDefaultsOff(), [...mine, "web"].sort(), "and the portal-wide default");
  assert.equal(logs.length, 1);
  assert.match(logs[0], /7 lists of switches/);
  assert.match(logs[0], /never listed the tools of quiet, paused.*switched off, whatever they were/, "a server the adapter never listed has nothing to name, and is named");
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")).packages, [], "the adapter is out all the same");
});

test("a list that switched off one of the adapter's own tools is read as a list that had MCP off, and one that had it on switches nothing off", async () => {
  const pi = await piMcp();
  reset();
  logs.length = 0;
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: { github: { command: "gh", directTools: true }, late: { command: "l" } } }));
  writeFileSync(path.join(agent, "mcp-cache.json"), JSON.stringify({ servers: { github: { tools: [{ name: "delete_repo" }, { name: "list" }] } } }));
  listed([{ source: ADAPTER, extensions: ["extensions/index.ts"] }]);
  db.rememberTools([db.remembered({ name: "github_delete_repo", source: "pi-mcp-adapter", package: ADAPTER })]);
  const sql = db.getDb();
  sql.prepare("INSERT INTO project_tools (project, tools_off, tools_on) VALUES ('p', 'github_delete_repo', ''), ('q', '', 'github_delete_repo')").run();
  db.setToolDefaultsOff(["github_delete_repo"]);
  const gone = pi.createMcpToolName("github", "delete_repo");
  const lines = (project, column) => sql.prepare(`SELECT ${column} AS v FROM project_tools WHERE project = ?`).get(project).v.split("\n").filter(Boolean);

  await moveFromAdapter();
  const { toolEnabled } = await import("../dist/tool-policy.js");
  assert.ok(lines("p", "tools_off").includes(gone), "the tool comes back under pi's name and is off in the list that had it off");
  assert.ok(db.toolDefaultsOff().includes(gone) && db.toolDefaultsOff().includes(pi.createMcpToolName("github", "list")), "the portal-wide default as well, and the server's other tools");
  assert.equal(toolEnabled(gone, db.toolDefaultsOff(), { off: lines("p", "tools_off"), on: [] }), false);
  assert.deepEqual(lines("q", "tools_off"), [], "a list that had it on switches nothing off");
  assert.deepEqual(lines("q", "tools_on"), ["github_delete_repo"]);
  assert.equal(readFile().mcpServers.late.enabled, false, "a server with no tool to name is off");
  assert.equal(readFile().mcpServers.github.enabled, undefined);
  assert.match(logs[0], /Switches that named the adapter's own tools in a list that had it on do nothing now/);
});

test("no list is touched where none had `mcp` or one of the adapter's tools off, and the servers stay as they were", async () => {
  reset();
  logs.length = 0;
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: { notes: { command: "node", lifecycle: "lazy" } } }));
  listed([{ source: ADAPTER, extensions: ["extensions/index.ts"] }]);
  db.getDb().prepare("INSERT INTO project_tools (project, tools_off, tools_on) VALUES ('p', 'bash', 'read')").run();
  await moveFromAdapter();
  assert.deepEqual(readFile().mcpServers.notes, { command: "node" });
  assert.deepEqual(db.getDb().prepare("SELECT tools_off, tools_on FROM project_tools WHERE project = 'p'").get(), { tools_off: "bash", tools_on: "read" });
  assert.doesNotMatch(logs[0], /had the adapter's `mcp` tool/);
});

test("`approveTools: []`, the adapter's \"no tool asks first\", is no gate: the server comes over on, and one that names tools is still left off", async () => {
  const pi = await piMcp();
  const moved = carryOver(pi, JSON.stringify({ mcpServers: { a: { command: "npx", args: ["-y", "x"], approveTools: [] }, b: { command: "b" }, c: { command: "c", approveTools: ["delete"] } }, settings: { approveTools: [] } }), false);
  assert.deepEqual(moved.carried, ["a", "b"]);
  assert.deepEqual(moved.left.map((l) => l.name), ["c"]);
  assert.equal(moved.file.mcpServers.a.enabled, undefined);
  assert.equal("approveTools" in moved.file.mcpServers.a, false, "the adapter's key that asks for nothing is not carried on");
  // A server's own `approveTools: false` outweighs the setting that covers the others, and is gone as well; `oauth: false` is the adapter's word and goes.
  const own = carryOver(pi, JSON.stringify({ mcpServers: { d: { url: "https://d.example.test/mcp", oauth: false, approveTools: false } }, settings: { approveTools: true } }), false);
  assert.deepEqual(own.left, []);
  assert.deepEqual(own.file.mcpServers.d, { url: "https://d.example.test/mcp" });
});

test("an adapter that was switched off, or never installed, leaves its servers off: nothing ran, and nothing starts", async () => {
  for (const packages of [[{ source: ADAPTER, extensions: [], skills: [], prompts: [], themes: [] }], []]) {
    reset();
    logs.length = 0;
    writeFileSync(mcpFile, JSON.stringify({ mcpServers: { notes: { command: "node", lifecycle: "lazy" } } }));
    listed(packages);
    await moveFromAdapter();
    assert.deepEqual(readFile().mcpServers.notes, { command: "node", enabled: false }, JSON.stringify(packages));
    assert.equal(JSON.parse(readFileSync(settingsFile, "utf8")).packages.length, 0);
  }
});

test("a switched-off adapter with a plain file: the servers are off in the file written, not only where the adapter's keys were", async () => {
  reset();
  logs.length = 0;
  writeFileSync(mcpFile, '{"mcpServers":{"plain":{"command":"node","args":["s.js"]}}}');
  listed([{ source: ADAPTER, extensions: [], skills: [], prompts: [], themes: [] }]);
  await moveFromAdapter();
  assert.deepEqual(readFile().mcpServers.plain, { command: "node", args: ["s.js"], enabled: false });
});

test("a file that is already pi's, with no adapter, is left as it is and nothing is said", async () => {
  reset();
  logs.length = 0;
  const native = JSON.stringify({ mcpServers: { a: { command: "x" } } });
  writeFileSync(mcpFile, native);
  listed(["npm:pi-other"]);
  await moveFromAdapter();
  assert.equal(readFileSync(mcpFile, "utf8"), native);
  assert.equal(logs.length, 0);
  assert.equal(db.getSetting("mcp_adapter_moved"), "1", "and it is not looked at again");
});

test("a file that cannot be parsed is not touched, the adapter stays, and the move is made on a start after", async () => {
  reset();
  logs.length = 0;
  const broken = '{ "mcpServers": { "a": { "command": "x", "lifecycle": "lazy" }, } ';
  writeFileSync(mcpFile, broken);
  listed([ADAPTER]);
  await moveFromAdapter();
  assert.equal(readFileSync(mcpFile, "utf8"), broken);
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")).packages, [ADAPTER]);
  assert.equal(db.getSetting("mcp_adapter_moved"), undefined);
  writeFileSync(mcpFile, '{ "mcpServers": { "a": { "command": "x", "lifecycle": "lazy" } } }');
  await moveFromAdapter();
  assert.deepEqual(readFile().mcpServers.a, { command: "x" });
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")).packages, []);
});

test("a server at an address that looks like the old SSE transport is left off and named: pi speaks streamable HTTP only", async () => {
  const pi = await piMcp();
  const moved = carryOver(pi, JSON.stringify({ mcpServers: { sse: { url: "http://localhost:8000/sse" }, other: { url: "http://localhost:8000/mcp" }, query: { url: "http://h.example.test/events/sse?x=1" } } }), false);
  assert.deepEqual(moved.carried, ["other"]);
  assert.deepEqual(moved.left.map((l) => l.name).sort(), ["query", "sse"]);
  assert.match(moved.left[0].why, /SSE/);
  assert.equal(moved.file.mcpServers.sse.enabled, false);
});
