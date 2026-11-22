import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

/**
 * pi-mcp-adapter's configuration carried over to pi's own MCP support, once, as the portal starts: the file in pi's
 * dialect, the adapter out of pi's packages, the names of its tools in the switches changed, and one line in the log.
 */
inProcessHome("pithagoras-mcp-migration-");
const agent = process.env.PI_CODING_AGENT_DIR;
const mcpFile = path.join(agent, "mcp.json");
const settingsFile = path.join(agent, "settings.json");
const ADAPTER = "npm:pi-mcp-adapter@2.18.0";

const db = await import("../dist/db.js");
const { moveFromAdapter, carryOver } = await import("../dist/mcp-migration.js");
const { piMcp } = await import("../dist/pi/mcp-config.js");

const ADAPTER_FILE = `{
  // the servers, as the adapter reads them: it takes comments
  "mcpServers": {
    "notes": { "command": "node", "args": ["n.js"], "env": { "A": "1" }, "lifecycle": "lazy", "directTools": true, "idleTimeout": 5, "debug": true },
    "paused": { "command": "node", "disabled": true },
    "docs": { "url": "https://docs.example.test/mcp", "auth": "bearer", "bearerTokenEnv": "DOCS_TOKEN", "requestTimeoutMs": 5000, "headers": { "X-Org": "a" } },
    "keyed": { "url": "https://k.example.test/mcp", "auth": "bearer", "bearerToken": "tok" },
    "signed-in": { "url": "https://o.example.test/mcp", "auth": "oauth" },
    "sock": { "socket": "/run/x.sock" },
    "filtered": { "command": "f", "excludeTools": ["delete_*"] },
    "docs.v2": { "command": "d" },
    "nothing": null
  },
  "settings": { "toolPrefix": "server", "directTools": true },
  "imports": ["cursor", "claude-code"]
}`;
const listed = (packages) => writeFileSync(settingsFile, JSON.stringify({ packages }));
const sql = db.getDb();
/** The move undone, and what an earlier test left in the switches gone. */
const reset = () => {
  db.putSetting("mcp_adapter_moved", "");
  for (const table of ["project_tools", "agent_tools", "routines", "chat_modes"]) sql.prepare(`DELETE FROM ${table}`).run();
  sql.prepare("UPDATE sessions SET tools_off = '', tools_on = ''").run();
  db.setToolDefaultsOff([]);
  db.setToolMarks({});
  rmSync(`${mcpFile}.adapter`, { force: true });
};
const logs = [];
const original = console.log;
console.log = (...args) => (/^\[portal\] MCP:/.test(String(args[0])) ? logs.push(String(args[0])) : original(...args));

test("the adapter's servers are put into pi's words: its keys go, on and off stay, a bearer token is a header, and what pi has no word for is left off", async () => {
  const pi = await piMcp();
  const moved = carryOver(pi, ADAPTER_FILE, "on");
  assert.equal(moved.error, undefined);
  const s = moved.file.mcpServers;
  assert.deepEqual(s.notes, { command: "node", args: ["n.js"], env: { A: "1" } }, "the adapter's lifecycle, directTools, idleTimeout and debug are gone");
  assert.deepEqual(s.paused, { command: "node", enabled: false }, "off as it was");
  assert.deepEqual(s.docs, { url: "https://docs.example.test/mcp", headers: { "X-Org": "a", Authorization: "Bearer ${DOCS_TOKEN}" } }, "a token named from the environment stays named");
  assert.deepEqual(s.keyed.headers, { Authorization: "Bearer tok" });
  assert.deepEqual(s["signed-in"], { url: "https://o.example.test/mcp" }, "pi signs in by itself when the server asks");
  assert.deepEqual(moved.carried.sort(), ["docs", "keyed", "notes", "paused", "signed-in"]);
  assert.deepEqual(moved.left.map((l) => l.name).sort(), ["docs.v2", "filtered", "nothing", "sock"]);
  assert.equal(s.sock.enabled, false);
  assert.equal(s.filtered.enabled, false);
  assert.match(moved.left.find((l) => l.name === "filtered").why, /leaves out/);
  assert.match(moved.left.find((l) => l.name === "docs.v2").why, /name/);
  assert.equal("settings" in moved.file, false);
  assert.deepEqual(moved.imports, ["cursor", "claude-code"]);
  // Without the adapter on, nothing ran, and nothing starts now.
  const idle = carryOver(pi, ADAPTER_FILE, "off");
  assert.equal(idle.file.mcpServers.notes.enabled, false);
  assert.equal(idle.file.mcpServers.docs.enabled, false);
});

test("a file that is already pi's is not changed, and one that cannot be read is no file at all", async () => {
  const pi = await piMcp();
  const native = JSON.stringify({ mcpServers: { a: { command: "x", enabled: false, exposure: "direct" }, b: { url: "https://b.example.test/mcp" } }, autoEnableCodemode: false });
  const same = carryOver(pi, native, "on");
  assert.equal(same.changed, false);
  assert.deepEqual(same.file, JSON.parse(native));
  assert.ok(carryOver(pi, "{ nope", "on").error);
  assert.ok(carryOver(pi, "[1]", "on").error);
  assert.deepEqual(carryOver(pi, "", "on").file, { mcpServers: {} });
});

test("on the first start: the file is carried over and kept as it was, the adapter leaves pi's packages, the names of its tools in the switches are pi's, and the log says so once", async () => {
  reset();
  logs.length = 0;
  writeFileSync(mcpFile, ADAPTER_FILE);
  listed([{ source: ADAPTER, extensions: ["extensions/index.ts"] }, "npm:pi-other"]);
  db.rememberTools([
    db.remembered({ name: "notes_read", source: "pi-mcp-adapter", package: ADAPTER }),
    db.remembered({ name: "notes_write", source: "pi-mcp-adapter", package: ADAPTER }),
    db.remembered({ name: "docs_search", source: "pi-mcp-adapter", package: ADAPTER }),
    db.remembered({ name: "mcp", source: "pi-mcp-adapter", package: ADAPTER }),
    db.remembered({ name: "other_tool", source: "pi-other", package: "npm:pi-other" }),
  ]);
  db.setToolDefaultsOff(["docs_search", "bash"]);
  db.createSession({ id: "moved-chat", title: "c", workspace: "/tmp", executor: "host" });
  sql.prepare("UPDATE sessions SET tools_off = ?, tools_on = ? WHERE id = ?").run("notes_write\nbash", "docs_search", "moved-chat");
  sql.prepare("INSERT OR REPLACE INTO project_tools (project, tools_off, tools_on) VALUES ('p', 'mcp', '')").run();
  db.setToolMarks({ "<tool>notes_read": "direct", notes: "lazy" });
  writeFileSync(path.join(agent, "mcp-cache.json"), "{}");
  writeFileSync(path.join(agent, "mcp-npx-cache.json"), "{}");

  await moveFromAdapter();
  assert.equal(existsSync(path.join(agent, "mcp-cache.json")) || existsSync(path.join(agent, "mcp-npx-cache.json")), false, "the adapter's own cache files go");

  const file = JSON.parse(readFileSync(mcpFile, "utf8"));
  assert.deepEqual(Object.keys(file.mcpServers).sort(), ["docs", "filtered", "keyed", "notes", "paused", "signed-in", "sock"], "what pi can read is in the file, the two it cannot (a name it does not take, no server at all) only in the copy");
  assert.deepEqual(file.mcpServers.notes, { command: "node", args: ["n.js"], env: { A: "1" } });
  assert.equal(file.mcpServers.paused.enabled, false);
  assert.equal(statSync(mcpFile).mode & 0o777, 0o600);
  assert.equal(readFileSync(`${mcpFile}.adapter`, "utf8"), ADAPTER_FILE, "the file as it was");
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")).packages, ["npm:pi-other"], "the adapter is out of pi's packages, and the rest is as it was");
  assert.equal(db.knownTools().some((t) => t.name === "notes_read"), false, "what the adapter registered is forgotten");
  assert.ok(db.knownTools().some((t) => t.name === "other_tool"));

  // The names the switches hold are pi's now: a tool that was off is off, and the adapter's `mcp` tool, off for a project, is every server's.
  const off = db.toolDefaultsOff();
  assert.ok(off.includes("mcp__docs__search") && off.includes("bash") && !off.includes("docs_search"));
  const chat = sql.prepare("SELECT tools_off, tools_on FROM sessions WHERE id = 'moved-chat'").get();
  assert.deepEqual(chat.tools_off.split("\n").sort(), ["bash", "mcp__notes__write"]);
  assert.equal(chat.tools_on, "mcp__docs__search");
  const project = sql.prepare("SELECT tools_off FROM project_tools WHERE project = 'p'").get();
  assert.deepEqual(project.tools_off.split("\n").sort(), ["mcp", "mcp__docs__search", "mcp__notes__read", "mcp__notes__write"]);
  assert.deepEqual(db.toolMarks(), { "<tool>mcp__notes__read": "direct", notes: "lazy" }, "a mark on a tool goes with it; one on a server is by its name, and stays");

  assert.equal(logs.length, 1, "one line");
  assert.match(logs[0], /3 servers .*carried over/);
  // A project had the adapter's own tool off, and nothing is known of these two servers' tools: they stay off rather than start there.
  assert.equal(file.mcpServers.keyed.enabled, false);
  assert.equal(file.mcpServers["signed-in"].enabled, false);
  assert.match(logs[0], /keyed \(the tools of it are not known/);
  assert.equal("enabled" in file.mcpServers.notes, false, "a server whose tools are known is not touched");
  assert.match(logs[0], /pi-mcp-adapter taken out of pi's packages/);
  assert.match(logs[0], /Left off, which pi cannot take as they were.*: .*sock \(a Unix socket/);
  assert.match(logs[0], /filtered \(a list of tools it leaves out/);
  assert.match(logs[0], /docs\.v2 \(pi does not take its name/);
  assert.match(logs[0], /cursor, claude-code/);

  // Once: another start does nothing, and a file edited since is not touched.
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: { later: { command: "x", lifecycle: "eager" } } }));
  await moveFromAdapter();
  assert.deepEqual(JSON.parse(readFileSync(mcpFile, "utf8")).mcpServers.later, { command: "x", lifecycle: "eager" });
  assert.equal(logs.length, 1);
});

test("an adapter that was switched off, or never installed, leaves its servers off: nothing ran, and nothing starts", async () => {
  for (const packages of [[{ source: ADAPTER, extensions: [], skills: [], prompts: [], themes: [] }], []]) {
    reset();
    logs.length = 0;
    writeFileSync(mcpFile, JSON.stringify({ mcpServers: { notes: { command: "node", lifecycle: "lazy" } } }));
    listed(packages);
    await moveFromAdapter();
    assert.deepEqual(JSON.parse(readFileSync(mcpFile, "utf8")).mcpServers.notes, { command: "node", enabled: false }, JSON.stringify(packages));
    assert.equal(JSON.parse(readFileSync(settingsFile, "utf8")).packages.length, 0);
  }
});

test("a file that is already pi's, with no adapter, is left as it is and nothing is said", async () => {
  reset();
  logs.length = 0;
  const native = JSON.stringify({ mcpServers: { a: { command: "x" } } });
  writeFileSync(mcpFile, native);
  listed(["npm:pi-other"]);
  await moveFromAdapter();
  assert.equal(readFileSync(mcpFile, "utf8"), native);
  assert.equal(existsSync(`${mcpFile}.adapter`) && readFileSync(`${mcpFile}.adapter`, "utf8") === native, false, "no copy of what did not change");
  assert.equal(logs.length, 0);
  assert.equal(db.getSetting("mcp_adapter_moved"), "1", "and it is not looked at again");
});

test("a file that cannot be parsed is not touched, the adapter stays, and the move is made on a start after", async () => {
  reset();
  logs.length = 0;
  writeFileSync(mcpFile, '{ "mcpServers": { "a": { "command": "x", "lifecycle": "lazy" }, } ');
  listed([ADAPTER]);
  await moveFromAdapter();
  assert.equal(readFileSync(mcpFile, "utf8"), '{ "mcpServers": { "a": { "command": "x", "lifecycle": "lazy" }, } ');
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")).packages, [ADAPTER]);
  assert.equal(db.getSetting("mcp_adapter_moved"), undefined);
  writeFileSync(mcpFile, '{ "mcpServers": { "a": { "command": "x", "lifecycle": "lazy" } } }');
  await moveFromAdapter();
  assert.deepEqual(JSON.parse(readFileSync(mcpFile, "utf8")).mcpServers.a, { command: "x" });
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")).packages, []);
});

const adapterOnFile = (servers, extra = {}) => JSON.stringify({ mcpServers: servers, ...extra });
const readFile = () => JSON.parse(readFileSync(mcpFile, "utf8"));

test("an adapter that is switched off, with a plain file: the servers are off in the file written, not only where the adapter's keys were", async () => {
  const pi = await piMcp();
  const plain = '{"mcpServers":{"plain":{"command":"node","args":["s.js"]}}}';
  const moved = carryOver(pi, plain, "off");
  assert.equal(moved.file.mcpServers.plain.enabled, false);
  assert.equal(moved.changed, true, "so that it is written");
  assert.equal(carryOver(pi, plain, "none").changed, false, "no adapter in sight: the person's file, kept as it is");
  assert.equal(carryOver(pi, plain, "on").changed, false);
  reset();
  logs.length = 0;
  writeFileSync(mcpFile, plain);
  listed([{ source: ADAPTER, extensions: [], skills: [], prompts: [], themes: [] }]);
  await moveFromAdapter();
  assert.deepEqual(readFile().mcpServers.plain, { command: "node", args: ["s.js"], enabled: false });
  assert.equal(logs.length, 1);
});

test("a plain file with comments, which the adapter read and pi cannot, is written without them while the adapter is on", async () => {
  const pi = await piMcp();
  const commented = '{\n  // my server\n  "mcpServers": { "plain": { "command": "node" } }\n}';
  const moved = carryOver(pi, commented, "on");
  assert.equal(moved.changed, true);
  assert.deepEqual(moved.file, { mcpServers: { plain: { command: "node" } } });
  reset();
  writeFileSync(mcpFile, commented);
  listed([ADAPTER]);
  await moveFromAdapter();
  assert.deepEqual(readFile(), { mcpServers: { plain: { command: "node" } } }, "pi can read it now");
  assert.equal(readFileSync(`${mcpFile}.adapter`, "utf8"), commented);
});

test("the adapter's own spellings of a variable ($env:NAME, {env:NAME}) are ${NAME} in pi's words; a server with one in a place pi does not read them is left off", async () => {
  const pi = await piMcp();
  const moved = carryOver(pi, adapterOnFile({
    gh: { url: "https://x.example/mcp", headers: { Authorization: "Bearer $env:GH_TOKEN", "X-Other": "{env:OTHER}-${KEPT}" }, lifecycle: "lazy" },
    st: { command: "node", env: { KEY: "$env:KEY", PLAIN: "a" } },
    b: { url: "https://b.example/mcp", auth: "bearer", bearerToken: "$env:TOK" },
    inurl: { url: "https://${HOST}/mcp" },
    incwd: { command: "node", cwd: "$env:HOME/x" },
    inargs: { command: "node", args: ["--key", "{env:KEY}"] },
  }), "on");
  const s = moved.file.mcpServers;
  assert.deepEqual(s.gh.headers, { Authorization: "Bearer ${GH_TOKEN}", "X-Other": "${OTHER}-${KEPT}" });
  assert.deepEqual(s.st.env, { KEY: "${KEY}", PLAIN: "a" });
  assert.deepEqual(s.b.headers, { Authorization: "Bearer ${TOK}" });
  assert.deepEqual(moved.carried.sort(), ["b", "gh", "st"]);
  assert.deepEqual(moved.left.map((l) => l.name).sort(), ["inargs", "incwd", "inurl"]);
  assert.ok(moved.left.every((l) => /variables in its url, folder or arguments/.test(l.why)));
  assert.ok(["inurl", "incwd", "inargs"].every((name) => s[name].enabled === false));
  // What pi resolves it to: the variable, not one called `env`.
  process.env.PITHAGORAS_TEST_TOK = "t0k";
  const root = import.meta.resolve("@earendil-works/pi-coding-agent");
  const { resolveConfigValueOrThrow } = await import(new URL("./core/resolve-config-value.js", root).href);
  assert.equal(resolveConfigValueOrThrow("Bearer ${PITHAGORAS_TEST_TOK}", "t"), "Bearer t0k");
  assert.throws(() => resolveConfigValueOrThrow("Bearer $env:PITHAGORAS_TEST_TOK", "t"), "the adapter's spelling would have failed to connect");
});

/** The adapter's tool naming, in each of its modes, and pi's names for the same tools. */
test("the names in the switches are rebuilt by the adapter's own naming (toolPrefix: server, short, mcp, none; a server's own beats the settings'), from the tools it had cached", async () => {
  const pi = await piMcp();
  const servers = { "github-mcp": { command: "g" }, "own-short": { command: "o", toolPrefix: "short" }, plain: { command: "p", toolPrefix: "none" }, "viamcp": { command: "m", toolPrefix: "mcp" } };
  const moved = carryOver(pi, adapterOnFile(servers, { settings: { toolPrefix: "short" } }), "on");
  assert.deepEqual([...moved.naming].sort(), [["github-mcp", "short"], ["own-short", "short"], ["plain", "none"], ["viamcp", "mcp"]]);
  const { adapterPrefix, toolNames } = await import("../dist/mcp-migration.js");
  assert.equal(adapterPrefix("github-mcp", "server"), "github_mcp");
  assert.equal(adapterPrefix("github-mcp", "short"), "github");
  assert.equal(adapterPrefix("viamcp", "mcp"), "mcp__viamcp");
  assert.equal(adapterPrefix("plain", "none"), "");
  const cache = new Map([["github-mcp", ["delete_repo", "list.repos"]], ["plain", ["read_it"]], ["viamcp", ["ping"]]]);
  const names = toolNames(pi, moved.naming, cache, ["github_delete_repo"]);
  assert.equal(names.map.get("github_delete_repo"), "mcp__github_mcp__delete_repo");
  assert.equal(names.map.get("github_list_repos"), "mcp__github_mcp__list_repos", "a tool's own dot is an underscore");
  assert.equal(names.map.get("read_it"), "mcp__plain__read_it", "no prefix: told by the cache alone");
  assert.equal(names.map.get("mcp__viamcp_ping"), "mcp__viamcp__ping");
  assert.deepEqual([...names.byServer.get("github-mcp")].sort(), ["mcp__github_mcp__delete_repo", "mcp__github_mcp__list_repos"]);
});

test("tools reached through the adapter's mcp tool (never registered one by one) keep their switches: from the cache, which goes after; a project that had mcp off keeps every server's tools off, and a server of unknown tools off", async () => {
  reset();
  logs.length = 0;
  writeFileSync(mcpFile, adapterOnFile({ github: { command: "g", lifecycle: "lazy" }, fresh: { command: "f" } }));
  listed([ADAPTER]);
  writeFileSync(path.join(agent, "mcp-cache.json"), JSON.stringify({ version: 1, servers: { github: { tools: [{ name: "delete_repository" }, { name: "list_issues" }] } } }));
  db.rememberTools([db.remembered({ name: "mcp", source: "pi-mcp-adapter", package: ADAPTER })]);
  db.setToolDefaultsOff(["github_delete_repository"]);
  sql.prepare("INSERT OR REPLACE INTO project_tools (project, tools_off, tools_on) VALUES ('only-mcp-off', 'mcp', '')").run();
  sql.prepare("INSERT OR REPLACE INTO project_tools (project, tools_off, tools_on) VALUES ('by-name', 'github_list_issues', '')").run();
  await moveFromAdapter();
  assert.ok(db.toolDefaultsOff().includes("mcp__github__delete_repository"), "the switch of a tool nothing had registered one by one");
  assert.equal(db.toolDefaultsOff().includes("github_delete_repository"), false);
  const project = (name) => sql.prepare("SELECT tools_off FROM project_tools WHERE project = ?").get(name).tools_off.split("\n").sort();
  assert.deepEqual(project("by-name"), ["mcp__github__list_issues"]);
  assert.deepEqual(project("only-mcp-off"), ["mcp", "mcp__github__delete_repository", "mcp__github__list_issues"]);
  assert.equal(readFile().mcpServers.fresh.enabled, false, "its tools are not known, and a project had MCP off");
  assert.equal("enabled" in readFile().mcpServers.github, false);
  assert.match(logs[0], /fresh \(the tools of it are not known/);
  assert.equal(existsSync(path.join(agent, "mcp-cache.json")), false);
});

test("an exception that turned the adapter's mcp tool on did not turn on the tools that were off by themselves: nor does it now", async () => {
  reset();
  writeFileSync(mcpFile, adapterOnFile({ notes: { command: "n", lifecycle: "lazy" } }));
  listed([ADAPTER]);
  writeFileSync(path.join(agent, "mcp-cache.json"), JSON.stringify({ servers: { notes: { tools: [{ name: "read" }, { name: "delete" }] } } }));
  db.setToolDefaultsOff(["mcp", "notes_delete"]);
  sql.prepare("INSERT OR REPLACE INTO project_tools (project, tools_off, tools_on) VALUES ('p', '', 'mcp')").run();
  sql.prepare("INSERT OR REPLACE INTO project_tools (project, tools_off, tools_on) VALUES ('q', 'notes_read', 'mcp')").run();
  const { toolEnabled } = await import("../dist/tool-policy.js");
  await moveFromAdapter();
  const defaults = db.toolDefaultsOff();
  assert.ok(defaults.includes("mcp__notes__read") && defaults.includes("mcp__notes__delete"), "off by default, as the mcp tool was");
  const row = (name) => sql.prepare("SELECT tools_off, tools_on FROM project_tools WHERE project = ?").get(name);
  const on = (name) => row(name).tools_on.split("\n").sort();
  assert.deepEqual(on("p"), ["mcp", "mcp__notes__read"], "what was on by the exception, and the tool that was off by itself is not");
  const exceptions = (name) => ({ off: row(name).tools_off.split("\n").filter(Boolean), on: on(name) });
  assert.equal(toolEnabled("mcp__notes__delete", defaults, exceptions("p")), false, "still off in the project, as before");
  assert.equal(toolEnabled("mcp__notes__read", defaults, exceptions("p")), true);
  assert.equal(toolEnabled("mcp__notes__read", defaults, exceptions("q")), false, "off in the project by name, as it was");
});

test("a project's own .pi/mcp.json in the adapter's dialect is named in the log line, not converted", async () => {
  reset();
  logs.length = 0;
  const folder = path.join(process.env.WORKSPACE_ROOT, "proj-with-adapter-file");
  mkdirSync(path.join(folder, ".pi"), { recursive: true });
  const projectFile = path.join(folder, ".pi", "mcp.json");
  const own = JSON.stringify({ mcpServers: { a: { url: "https://a.example/mcp", auth: "bearer", bearerToken: "t" } } });
  writeFileSync(projectFile, own);
  const fine = path.join(process.env.WORKSPACE_ROOT, "proj-native");
  mkdirSync(path.join(fine, ".pi"), { recursive: true });
  writeFileSync(path.join(fine, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { a: { command: "x" } } }));
  writeFileSync(mcpFile, adapterOnFile({ notes: { command: "n", lifecycle: "lazy" } }));
  listed([ADAPTER]);
  await moveFromAdapter();
  assert.equal(readFileSync(projectFile, "utf8"), own, "left as it is");
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes(projectFile), "named");
  assert.equal(logs[0].includes(path.join(fine, ".pi", "mcp.json")), false, "a file pi reads as it is is not named");
});
