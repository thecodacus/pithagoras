import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pi, wireSession } from "./pi-wire.mts";
import { Type } from "typebox";

/**
 * What the portal's plan for native MCP (issue #361, PR 0) relies on pi's MCP support to do, with its real extension
 * and a small MCP server of the fixtures' (see fixtures/mcp-server.mjs) in a real pi session: hidden declarations for
 * servers that are connected at the start, a server connected on its first use, a config read again at a reload, the
 * notices and the prompt section pi adds, and a call of a deferred tool through the hooks.
 */
const FIXTURE = path.resolve("tests/fixtures/mcp-server.mjs");
const dir = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), "pitha-mcp-"));
const log = path.join(dir, "servers.log");
// What this file made, and no more.
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const lines = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => line.split(" ").slice(2).join(" ")) : []);

type Server = { name: string; exposure?: string; delay?: number; resources?: boolean; tools?: string };
const entry = ({ name, exposure, delay, resources, tools }: Server) => ({
  name,
  source: "test",
  scope: "global" as const,
  config: { command: process.execPath, args: [FIXTURE, name, "--tools", tools ?? "one,two", "--log", log, ...(delay ? ["--delay", String(delay)] : []), ...(resources ? ["--resources"] : [])], ...(exposure ? { exposure } : {}) },
});
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });
const until = async (done: () => boolean, ms = 8000) => {
  const from = Date.now();
  while (!done()) {
    if (Date.now() - from > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return Date.now() - from;
};
const call = (name: string, args: unknown = {}) => ({ name, args });
const anthropic = async () => (await pi.ModelRuntime.create()).getModel("anthropic", "claude-opus-4-5");

/** pi's MCP support with the servers a test says, as `loadConfig` gives them: the seam the portal uses. */
function mcpWith(servers: () => Server[], options: Record<string, unknown> = {}) {
  const reads: number[] = [];
  const extension = pi.createMcpExtension({
    loadConfig: () => {
      reads.push(Date.now());
      return { servers: servers().map(entry), errors: [], autoEnableCodemode: false };
    },
    startupWaitMs: 0,
    logPath: path.join(dir, "mcp.log"),
    ...options,
  });
  return { extension, reads };
}

/**
 * The stand-in tool search: it hides what `hide` says (by the name or the namespace, read from pi's registry at each
 * request) and calls through `executeTool`; `connect` is what a call of a server's tool does first, if anything.
 */
function toolSearch(hide: (name: string, namespace: string | undefined) => boolean, connect?: (p: any, name: string) => Promise<void>) {
  return (p: any) => {
    p.registerTool({
      name: "tool_search",
      label: "tool_search",
      description: "Find the tools that are not in your list, and call them.",
      parameters: Type.Object({ action: Type.String(), name: Type.Optional(Type.String()), args: Type.Optional(Type.Any()) }),
      exposure: "model-only",
      prepareLoadout: (loadout: any) => ({ hiddenDeclarations: loadout.registered.filter((t: any) => hide(t.name, loadout.getNamespace(t.name)?.name)).map((t: any) => t.name) }),
      async execute(_id: string, a: any, signal: AbortSignal, _update: unknown, ctx: any) {
        if (a.action !== "call") return text(p.getAllTools().filter((t: any) => t.name.startsWith("mcp__")).map((t: any) => `${t.name} (${t.exposure})`).join("\n"));
        await connect?.(p, a.name);
        const done = await ctx.executeTool(a.name, a.args ?? {}, { signal });
        return { ...done.result, isError: done.isError };
      },
    });
  };
}
const inMcp = (server: string) => (name: string, namespace: string | undefined) => namespace === `mcp__${server}`;

async function chat(extensions: ((p: any) => void)[], script: (n: number) => any, prompts = ["go"], after?: (s: any, r: any[]) => Promise<void>) {
  const { session, requests, notices, close } = await wireSession(await anthropic(), extensions, script);
  try {
    for (const prompt of prompts) {
      await session.prompt(prompt);
      await after?.(session, requests);
    }
    return { session, requests, notices };
  } finally {
    await close();
  }
}

test("a server that is direct and hidden by its namespace: its tools are in no request, run by name and through the search, and pi adds no prompt section", async () => {
  // pi's own wait for the servers that have direct tools, which the first prompt makes, is what lets a call by name work at once.
  const { extension } = mcpWith(() => [{ name: "alpha", exposure: "direct" }], { startupWaitMs: 5000 });
  const script = [call("tool_search", { action: "search" }), call("mcp__alpha__one", { text: "a" }), call("tool_search", { action: "call", name: "mcp__alpha__two", args: { text: "b" } }), "Done."];
  const { requests, notices } = await chat([extension, toolSearch(inMcp("alpha"))], (n) => script[n], ["go"], async () => {});
  assert.equal(requests.length, 4);
  for (const request of requests) {
    assert.equal(request.tools, requests[0].tools);
    assert.equal(request.system, requests[0].system);
  }
  assert.doesNotMatch(requests[0].tools, /mcp__alpha/);
  assert.doesNotMatch(requests[0].system, /mcp__alpha|MCP servers whose tools/);
  assert.match(JSON.stringify(requests[3].body.messages), /alpha\/two says/);
  assert.deepEqual(notices, [], "nothing is said to the person");
});

test("a direct server that connects after the first request does not change the head when its tools are hidden by namespace, and does when they are not", async () => {
  for (const hidden of [true, false]) {
    const { extension } = mcpWith(() => [{ name: "slow", exposure: "direct", delay: 600 }]);
    const script = [call("tool_search", { action: "search" }), "ok", "Done."];
    const first = await wireSession(await anthropic(), [extension, toolSearch(hidden ? inMcp("slow") : () => false)], (n) => script[n]);
    try {
      // The first prompt goes out before the server has answered (startupWaitMs is 0): its tools register in the middle of the chat.
      await first.session.prompt("one");
      assert.equal(first.session.getAllTools().some((t: any) => t.name.startsWith("mcp__slow")), false, "not connected yet at the first request");
      await until(() => first.session.getAllTools().some((t: any) => t.name.startsWith("mcp__slow")));
      await first.session.prompt("two");
      const [before, after] = [first.requests[0], first.requests.at(-1)!];
      assert.equal(after.tools === before.tools, hidden, hidden ? "the head holds" : "the late tools were declared");
      assert.equal(after.system === before.system, true);
    } finally {
      await first.close();
    }
  }
});

/** What the search does for a server that is not connected: registers it with pi, and waits for its tools to exist (pi has no await for that). */
const connectOnUse = (server: Server, measured?: number[]) => async (p: any, name: string) => {
  if (!name.startsWith(`mcp__${server.name}__`) || p.getAllTools().some((t: any) => t.name === name)) return;
  const from = Date.now();
  p.registerMcpServer(server.name, entry(server).config);
  await until(() => p.getAllTools().some((t: any) => t.name === name), 8000);
  measured?.push(Date.now() - from);
};
const PROMPT_SECTION = /MCP servers whose tools are not declared/;
const NEITHER = /neither .*active/i;

test("a server connected on its first use: its tools arrive deferred and inactive, the tools array stays, and pi writes a prompt section and a notice the portal has to neutralise", async () => {
  const lazy: Server = { name: "beta", exposure: "deferred" };
  const waited: number[] = [];
  const { extension } = mcpWith(() => []);
  const script = [call("tool_search", { action: "call", name: "mcp__beta__one", args: { text: "x" } }), "ok", "Done."];
  const { requests, notices } = await chat([extension, toolSearch(inMcp("beta"), connectOnUse(lazy, waited))], (n) => script[n], ["one", "two"]);
  assert.equal(waited.length, 1, "it was not connected, and the call waited for it");
  assert.equal(requests.length, 3);
  // Before and after: the tools array is the same, with the server running.
  assert.equal(requests.at(-1)!.tools, requests[0].tools);
  assert.doesNotMatch(requests[0].tools, /mcp__beta/);
  assert.match(JSON.stringify(requests.at(-1)!.body.messages), /beta\/one says/);
  // pi puts its `mcp_servers` section into the prompt when the server is registered (deferred is one of the exposures it lists).
  assert.doesNotMatch(requests[0].system, PROMPT_SECTION);
  assert.match(requests.at(-1)!.system, PROMPT_SECTION, "the head changed with the connection: that is what the portal's handler has to take out");
  // And it says that neither tool_search nor codemode is active: it only knows its own tool_search.
  assert.ok(notices.some((n) => NEITHER.test(n.text)), `a notice: ${JSON.stringify(notices)}`);
});

test("a before_agent_start handler that comes after pi's keeps the section out of every request, and the server's tools are still callable", async () => {
  const lazy: Server = { name: "beta", exposure: "deferred" };
  const { extension } = mcpWith(() => []);
  // Loaded after pi's own, as the portal's extensions are: handlers run in load order.
  const portalHandler = (p: any) => p.on("before_agent_start", (event: any) => void delete event.systemPromptOptions.sections.mcp_servers);
  const script = [call("tool_search", { action: "call", name: "mcp__beta__one" }), "ok", "Done."];
  const { requests } = await chat([extension, portalHandler, toolSearch(inMcp("beta"), connectOnUse(lazy))], (n) => script[n], ["one", "two"]);
  assert.equal(requests.length, 3);
  for (const request of requests) assert.equal(request.system, requests[0].system);
  assert.doesNotMatch(requests[0].system, PROMPT_SECTION);
  assert.match(JSON.stringify(requests.at(-1)!.body.messages), /beta\/one says/);
  // Before pi's own handler it would not: pi writes the section after.
  const wrong = await chat([portalHandler, mcpWith(() => []).extension, toolSearch(inMcp("beta"), connectOnUse(lazy))], (n) => script[n], ["one", "two"]);
  assert.match(wrong.requests.at(-1)!.system, PROMPT_SECTION, "an earlier handler is undone by pi's");
});

test("loadConfig is read again at a reload, and what it returns then is what the session has", async () => {
  let servers: Server[] = [{ name: "one", exposure: "deferred" }];
  const { extension, reads } = mcpWith(() => servers);
  const { session, close } = await wireSession(await anthropic(), [extension], () => "Done.");
  try {
    await until(() => session.getAllTools().some((t: any) => t.name === "mcp__one__one"));
    assert.equal(reads.length, 1);
    servers = [{ name: "two", exposure: "deferred" }];
    await session.reload();
    assert.equal(reads.length, 2, "read again at the reload");
    await until(() => session.getAllTools().some((t: any) => t.name === "mcp__two__one"));
    // The old runtime was shut down with its servers: the first server's process ended.
    await until(() => lines().some((l) => l.startsWith("exit one")));
  } finally {
    await close();
  }
});

test("a server that is unregistered is closed and its tools are withdrawn; registered again it starts again and the tools are back, still deferred", async () => {
  let api: any;
  const holder = (p: any) => void (api = p);
  const { extension } = mcpWith(() => []);
  const { session, close } = await wireSession(await anthropic(), [extension, holder], () => "Done.");
  const config = entry({ name: "gamma", exposure: "deferred" }).config;
  const count = (what: string) => lines().filter((l) => l === `${what} gamma`).length;
  const exposure = () => session.getAllTools().find((t: any) => t.name === "mcp__gamma__one")?.exposure;
  try {
    api.registerMcpServer("gamma", config);
    await until(() => exposure() === "deferred");
    assert.equal(count("start"), 1);
    api.unregisterMcpServer("gamma");
    await until(() => exposure() === "hidden");
    await until(() => count("exit") === 1);
    // Registered again with the same config: a new process, and the tools as they were.
    api.registerMcpServer("gamma", config);
    await until(() => exposure() === "deferred");
    assert.equal(count("start"), 2);
    assert.equal(session.getActiveToolNames().includes("mcp__gamma__one"), false, "never active: deferred tools are not declared");
  } finally {
    await close();
  }
});

test("a call through executeTool of a deferred MCP tool goes through the hooks, with the call that made it, and a tool that is not callable is not found", async () => {
  const seen: { tool: string; parent?: string }[] = [];
  const hooks = (p: any) => p.on("tool_call", (event: any) => void seen.push({ tool: event.toolName, parent: event.parentToolCallId }));
  const { extension } = mcpWith(() => [{ name: "delta", exposure: "deferred" }]);
  const script = [call("tool_search", { action: "call", name: "mcp__delta__one", args: { text: "x" } }), call("mcp__delta__two", {}), "Done."];
  const search = toolSearch(inMcp("delta"), async (p, name) => void (await until(() => p.getAllTools().some((t: any) => t.name === name))));
  const { requests } = await chat([extension, hooks, search], (n) => script[n]);
  assert.deepEqual(seen.map((s) => s.tool), ["tool_search", "mcp__delta__one"]);
  assert.equal(seen[1].parent, seen[0] && "call_1_0", "the nested call carries the id of the call that made it");
  assert.match(JSON.stringify(requests[1].body.messages), /delta\/one says/);
  // By its own name the model cannot call it: it is not declared, and not active (a deferred tool is neither).
  assert.match(JSON.stringify(requests[2].body.messages), /Tool mcp__delta__two not found/);
});

test("the resource tools of a direct server are declared in the middle of a chat, unless they are hidden by name; of a deferred one they are not", async () => {
  const names = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];
  for (const [exposure, hidden] of [["direct", false], ["direct", true], ["deferred", false]] as const) {
    const { extension } = mcpWith(() => [{ name: "res", exposure, resources: true, delay: 500 }]);
    const search = toolSearch((name, namespace) => namespace === "mcp__res" || (hidden && names.includes(name)));
    const script = ["ok", "Done."];
    const { session, requests, close } = await wireSession(await anthropic(), [extension, search], (n) => script[n]);
    try {
      await session.prompt("one");
      await until(() => session.getAllTools().some((t: any) => names.includes(t.name)));
      await session.prompt("two");
      const declared = names.filter((name) => requests.at(-1)!.tools.includes(`"name":"${name}"`));
      assert.deepEqual(declared, exposure === "direct" && !hidden ? names : [], `${exposure}${hidden ? " and hidden" : ""}`);
      assert.equal(requests.at(-1)!.tools === requests[0].tools, !(exposure === "direct" && !hidden));
    } finally {
      await close();
    }
  }
});

test("a server connected on its first use as a direct server and hidden by its namespace: pi adds no section and no notice, the head holds, and the tool is called by name once it is there", async () => {
  const server: Server = { name: "eps", exposure: "direct" };
  const waited: number[] = [];
  const { extension } = mcpWith(() => []);
  const script = [call("tool_search", { action: "call", name: "mcp__eps__one", args: { text: "x" } }), call("mcp__eps__two", { text: "y" }), "Done."];
  const { requests, notices } = await chat([extension, toolSearch(inMcp("eps"), connectOnUse(server, waited))], (n) => script[n], ["go"]);
  assert.equal(waited.length, 1);
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.tools, requests[0].tools);
    assert.equal(request.system, requests[0].system);
  }
  assert.doesNotMatch(requests[0].system, PROMPT_SECTION);
  assert.deepEqual(notices, []);
  assert.match(JSON.stringify(requests[2].body.messages), /eps\/one says/);
  assert.match(JSON.stringify(requests[2].body.messages), /eps\/two says/, "by its own name, as the model does after a native tool search");
});

test("an idle disconnect of a direct, hidden server in the middle of a chat costs the head nothing, also on a provider that takes tool changes in the middle", async () => {
  let api: any;
  const { extension } = mcpWith(() => []);
  const model = (await pi.ModelRuntime.create()).getModel("anthropic", "claude-fable-5");
  const script = ["ok", "ok", "Done."];
  const { session, requests, close } = await wireSession(model, [extension, (p: any) => void (api = p), toolSearch(inMcp("zeta"))], (n) => script[n]);
  const config = entry({ name: "zeta", exposure: "direct" }).config;
  try {
    api.registerMcpServer("zeta", config);
    await until(() => session.getActiveToolNames().includes("mcp__zeta__one"));
    await session.prompt("one");
    api.unregisterMcpServer("zeta");
    await until(() => !session.getActiveToolNames().includes("mcp__zeta__one"));
    await session.prompt("two");
    const [first, last] = [requests[0], requests.at(-1)!];
    assert.equal(last.tools, first.tools, "no tool is declared or taken away on the provider's side");
    assert.equal(last.system, first.system);
    assert.doesNotMatch(JSON.stringify(last.body), /tool_removal|mcp__zeta/);
  } finally {
    await close();
  }
});
