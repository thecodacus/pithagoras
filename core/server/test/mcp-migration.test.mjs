import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    gatedList: { command: "node", approveTools: ["delete_*"], enabled: false },
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
  db.putSetting("mcp_adapter_held", "");
  for (const table of ["project_tools", "agent_tools", "chat_modes", "routines"]) db.getDb().prepare(`DELETE FROM ${table}`).run();
  db.getDb().prepare("DELETE FROM sessions WHERE id LIKE 'mig-%'").run();
  db.setToolDefaultsOff([]);
  // The copies of the file a move keeps beside it.
  for (const name of readdirSync(agent)) if (name.startsWith("mcp.json.adapter")) rmSync(path.join(agent, name));
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
  assert.deepEqual(moved.carried.sort(), ["docs", "filtered", "gated", "gatedList", "keepsOwnHeader", "notes", "ownAuth", "paused", "plain"]);
  assert.deepEqual(moved.left.map((l) => l.name).sort(), ["blocked", "docs.v2", "envish", "nothing", "sock"]);
  for (const name of ["blocked", "docs.v2", "envish", "sock"]) assert.equal(s[name].enabled, false, `${name} is off`);
  // What a server left out is pi's toolExposure now, and the server stays on.
  assert.deepEqual(s.filtered, { command: "f", toolExposure: { "delete_*": "hidden" } });
  assert.deepEqual(s.docs, { url: "https://docs.example.test/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } }, "the bearer variable is an Authorization header in pi's words, and the adapter's keys are gone");
  // approveTools is no reason to leave a server off: the server keeps its on/off, and what it asked about is its `approve`, not a key of the file.
  assert.deepEqual(s.gated, { command: "node" });
  assert.deepEqual(s.gatedList, { command: "node", enabled: false });
  assert.deepEqual(moved.approve, { gated: ["*"], gatedList: ["delete_*"] });
  assert.equal("nothing" in s, false, "an entry that is no server is only named");
  assert.match(moved.left.find((l) => l.name === "envish").why, /\$env:NAME/);
  assert.match(moved.left.find((l) => l.name === "docs.v2").why, /name/);
  assert.equal("settings" in moved.file || "imports" in moved.file, false);
  assert.deepEqual(moved.imports, ["cursor", "claude-code"]);
  // Where nothing ran under the adapter, nothing starts now.
  assert.equal(carryOver(pi, ADAPTER_FILE, true).file.mcpServers.notes.enabled, false);
});

test("the adapter's lists of the tools a server offers or leaves out are pi's toolExposure, in the order pi reads it, with the server on", async () => {
  const pi = await piMcp();
  const file = JSON.stringify({
    mcpServers: {
      // As a production file has them: the adapter's names, the server's prefix and the tool's own name.
      pangolin: { url: "https://p.example.test/mcp", excludeTools: ["pangolin_admin_orgs", "pangolin_org_by_orgId_users"] },
      // A pattern across the prefix, and a tool whose own name has a dash, which the adapter's name has as an underscore.
      kube: { command: "k", excludeTools: ["kube_Delete*", "kube_get_thing"] },
      // Only some tools: the rest hidden, what is offered direct, and what both lists name left out.
      narrow: { command: "n", includeTools: ["narrow_read", "narrow_list_*", "narrow_drop"], excludeTools: ["narrow_drop"], toolExposure: { read: "deferred" } },
    },
  });
  const moved = carryOver(pi, file, false, new Map([["kube", ["get-thing", "DeleteNamespace", "list"]]]));
  const s = moved.file.mcpServers;
  assert.deepEqual(moved.left, []);
  // The tool's own name is hidden; the name as written stays hidden too, as the adapter matched a list against both.
  assert.equal(s.pangolin.url, "https://p.example.test/mcp");
  assert.equal(s.pangolin.toolExposure.admin_orgs, "hidden");
  assert.equal(s.pangolin.toolExposure.org_by_orgId_users, "hidden");
  assert.equal(Object.values(s.pangolin.toolExposure).every((value) => value === "hidden"), true);
  assert.equal(s.kube.toolExposure["Delete*"], "hidden");
  assert.equal(s.kube.toolExposure["get-thing"], "hidden", "the cached tool by its own name, which the adapter's name has with an underscore");
  assert.equal(s.kube.toolExposure.DeleteNamespace, "hidden");
  assert.equal(s.kube.toolExposure.list, undefined, "what neither list names is offered");
  assert.equal("excludeTools" in s.kube || "includeTools" in s.narrow, false, "the adapter's keys are gone");
  // pi's own reading: an exact name, else the first pattern in order, else the server's exposure.
  const exposure = (entry, tool) => {
    const own = entry.toolExposure ?? {};
    if (own[tool] !== undefined) return own[tool];
    for (const [pattern, value] of Object.entries(own)) if (pattern.includes("*") && new RegExp(`^${pattern.replace(/\*/g, ".*")}$`).test(tool)) return value;
    return "direct";
  };
  assert.equal(exposure(s.narrow, "read"), "deferred", "what the entry said itself stays");
  assert.equal(exposure(s.narrow, "list_files"), "direct");
  assert.equal(exposure(s.narrow, "drop"), "hidden", "named by both lists: left out, as under the adapter");
  assert.equal(exposure(s.narrow, "write"), "hidden", "named by neither, where only some are offered");
});

test("the adapter's setting that asks before every call becomes every server's approve, and one server's own false takes it out", async () => {
  const pi = await piMcp();
  const moved = carryOver(pi, JSON.stringify({ mcpServers: { a: { command: "a" }, b: { command: "b", approveTools: false }, "c.d": { command: "c" }, e: { command: "e", enabled: false } }, settings: { approveTools: true } }), false);
  // The servers keep their on/off, and none is left off for it.
  assert.deepEqual(moved.left.map((l) => l.name), ["c.d"]);
  assert.deepEqual(moved.carried, ["a", "b", "e"]);
  assert.deepEqual(moved.file.mcpServers.a, { command: "a" });
  assert.deepEqual(moved.file.mcpServers.e, { command: "e", enabled: false });
  assert.deepEqual(moved.approve, { a: ["*"], "c.d": ["*"], e: ["*"] }, "b said false; a name pi does not take keeps its gate, for a rename to carry");
  assert.deepEqual(moved.file.mcpServers["c.d"], { command: "c", enabled: false });
});

test("a server pi does not take by its name keeps the gate the adapter gave it, and a rename in Settings carries it to the new name", async () => {
  reset();
  logs.length = 0;
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: { "docs.v2": { command: "d", approveTools: ["send_*", "delete"] } } }));
  listed([{ source: ADAPTER, extensions: ["extensions/index.ts"] }]);
  await moveFromAdapter();
  assert.deepEqual(readFile().mcpServers["docs.v2"], { command: "d", enabled: false }, "off, and the key is not in the file");
  assert.deepEqual(db.mcpApprove()["docs.v2"], ["send_*", "delete"]);
  assert.match(logs[0], /still asked, by each server's `approve`: docs\.v2/);
  const { mcpRouter } = await import("../dist/api/mcp.js");
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api", mcpRouter());
  const listener = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  try {
    const put = await fetch(`http://127.0.0.1:${listener.address().port}/api/mcp/servers/docs-v2`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: "docs.v2", entry: { command: "d" } }) });
    assert.equal(put.status, 200, await put.clone().text());
  } finally {
    listener.close();
  }
  assert.deepEqual(db.mcpApprove()["docs-v2"], ["send_*", "delete"], "the renamed server is gated as it was");
  assert.equal(db.mcpApprove()["docs.v2"], undefined);
  db.setMcpApprove("docs-v2", undefined);
});

test("a server named __proto__ is not lost: it stays in the file, off, with its gate, and is not reported as carried", async () => {
  const pi = await piMcp();
  const moved = carryOver(pi, '{"mcpServers":{"__proto__":{"command":"x","approveTools":true},"ok":{"command":"y"}}}', false, new Map());
  assert.ok(!("error" in moved));
  assert.deepEqual(Object.keys(moved.file.mcpServers).sort(), ["__proto__", "ok"], "the server is in the file");
  assert.deepEqual(Object.getOwnPropertyDescriptor(moved.file.mcpServers, "__proto__").value, { command: "x", enabled: false });
  assert.deepEqual(JSON.parse(JSON.stringify(moved.file)).mcpServers.ok, { command: "y" });
  assert.deepEqual(moved.carried, ["ok"]);
  assert.deepEqual(moved.left.map((l) => l.name), ["__proto__"]);
  assert.match(moved.left[0].why, /name/);
  assert.deepEqual(Object.keys(moved.approve).sort(), ["__proto__"]);
});

test("the adapter's patterns match what the adapter matched: the tool's own name or its prefixed one, `?`, dashes as underscores, and no tool it asked about is left out", async () => {
  const pi = await piMcp();
  const file = JSON.stringify({
    mcpServers: {
      "git-hub": { command: "g", approveTools: ["git_hub_delete_*", "merge-pull_request", "creat?_issue", "mcp__git_hub_fork"] },
      "notes-mcp": { command: "n" },
    },
    settings: { approveTools: ["notes_remove*"] },
  });
  const cache = new Map([["git-hub", ["delete_repo", "merge-pull_request", "list_issues", "fork"]], ["notes-mcp", ["remove_note", "add_note"]]]);
  const moved = carryOver(pi, file, false, cache);
  const patterns = moved.approve["git-hub"];
  // The pattern as written (`?` asking more), with its prefix taken off, and each tool it caught by its own name.
  for (const asked of ["git_hub_delete_*", "delete_*", "merge_pull_request", "creat*_issue", "fork", "delete_repo", "merge-pull_request"]) assert.ok(patterns.includes(asked), `${asked} in ${patterns}`);
  assert.equal(patterns.includes("list_issues"), false, "a tool nothing named is not asked about");
  // The setting's pattern is by the short prefix of `notes-mcp` (`notes`).
  assert.deepEqual(moved.approve["notes-mcp"].includes("remove_note"), true);
  assert.equal(moved.approve["notes-mcp"].includes("add_note"), false);
  // As the guard matches them, the tools of the server are all asked about by the names the server gave them.
  const { needsApproval } = await import("../dist/pi/mcp-origin.js");
  for (const tool of ["delete_repo", "merge-pull_request", "fork", "create_issue"]) assert.equal(needsApproval(patterns, [tool.replace(/-/g, "_")]), true, tool);
  assert.equal(needsApproval(patterns, ["list_issues"]), false);
});

test("a pattern that matched only across the server's prefix is carried whatever it starts with, with no tool cached to try it on", async () => {
  const pi = await piMcp();
  const { needsApproval } = await import("../dist/pi/mcp-origin.js");
  // The adapter matched `*_delete_*` against `github_delete_repo`: the own name `delete_repo` does not match it, the prefixed one does.
  const moved = carryOver(pi, JSON.stringify({ settings: { approveTools: ["*_delete_*"] }, mcpServers: { github: { command: "x", lifecycle: "lazy" }, "my-mcp": { command: "y", approveTools: ["my_*_drop?"] } } }), false, new Map());
  assert.equal(moved.file.mcpServers.github.enabled, undefined, "the server is on, as it was");
  assert.equal(needsApproval(moved.approve.github, ["delete_repo"]), true, moved.approve.github.join());
  assert.equal(needsApproval(moved.approve.github, ["list_repos"]), false, "no wider than the pattern was");
  assert.equal(needsApproval(moved.approve["my-mcp"], ["x_drop1"]), true, moved.approve["my-mcp"].join());
  assert.equal(needsApproval(moved.approve["my-mcp"], ["x_keep"]), false);
});

test("what a move from the adapter stores as approve is in the database, and the file has none of it", async () => {
  reset();
  logs.length = 0;
  db.setMcpApprove("stale", ["x"]);
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: { gated: { command: "node", approveTools: ["delete_*"] }, open: { command: "node" } }, settings: { approveTools: false } }));
  listed([{ source: ADAPTER, extensions: ["extensions/index.ts"] }]);
  await moveFromAdapter();
  assert.deepEqual(readFile().mcpServers, { gated: { command: "node" }, open: { command: "node" } });
  assert.deepEqual(db.mcpApprove().gated, ["delete_*"]);
  assert.equal(db.mcpApprove().open, undefined);
  assert.match(logs[0], /still asked, by each server's `approve`: gated/);
  db.setMcpApprove("gated", undefined);
  db.setMcpApprove("stale", undefined);
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
  assert.equal(readFileSync(`${mcpFile}.adapter`, "utf8"), ADAPTER_FILE, "the file as it was is kept beside it");
  assert.equal(statSync(`${mcpFile}.adapter`).mode & 0o777, 0o600, "and is the person's alone, as the file is");
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")).packages, ["npm:pi-other"], "the adapter is out of pi's packages, and the rest is as it was");
  assert.equal(db.knownTools().some((t) => t.name === "notes_read"), false, "what the adapter registered is forgotten");
  assert.ok(db.knownTools().some((t) => t.name === "other_tool"));

  assert.equal(logs.length, 1, "one line");
  assert.match(logs[0], /9 servers .*carried over/);
  assert.match(logs[0], /pi-mcp-adapter taken out of pi's packages/);
  assert.ok(logs[0].includes(`The file as it was is kept as ${mcpFile}.adapter.`), "the log says where the copy is");
  assert.match(logs[0], /Left off, as they were.*sock \(a Unix socket/);
  assert.match(logs[0], /still asked, by each server's `approve`: gated, gatedList/, "what the adapter asked about before a call is asked still, and the servers are not left off for it");
  assert.deepEqual({ ...db.mcpApprove() }, { gated: ["*"], gatedList: ["delete_*"] });
  assert.equal(file.mcpServers.gated.enabled, undefined);
  assert.equal(file.mcpServers.gatedList.enabled, false, "on or off as it was");
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
  db.setMcpApprove("gated", undefined);
  db.setMcpApprove("gatedList", undefined);
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

test("a list that named one of the adapter's own tools names it as pi does, off or on as it was, and nothing else is switched", async () => {
  const pi = await piMcp();
  reset();
  logs.length = 0;
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: { github: { command: "gh", directTools: true }, late: { command: "l" } } }));
  writeFileSync(path.join(agent, "mcp-cache.json"), JSON.stringify({ servers: { github: { tools: [{ name: "delete_repo" }, { name: "list" }] } } }));
  listed([{ source: ADAPTER, extensions: ["extensions/index.ts"] }]);
  db.rememberTools([db.remembered({ name: "github_delete_repo", source: "pi-mcp-adapter", package: ADAPTER })]);
  const sql = db.getDb();
  sql.prepare("INSERT INTO project_tools (project, tools_off, tools_on) VALUES ('p', 'bash\ngithub_delete_repo', ''), ('q', '', 'github_delete_repo')").run();
  db.setToolDefaultsOff(["github_delete_repo"]);
  const gone = pi.createMcpToolName("github", "delete_repo");
  const lines = (project, column) => sql.prepare(`SELECT ${column} AS v FROM project_tools WHERE project = ?`).get(project).v.split("\n").filter(Boolean);

  await moveFromAdapter();
  const { toolEnabled } = await import("../dist/tool-policy.js");
  assert.deepEqual(lines("p", "tools_off"), ["bash", gone], "the tool is off under pi's name, and no other server's tools are");
  assert.deepEqual(db.toolDefaultsOff(), [gone], "the portal-wide default as well: the server's other tools stay on");
  assert.equal(toolEnabled(gone, db.toolDefaultsOff(), { off: lines("p", "tools_off"), on: [] }), false);
  assert.equal(toolEnabled(pi.createMcpToolName("github", "list"), db.toolDefaultsOff(), { off: lines("p", "tools_off"), on: [] }), true);
  assert.deepEqual(lines("q", "tools_off"), [], "a list that had it on switches nothing off");
  assert.deepEqual(lines("q", "tools_on"), [gone], "and has it on under pi's name, where the portal-wide default has it off");
  assert.equal(toolEnabled(gone, db.toolDefaultsOff(), { off: [], on: lines("q", "tools_on") }), true);
  assert.equal(readFile().mcpServers.late.enabled, undefined, "no list has MCP off: a server with no tool to name stays as it was");
  assert.match(logs[0], /3 lists of switches .*named single tools of the adapter's: they name them as pi does now/);
  assert.doesNotMatch(logs[0], /every server switched off/);
});

test("without the adapter's cache a tool's name is read as the server's prefix and the tool's own name; one no server here has is read as MCP off", async () => {
  const pi = await piMcp();
  reset();
  logs.length = 0;
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: { understory: { url: "http://127.0.0.1:3800/mcp", directTools: true }, "my-mcp": { command: "m" }, quiet: { command: "q" } } }));
  listed([{ source: ADAPTER, extensions: ["extensions/index.ts"] }]);
  db.rememberTools(["understory_memory_add", "my_search", "gone_tool"].map((name) => db.remembered({ name, source: "pi-mcp-adapter", package: ADAPTER })));
  const sql = db.getDb();
  sql.prepare("INSERT INTO project_tools (project, tools_off, tools_on) VALUES ('named', 'understory_memory_add\nmy_search', ''), ('lost', 'gone_tool', '')").run();
  const off = (project) => sql.prepare("SELECT tools_off AS v FROM project_tools WHERE project = ?").get(project).v.split("\n").filter(Boolean);

  await moveFromAdapter();
  assert.deepEqual(off("named"), [pi.createMcpToolName("my-mcp", "search"), pi.createMcpToolName("understory", "memory_add")].sort(), "the server's prefix, the short one as well, and the tool's name after it");
  assert.ok(off("lost").includes("list_mcp_resources") && off("lost").includes("gone_tool"), "a tool of no server here: the list is read as one that had MCP off");
  assert.equal(readFile().mcpServers.quiet.enabled, false, "and a server with no tool to name comes over off");
  assert.match(logs[0], /1 lists of switches .*named single tools/);
  assert.match(logs[0], /1 lists of switches had the adapter's `mcp` tool off, or one of its tools that no server here has/);
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

test("`approveTools: []`, the adapter's \"no tool asks first\", asks about nothing; one that names tools has them as its approve, on", async () => {
  const pi = await piMcp();
  const moved = carryOver(pi, JSON.stringify({ mcpServers: { a: { command: "npx", args: ["-y", "x"], approveTools: [] }, b: { command: "b" }, c: { command: "c", approveTools: ["delete"] } }, settings: { approveTools: [] } }), false);
  assert.deepEqual(moved.carried, ["a", "b", "c"]);
  assert.deepEqual(moved.left, []);
  assert.deepEqual(moved.approve, { c: ["delete"] });
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

test("a file that is already pi's, with no adapter: nothing read it before, so its servers come over off and the log names them; a file whose servers are off is left as it is", async () => {
  reset();
  logs.length = 0;
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: { a: { command: "x" }, b: { command: "y", enabled: false } } }));
  listed(["npm:pi-other"]);
  await moveFromAdapter();
  assert.deepEqual(readFile().mcpServers, { a: { command: "x", enabled: false }, b: { command: "y", enabled: false } });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /Nothing read it before.*: a\. Switch on/);
  assert.equal(db.getSetting("mcp_adapter_moved"), "1", "and it is not looked at again");

  reset();
  logs.length = 0;
  const off = JSON.stringify({ mcpServers: { b: { command: "y", enabled: false } } });
  writeFileSync(mcpFile, off);
  listed(["npm:pi-other"]);
  await moveFromAdapter();
  assert.equal(readFileSync(mcpFile, "utf8"), off);
  assert.equal(logs.length, 0);
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

test("tools of a server that sanitize to one name are switched off under the hashed names pi gives them, not the plain one", async () => {
  const pi = await piMcp();
  reset();
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: { notes: { command: "node", lifecycle: "lazy" } } }));
  writeFileSync(path.join(agent, "mcp-cache.json"), JSON.stringify({ servers: { notes: { tools: [{ name: "get-item" }, { name: "get_item" }, { name: "read" }] } } }));
  listed([{ source: ADAPTER, extensions: ["extensions/index.ts"] }]);
  db.getDb().prepare("INSERT INTO project_tools (project, tools_off, tools_on) VALUES ('p', 'mcp', '')").run();
  await moveFromAdapter();
  const off = db.getDb().prepare("SELECT tools_off FROM project_tools WHERE project = 'p'").get().tools_off.split("\n");
  // What pi registers: both tools get the hash suffix (see assignName in pi's mcp extension), `read` keeps its plain name.
  const hashed = ["get-item", "get_item"].map((tool) => pi.createMcpToolName("notes", tool, () => true));
  assert.notEqual(hashed[0], hashed[1]);
  for (const name of [...hashed, "mcp__notes__read"]) assert.ok(off.includes(name), `${name} is off`);
  assert.equal(off.includes("mcp__notes__get_item"), false, "the plain name is no tool of pi's here");
});

test("a copy an earlier start kept is not written over, and a file the move does not change gets none", async () => {
  reset();
  logs.length = 0;
  const text = JSON.stringify({ mcpServers: { notes: { command: "node", lifecycle: "lazy" } } });
  writeFileSync(mcpFile, text);
  writeFileSync(`${mcpFile}.adapter`, "an older copy");
  listed([{ source: ADAPTER, extensions: ["extensions/index.ts"] }]);
  await moveFromAdapter();
  assert.equal(readFileSync(`${mcpFile}.adapter`, "utf8"), "an older copy");
  assert.equal(readFileSync(`${mcpFile}.adapter-2`, "utf8"), text);
  assert.ok(logs[0].includes(`kept as ${mcpFile}.adapter-2.`));

  reset();
  logs.length = 0;
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: { notes: { command: "node" } } }));
  listed([{ source: ADAPTER, extensions: ["extensions/index.ts"] }]);
  await moveFromAdapter();
  assert.deepEqual(readdirSync(agent).filter((name) => name.startsWith("mcp.json.adapter")), [], "nothing to keep: the file is as it was");
  assert.doesNotMatch(logs[0], /kept as/);
});

test("a start that fails after the lists were rewritten still switches off the servers it could not name, on the start after", { skip: process.getuid?.() === 0 }, async () => {
  reset();
  logs.length = 0;
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: { notes: { command: "node" }, quiet: { command: "q", lifecycle: "lazy" } } }));
  writeFileSync(path.join(agent, "mcp-cache.json"), JSON.stringify({ servers: { notes: { tools: [{ name: "read" }] } } }));
  listed([{ source: ADAPTER, extensions: ["extensions/index.ts"] }]);
  db.getDb().prepare("INSERT INTO project_tools (project, tools_off, tools_on) VALUES ('p', 'mcp', '')").run();
  // No copy of the file can be kept beside it, nor the adapter taken out of pi's settings: the failure comes after the lists were written.
  chmodSync(agent, 0o500);
  const warned = [];
  const warn = console.warn;
  console.warn = (...args) => warned.push(String(args[0]));
  try {
    await moveFromAdapter();
  } finally {
    chmodSync(agent, 0o700);
    console.warn = warn;
  }
  assert.ok(warned.some((line) => /no copy of mcp\.json could be kept beside it/.test(line)), "the log says why nothing was moved");
  assert.equal(readFile().mcpServers.quiet.lifecycle, "lazy", "the file is not written without its copy");
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")).packages.length, 1, "and the adapter stays");
  assert.equal(db.getSetting("mcp_adapter_moved"), undefined, "not done");
  const projectOff = () => db.getDb().prepare("SELECT tools_off FROM project_tools WHERE project = 'p'").get().tools_off.split("\n");
  assert.equal(projectOff().includes("mcp"), false, "the entry is gone: the lists are done");
  await moveFromAdapter();
  assert.equal(readFile().mcpServers.quiet.enabled, false, "no tool of it to name: off, as it would have been without the failure");
  assert.equal(readFile().mcpServers.notes.enabled, undefined);
  assert.match(logs.at(-1), /never listed the tools of quiet/);
  assert.equal(db.getSetting("mcp_adapter_held"), undefined, "what was kept for the retry is gone with the move");
});

test("a project's own .pi/mcp.json: where the adapter cached its servers' tools, a list that had MCP off has them off by name, and the log names the file", async () => {
  const pi = await piMcp();
  reset();
  logs.length = 0;
  const folder = path.join(home, "mig-project");
  mkdirSync(path.join(folder, ".pi"), { recursive: true });
  writeFileSync(path.join(folder, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { projsrv: { command: "node", lifecycle: "lazy", excludeTools: ["drop_db"] }, uncached: { command: "u" } } }));
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: { notes: { command: "node" } } }));
  writeFileSync(path.join(agent, "mcp-cache.json"), JSON.stringify({ servers: { notes: { tools: [{ name: "read" }] }, projsrv: { tools: [{ name: "drop_db" }, { name: "ok" }] } } }));
  listed([{ source: ADAPTER, extensions: ["extensions/index.ts"] }]);
  db.getDb().prepare("INSERT INTO project_tools (project, tools_off, tools_on) VALUES ('mig-project', 'mcp', '')").run();
  db.createSession({ id: "mig-proj-chat", title: "c", workspace: folder, executor: "host", tools_off: "", tools_on: "" });
  await moveFromAdapter();
  const off = db.getDb().prepare("SELECT tools_off FROM project_tools WHERE project = 'mig-project'").get().tools_off.split("\n");
  const { toolEnabled } = await import("../dist/tool-policy.js");
  for (const tool of ["drop_db", "ok"]) {
    const name = pi.createMcpToolName("projsrv", tool);
    assert.ok(off.includes(name), `${name} is off where MCP was`);
    assert.equal(toolEnabled(name, db.toolDefaultsOff(), { off, on: [] }), false);
  }
  assert.equal(readFile().mcpServers.projsrv, undefined, "the project's file is not the portal's to write");
  assert.match(logs[0], /pi reads a project's own \.pi\/mcp\.json as well now: .*mig-project\/\.pi\/mcp\.json/);
  assert.doesNotMatch(logs[0], /never listed the tools of[^.]*(projsrv|uncached)/, "a project's server is not switched off by the move: it is not in the file");
});
