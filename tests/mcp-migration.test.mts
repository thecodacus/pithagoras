import { test } from "node:test";
import assert from "node:assert/strict";
import { McpMigration, adapterKeysOf, adapterToolName, isNativeEntry, parseAdapterCache, type AdapterState, type Options } from "../core/server/src/mcp-migration.ts";
import { entryProblem, mcpToolName } from "../core/server/src/mcp-config.ts";

/**
 * What the migration from pi-mcp-adapter to pi's own MCP support does with a file and with the names stored by the
 * adapter's naming, on fixtures: one for every row of the table in the issue (361, 5.1) and for every case that has to fail
 * closed. The rule under all of them: what meant "off" or "not reachable" stays off, and where a conversion is not certain the
 * server is switched off and says why.
 */

/** The adapter's cache entry for a server, from the names of its tools (and resources). */
const offered = (tools: string[], resources: string[] = []) => ({ tools: tools.map((name) => ({ name, description: `${name} does it`, inputSchema: { type: "object", properties: {} } })), resources: resources.map((name) => ({ name, uri: `file:///${name}` })) });
const cacheOf = (servers: Record<string, ReturnType<typeof offered>>) => parseAdapterCache({ version: 1, servers });

function migrate(servers: Record<string, unknown>, rest: { settings?: Record<string, unknown>; cache?: Record<string, ReturnType<typeof offered>>; adapter?: AdapterState["adapter"]; imports?: unknown; normal?: string[]; lazyOnly?: string[] } = {}) {
  const state: AdapterState = { servers, settings: rest.settings ?? {}, extra: {}, imports: rest.imports, cache: cacheOf(rest.cache ?? {}), adapter: rest.adapter ?? "on" };
  const options: Options = { state, known: { normal: new Set(rest.normal ?? []) }, lazyOnly: rest.lazyOnly ?? [] };
  return new McpMigration(options);
}

/** The entry that is written for a server, after what stored names asked of it. */
const written = (migration: McpMigration, name: string) => migration.finish().mcpServers[name] as Record<string, unknown>;
const noteOf = (migration: McpMigration, name: string) => migration.servers.find((server) => server.name === name)!.notes.join(" | ");

test("the keys pi has too are carried as they are", () => {
  const entry = { command: "npx", args: ["-y", "x"], env: { A: "1" }, cwd: "/work", description: "Docs", timeout: 30 };
  const m = migrate({ docs: entry }, { cache: { docs: offered(["search"]) } });
  assert.deepEqual({ ...written(m, "docs") }, { ...entry, exposure: "deferred" });
  const http = migrate({ remote: { url: "https://example.com/mcp", headers: { "X-Key": "k" } } });
  assert.deepEqual(written(http, "remote"), { url: "https://example.com/mcp", headers: { "X-Key": "k" }, exposure: "deferred" });
});

test("disabled: true becomes enabled: false, and the server is off in the report as the person had it", () => {
  const m = migrate({ off: { command: "x", disabled: true }, on: { command: "y" } });
  const out = m.finish();
  assert.equal((out.mcpServers.off as Record<string, unknown>).enabled, false);
  assert.equal("disabled" in (out.mcpServers.off as object), false);
  assert.equal((out.mcpServers.on as Record<string, unknown>).enabled, undefined);
  assert.equal(out.servers.find((s) => s.name === "off")!.state, "off");
});

test("directTools: unset is lazy as the adapter's default was; true is direct; a list names the direct ones; the adapter-wide setting and a server's false", () => {
  const m = migrate({ lazy: { command: "a" }, direct: { command: "b", directTools: true }, some: { command: "c", directTools: ["search", "read_page"] }, no: { command: "d", directTools: false } }, { cache: {} });
  assert.deepEqual([m.server("lazy")!.mark, m.server("direct")!.mark, m.server("some")!.mark, m.server("no")!.mark], ["lazy", "direct", "lazy", "lazy"]);
  assert.equal(written(m, "direct").exposure, "direct");
  assert.equal(written(m, "lazy").exposure, "deferred");
  assert.equal(written(m, "some").exposure, "deferred");
  assert.deepEqual(written(m, "some").toolExposure, { search: "direct", read_page: "direct" });
  const wide = migrate({ a: { command: "a" }, b: { command: "b", directTools: false }, c: { command: "c", directTools: ["x"] } }, { settings: { directTools: true } });
  assert.deepEqual([wide.server("a")!.mark, wide.server("b")!.mark, wide.server("c")!.mark], ["direct", "lazy", "lazy"], "the setting is for a server that says nothing; a list is its own; false turns it off");
  assert.equal(written(wide, "a").exposure, "direct");
});

test("includeTools and excludeTools are evaluated as the adapter did, and written as exact names with everything else hidden", () => {
  const cache = { gh: offered(["search_code", "get_file", "delete_repo", "delete-branch", "list.issues"]) };
  const m = migrate({ gh: { command: "gh-mcp", excludeTools: ["delete_*", "gh_search_code"] } }, { cache });
  assert.deepEqual(written(m, "gh").toolExposure, { get_file: "deferred", "list.issues": "deferred", "*": "hidden" });
  const only = migrate({ gh: { command: "gh-mcp", includeTools: ["get_file", "gh_list_issues", "delete?branch"], excludeTools: ["delete_branch"] } }, { cache });
  assert.deepEqual(written(only, "gh").toolExposure, { get_file: "deferred", "list.issues": "deferred", "*": "hidden" }, "its prefixed name, a ?, and hyphen and underscore alike; an exclusion beats an inclusion");
  // pi takes an exact name before a pattern: an include that an exclude glob also covers must not come back as an exact one.
  const both = migrate({ gh: { command: "gh-mcp", includeTools: ["delete_repo", "get_file"], excludeTools: ["delete_*"] } }, { cache });
  assert.deepEqual(written(both, "gh").toolExposure, { get_file: "deferred", "*": "hidden" });
  const direct = migrate({ gh: { command: "gh-mcp", directTools: ["get_file"], includeTools: ["get_file", "search_code"] } }, { cache });
  assert.deepEqual(written(direct, "gh").toolExposure, { get_file: "direct", search_code: "deferred", "*": "hidden" });
  assert.match(noteOf(m, "gh"), /exact toolExposure/);
});

test("includeTools or excludeTools without a list of the server's tools to apply them to: the server is off", () => {
  for (const entry of [{ command: "x", includeTools: ["a"] }, { command: "x", excludeTools: ["a"] }]) {
    const m = migrate({ s: entry });
    assert.equal(written(m, "s").enabled, false);
    assert.match(m.finish().servers[0].why.join(" "), /no list of its tools/);
  }
  // An empty list is no filter at all, as the adapter read it.
  assert.equal(written(migrate({ s: { command: "x", includeTools: [], excludeTools: [] } }), "s").enabled, undefined);
});

test("a server whose resources were held back is off: pi's resource tools reach every resource of an enabled server", () => {
  const cache = { docs: offered(["search"], ["readme"]) };
  assert.equal(written(migrate({ docs: { command: "x", exposeResources: false } }, { cache }), "docs").enabled, false);
  assert.equal(written(migrate({ docs: { command: "x", includeTools: ["search"] } }, { cache }), "docs").enabled, false, "an include that names no read_ tool holds the resource back");
  assert.equal(written(migrate({ docs: { command: "x", includeTools: ["search", "read_readme"] } }, { cache }), "docs").enabled, undefined, "one that names it does not");
  assert.equal(written(migrate({ docs: { command: "x", includeTools: ["search"] } }, { cache: { docs: offered(["search"]) } }), "docs").enabled, undefined, "nothing to hold back");
});

test("toolPrefix, per server and for all, builds the old names, and is dropped", () => {
  const cache = { "brave-search": offered(["web.search"]), "docs-mcp": offered(["find"]), notes: offered(["note.add"]), plain: offered(["ping"]) };
  const m = migrate(
    { "brave-search": { command: "a" }, "docs-mcp": { command: "b", toolPrefix: "short" }, notes: { command: "c", toolPrefix: "mcp" }, plain: { command: "d", toolPrefix: "none" } },
    { cache },
  );
  assert.deepEqual(
    ["brave_search_web_search", "docs_find", "mcp__notes_note_add", "ping"].map((name) => m.verdict(name)),
    [
      { kind: "map", to: "mcp__brave_search__web_search", server: "brave-search" },
      { kind: "map", to: "mcp__docs_mcp__find", server: "docs-mcp" },
      { kind: "map", to: "mcp__notes__note_add", server: "notes" },
      { kind: "map", to: "mcp__plain__ping", server: "plain" },
    ],
  );
  assert.equal("toolPrefix" in written(m, "notes"), false);
  assert.match(noteOf(m, "notes"), /toolPrefix mcp dropped/);
  const all = migrate({ a: { command: "a" } }, { settings: { toolPrefix: "short" }, cache: { a: offered(["x"]) } });
  assert.equal(all.verdict("a_x").kind, "map");
  assert.equal(adapterToolName("x.y", "a-b", "server"), "a_b_x_y");
});

test("a value that starts with ! is a command to pi: the server is off until the person confirms it", () => {
  for (const entry of [
    { command: "x", env: { TOKEN: "!pass show token" } },
    { url: "https://x.example/mcp", headers: { Authorization: "!echo Bearer abc" } },
    { url: "https://x.example/mcp", auth: "bearer", bearerToken: "!gh auth token" },
  ]) {
    const m = migrate({ s: entry });
    assert.equal(written(m, "s").enabled, false, JSON.stringify(entry));
    assert.match(m.finish().servers[0].why.join(" "), /!/);
  }
});

test("a bearer token becomes an Authorization header, by value or by variable, and the adapter's variable syntax becomes pi's", () => {
  const m = migrate({
    a: { url: "https://a.example/mcp", auth: "bearer", bearerToken: "sk-1" },
    b: { url: "https://b.example/mcp", auth: "bearer", bearerTokenEnv: "B_TOKEN" },
    c: { url: "https://c.example/$env:HOST/mcp", headers: { "X-Key": "{env:KEY}" }, auth: "oauth" },
    d: { command: "x", env: { A: "$env:A_VALUE", B: "${B_VALUE}" }, cwd: "{env:HOME}/work" },
  });
  assert.deepEqual(written(m, "a").headers, { Authorization: "Bearer sk-1" });
  assert.deepEqual(written(m, "b").headers, { Authorization: "Bearer ${B_TOKEN}" });
  assert.equal(written(m, "c").url, "https://c.example/${HOST}/mcp");
  assert.deepEqual(written(m, "c").headers, { "X-Key": "${KEY}" });
  assert.equal("auth" in written(m, "c"), false);
  assert.deepEqual(written(m, "d").env, { A: "${A_VALUE}", B: "${B_VALUE}" });
  assert.equal(written(m, "d").cwd, "${HOME}/work");
  for (const name of ["a", "b", "c", "d"]) assert.equal(written(m, name).enabled, undefined, name);
  // Both an Authorization header and a token: which one the adapter sent is not known.
  const clash = migrate({ s: { url: "https://x.example/mcp", headers: { authorization: "Bearer one" }, auth: "bearer", bearerToken: "two" } });
  assert.equal(written(clash, "s").enabled, false);
  assert.deepEqual(written(clash, "s").headers, { authorization: "Bearer one" });
});

test("an oauth block keeps the keys pi has; the adapter's redirect becomes the callback; any other key is not certain", () => {
  const m = migrate({
    a: { url: "https://a.example/mcp", oauth: { clientId: "id", clientSecret: "${S}", scope: "read", clientName: "Pithagoras" } },
    b: { url: "https://b.example/mcp", oauth: { clientId: "id", redirectUri: "http://127.0.0.1:8765/callback" } },
    c: { url: "https://c.example/mcp", oauth: { redirectUri: "https://elsewhere.example/cb" } },
    d: { url: "https://d.example/mcp", oauth: { grantType: "client_credentials", clientId: "id" } },
    e: { url: "https://e.example/mcp", oauth: false },
  });
  assert.deepEqual(written(m, "a").oauth, { clientId: "id", clientSecret: "${S}", scope: "read", clientName: "Pithagoras" });
  assert.deepEqual(written(m, "b").oauth, { clientId: "id", callbackUrl: "http://127.0.0.1:8765/callback" });
  assert.equal(written(m, "c").enabled, false);
  assert.equal(written(m, "d").enabled, false);
  assert.equal("oauth" in written(m, "e"), false);
  assert.equal(written(m, "e").enabled, undefined);
});

test("approveTools, for a server and for all, becomes confirmations on the server's own tool names, and never fewer than the adapter asked", () => {
  const cache = { gh: offered(["delete_repo", "delete-branch", "get_file", "list.issues"]) };
  const m = migrate(
    { gh: { command: "x", approveTools: ["gh_delete_*", "get_fil?"] }, all: { command: "y" }, quiet: { command: "z", approveTools: false }, everything: { command: "w", approveTools: true } },
    { cache, settings: { approveTools: ["all_drop*"] } },
  );
  const gh = m.server("gh")!.approve;
  for (const tool of ["delete_repo", "delete-branch", "get_file"]) assert.ok(gh.includes(tool), `${tool} is exact`);
  assert.ok(gh.includes("delete*") && gh.includes("get*fil*"), `a tool not listed yet is covered: ${gh.join(", ")}`);
  assert.equal(gh.includes("list.issues"), false);
  assert.deepEqual(m.server("all")!.approve.filter((one) => one.startsWith("drop")), ["drop*"], "the setting for every server");
  assert.deepEqual(m.server("quiet")!.approve, [], "a server's false is its own");
  assert.deepEqual(m.server("everything")!.approve, ["*"]);
  assert.equal("approveTools" in written(m, "gh"), false);
});

test("lifecycle, debug, idleTimeout and the adapter's own settings are dropped, and said; a timeout in milliseconds is seconds", () => {
  const m = migrate({ s: { command: "x", lifecycle: "keep-alive", debug: true, idleTimeout: 5, requestTimeoutMs: 90_500, scriptMode: true } }, { settings: { scriptMode: true, idleTimeout: 10, toolPrefix: "server" } });
  const entry = written(m, "s");
  for (const key of ["lifecycle", "debug", "idleTimeout", "requestTimeoutMs"]) assert.equal(key in entry, false, key);
  assert.equal(entry.timeout, 91);
  assert.match(noteOf(m, "s"), /lifecycle: keep-alive dropped/);
  assert.match(m.finish().gone.join(" "), /settings: scriptMode, idleTimeout, toolPrefix/);
  assert.equal(written(m, "s").enabled, undefined, "dropping what has no counterpart does not switch the server off");
});

test("a socket, and an address that is only legacy SSE, cannot be reached: the server is off and the entry kept", () => {
  const m = migrate({ mux: { socket: "/run/rmcp.sock" }, old: { url: "https://x.example/sse", type: "sse" } });
  assert.equal(written(m, "mux").enabled, false);
  assert.equal(written(m, "mux").socket, "/run/rmcp.sock");
  assert.match(m.finish().servers[0].why.join(" "), /socket/);
  assert.equal(written(m, "old").enabled, false);
  assert.match(m.finish().servers[1].why.join(" "), /SSE/);
});

test("names with a dot are renamed, a name pi would take for another is told apart and off, and trust follows only a certain rename", () => {
  const cache = { "docs.v2": offered(["search"]), "a-b": offered(["x"]), a_b: offered(["y"]) };
  const m = migrate({ "docs.v2": { command: "x" }, "a-b": { command: "y" }, a_b: { command: "z" } }, { cache });
  const out = m.finish();
  assert.deepEqual(Object.keys(out.mcpServers), ["docs_v2", "a-b", "a_b_2"]);
  assert.equal((out.mcpServers.docs_v2 as Record<string, unknown>).enabled, undefined);
  assert.equal((out.mcpServers.a_b_2 as Record<string, unknown>).enabled, false, "refused: it clashes");
  assert.deepEqual(m.trusted(["docs.v2", "a-b", "a_b", "elsewhere"]), { names: ["docs_v2", "a-b", "elsewhere"], untrusted: ["a_b"] });
  assert.equal(m.setName("docs.v2"), "docs_v2");
  assert.equal(entryProblem("docs_v2", out.mcpServers.docs_v2), null);
  // The tools of the dotted server are named by the renamed one.
  assert.deepEqual(m.verdict("docs.v2_search"), { kind: "map", to: "mcp__docs_v2__search", server: "docs.v2" });
  // The name `a_b_x` was both servers' prefix: not told.
  assert.equal(m.verdict("a_b_x").kind, "map", "the first server's tool, by its cache");
});

test("an adapter that was switched off, or never installed, leaves every server of the file off", () => {
  for (const adapter of ["off", "absent"] as const) {
    const m = migrate({ one: { command: "a" }, two: { url: "https://x.example/mcp", directTools: true }, three: { command: "b", disabled: true } }, { adapter });
    const out = m.finish();
    for (const name of ["one", "two", "three"]) assert.equal((out.mcpServers[name] as Record<string, unknown>).enabled, false, `${adapter}: ${name}`);
    assert.match(out.servers[0].why.join(" "), adapter === "off" ? /switched off/ : /not installed/);
  }
  assert.equal(written(migrate({ one: { command: "a" } }), "one").enabled, undefined);
});

test("an entry that is pi's already is left as it is, and is not switched off with the adapter", () => {
  const native = { command: "x", exposure: "direct", toolExposure: { a: "hidden" } };
  assert.equal(isNativeEntry(native), true);
  assert.equal(isNativeEntry({ command: "x" }), false, "no exposure, enabled or toolExposure: the adapter's");
  assert.equal(isNativeEntry({ command: "x", exposure: "direct", directTools: true }), false);
  const m = migrate({ ours: native }, { adapter: "absent" });
  assert.deepEqual(written(m, "ours"), native);
  assert.equal(m.finish().servers[0].state, "native");
  assert.deepEqual(adapterKeysOf({ command: "x", includeTools: ["a"], auth: "bearer" }), ["includeTools", "auth"]);
  assert.deepEqual(adapterKeysOf({ command: "x", auth: { provider: "p" }, enabled: false }), []);
  assert.deepEqual(adapterKeysOf({ url: "https://x/mcp", oauth: { redirectUri: "http://localhost/cb" } }), ["oauth"]);
});

test("a stored name is carried to pi's, by what the adapter's cache lists, with pi's own rule for long names and collisions", () => {
  const long = "a_very_long_tool_name_that_goes_on_and_on_beyond_what_a_provider_takes_as_a_tool_name";
  const cache = { notes: offered(["read", "add.note", "a.b", "a_b", long]) };
  const m = migrate({ notes: { command: "x" } }, { cache });
  assert.deepEqual(m.verdict("notes_read"), { kind: "map", to: "mcp__notes__read", server: "notes" });
  assert.deepEqual(m.verdict("notes_add_note"), { kind: "map", to: "mcp__notes__add_note", server: "notes" });
  // `a.b` and `a_b` come out the same, so both get the hash pi gives them, and the adapter's name for each is the same one: not told.
  assert.equal(m.verdict("notes_a_b").kind, "unknown");
  assert.equal(m.nativeName("notes", "a.b"), mcpToolName("notes", "a.b", () => true));
  const longName = adapterToolName(long, "notes", "server");
  assert.deepEqual(m.verdict(longName), { kind: "map", to: mcpToolName("notes", long, () => true), server: "notes" });
  assert.ok(mcpToolName("notes", long).length <= 64);
  assert.equal(m.verdict("bash").kind, "keep");
  assert.equal(m.verdict("mcp__notes__read").kind, "keep", "a name that is pi's is left alone");
});

test("a switched-off name that cannot be told switches the server off, and is never dropped into on", () => {
  const cache = { gh: offered(["search"]), "a": offered(["b_c"]), "a_b": offered(["c"]), docs: offered(["find"], ["readme"]) };
  const m = migrate({ gh: { command: "x" }, a: { command: "y" }, a_b: { command: "z" }, docs: { command: "w" } }, { cache, normal: ["gh_issue_tool"] });
  // A name that looks like a tool of gh and that its cache does not list: removed from the server, never cached, or from before.
  assert.deepEqual(m.list("the default", "off", ["gh_old_tool", "bash"]), ["gh_old_tool", "bash"]);
  // The name of tools of two servers.
  assert.deepEqual(m.list("a chat", "off", ["a_b_c"]), ["a_b_c"]);
  // A resource's own tool.
  assert.deepEqual(m.list("a project", "off", ["docs_read_readme"]), ["docs_read_readme"]);
  const out = m.finish();
  assert.equal((out.mcpServers.gh as Record<string, unknown>).enabled, false);
  assert.equal((out.mcpServers.a as Record<string, unknown>).enabled, false);
  assert.equal((out.mcpServers.a_b as Record<string, unknown>).enabled, false);
  assert.equal((out.mcpServers.docs as Record<string, unknown>).enabled, false);
  assert.match(out.servers.find((s) => s.name === "gh")!.why.join(" "), /gh_old_tool, switched off in the default/);
  assert.ok(out.unconverted.length >= 3);
  // The same names in a list of exceptions that switch tools on are not switches: the default decides, which cannot be more open.
  const on = migrate({ gh: { command: "x" } }, { cache: { gh: offered(["search"]) } });
  assert.deepEqual(on.list("a chat", "on", ["gh_old_tool", "gh_search"]), ["gh_old_tool", "mcp__gh__search"]);
  assert.equal(written(on, "gh").enabled, undefined);
});

test("a tool of another package that has the name of an MCP tool is not told apart by its name: the server is off where it was switched off", () => {
  const m = migrate({ web: { command: "x" } }, { cache: { web: offered(["search"]) }, normal: ["web_search"] });
  assert.deepEqual(m.list("a chat", "off", ["web_search"]), ["web_search"]);
  assert.equal(written(m, "web").enabled, false);
  // An extension's own tool that merely starts like a server and is no tool of it is not a tool of it.
  const other = migrate({ web: { command: "x" } }, { cache: { web: offered(["search"]) }, normal: ["web_fetch"] });
  assert.deepEqual(other.list("a chat", "off", ["web_fetch"]), ["web_fetch"]);
  assert.equal(written(other, "web").enabled, undefined);
});

test("the adapter's mcp tool switched off is every MCP tool switched off, and the gateway's, every tool that was lazy-only", () => {
  const cache = { a: offered(["x", "y"]), b: offered(["z"]) };
  const m = migrate({ a: { command: "a" }, b: { command: "b" }, fresh: { command: "c" } }, { cache, lazyOnly: ["canvas_write", "canvas_read"] });
  const off = m.list("a project", "off", ["mcp", "bash"]);
  assert.deepEqual(off.sort(), ["bash", "mcp", "mcp__a__x", "mcp__a__y", "mcp__b__z"].sort());
  // The tools of a server that never ran cannot be named: it is off, as nothing stored can reach it.
  assert.equal(written(m, "fresh").enabled, false);
  assert.match(m.finish().servers.find((s) => s.name === "fresh")!.why.join(" "), /"mcp" was switched off in a project/);
  assert.equal(written(m, "a").enabled, undefined);
  assert.deepEqual(m.list("an agent", "off", ["mcp_script"]).filter((name) => name.startsWith("mcp__")).length, 3);
  const gateway = migrate({ a: { command: "a" } }, { cache: { a: offered(["x"]) }, lazyOnly: ["canvas_write", "canvas_read"] });
  assert.deepEqual(gateway.list("a chat", "off", ["tools"]).sort(), ["canvas_read", "canvas_write", "tools"]);
  assert.equal(written(gateway, "a").enabled, undefined, "the gateway never reached MCP");
  assert.deepEqual(gateway.finish().expanded, [{ where: "a chat", wrapper: "tools", count: 2 }]);
  // In a list of exceptions that switch on, the same tools are switched on: the layer keeps what it said.
  assert.deepEqual(m.list("a chat", "on", ["mcp"]).sort(), ["mcp", "mcp__a__x", "mcp__a__y", "mcp__b__z"]);
});

test("a mark or a pin on a server follows its rename, and one on a tool its new name; one that cannot be told is dropped", () => {
  const m = migrate({ "docs.v2": { command: "x" } }, { cache: { "docs.v2": offered(["search"]) } });
  assert.deepEqual(m.entries("a mode", ["docs.v2", "canvas", "<tool>docs.v2_search", "<tool>docs.v2_gone", "<tool>bash"]).sort(), ["<tool>bash", "<tool>mcp__docs_v2__search", "canvas", "docs_v2"]);
  assert.equal(m.finish().unconverted.some((item) => item.name === "docs.v2_gone"), true);
});

test("a server only the adapter's cache knows still has its names told, and an entry that is no object is left out", () => {
  const m = migrate({ broken: null, real: { command: "x" } }, { cache: { gone: offered(["tool"]) } });
  assert.deepEqual(m.verdict("gone_tool"), { kind: "map", to: "mcp__gone__tool", server: "gone" });
  const out = m.finish();
  assert.equal("broken" in out.mcpServers, false);
  assert.match(out.servers.find((s) => s.name === "broken")!.why.join(" "), /not an object/);
});

test("imports the adapter read, and its other settings, are said to be gone", () => {
  const m = migrate({ s: { command: "x" } }, { imports: ["cursor", "claude-code"], settings: { hostConfigDiscovery: "on" } });
  const gone = m.finish().gone.join(" | ");
  assert.match(gone, /imports: cursor, claude-code/);
  assert.match(gone, /settings: hostConfigDiscovery/);
});

test("every entry that is written is one pi's own validation takes, or is off", () => {
  const entries: Record<string, unknown> = {
    a: { command: "x", directTools: true, lifecycle: "eager" },
    b: { url: "https://x.example/mcp", auth: "bearer", bearerTokenEnv: "T", includeTools: ["a"] },
    c: { url: "ftp://x/mcp" },
    d: { command: "" },
    e: { command: "x", timeout: -3 },
  };
  const m = migrate(entries, { cache: { b: offered(["a", "b"]) } });
  const out = m.finish().mcpServers as Record<string, Record<string, unknown>>;
  for (const [name, entry] of Object.entries(out)) assert.ok(entry.enabled === false || entryProblem(name, entry) === null, `${name}: ${entryProblem(name, entry)}`);
  assert.equal(out.c.enabled, false);
  assert.equal(out.e.enabled, false);
});
