import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { callThrough, GROUP, pi, wireSession } from "./pi-wire.mts";

/**
 * What the plan for the tool search (issue #361, PR 0) relies on pi to do with a group of tools that stays active and
 * callable but is left out of every request (`prepareLoadout`, `hiddenDeclarations`): one test for each thing that was
 * to be verified, on a provider with native tool changes and on ones without. Real pi, real adapters (see pi-wire.mts).
 */
const MODELS = [
  ["anthropic", "claude-fable-5"], // takes tool changes in the middle of a conversation
  ["anthropic", "claude-opus-4-5"], // collapses them into the head
  ["openai", "gpt-5.4"],
  ["local", "local-model"],
  ["google", "gemini-2.5-flash"],
  ["amazon-bedrock", "amazon.nova-lite-v1:0"],
  ["mistral", "codestral-latest"],
] as const;
const modelOf = async (provider: string, id: string) => (await pi.ModelRuntime.create()).getModel(provider, id);
const call = (name: string, args: unknown = {}) => ({ name, args });
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });
const tool = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  label: name,
  description: `${name} does one thing.`,
  promptSnippet: `${name} snippet`,
  promptGuidelines: [`${name} rule`],
  parameters: Type.Object({ x: Type.Optional(Type.String()) }),
  async execute() {
    return text(`${name} ran`);
  },
  ...extra,
});

for (const [provider, id] of MODELS) {
  test(`${provider}/${id}: a tool of the group that is switched off in the middle of a chat leaves the head as it was, and is not named to the provider`, async () => {
    const script = [call("tool_search", { action: "search" }), "ok", call("tool_search", { action: "search" }), "Done."];
    const { session, requests, close } = await wireSession(await modelOf(provider, id), [await callThrough()], (n) => script[n]);
    try {
      await session.prompt("one");
      // What the portal's switches do: the tool is taken out of the active set.
      session.setActiveToolsByName(session.getActiveToolNames().filter((name: string) => name !== GROUP[1]));
      await session.prompt("two");
      const [first, last] = [requests[0], requests.at(-1)!];
      assert.equal(last.tools, first.tools);
      assert.equal(last.system, first.system);
      assert.doesNotMatch(JSON.stringify(last.body), /tool_removal|toolsRemoved/);
      // The group is hidden whether or not a tool of it is active now: a hidden set that is only what is declared leaks the
      // tool into the model's list the moment it is switched off (the transcript still has it as added).
      assert.doesNotMatch(last.tools, new RegExp(GROUP[1]));
    } finally {
      await close();
    }
  });
}

test("a hidden set that follows what is declared leaks a tool switched off into the model's list, on a provider with native tool changes", async () => {
  const lazy = (p: any) => {
    for (const name of GROUP) p.registerTool(tool(name));
    p.registerTool(tool("tool_search", {
      exposure: "model-only",
      prepareLoadout: (loadout: any) => ({ hiddenDeclarations: loadout.declared.map((t: any) => t.name).filter((n: string) => (GROUP as readonly string[]).includes(n)) }),
    }));
  };
  const script = ["ok", "Done."];
  const { session, requests, close } = await wireSession(await modelOf("anthropic", "claude-fable-5"), [lazy], (n) => script[n]);
  try {
    await session.prompt("one");
    session.setActiveToolsByName(session.getActiveToolNames().filter((name: string) => name !== GROUP[1]));
    await session.prompt("two");
    assert.doesNotMatch(requests[0].tools, new RegExp(GROUP[1]));
    assert.match(requests.at(-1)!.tools, new RegExp(GROUP[1]), "declared after all");
    assert.match(JSON.stringify(requests.at(-1)!.body), /tool_removal/);
  } finally {
    await close();
  }
});

for (const [provider, id] of MODELS) {
  test(`${provider}/${id}: a tool of the group that registers in the middle of a chat is hidden from its first request, and runs by name and through the search`, async () => {
    // The group by its names, from the registry at each request: what a server half's late registration and an MCP server's are.
    const group = (name: string) => name.startsWith("alpha_");
    let later: any;
    const search = (p: any) => {
      later = p;
      p.registerTool(tool("plain_tool"));
      p.registerTool(tool("tool_search", {
        exposure: "model-only",
        prepareLoadout: (loadout: any) => ({ hiddenDeclarations: loadout.registered.map((t: any) => t.name).filter(group) }),
        async execute(_id: string, a: any, signal: AbortSignal, _update: unknown, ctx: any) {
          return (await ctx.executeTool(a.name, {}, { signal })).result;
        },
      }));
    };
    const script = ["ok", call("alpha_late"), call("tool_search", { name: "alpha_late" }), "Done."];
    const { session, requests, close } = await wireSession(await modelOf(provider, id), [search], (n) => script[n]);
    try {
      await session.prompt("one");
      later.registerTool(tool("alpha_late"));
      assert.ok(session.getActiveToolNames().includes("alpha_late"), "pi activates a direct tool as it registers");
      await session.prompt("two");
      const [first, last] = [requests[0], requests.at(-1)!];
      assert.equal(last.tools, first.tools);
      assert.equal(last.system, first.system);
      assert.doesNotMatch(last.system, /alpha_late/);
      assert.equal((JSON.stringify(last.body).match(/alpha_late ran/g) ?? []).length, 2);
    } finally {
      await close();
    }
  });
}

test("a tool that registers late and is not in the group is declared in the middle of a chat: on a provider without native tool changes the head changes", async () => {
  let later: any;
  const search = (p: any) => {
    later = p;
    p.registerTool(tool("plain_tool"));
  };
  const heads: Record<string, boolean> = {};
  for (const [provider, id] of MODELS) {
    const { session, requests, close } = await wireSession(await modelOf(provider, id), [search], () => "ok");
    try {
      await session.prompt("one");
      later.registerTool(tool("late_tool"));
      await session.prompt("two");
      heads[`${provider}/${id}`] = requests.at(-1)!.tools === requests[0].tools;
    } finally {
      await close();
    }
  }
  // The tools array holds only where the provider takes the addition at the end (Anthropic with the beta, OpenAI Responses).
  assert.deepEqual(heads, {
    "anthropic/claude-fable-5": true,
    "anthropic/claude-opus-4-5": false,
    "openai/gpt-5.4": true,
    "local/local-model": false,
    "google/gemini-2.5-flash": false,
    "amazon-bedrock/amazon.nova-lite-v1:0": false,
    "mistral/codestral-latest": false,
  });
});

test("the hidden set is read again for every request, so a hook that fails declares the whole group from then on, and says so", async () => {
  let broken = false;
  const lazy = (p: any) => {
    for (const name of GROUP) p.registerTool(tool(name));
    p.registerTool(tool("tool_search", {
      exposure: "model-only",
      prepareLoadout: () => {
        if (broken) throw new Error("the hook failed");
        return { hiddenDeclarations: [...GROUP] };
      },
    }));
  };
  const { session, requests, errors, close } = await wireSession(await modelOf("anthropic", "claude-opus-4-5"), [lazy], () => "ok");
  try {
    await session.prompt("one");
    broken = true;
    session.setActiveToolsByName(session.getActiveToolNames());
    await session.prompt("two");
    assert.doesNotMatch(requests[0].tools, new RegExp(GROUP[0]));
    assert.match(requests.at(-1)!.tools, new RegExp(GROUP[0]), "fails open: the tools are declared");
    assert.ok(errors.some((e) => e.event === "prepare_loadout" && /the hook failed/.test(e.error)), JSON.stringify(errors));
  } finally {
    await close();
  }
});

test("a tool of the group is callable through executeTool only while it is active (a direct tool), and a deferred tool at any time", async () => {
  const lazy = (p: any) => {
    p.registerTool(tool("direct_one"));
    p.registerTool(tool("deferred_one", { exposure: "deferred" }));
    p.registerTool(tool("tool_search", {
      exposure: "model-only",
      async execute(_id: string, a: any, signal: AbortSignal, _update: unknown, ctx: any) {
        const done = await ctx.executeTool(a.name, {}, { signal });
        return { ...done.result, isError: done.isError };
      },
    }));
  };
  const script = [call("tool_search", { name: "direct_one" }), call("tool_search", { name: "deferred_one" }), call("tool_search", { name: "direct_one" }), "Done."];
  const { session, requests, close } = await wireSession(await modelOf("anthropic", "claude-opus-4-5"), [lazy], (n) => script[n]);
  try {
    await session.prompt("one");
    const results = requests.at(-1)!.body.messages.filter((m: any) => Array.isArray(m.content) && m.content[0]?.type === "tool_result").map((m: any) => m.content[0].content);
    assert.deepEqual(results, ["direct_one ran", "deferred_one ran", "direct_one ran"]);
    // Taken out of the active set (a switch), a direct tool is not callable any more; a deferred one still is.
    session.setActiveToolsByName(session.getActiveToolNames().filter((name: string) => name !== "direct_one"));
    const callable = session._getCallableTools().map((t: any) => t.name);
    assert.ok(!callable.includes("direct_one"));
    assert.ok(callable.includes("deferred_one"), "which is why the portal wraps _getCallableTools for what is switched off (sdk-client keepSwitchedOffFromScripts)");
  } finally {
    await close();
  }
});

test("pi's code mode and the hidden group go together: the tools array holds the code tool and the search, and a script and the search both reach the group", async () => {
  const codemode = pi.createCodemodeExtension({ models: false, mode: "only" });
  const script = [call("codemode", { code: "return (await tools.alpha_open({ x: 'a' })).toString();" }), call("tool_search", { action: "call", name: GROUP[1] }), "Done."];
  const { session, requests, close } = await wireSession(await modelOf("anthropic", "claude-opus-4-5"), [codemode, await callThrough()], (n) => script[n], { tools: ["+codemode"] });
  try {
    await session.prompt("one");
    const names = JSON.parse(requests[0].tools).map((t: any) => t.name);
    assert.deepEqual(names, ["codemode", "tool_search"], "pi's `only` hides the rest, and the group is hidden by the search: the union");
    for (const request of requests) assert.equal(request.tools, requests[0].tools);
    const answers = JSON.stringify(requests.at(-1)!.body.messages);
    assert.match(answers, /alpha_open ran/);
    assert.match(answers, /alpha_read ran/);
  } finally {
    await close();
  }
});

test("a chat that is opened again from its session file has the head it had: the hidden set is the same, and the transcript's own tools are not declared", async () => {
  const dir = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), "pitha-resume-"));
  try {
    const model = await modelOf("anthropic", "claude-opus-4-5");
    const script = [call("tool_search", { action: "call", name: GROUP[0] }), "ok"];
    const make = async (manager: any, say: (n: number) => any) => {
      // The same session manager type that the portal opens (SessionManager.open), on a file.
      const first = await wireSession(model, [await callThrough()], say, { sessionManager: manager, cwd: dir });
      return first;
    };
    const created = pi.SessionManager.create(dir, dir);
    const a = await make(created, (n) => script[n]);
    await a.session.prompt("one");
    const file = created.getSessionFile();
    await a.close();
    const b = await make(pi.SessionManager.open(file, dir, dir), () => "again");
    await b.session.prompt("two");
    assert.equal(b.requests[0].tools, a.requests[0].tools);
    assert.equal(b.requests[0].system, a.requests[0].system);
    await b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a group can be the tools of one extension: the hook reads where each tool comes from through the public getAllTools(), also for a tool that registers later", async () => {
  const from = (name: string, keep?: (p: any) => void) => (p: any) => {
    p.registerTool(tool(name));
    keep?.(p);
  };
  let groupApi: any;
  const search = (p: any) =>
    p.registerTool(tool("tool_search", {
      exposure: "model-only",
      // Everything the extension named wire-1 registers, by its source: the package of the portal's own grouping.
      prepareLoadout: () => ({ hiddenDeclarations: p.getAllTools().filter((t: any) => String(t.sourceInfo?.path).includes("wire-1")).map((t: any) => t.name) }),
    }));
  // Three extensions, in the order wire-0, wire-1, wire-2: the first is declared, the second is the group, the third is the search.
  const { session, requests, close } = await wireSession(await modelOf("anthropic", "claude-opus-4-5"), [from("from_zero"), from("from_one", (p) => void (groupApi = p)), search], () => "ok");
  try {
    await session.prompt("one");
    assert.deepEqual(JSON.parse(requests[0].tools).map((t: any) => t.name), ["read", "bash", "edit", "write", "from_zero", "tool_search"]);
    groupApi.registerTool(tool("late_one"));
    await session.prompt("two");
    assert.equal(requests.at(-1)!.tools, requests[0].tools, "the late tool of the group is not declared");
  } finally {
    await close();
  }
});
