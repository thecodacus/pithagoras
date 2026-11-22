import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
const reset = () => db.putSetting("mcp_adapter_moved", "");
const logs = [];
const original = console.log;
console.log = (...args) => (/^\[portal\] MCP:/.test(String(args[0])) ? logs.push(String(args[0])) : original(...args));
const sql = db.getDb();

test("the adapter's servers are put into pi's words: its keys go, on and off stay, a bearer token is a header, and what pi has no word for is left off", async () => {
  const pi = await piMcp();
  const moved = carryOver(pi, ADAPTER_FILE, true);
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
  const idle = carryOver(pi, ADAPTER_FILE, false);
  assert.equal(idle.file.mcpServers.notes.enabled, false);
  assert.equal(idle.file.mcpServers.docs.enabled, false);
});

test("a file that is already pi's is not changed, and one that cannot be read is no file at all", async () => {
  const pi = await piMcp();
  const native = JSON.stringify({ mcpServers: { a: { command: "x", enabled: false, exposure: "direct" }, b: { url: "https://b.example.test/mcp" } }, autoEnableCodemode: false });
  const same = carryOver(pi, native, true);
  assert.equal(same.changed, false);
  assert.deepEqual(same.file, JSON.parse(native));
  assert.ok(carryOver(pi, "{ nope", true).error);
  assert.ok(carryOver(pi, "[1]", true).error);
  assert.deepEqual(carryOver(pi, "", true).file, { mcpServers: {} });
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
  assert.match(logs[0], /5 servers .*carried over/);
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
