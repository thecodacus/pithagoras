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
  db.getDb().prepare("DELETE FROM project_tools").run();
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
  assert.deepEqual(moved.carried.sort(), ["keepsOwnHeader", "notes", "ownAuth", "paused", "plain"]);
  assert.deepEqual(moved.left.map((l) => l.name).sort(), ["blocked", "docs", "docs.v2", "envish", "filtered", "gated", "nothing", "sock"]);
  for (const name of ["blocked", "docs", "docs.v2", "envish", "filtered", "gated", "sock"]) assert.equal(s[name].enabled, false, `${name} is off`);
  assert.deepEqual(s.docs, { url: "https://docs.example.test/mcp", auth: "bearer", bearerTokenEnv: "DOCS_TOKEN", enabled: false }, "and as it was, nothing of it lost");
  assert.equal("nothing" in s, false, "an entry that is no server is only named");
  assert.match(moved.left.find((l) => l.name === "gated").why, /ask before each call/);
  assert.match(moved.left.find((l) => l.name === "docs").why, /bearer token/);
  assert.match(moved.left.find((l) => l.name === "envish").why, /\$env:NAME/);
  assert.match(moved.left.find((l) => l.name === "filtered").why, /leaves out/);
  assert.match(moved.left.find((l) => l.name === "docs.v2").why, /name/);
  assert.equal("settings" in moved.file || "imports" in moved.file, false);
  assert.deepEqual(moved.imports, ["cursor", "claude-code"]);
  // Where nothing ran under the adapter, nothing starts now.
  assert.equal(carryOver(pi, ADAPTER_FILE, true).file.mcpServers.notes.enabled, false);
});

test("the adapter's setting that asks before every call leaves every server it covers off, and one server's own false takes it out", async () => {
  const pi = await piMcp();
  const moved = carryOver(pi, JSON.stringify({ mcpServers: { a: { command: "a" }, b: { command: "b", approveTools: false } }, settings: { approveTools: true } }), false);
  assert.deepEqual(moved.left.map((l) => l.name), ["a"]);
  assert.deepEqual(moved.carried, ["b"]);
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
  db.getDb().prepare("INSERT OR REPLACE INTO project_tools (project, tools_off, tools_on) VALUES ('p', 'mcp', '')").run();
  mkdirSync(path.join(home, ".config", "mcp"), { recursive: true });
  writeFileSync(path.join(home, ".config", "mcp", "mcp.json"), "{}");
  writeFileSync(path.join(agent, "mcp-cache.json"), "{}");
  writeFileSync(path.join(agent, "mcp-npx-cache.json"), "{}");

  await moveFromAdapter();
  assert.equal(existsSync(path.join(agent, "mcp-cache.json")) || existsSync(path.join(agent, "mcp-npx-cache.json")), false, "the adapter's own cache files go");
  const file = readFile();
  assert.deepEqual(file.mcpServers.notes, { command: "node", args: ["n.js"], env: { A: "1" } });
  assert.equal(file.mcpServers.docs.enabled, false);
  assert.equal(file.mcpServers["docs.v2"].enabled, false, "what pi cannot take stays in the file, off");
  assert.equal(statSync(mcpFile).mode & 0o777, 0o600);
  assert.equal(existsSync(`${mcpFile}.adapter`), false, "no copy beside it");
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")).packages, ["npm:pi-other"], "the adapter is out of pi's packages, and the rest is as it was");
  assert.equal(db.knownTools().some((t) => t.name === "notes_read"), false, "what the adapter registered is forgotten");
  assert.ok(db.knownTools().some((t) => t.name === "other_tool"));

  assert.equal(logs.length, 1, "one line");
  assert.match(logs[0], /5 servers .*carried over/);
  assert.match(logs[0], /pi-mcp-adapter taken out of pi's packages/);
  assert.match(logs[0], /Left off, as they were.*sock \(a Unix socket/);
  assert.match(logs[0], /gated \(tools that ask before each call/);
  assert.match(logs[0], /docs\.v2 \(pi does not take its name/);
  assert.match(logs[0], /nothing \(it is not a server\)/);
  assert.ok(logs[0].includes("what the adapter imported from cursor"), "the adapter's imports are named");
  assert.ok(logs[0].includes(path.join(home, ".config", "mcp", "mcp.json")), "and so is a shared file it read, which pi does not");
  assert.match(logs[0], /Switches that named the adapter's tools or its `mcp` tool do nothing now/, "a project that had the adapter's mcp tool off is told");

  // Once: another start does nothing, and a file edited since is not touched.
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: { later: { command: "x", lifecycle: "eager" } } }));
  await moveFromAdapter();
  assert.deepEqual(readFile().mcpServers.later, { command: "x", lifecycle: "eager" });
  assert.equal(logs.length, 1);
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
