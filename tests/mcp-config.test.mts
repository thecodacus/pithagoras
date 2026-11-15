import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { clashes, commandValues, entryProblem, fromAdapterEntry, mcpToolName, mcpToolNames, matchesTool, toolExposureOf } from "../core/server/src/mcp-config.ts";
import { pi, wireSession } from "./pi-wire.mts";

/**
 * What the portal writes again of pi's MCP support: the validation of a server's entry and the names of its tools. pi
 * exports neither (its package has no deep import), so these tests hold the copies to pi: its documented examples, and the
 * real functions of the installed pi, read by their file, run against the same inputs. A pi that moves a rule fails here and
 * not in a person's server.
 */
const root = path.resolve("node_modules/@earendil-works/pi-coding-agent");
const real = (file: string) => import(pathToFileURL(path.join(root, "dist", file)).href);
const core = await real("core/mcp-servers.js");
const tools = await real("extensions/mcp/tools.js");

/** The examples of pi's docs/mcp.md, as the file has them. */
const EXAMPLES: Record<string, unknown> = {
  filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] },
  docs: { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" }, description: "Search and read the product documentation" },
  sentry: { url: "https://mcp.sentry.dev/mcp" },
  github: { url: "https://api.githubcopilot.com/mcp/", exposure: "deferred", toolExposure: { search_code: "direct", "get_*": "codemode", "delete_*": "hidden" } },
  example: { url: "https://mcp.example.com/mcp", oauth: { clientId: "my-client", clientSecret: "${EXAMPLE_SECRET}", callbackPort: 8765 } },
  figma: { url: "https://mcp.figma.com/mcp", oauth: { clientName: "Claude Code" } },
  cimd: { url: "https://mcp.example.com/mcp", oauth: { clientRegistration: "cimd" } },
  metadata: { url: "https://mcp.example.com/mcp", oauth: { authServerMetadataUrl: "https://example.okta.com/.well-known/openid-configuration" } },
  command: { url: "https://mcp.example.com/mcp", headers: { Authorization: "!echo Bearer $(gh auth token)" } },
  old: { url: "https://mcp.example.com/mcp", exposure: "codemode-deferred" },
};

test("pi's own examples are servers, and the portal says so too", () => {
  for (const [name, entry] of Object.entries(EXAMPLES)) {
    assert.equal(typeof core.validateMcpServerConfig(name, entry), "object", `pi takes ${name}`);
    assert.equal(entryProblem(name, entry), null, `and so does the portal: ${name}`);
  }
});

/** Entries pi refuses, and entries it takes that look odd: the two must agree on each. */
const CASES: [string, unknown][] = [
  ["a.b", { command: "x" }],
  ["a b", { command: "x" }],
  ["-x", { command: "x" }],
  ["ok", null],
  ["ok", []],
  ["ok", {}],
  ["ok", { command: "" }],
  ["ok", { command: 1 }],
  ["ok", { command: "x", args: "y" }],
  ["ok", { command: "x", args: ["y", 2] }],
  ["ok", { command: "x", env: { A: 1 } }],
  ["ok", { command: "x", cwd: 3 }],
  ["ok", { command: "x", type: "stdio" }],
  ["ok", { command: "x", type: "http" }],
  ["ok", { url: "https://x/mcp", type: "streamable-http" }],
  ["ok", { url: "https://x/mcp", type: "sse" }],
  ["ok", { url: "ftp://x/mcp" }],
  ["ok", { url: "not a url" }],
  ["ok", { url: "https://x/mcp", headers: { A: 1 } }],
  ["ok", { url: "https://x/mcp", headers: [] }],
  ["ok", { command: "x", url: "https://x/mcp" }],
  ["ok", { socket: "/tmp/x.sock" }],
  ["ok", { command: "x", enabled: "no" }],
  ["ok", { command: "x", enabled: false }],
  ["ok", { command: "x", timeout: 0 }],
  ["ok", { command: "x", timeout: -1 }],
  ["ok", { command: "x", timeout: 30 }],
  ["ok", { command: "x", description: 1 }],
  ["ok", { command: "x", exposure: "everywhere" }],
  ["ok", { command: "x", exposure: "hidden" }],
  ["ok", { command: "x", toolExposure: "direct" }],
  ["ok", { command: "x", toolExposure: { a: "nope" } }],
  ["ok", { command: "x", toolExposure: { "a*": "hidden", b: "direct" } }],
  ["ok", { url: "https://x/mcp", oauth: "yes" }],
  ["ok", { url: "https://x/mcp", oauth: { callbackPort: 0 } }],
  ["ok", { url: "https://x/mcp", oauth: { callbackPort: 99999 } }],
  ["ok", { url: "https://x/mcp", oauth: { callbackUrl: "https://x/cb" } }],
  ["ok", { url: "https://x/mcp", oauth: { callbackUrl: "http://127.0.0.1:9000/cb", callbackPort: 9001 } }],
  ["ok", { url: "https://x/mcp", oauth: { clientName: " " } }],
  ["ok", { url: "https://x/mcp", oauth: { clientRegistration: "cimd", clientId: "c" } }],
  ["ok", { url: "https://x/mcp", oauth: { clientRegistration: "other" } }],
  ["ok", { url: "https://x/mcp", oauth: { authServerMetadataUrl: "http://example.com/m" } }],
  ["ok", { url: "https://x/mcp", oauth: { authServerMetadataUrl: "http://127.0.0.1/m" } }],
  ["ok", { url: "https://x/mcp", auth: { provider: "p" } }],
  ["ok", { url: "https://x/mcp", auth: { provider: "" } }],
  ["ok", { url: "http://x/mcp", auth: { provider: "p" } }],
  ["ok", { url: "http://localhost:1/mcp", auth: { provider: "p" } }],
  // What the old adapter's entries look like: pi skips or takes them by the same rules.
  ["ok", { url: "https://x/mcp", lifecycle: "lazy", directTools: true }],
  ["ok", { command: "x", disabled: true }],
  ["ok", { command: "x", auth: "bearer", bearerToken: "t" }],
];

test("the portal's entry validation agrees with pi's on what is a server", () => {
  for (const [name, entry] of CASES) {
    const theirs = core.validateMcpServerConfig(name, entry);
    const ours = entryProblem(name, entry);
    assert.equal(ours === null, typeof theirs !== "string", `${name} ${JSON.stringify(entry)}: pi says ${typeof theirs === "string" ? theirs : "fine"}, the portal says ${ours ?? "fine"}`);
  }
});

test("a name that differs from another only in - and _ is the same server to pi, and so to the portal", () => {
  assert.deepEqual(clashes(["my-notes", "other", "my_notes"]), [["my-notes", "my_notes"]]);
  assert.deepEqual(clashes(["a", "b"]), []);
});

test("the portal names a server's tools as pi does, one at a time and over a whole list", async () => {
  const hard = ["search", "search-code", "search_code", "get.issue", "get issue", "ü", "a".repeat(80), "a".repeat(80) + "b", "x/y", "dash-es-and.dots", "__"];
  for (const server of ["notes", "my-notes", "my_notes", "x".repeat(40)]) {
    for (const tool of hard) assert.equal(mcpToolName(server, tool), tools.createMcpToolName(server, tool), `${server} ${tool}`);
  }
  // pi's list rule (registerTools in extensions/mcp/index.js): a name two tools would get is given to neither, each takes the hash.
  const list = ["search-code", "search_code", "search.code", "plain", "also-plain"];
  const names = mcpToolNames("notes", list);
  const plain = list.map((tool) => tools.createMcpToolName("notes", tool));
  for (const tool of list) {
    const clash = plain.indexOf(tools.createMcpToolName("notes", tool)) !== plain.lastIndexOf(tools.createMcpToolName("notes", tool));
    assert.equal(names.get(tool), clash ? tools.createMcpToolName("notes", tool, () => true) : tools.createMcpToolName("notes", tool), tool);
  }
  assert.notEqual(names.get("search-code"), names.get("search_code"));
  assert.equal(names.get("plain"), "mcp__notes__plain");
});

test("what pi really registers for a server's tools is what the portal's rule says", async () => {
  const dir = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), "pitha-mcp-names-"));
  try {
    const tools = ["search-code", "search_code", "get.issue", "plain", "x".repeat(70)];
    const entry = { name: "my-notes", source: "test", scope: "global" as const, config: { command: process.execPath, args: [path.resolve("tests/fixtures/mcp-server.mjs"), "my-notes", "--tools", tools.join(",")], exposure: "direct" } };
    const extension = pi.createMcpExtension({ loadConfig: () => ({ servers: [entry], errors: [], autoEnableCodemode: false }), startupWaitMs: 8000, logPath: path.join(dir, "mcp.log") });
    const model = (await pi.ModelRuntime.create()).getModel("anthropic", "claude-opus-4-5");
    const { session, close } = await wireSession(model, [extension], () => "ok");
    try {
      await session.prompt("go");
      const registered = session.getAllTools().filter((tool: any) => tool.name.startsWith("mcp__")).map((tool: any) => tool.name).sort();
      assert.deepEqual([...mcpToolNames("my-notes", tools).values()].sort(), registered);
    } finally {
      await close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pattern of tool names is pi's: * is any characters, an exact name before a pattern, the first pattern that fits", () => {
  const { createToolNameMatcher, getMcpToolExposure } = core;
  for (const [entries, name] of [[["get_*"], "get_issue"], [["get_*"], "forget_it"], [["a.b"], "aXb"], [["a.b"], "a.b"], [["*"], ""], [["x*y*z"], "xAyBz"], [["(a)"], "(a)"]] as [string[], string][]) {
    assert.equal(matchesTool(entries, name), createToolNameMatcher(entries)(name), `${entries} ${name}`);
  }
  const config = { exposure: "deferred", toolExposure: { "get_*": "codemode", get_issue: "direct", "*": "hidden" } };
  for (const name of ["get_issue", "get_other", "list", "x"]) assert.equal(toolExposureOf(config, name), getMcpToolExposure(config, name), name);
  assert.equal(toolExposureOf({}, "x"), "codemode", "pi's default");
  assert.equal(toolExposureOf({ exposure: "codemode-deferred" }, "x"), "codemode", "the older name");
});

test("a value that starts with ! is a command pi runs, even for an HTTP server, and the portal names the places", () => {
  assert.deepEqual(commandValues(EXAMPLES.command), ["headers.Authorization"]);
  assert.deepEqual(commandValues({ command: "x", env: { A: "!pass show a", B: "plain" } }), ["env.A"]);
  assert.deepEqual(commandValues({ url: "https://x/mcp", oauth: { clientSecret: "!cat /secret" } }), ["oauth.clientSecret"]);
  assert.deepEqual(commandValues({ url: "https://x/mcp", headers: { A: "Bearer !x" } }), [], "only a value that starts with it");
  assert.deepEqual(commandValues(null), []);
});

test("the old adapter's keys are translated for one release, and what cannot be said exactly is refused", () => {
  const one = fromAdapterEntry({ url: "https://x/mcp", lifecycle: "lazy", directTools: true, disabled: true, auth: "bearer", bearerTokenEnv: "TOKEN", approveTools: ["delete_*"], idleTimeout: 5, debug: true }, "x");
  assert.deepEqual(one.entry, { url: "https://x/mcp", enabled: false, exposure: "direct", headers: { Authorization: "Bearer ${TOKEN}" } });
  assert.deepEqual(one.approve.sort(), ["delete-*", "delete_*"]);
  const list = fromAdapterEntry({ command: "x", directTools: ["a", "b"] }, "x");
  assert.deepEqual(list.entry, { command: "x", exposure: "deferred", toolExposure: { a: "direct", b: "direct" } });
  assert.deepEqual(list.direct, ["a", "b"]);
  // Include then exclude, as the adapter did: what is excluded stays hidden, whatever the include says, and the rest is hidden.
  const filtered = fromAdapterEntry({ command: "x", includeTools: ["get_*", "delete_all"], excludeTools: ["delete_*"] }, "x").entry;
  for (const [tool, shown] of [["get_issue", true], ["get-issue", true], ["delete_all", false], ["delete_one", false], ["delete-one", false], ["other", false]] as const) {
    assert.equal(toolExposureOf(filtered as never, tool) !== "hidden", shown, tool);
  }
  assert.throws(() => fromAdapterEntry({ socket: "/tmp/mux.sock" }, "x"), /socket/);
  assert.throws(() => fromAdapterEntry({ command: "x", includeTools: ["get_?"] }, "x"), /\?/);
  assert.deepEqual(fromAdapterEntry({ url: "https://x/mcp", auth: "oauth" }, "x").entry, { url: "https://x/mcp" });
  assert.deepEqual(fromAdapterEntry({ url: "https://x/mcp", headers: { A: "b" }, description: "d", timeout: 9 }, "x").entry, { url: "https://x/mcp", headers: { A: "b" }, description: "d", timeout: 9 });
});

test("the adapter's patterns are carried to the server's own tool names: its prefixes taken off, and - and _ alike, as it matched them", () => {
  // Correctness review 1 of PR B, finding 3, and security review 1, finding 4: what the adapter held back stays held back.
  const tools = ["delete_repo", "delete-branch", "create_issue", "get_file", "list_pulls", "search_code_in_the_repository_now"];
  const shown = (entry: Record<string, unknown>) => tools.filter((tool) => toolExposureOf(entry as never, tool) !== "hidden");
  for (const exclude of [["gh_delete_*"], ["gh-delete-*"], ["mcp__gh_mcp_delete_*"], ["delete_*"], ["delete-*"], ["gh*delete*"]]) {
    const { entry } = fromAdapterEntry({ command: "gh-mcp", excludeTools: exclude }, "gh-mcp");
    assert.deepEqual(shown(entry), ["create_issue", "get_file", "list_pulls", "search_code_in_the_repository_now"], exclude.join());
  }
  // The short naming of gh-mcp is gh; a name that is excluded exactly, in the other separator.
  assert.deepEqual(shown(fromAdapterEntry({ command: "gh-mcp", excludeTools: ["delete_branch", "gh_mcp_get_file"] }, "gh-mcp").entry), ["delete_repo", "create_issue", "list_pulls", "search_code_in_the_repository_now"]);
  // A long name is hidden by a wider pattern, never shown.
  assert.equal(shown(fromAdapterEntry({ command: "g", excludeTools: ["search-code-in-the-repository-now"] }, "g").entry).includes("search_code_in_the_repository_now"), false);
  // An include in the prefixed form lets the tool through, and nothing else.
  assert.deepEqual(shown(fromAdapterEntry({ command: "gh", includeTools: ["gh_get_file", "gh_list-pulls"] }, "gh").entry), ["get_file", "list_pulls"]);
  // A directTools name that an exclusion covers, or an include leaves out, is no exact entry that would win over them.
  const covered = fromAdapterEntry({ command: "gh", directTools: ["delete_repo", "get_file"], excludeTools: ["delete_*"] }, "gh");
  assert.equal(toolExposureOf(covered.entry as never, "delete_repo"), "hidden");
  assert.equal(toolExposureOf(covered.entry as never, "get_file"), "direct");
  assert.deepEqual(covered.direct, ["get_file"]);
  const outside = fromAdapterEntry({ command: "gh", directTools: ["b"], includeTools: ["a"] }, "gh");
  assert.equal(toolExposureOf(outside.entry as never, "b"), "hidden");
  assert.deepEqual(outside.direct, []);
  // Confirmations: wider, never narrower; a prefixed one asks for the tool by its own name.
  const approve = fromAdapterEntry({ command: "gh", approveTools: ["gh_create_*", "gh?delete-repo"] }, "gh").approve;
  for (const tool of ["create_issue", "create-issue", "delete_repo", "delete-repo"]) assert.ok(matchesTool(approve, tool), `${tool}: ${approve}`);
  assert.equal(matchesTool(approve, "get_file"), false);
});

test("an include and an exclude of the same pattern hide what it names, and an include of everything shows what no exclusion holds back", () => {
  // From the CodeRabbit review of #371.
  const tools = ["delete_repo", "delete-branch", "get_file"];
  const shown = (entry: Record<string, unknown>) => tools.filter((tool) => toolExposureOf(entry as never, tool) !== "hidden");
  assert.deepEqual(shown(fromAdapterEntry({ command: "x", includeTools: ["delete_*"], excludeTools: ["delete_*"] }, "x").entry), []);
  assert.deepEqual(shown(fromAdapterEntry({ command: "x", includeTools: ["*"] }, "x").entry), tools);
  assert.deepEqual(shown(fromAdapterEntry({ command: "x", includeTools: ["*"], excludeTools: ["delete_*"] }, "x").entry), ["get_file"]);
  assert.deepEqual(shown(fromAdapterEntry({ command: "x", includeTools: ["*"], excludeTools: ["*"] }, "x").entry), []);
});
