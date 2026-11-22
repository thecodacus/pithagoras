import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeModel, resultsIn } from "./fake-model.mjs";
import { inProcessHome } from "./server-harness.mjs";

/**
 * pi's own MCP support under the portal's client: mcp.json is read and its servers connected by pi, each tool arrives as
 * `mcp__<server>__<tool>` and is a tool like any other, in the model's list or, where the chat's head says its server is lazy,
 * behind `tool_search`. Real pi, the portal's own client, a real MCP server over stdio and a model that asks for what the
 * script says.
 */
const home = inProcessHome("pithagoras-mcp-native-");
mkdirSync(process.env.WORKSPACE_ROOT, { recursive: true });
const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));
const agentDir = process.env.PI_CODING_AGENT_DIR;

const server = (name, tools = "ping,echo", extra = {}) => ({ command: process.execPath, args: [FIXTURE, name, "--tools", tools], ...extra });
const putConfig = (servers) => writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: servers }));

let script = [];
const resultsOfTurn = (request) => resultsIn({ messages: request.messages.slice(request.messages.findLastIndex((m) => m.role === "user") + 1) });
const model = await fakeModel((request) => script[resultsOfTurn(request)] ?? "Done.");
writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(model.models()));

const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
const { buildLazyHead } = await import("../dist/lazy-head.js");

let n = 0;
const chat = () => mkdtempSync(path.join(process.env.WORKSPACE_ROOT, "chat-"));
const names = (request) => (request.tools ?? []).map((t) => t.function.name);
const textOf = (result) => JSON.stringify(result.result);
const search = (action, rest = {}) => ({ name: "tool_search", args: { action, ...rest } });
/** A head in which these sets are lazy, as a chat freezes it. */
const lazyHead = (...sets) => ({ v: 1, lazy: sets, direct: [], hint: `These tools are not in your list: ${sets.join(", ")}. Search them with the tool_search tool.`, outside: false, voice: [], tag: "0123456789abcdef" });

/** One message to a chat, and what came of it. */
async function run(calls, options = {}) {
  script = calls;
  model.requests.length = 0;
  const client = await SdkPiClient.create({
    cwd: chat(), sessionDir: mkdtempSync(path.join(home, "chat-")), provider: "fake", modelId: "m", sessionId: `mcp-native-${n++}`, dialogs: false, ...options,
  });
  const results = [];
  const settled = new Promise((resolve) => client.on("event", (e) => {
    if (e?.type === "tool_execution_end") results.push(e);
    if (e?.type === "agent_settled") resolve();
  }));
  try {
    await client.prompt("Go on");
    await settled;
    return { results, requests: [...model.requests], client, tools: await client.getTools(), active: client.session.getActiveToolNames() };
  } finally {
    // As the session manager lets a chat go: pi's MCP support stops the servers it started when it is told the session ends.
    await client.shutdown();
    client.dispose();
  }
}

test("a server in mcp.json is connected by pi, and its tools are in the model's list under pi's names, as any tool is", async () => {
  putConfig({ alpha: server("alpha") });
  const r = await run([{ name: "mcp__alpha__echo", args: { text: "hi" } }]);
  assert.match(names(r.requests[0]).join(","), /mcp__alpha__ping,mcp__alpha__echo|mcp__alpha__echo,mcp__alpha__ping/);
  assert.match(textOf(r.results[0]), /alpha\/echo says .*hi/);
  const mine = r.tools.filter((t) => t.name.startsWith("mcp__alpha__"));
  assert.deepEqual(mine.map((t) => [t.source, t.mcp, t.inline ?? false]).sort()[0], ["alpha", "alpha", false], "filed under the server, which brought it");
  assert.ok(mine.every((t) => t.tokens > 0), "each tool says what its declaration costs, for the threshold");
});

test("a server whose chat's head says it is lazy has its tools active and out of every request, and the search finds and calls them", async () => {
  putConfig({ alpha: server("alpha") });
  const r = await run([search("search", { query: "echo" }), search("call", { name: "mcp__alpha__echo", args: { text: "found" } })], { lazy: lazyHead("alpha") });
  assert.doesNotMatch(names(r.requests[0]).join(","), /mcp__alpha/, "not in the tools array");
  assert.ok(names(r.requests[0]).includes("tool_search"));
  assert.ok(r.active.includes("mcp__alpha__echo"), "active, and so callable");
  assert.equal(new Set(r.requests.map((q) => names(q).join(","))).size, 1, "the same tools array in every request");
  assert.match(textOf(r.results[0]), /mcp__alpha__echo/);
  // The call of the tool it names is told as the search's own result, to the pages: that is what the search returns.
  assert.match(textOf(r.results[1]), /alpha\/echo says .*found/);
});

test("a server in the head's direct list stays in the model's list beside a lazy one", async () => {
  putConfig({ alpha: server("alpha"), beta: server("beta", "other") });
  const r = await run([], { lazy: { ...lazyHead("beta"), direct: ["alpha"] } });
  const listed = names(r.requests[0]).join(",");
  assert.match(listed, /mcp__alpha__ping/);
  assert.doesNotMatch(listed, /mcp__beta/);
});

test("a server whose tools the chat has all switched off (mcpOff) is not started for it", async () => {
  putConfig({ alpha: server("alpha"), beta: server("beta", "other") });
  const r = await run([], { mcpOff: () => new Set(["alpha"]) });
  const listed = names(r.requests[0]).join(",");
  assert.doesNotMatch(listed, /mcp__alpha/);
  assert.match(listed, /mcp__beta__other/);
});

test("a server the file switches off (enabled: false) is not connected, and one it hides is unreachable", async () => {
  putConfig({ alpha: server("alpha", "ping", { enabled: false }), beta: server("beta", "other", { exposure: "hidden" }), gamma: server("gamma", "third") });
  const r = await run([]);
  const listed = names(r.requests[0]).join(",");
  assert.doesNotMatch(listed, /mcp__alpha|mcp__beta/);
  assert.match(listed, /mcp__gamma__third/);
});

test("a tool that is switched off is out of the list and not callable, whatever pi's exposure is", async () => {
  putConfig({ alpha: server("alpha") });
  const r = await run([{ name: "mcp__alpha__echo", args: {} }], { toolsOff: ["mcp__alpha__echo"] });
  assert.doesNotMatch(names(r.requests[0]).join(","), /mcp__alpha__echo/);
  assert.match(textOf(r.results[0]), /not found/);
});

test("the file's exposure does not decide what the model is given: a server the file puts behind codemode is in the list all the same", async () => {
  putConfig({ alpha: server("alpha", "ping", { exposure: "codemode" }), beta: server("beta", "other", { exposure: "deferred" }) });
  const r = await run([]);
  const listed = names(r.requests[0]).join(",");
  assert.match(listed, /mcp__alpha__ping/);
  assert.match(listed, /mcp__beta__other/);
  assert.doesNotMatch(listed, /mcp_servers/, "no section of pi's about servers whose tools are not declared");
  assert.doesNotMatch(JSON.stringify(r.requests[0].messages), /mcp_servers/);
});

test("a trusted project's own mcp.json cannot define a server of the user's file again, and keeps the right to turn it off", async () => {
  putConfig({ alpha: server("alpha") });
  const folder = chat();
  mkdirSync(path.join(folder, ".pi"), { recursive: true });
  // Trusted as pi decides it: the setting the portal's loader reads; the sandbox is off in a test.
  writeFileSync(path.join(folder, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { alpha: server("alpha", "stolen"), mine: server("mine", "own") } }));
  const { piMcp } = await import("../dist/pi/mcp-config.js");
  const { configForChat } = await import("../dist/pi/mcp-config.js");
  const pi = await piMcp();
  const seen = [];
  const loaded = configForChat(pi, { cwd: folder, isProjectTrusted: () => true }, agentDir, () => false, (servers) => seen.push(...servers));
  const alpha = loaded.servers.find((s) => s.name === "alpha");
  assert.deepEqual(alpha.config.args.slice(-2), ["--tools", "ping,echo"], "the user's own definition, not the project's");
  assert.equal(alpha.scope, "global");
  assert.ok(loaded.servers.some((s) => s.name === "mine" && s.scope === "project"), "a server of its own is its own");
  assert.equal(loaded.autoEnableCodemode, false);
  // An override of enabled is pi's own rule and stays.
  writeFileSync(path.join(folder, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { alpha: { enabled: false } } }));
  const overridden = configForChat(pi, { cwd: folder, isProjectTrusted: () => true }, agentDir, () => false, () => {});
  assert.equal(overridden.servers.find((s) => s.name === "alpha").config.enabled, false);
});

test("what a chat's head makes of servers: one nothing has been seen of is lazy until it has been, one marked direct is not", async () => {
  const db = await import("../dist/db.js");
  putConfig({ alpha: server("alpha"), beta: server("beta", "other"), gamma: server("gamma", "third") });
  db.setToolMarks({ beta: "direct" });
  const head = buildLazyHead();
  assert.deepEqual(head.lazy, ["alpha", "gamma"].sort(), "alpha and gamma were never seen: lazy; beta is marked direct");
  assert.deepEqual(head.direct, ["beta"]);
  assert.match(head.hint, /alpha; gamma|alpha.*gamma/);
  // Once a chat has seen a server's tools, the threshold decides: a small server is in the list.
  db.rememberTools([db.remembered({ name: "mcp__alpha__ping", source: "alpha", mcp: "alpha", tokens: 50 }), db.remembered({ name: "mcp__alpha__echo", source: "alpha", mcp: "alpha", tokens: 50 })]);
  assert.deepEqual(buildLazyHead().lazy, ["gamma"]);
  db.setToolMarks({});
});
