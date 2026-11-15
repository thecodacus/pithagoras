import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// The move from pi-mcp-adapter to pi's own MCP support (issue 361): the file, pi's package list, and every place that holds a
// tool's name, on a real database and real files. One scenario that has a row of the issue's table for each server, then
// each case that has to fail closed.
const home = inProcessHome("pithagoras-mcp-migration-");
const agent = process.env.PI_CODING_AGENT_DIR;
const mcpPath = path.join(agent, "mcp.json");
const settingsPath = path.join(agent, "settings.json");
const cachePath = path.join(agent, "mcp-cache.json");

const db = await import("../dist/db.js");
const { migrateMcp, migrationPending, MCP_MIGRATION } = await import("../dist/mcp-migration-run.js");
const toolCache = await import("../dist/mcp-tools.js");
const { chatServers } = await import("../dist/api/mcp.js");
const d = db.getDb();
test.after(() => d.close());

const ADAPTER = "npm:pi-mcp-adapter@2.18.0";
const setting = (key) => d.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value;
const put = (key, value) => db.putSetting(key, value);
const lines = (value) => (value ?? "").split("\n").filter(Boolean).sort();
const json = (key) => JSON.parse(setting(key));
const file = () => JSON.parse(readFileSync(mcpPath, "utf8"));
const report = () => json(MCP_MIGRATION);
const literal = (text) => text.replace(/[\\*]/g, "\\$&");

const tool = (name, description = `${name} does it`) => ({ name, description, inputSchema: { type: "object", properties: { q: { type: "string" } } } });
const cacheJson = (servers) => JSON.stringify({ version: 1, servers: Object.fromEntries(Object.entries(servers).map(([name, tools]) => [name, { configHash: "h", tools: tools.map((t) => tool(t)), resources: [], cachedAt: Date.now() }])) });

/** The adapter's own file, comments and all. */
const ADAPTER_FILE = `{
  // the adapter's file, as the portal's panel and a person wrote it
  "settings": { "toolPrefix": "server", "idleTimeout": 10, "approveTools": ["notes_drop*"] },
  "imports": ["cursor"],
  "mcpServers": {
    "github": { "url": "https://api.example.com/mcp", "auth": "bearer", "bearerTokenEnv": "GH_TOKEN", "directTools": ["search_code"], "excludeTools": ["delete_*"], "approveTools": ["github_create_*"], "lifecycle": "eager" },
    "docs.v2": { "command": "docs-mcp", "args": ["--stdio"], "env": { "A": "$env:DOCS_A" } },
    "understory": { "url": "http://localhost:3800/mcp", "lifecycle": "lazy", "directTools": true, "auth": "bearer", "bearerToken": "token-from-the-test" },
    "secrets": { "command": "x", "env": { "KEY": "!pass show key" } },
    "mux": { "socket": "/run/mux.sock" },
    "filtered": { "command": "y", "includeTools": ["a"] },
    "paused": { "command": "z", "disabled": true },
    "notes": { "command": "notes-mcp" }
  }
}
`;
const CACHED = {
  github: ["search_code", "get_file", "delete_repo", "create_issue"],
  "docs.v2": ["search"],
  understory: ["memory_query", "memory_add"],
  notes: ["note.add", "drop_all"],
};

/** Every tool the adapter's cache lists, by pi's names. */
const ALL_MCP = ["mcp__docs_v2__search", "mcp__github__create_issue", "mcp__github__delete_repo", "mcp__github__get_file", "mcp__github__search_code", "mcp__notes__drop_all", "mcp__notes__note_add", "mcp__understory__memory_add", "mcp__understory__memory_query"];

const seen = (name, source, extra = {}) => ({ name, source, description: `${name} does it`, ...extra });
const SEEN = [
  seen("mcp", "pi-mcp-adapter", { package: ADAPTER }),
  seen("github_get_file", "pi-mcp-adapter", { package: ADAPTER }),
  seen("github_delete_repo", "pi-mcp-adapter", { package: ADAPTER, tokens: 40 }),
  seen("understory_memory_add", "pi-mcp-adapter", { package: ADAPTER }),
  seen("docs.v2_gone", "pi-mcp-adapter", { package: ADAPTER }),
  seen("web_search", "pi-web-access", { package: "npm:pi-web-access", inline: false }),
  seen("canvas_write", "pithagoras-canvas", { package: null, inline: true }),
];

/** The portal as a release before this one left it. */
function seed({ adapter = true, files = ADAPTER_FILE } = {}) {
  rmSync(path.join(home, "mcp-migration.json"), { force: true });
  rmSync(toolCache.mcpToolCachePath(), { force: true });
  rmSync(`${mcpPath}.adapter`, { force: true });
  rmSync(`${mcpPath}.migrating`, { force: true });
  rmSync(mcpPath, { recursive: true, force: true });
  mkdirSync(agent, { recursive: true });
  writeFileSync(mcpPath, files);
  writeFileSync(cachePath, cacheJson(CACHED));
  writeFileSync(settingsPath, JSON.stringify({ theme: "x", packages: adapter ? [ADAPTER, "npm:pi-web-access"] : ["npm:pi-web-access"] }, null, 2));
  for (const table of ["sessions", "routines", "project_tools", "agent_tools", "chat_modes", "tool_rules"]) d.prepare(`DELETE FROM ${table}`).run();
  d.prepare("DELETE FROM settings").run();
  put("tools_seen", JSON.stringify(SEEN));
  put("tools_off_default", ["github_delete_repo", "notes_drop_all", "bash", "web_search"].join("\n"));
  put("tool_marks", JSON.stringify({ "docs.v2": "direct", "<tool>github_get_file": "lazy", "<tool>docs.v2_gone": "lazy", canvas: "lazy" }));
  put("tool_group_names", JSON.stringify({ "docs.v2": "Docs", canvas: "Pictures" }));
  put("guard_trusted_mcp_servers", JSON.stringify(["docs.v2", "understory", "github"]));
  put("mcp_configured", JSON.stringify(["docs.v2", "github"]));
  put("mcp_removed", JSON.stringify(["old"]));
  put("lazy_notice", JSON.stringify(["docs.v2", "canvas"]));
  d.prepare("INSERT INTO sessions (id, title, workspace, tools_off, tools_on, lazy_head) VALUES (?, ?, ?, ?, ?, ?)").run(
    "s1", "A chat", "/work/one", "github_get_file\nmcp_script\nbash", "notes_note_add",
    JSON.stringify({ v: 1, lazy: ["docs.v2", "canvas"], direct: ["<tool>github_get_file"], hint: "docs.v2", outside: false, voice: [], tag: "" }),
  );
  d.prepare("INSERT INTO sessions (id, title, workspace, tools_off) VALUES (?, ?, ?, ?)").run("s2", "Another", "/work/two", "docs.v2_search");
  d.prepare("INSERT INTO project_tools (project, tools_off, tools_on) VALUES (?, ?, ?)").run("/work/one", "mcp\nweb_search", "");
  d.prepare("INSERT INTO agent_tools (agent, tools_off, tools_on, keep_direct) VALUES (?, ?, ?, ?)").run("home", "understory_memory_add", "", "github\n<tool>notes_note_add\ndocs.v2");
  d.prepare("INSERT INTO routines (id, slug, name, instructions, tools_off, tools_on) VALUES (?, ?, ?, ?, ?, ?)").run("r1", "morning", "Morning", "Call github_get_file for the repo, then docs.v2_search, and mcp_script if it fails.", "github_get_file", "");
  d.prepare("INSERT INTO chat_modes (id, label, tools_off, tools_on, keep_direct) VALUES (?, ?, ?, ?, ?)").run("m1", "Mode", "docs.v2_search", "github_search_code", "docs.v2");
  const rule = d.prepare("INSERT INTO tool_rules (id, role, tool, pattern, person_key, note) VALUES (?, 'colleague', ?, ?, NULL, '')");
  rule.run("r-direct", "github_get_file", "*");
  rule.run("r-wrapped", "mcp", literal(JSON.stringify({ tool: "notes_note_add", args: { text: "hi" } })));
  rule.run("r-wild", "mcp", "*");
  rule.run("r-bash", "bash", "ls *");
}

const run = () => {
  d.transaction(() => migrateMcp(d))();
  return report();
};
/** A run that may leave no report: one that found nothing to move. */
run.quiet = () => d.transaction(() => migrateMcp(d))();
/** A run that writes its files and stops before the database takes its work. */
const killed = () =>
  assert.throws(() => d.transaction(() => {
    migrateMcp(d);
    throw new Error("killed before the commit");
  })(), /killed/);

test("a portal with nothing of the adapter, and no server, has nothing to carry over and says nothing", () => {
  rmSync(mcpPath, { force: true });
  rmSync(cachePath, { force: true });
  writeFileSync(settingsPath, JSON.stringify({ packages: ["npm:pi-web-access"] }));
  d.prepare("DELETE FROM settings").run();
  migrateMcp(d);
  assert.equal(setting(MCP_MIGRATION), undefined);
  assert.equal(setting("mcp_migration_notice"), undefined);
  assert.equal(existsSync(mcpPath), false);
  assert.equal(db.mcpMigration().report, null);
});

test("every row of the table: the file, the package list, the marks and every place that holds a tool's name", () => {
  seed();
  const r = run();
  assert.equal(r.status, "done");

  // The file: the old one is kept, the new one is plain JSON in pi's keys.
  assert.equal(readFileSync(`${mcpPath}.adapter`, "utf8"), ADAPTER_FILE, "the file as it was");
  const servers = file().mcpServers;
  assert.deepEqual(Object.keys(servers).sort(), ["docs_v2", "filtered", "github", "mux", "notes", "paused", "secrets", "understory"]);
  assert.deepEqual(Object.keys(file()).sort(), ["mcpServers"], "the adapter's own settings and imports have no counterpart");
  assert.deepEqual(servers.github, {
    url: "https://api.example.com/mcp",
    headers: { Authorization: "Bearer ${GH_TOKEN}" },
    exposure: "deferred",
    toolExposure: { search_code: "direct", get_file: "deferred", create_issue: "deferred", "*": "hidden" },
  });
  assert.deepEqual(servers.docs_v2, { command: "docs-mcp", args: ["--stdio"], env: { A: "${DOCS_A}" }, exposure: "deferred" });
  assert.deepEqual(servers.understory, { url: "http://localhost:3800/mcp", headers: { Authorization: "Bearer token-from-the-test" }, exposure: "direct" });
  assert.deepEqual(servers.notes, { command: "notes-mcp", exposure: "deferred" });
  for (const off of ["secrets", "mux", "filtered", "paused"]) assert.equal(servers[off].enabled, false, `${off} is off`);
  assert.equal(servers.secrets.env.KEY, "!pass show key", "kept as it was, for the person to confirm");
  for (const on of ["github", "docs_v2", "understory", "notes"]) assert.equal(servers[on].enabled, undefined, `${on} is on`);
  assert.deepEqual(r.servers.filter((s) => s.state === "off").map((s) => s.name).sort(), ["filtered", "mux", "paused", "secrets"]);
  assert.match(r.servers.find((s) => s.name === "secrets").why.join(), /starts with !/);
  assert.match(r.servers.find((s) => s.name === "filtered").why.join(), /no list of its tools/);
  assert.equal(r.servers.find((s) => s.name === "docs.v2").renamedTo, "docs_v2");

  // pi's package list: the adapter is out, and nothing else.
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { theme: "x", packages: ["npm:pi-web-access"] });
  assert.deepEqual(r.adapter, { was: "on", removed: true, spec: ADAPTER });

  // Marks, by the server's name now; the adapter's default was lazy.
  assert.deepEqual(json("tool_marks"), {
    docs_v2: "direct",
    "<tool>mcp__github__get_file": "lazy",
    canvas: "lazy",
    github: "lazy",
    // Its `directTools` list: the tool stays in the model's list by its own mark, as the chats go by the marks.
    "<tool>mcp__github__search_code": "direct",
    understory: "direct",
    notes: "lazy",
    secrets: "lazy",
    mux: "lazy",
    filtered: "lazy",
    paused: "lazy",
  });
  assert.deepEqual(json("tool_group_names"), { docs_v2: "Docs", canvas: "Pictures" });
  assert.deepEqual(json("guard_trusted_mcp_servers"), ["docs_v2", "understory", "github"]);
  assert.deepEqual(json("mcp_configured"), ["docs_v2", "github"]);
  assert.deepEqual(json("lazy_notice"), ["canvas", "docs_v2"]);
  // A server's own `approveTools`, and the adapter-wide one for every server that says none: wider than the adapter's wherever pi's * cannot say what it said.
  const approve = json("mcp_approve");
  assert.deepEqual(approve.github, ["create*", "create_issue", "github*create*"]);
  assert.deepEqual(approve.notes, ["drop*", "drop_all", "notes*drop*"]);
  assert.deepEqual(approve.docs_v2, ["notes*drop*"]);

  // Every layer's switches, by pi's names.
  assert.deepEqual(lines(setting("tools_off_default")), ["bash", "mcp__github__delete_repo", "mcp__notes__drop_all", "web_search"]);
  const chat = d.prepare("SELECT tools_off, tools_on, lazy_head FROM sessions WHERE id = 's1'").get();
  // `mcp_script` was the adapter's tool for scripts over every server: it is every MCP tool off in this chat, and the name stays.
  assert.deepEqual(lines(chat.tools_off), ["bash", "mcp_script", ...ALL_MCP].sort());
  assert.deepEqual(lines(chat.tools_on), ["mcp__notes__note_add"]);
  assert.deepEqual(JSON.parse(chat.lazy_head).lazy, ["canvas", "docs_v2"].sort((a, b) => ["docs_v2", "canvas"].indexOf(a) - ["docs_v2", "canvas"].indexOf(b)));
  assert.deepEqual(JSON.parse(chat.lazy_head).direct, ["<tool>mcp__github__get_file"]);
  assert.deepEqual(lines(d.prepare("SELECT tools_off FROM sessions WHERE id = 's2'").get().tools_off), ["mcp__docs_v2__search"]);
  const project = lines(d.prepare("SELECT tools_off FROM project_tools WHERE project = '/work/one'").get().tools_off);
  assert.ok(project.includes("web_search") && project.includes("mcp"), "the names it had stay");
  for (const name of ["mcp__github__get_file", "mcp__docs_v2__search", "mcp__understory__memory_add", "mcp__notes__drop_all", "mcp__notes__note_add"]) assert.ok(project.includes(name), `mcp off in a project is ${name} off`);
  const agentRow = d.prepare("SELECT tools_off, keep_direct FROM agent_tools WHERE agent = 'home'").get();
  assert.deepEqual(lines(agentRow.tools_off), ["mcp__understory__memory_add"]);
  assert.deepEqual(lines(agentRow.keep_direct), ["<tool>mcp__notes__note_add", "docs_v2", "github"].sort());
  assert.deepEqual(lines(d.prepare("SELECT tools_off FROM routines WHERE slug = 'morning'").get().tools_off), ["mcp__github__get_file"]);
  const mode = d.prepare("SELECT tools_off, tools_on, keep_direct FROM chat_modes WHERE id = 'm1'").get();
  assert.deepEqual([lines(mode.tools_off), lines(mode.tools_on), lines(mode.keep_direct)], [["mcp__docs_v2__search"], ["mcp__github__search_code"], ["docs_v2"]]);

  // The tools the portal has seen: the adapter's own tool and the ones it cannot tell are gone, its servers' tools are the servers' by pi's names.
  const known = json("tools_seen");
  assert.deepEqual(known.map((t) => t.name).sort(), ["canvas_write", "mcp__github__delete_repo", "mcp__github__get_file", "mcp__understory__memory_add", "web_search"].sort());
  const converted = known.find((t) => t.name === "mcp__github__get_file");
  assert.deepEqual([converted.server, converted.source, "package" in converted], ["github", "github", false]);
  assert.equal(known.find((t) => t.name === "mcp__github__delete_repo").tokens, 40, "what was measured is kept");

  // Standing permissions: a tool by its new name; one given to the adapter's wrapper to the tool it was for; one that cannot be told is gone.
  assert.deepEqual(
    d.prepare("SELECT id, tool, pattern FROM tool_rules ORDER BY id").all(),
    [
      { id: "r-bash", tool: "bash", pattern: "ls *" },
      { id: "r-direct", tool: "mcp__github__get_file", pattern: "*" },
      { id: "r-wrapped", tool: "mcp__notes__note_add", pattern: literal(JSON.stringify({ text: "hi" })) },
    ],
  );

  // What each server offered, for the tool lists before it runs.
  assert.deepEqual(Object.keys(toolCache.cachedServers()).sort(), ["docs_v2", "github", "notes", "understory"]);
  // Not the tools its excludeTools hid: pi registers none of them, and a search is not to find them in the cache either.
  assert.deepEqual(toolCache.cachedServer("github").tools.map((t) => [t.name, t.original]).sort(), [["mcp__github__create_issue", "create_issue"], ["mcp__github__get_file", "get_file"], ["mcp__github__search_code", "search_code"]]);
  assert.equal(toolCache.cachedServer("docs_v2").hash, toolCache.configHash(servers.docs_v2));

  // The report, the notice, and the copy that survives going back to the database from before.
  assert.equal(db.mcpMigration().notice, true);
  assert.equal(db.mcpMigration().report.servers.length, 8);
  assert.deepEqual(JSON.parse(readFileSync(path.join(home, "mcp-migration.json"), "utf8")).adapter, r.adapter);
  assert.match(r.gone.join(" | "), /imports: cursor/);
  assert.ok(r.names.converted >= 10);
  assert.ok(!JSON.stringify(r).includes("token-from-the-test") && !JSON.stringify(r).includes("pass show key"), "no secret is in the report");
  assert.deepEqual(r.texts.map((t) => t.where).sort(), ["routine morning"]);
  assert.deepEqual(r.texts[0].names.sort(), ["docs.v2_search", "github_get_file", "mcp_script"].sort());
  assert.equal(d.prepare("SELECT instructions FROM routines WHERE slug = 'morning'").get().instructions.includes("github_get_file"), true, "scanned, not changed");
  // A mark on a tool that is gone is dropped and said, and switches nothing off: a mark only says where the tool is offered.
  assert.ok(r.unconverted.some((item) => item.name === "docs.v2_gone" && /mark/.test(item.why)));
  assert.equal(file().mcpServers.docs_v2.enabled, undefined);
  db.dismissMcpMigrationNotice();
  assert.equal(db.mcpMigration().notice, false);
  assert.ok(db.mcpMigration().report, "and the report stays");
});

test("the converted entries are what the chats read, and the file is one pi's own CLI can read", () => {
  const { servers, errors } = chatServers("/nowhere", false);
  assert.deepEqual(errors, []);
  // `mux` is off and kept for the person to see, and pi would skip it (a socket, no command or address): the chats skip it too.
  assert.deepEqual(servers.map((s) => s.name).sort(), ["docs_v2", "filtered", "github", "notes", "paused", "secrets", "understory"]);
  // JSON.parse, as pi has it: no comments.
  assert.doesNotThrow(() => JSON.parse(readFileSync(mcpPath, "utf8")));
  assert.equal(statModeOf(mcpPath), 0o600);
  assert.equal(statModeOf(`${mcpPath}.adapter`), 0o600);
});

import { statSync } from "node:fs";
const statModeOf = (p) => statSync(p).mode & 0o777;

test("a second run changes nothing: what is pi's already is left, and the first report's copy is kept", () => {
  const before = { file: readFileSync(mcpPath, "utf8"), off: setting("tools_off_default"), marks: setting("tool_marks"), seen: setting("tools_seen"), copy: readFileSync(`${mcpPath}.adapter`, "utf8") };
  const r = run();
  assert.equal(readFileSync(mcpPath, "utf8"), before.file);
  assert.equal(setting("tools_off_default"), before.off);
  assert.equal(setting("tool_marks"), before.marks);
  assert.equal(setting("tools_seen"), before.seen);
  assert.equal(readFileSync(`${mcpPath}.adapter`, "utf8"), before.copy, "the adapter's file is not overwritten by the converted one");
  assert.equal(r.status, "done");
});

test("trust and confirmations given to a name that is no server of the file are not carried over, and the report says so", () => {
  // Round 5 of PR B, security finding 1: they would attach to the next server given that name (a folder's own file imported).
  seed();
  put("guard_trusted_mcp_servers", JSON.stringify(["github", "old"]));
  put("mcp_approve", JSON.stringify({ github: ["create*"], old: ["*"] }));
  const r = run();
  assert.deepEqual(json("guard_trusted_mcp_servers"), ["github"]);
  assert.equal("old" in json("mcp_approve"), false);
  assert.ok(json("mcp_approve").github);
  assert.ok(r.untrusted.includes("old"), "named in the report");
});

test("an adapter that was switched off, or not installed, leaves every server off, and is still taken out of the package list", () => {
  for (const [label, packages] of [
    ["off", [{ source: ADAPTER, extensions: [], skills: [], prompts: [], themes: [] }, "npm:pi-web-access"]],
    ["absent", ["npm:pi-web-access"]],
  ]) {
    seed();
    writeFileSync(settingsPath, JSON.stringify({ packages }));
    const r = run();
    assert.equal(r.adapter.was, label);
    for (const [name, entry] of Object.entries(file().mcpServers)) assert.equal(entry.enabled, false, `${label}: ${name}`);
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")).packages, ["npm:pi-web-access"]);
    assert.equal(r.servers.every((s) => s.state === "off"), true);
    assert.match(r.servers.find((s) => s.name === "github").why.join(), label === "off" ? /switched off/ : /not installed/);
  }
});

test("a stored switch that cannot be carried to pi's names switches its server off, and no list loses it", () => {
  seed();
  // A tool that the cache does not list: removed from the server since, or never cached.
  d.prepare("UPDATE sessions SET tools_off = ? WHERE id = 's2'").run("github_delete_everything\nunrelated_tool");
  // A resource's own tool of a server, and the name of another package's tool that starts like a server.
  d.prepare("UPDATE sessions SET tools_off = tools_off || ? WHERE id = 's1'").run("\nnotes_read_manual");
  const r = run();
  const servers = file().mcpServers;
  assert.equal(servers.github.enabled, false, "github_delete_everything");
  assert.match(r.servers.find((s) => s.name === "github").why.join(), /github_delete_everything, switched off in chat s2/);
  assert.deepEqual(lines(d.prepare("SELECT tools_off FROM sessions WHERE id = 's2'").get().tools_off), ["github_delete_everything", "unrelated_tool"], "the name stays: what is not told is not dropped");
  assert.equal(servers.docs_v2.enabled, undefined, "a server none of it is about stays on");
  assert.equal(servers.notes.enabled, false, "notes_read_manual is not a tool its cache lists");
  assert.ok(r.unconverted.some((item) => item.name === "github_delete_everything"));
});

test("what meant off is not made on by dropping: the gateway and mcp off in a layer, and a server nothing is cached of", () => {
  seed();
  put("tool_marks", JSON.stringify({ "pithagoras-canvas": "lazy" }));
  put("tools_seen", JSON.stringify([...SEEN, seen("canvas_read", "pithagoras-canvas", { package: null, inline: true })]));
  d.prepare("UPDATE sessions SET tools_off = ? WHERE id = 's2'").run("tools");
  const r = run();
  assert.deepEqual(lines(d.prepare("SELECT tools_off FROM sessions WHERE id = 's2'").get().tools_off), ["canvas_read", "canvas_write", "tools"]);
  // "mcp" off in a project: every cached tool, and the servers whose tools are not cached cannot be named in a list: off.
  assert.ok(r.expanded.some((item) => item.wrapper === "mcp" && item.where === "project /work/one" && item.count >= 7));
  assert.match(r.servers.find((s) => s.name === "paused").why.join() + r.servers.find((s) => s.name === "notes").why.join(), /./);
});

test("a file that cannot be read is changed in no way, and waits: the next start converts it once it is fixed", () => {
  seed();
  writeFileSync(mcpPath, `{ "mcpServers": { "a": { "command": "x" `);
  const r = run();
  assert.equal(r.status, "pending");
  assert.equal(r.file.state, "unreadable");
  assert.equal(readFileSync(mcpPath, "utf8"), `{ "mcpServers": { "a": { "command": "x" `, "not touched");
  assert.equal(existsSync(`${mcpPath}.adapter`), false);
  assert.ok(JSON.parse(readFileSync(settingsPath, "utf8")).packages.includes(ADAPTER), "the adapter's package is still listed");
  assert.equal(setting("tools_off_default").includes("mcp__"), false, "no name was carried over");
  assert.equal(db.mcpMigration().notice, true);
  assert.equal(migrationPending(d), true);
  // Fixed: the next run converts, and is done.
  writeFileSync(mcpPath, ADAPTER_FILE);
  const done = run();
  assert.equal(done.status, "done");
  assert.equal(migrationPending(d), false);
  assert.ok(file().mcpServers.github);
  // A file of nothing but blanks is no servers, not a broken file.
  writeFileSync(mcpPath, "  \n");
  put(MCP_MIGRATION, "");
  assert.notEqual(run().status, "pending");
});

test("an mcp.json that is there and cannot be read at all waits as a broken one does, and one that waited and is empty now waits no more", () => {
  // From the CodeRabbit review of #371: the read threw out of the upgrade, and the portal said its database was damaged.
  seed();
  rmSync(mcpPath);
  mkdirSync(mcpPath);
  const r = run();
  assert.equal(r.status, "pending");
  assert.equal(r.file.state, "unreadable");
  assert.ok(JSON.parse(readFileSync(settingsPath, "utf8")).packages.includes(ADAPTER), "nothing changed");
  // Fixed to nothing at all, with nothing of the adapter left: nothing to move, and no report that waits (and takes a backup at every start).
  rmSync(mcpPath, { recursive: true });
  writeFileSync(mcpPath, "{}");
  rmSync(cachePath, { force: true });
  writeFileSync(settingsPath, JSON.stringify({ packages: [] }));
  run.quiet();
  assert.equal(migrationPending(d), false);
  assert.equal(setting(MCP_MIGRATION), undefined);
});

test("what folders bring is listed, and left as it is", () => {
  seed();
  const withAdapter = path.join(home, "ws", "brings-adapter");
  const withConfig = path.join(home, "ws", "has-config");
  for (const folder of [withAdapter, withConfig]) mkdirSync(path.join(folder, ".pi"), { recursive: true });
  writeFileSync(path.join(withAdapter, ".pi", "settings.json"), JSON.stringify({ packages: [ADAPTER] }));
  writeFileSync(path.join(withConfig, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { local: { command: "x", directTools: true } } }));
  writeFileSync(path.join(withConfig, ".mcp.json"), "{}");
  d.prepare("INSERT INTO sessions (id, title, workspace) VALUES ('p1', 'a', ?), ('p2', 'b', ?)").run(withAdapter, withConfig);
  const r = run();
  assert.deepEqual(r.projects.map((p) => p.folder).sort(), [withAdapter, withConfig].sort());
  assert.deepEqual(r.projects.find((p) => p.folder === withAdapter), { folder: withAdapter, adapterSettings: true, mcpJson: false, foreign: [], hashes: {} });
  const config = r.projects.find((p) => p.folder === withConfig);
  assert.deepEqual({ ...config, hashes: Object.keys(config.hashes).sort() }, { folder: withConfig, adapterSettings: false, mcpJson: true, foreign: [".mcp.json"], hashes: [path.join(".pi", "mcp.json"), ".mcp.json"].sort() });
  assert.match(config.hashes[".mcp.json"], /^[0-9a-f]{64}$/);
  assert.equal(JSON.parse(readFileSync(path.join(withAdapter, ".pi", "settings.json"), "utf8")).packages[0], ADAPTER, "a project's own settings are not edited");
  // What a project's own file says in the adapter's keys is not connected: pi would take it without them, with every tool open.
  const { servers, errors } = chatServers(withConfig, true);
  assert.equal(servers.some((s) => s.name === "local"), false);
  assert.match(errors.join("\n"), /server "local" is written for the old MCP adapter \(directTools\)/);
});

test("a folder whose MCP files are a FIFO, a link to a device, or a link out of it does not stop the move, and is listed without a hash", () => {
  // Round 6 of PR B, security finding 1: a plain read of a FIFO waits for a writer for good, and of /dev/zero until memory is gone.
  seed();
  const folder = path.join(home, "ws", "hostile");
  mkdirSync(path.join(folder, ".pi"), { recursive: true });
  mkdirSync(path.join(folder, ".vscode"), { recursive: true });
  const outside = path.join(home, "elsewhere.json");
  writeFileSync(outside, JSON.stringify({ mcpServers: {} }));
  execFileSync("mkfifo", [path.join(folder, ".mcp.json")]);
  execFileSync("mkfifo", [path.join(folder, ".pi", "settings.json")]);
  symlinkSync("/dev/zero", path.join(folder, "opencode.json"));
  symlinkSync(outside, path.join(folder, ".vscode", "mcp.json"));
  writeFileSync(path.join(folder, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { local: { command: "x" } } }));
  d.prepare("INSERT INTO sessions (id, title, workspace) VALUES ('h1', 'a', ?)").run(folder);
  const r = run();
  const one = r.projects.find((p) => p.folder === folder);
  assert.deepEqual(one.foreign.sort(), [".mcp.json", path.join(".vscode", "mcp.json"), "opencode.json"].sort(), "listed, so that the report shows them");
  assert.deepEqual(Object.keys(one.hashes), [path.join(".pi", "mcp.json")], "only the regular file in the folder has a hash: the import refuses the others as changed");
  assert.equal(one.adapterSettings, false);
});

test("an entry in the adapter's keys that is written later is not connected either, unless it is off anyway", () => {
  writeFileSync(mcpPath, JSON.stringify({ mcpServers: { late: { command: "x", includeTools: ["a"] }, fine: { command: "y", exposure: "deferred" }, paused: { command: "z", disabled: true, includeTools: ["a"] } } }));
  const read = chatServers("/nowhere", false);
  assert.deepEqual(read.servers.map((s) => s.name).sort(), ["fine", "paused"]);
  assert.match(read.errors.join("\n"), /server "late" is written for the old MCP adapter \(includeTools\)/);
  assert.equal(read.errors.length, 1, "one that is off says nothing");
});

test("an adapter that loads no extension ran no MCP: its servers are off as with one switched off", () => {
  // Correctness review 1 of PR B, finding 7.
  for (const entry of [{ source: ADAPTER, extensions: [] }, { source: ADAPTER, autoload: false }, { source: ADAPTER, autoload: false, extensions: [], skills: ["x"] }]) {
    seed();
    writeFileSync(settingsPath, JSON.stringify({ packages: [entry, "npm:pi-web-access"] }));
    const r = run();
    assert.equal(r.adapter.was, "off", JSON.stringify(entry));
    assert.equal(file().mcpServers.notes.enabled, false, JSON.stringify(entry));
  }
  // Narrowed to some of its extensions is still on.
  seed();
  writeFileSync(settingsPath, JSON.stringify({ packages: [{ source: ADAPTER, extensions: ["index.ts"] }] }));
  assert.equal(run().adapter.was, "on");
});

test("a run that wrote the new mcp.json and stopped before the database took it is done again from the copy it kept", () => {
  // Correctness review 1 of PR B, finding 10: the converted file has lost `docs.v2` and the adapter is out of pi's settings already.
  seed();
  const before = setting("tools_off_default");
  assert.throws(() => d.transaction(() => {
    migrateMcp(d);
    throw new Error("killed before the commit");
  })(), /killed/);
  assert.equal(setting("tools_off_default"), before, "the database is as it was");
  assert.ok(file().mcpServers.docs_v2, "and the file is the converted one");
  assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).packages.includes(ADAPTER), false);
  const r = run();
  assert.equal(r.status, "done");
  assert.equal(r.adapter.was, "on", "what that run found of the adapter");
  assert.deepEqual(lines(d.prepare("SELECT tools_off FROM sessions WHERE id = 's2'").get().tools_off), ["mcp__docs_v2__search"]);
  assert.equal(file().mcpServers.docs_v2.enabled, undefined);
  assert.equal(file().mcpServers.github.enabled, undefined);
  assert.equal(readFileSync(`${mcpPath}.adapter`, "utf8"), ADAPTER_FILE);
  // A file the person put back (going back), and changed, is the source as it is: not the copy.
  writeFileSync(mcpPath, ADAPTER_FILE.replace(`"notes": { "command": "notes-mcp" }`, `"notes": { "command": "notes-mcp" },\n    "added": { "command": "later" }`));
  writeFileSync(settingsPath, JSON.stringify({ packages: [ADAPTER] }));
  run();
  assert.ok(file().mcpServers.added);
});

test("a second move that stops halfway is done again from what it converted, not from the first move's copy; and a retry that writes nothing keeps that source for one more", () => {
  // From the CodeRabbit review of #371: mcp.json.adapter is the file of the first move, and a later one converts another.
  seed();
  writeFileSync(`${mcpPath}.adapter`, ADAPTER_FILE);
  const later = ADAPTER_FILE.replace(`"notes": { "command": "notes-mcp" }`, `"notes": { "command": "notes-mcp" },\n    "added": { "command": "later" }`);
  writeFileSync(mcpPath, later);
  killed();
  assert.ok(file().mcpServers.added, "the converted file has it");
  // The retry comes to the very file that was written, writes nothing, and stops as well.
  killed();
  const r = run();
  assert.equal(r.status, "done");
  assert.ok(file().mcpServers.added, "converted from the second move's source, every time");
  assert.equal(readFileSync(`${mcpPath}.adapter`, "utf8"), ADAPTER_FILE, "the first copy is the first file still");
  assert.equal(lines(d.prepare("SELECT tools_off FROM sessions WHERE id = 's2'").get().tools_off).join(), "mcp__docs_v2__search", "the stored names were carried from the source");
});

test("a channel's instructions are scanned for the old names, as a routine's are", () => {
  // Correctness review 1 of PR B, finding 11.
  seed();
  d.prepare("DELETE FROM channels").run();
  d.prepare("INSERT INTO channels (id, slug, kind, name, instructions) VALUES ('c1', 'team', 'telegram', 'Team', 'File bugs with github_create_issue, or mcp({ tool: \"x\" }).')").run();
  const r = run();
  const found = r.texts.find((t) => t.where === "channel team");
  assert.ok(found, JSON.stringify(r.texts));
  assert.deepEqual(found.names.sort(), ["github_create_issue", "mcp({…})"]);
  d.prepare("DELETE FROM channels").run();
});

test("a permission for one call of the adapter's mcp tool becomes one on the tool only where it keeps all of what it allowed", () => {
  // Security review 1 of PR B, finding 7: a subject of the path alone would allow any other argument with it.
  seed();
  const rule = d.prepare("INSERT INTO tool_rules (id, role, tool, pattern, person_key, note) VALUES (?, 'colleague', 'mcp', ?, NULL, '')");
  rule.run("r-path-and-more", literal(JSON.stringify({ tool: "notes_note_add", args: { path: "/notes/a.md", content: "anything" } })));
  rule.run("r-path-only", literal(JSON.stringify({ tool: "notes_note_add", args: { path: "/notes/a.md" } })));
  const r = run();
  const rules = Object.fromEntries(d.prepare("SELECT id, tool, pattern FROM tool_rules").all().map((one) => [one.id, one]));
  assert.equal(rules["r-path-and-more"], undefined, "deleted: an allow rule that goes is closed");
  // From the CodeRabbit review of #371: one of the path alone allowed only that path, and a rule on the path would allow it with any other argument.
  assert.equal(rules["r-path-only"], undefined);
  assert.ok(r.unconverted.some((item) => item.where === "standing permissions" && /other arguments/.test(item.why)));
});
