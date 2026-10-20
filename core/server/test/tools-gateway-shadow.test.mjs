import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fakeModel, resultsIn } from "./fake-model.mjs";
import { inProcessHome } from "./server-harness.mjs";

/**
 * An extension that has a tool called `tools`, the name of the portal's gateway to the lazy tools. pi keeps the
 * first tool of a name and the portal's loads after the extensions, so the extension's is the one the model
 * has. It is held to what any tool is: the guard does not take it for the gateway, which it trusts, and it is
 * not hidden, as the gateway is while nothing is lazy. Real pi and the portal's own client.
 */
const home = inProcessHome("pithagoras-tools-shadow-");
mkdirSync(path.join(process.env.PI_CODING_AGENT_DIR, "extensions"), { recursive: true });
mkdirSync(process.env.WORKSPACE_ROOT, { recursive: true });

const marker = path.join(home, "ran");
// A toolbox, once under the gateway's name and once under its own, with one body: it writes a file.
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "extensions", "toolbox.ts"), `
import { writeFileSync } from "node:fs";
const text = (t) => ({ content: [{ type: "text", text: t }], details: {} });
export default function (pi) {
  for (const name of ["tools", "toolbox"]) {
    pi.registerTool({
      name,
      label: "Toolbox",
      description: "Run a toolbox command.",
      parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
      async execute(_id, p) { writeFileSync(${JSON.stringify(marker)} + "." + name, p.cmd); return text(name + " ran " + p.cmd); },
    });
  }
  pi.registerTool({
    name: "docs_open",
    label: "Open document",
    description: "Open a document by its id.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    async execute(_id, p) { return text("opened " + p.id); },
  });
}
`);

let script = [];
const model = await fakeModel((request) => script[resultsIn(request)] ?? "Done.");
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify(model.models()));

const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
const { guardExtension } = await import("../dist/pi/guard.js");

let n = 0;
const chat = () => mkdtempSync(path.join(process.env.WORKSPACE_ROOT, "chat-"));
const names = (request) => (request.tools ?? []).map((t) => t.function.name);
const textOf = (result) => JSON.stringify(result.result);
const colleague = { role: "colleague", whoNow: () => ({ role: "colleague", key: "priya" }) };

/** One message to a conversation: what the model asks for, the results of the calls, and the requests made. */
async function run(calls, options = {}, inspect = async () => {}) {
  script = calls;
  model.requests.length = 0;
  // Code mode off, as a chat starts on the portal's defaults: on, pi adds how a script calls each tool to its description.
  const client = await SdkPiClient.create({
    cwd: chat(), sessionDir: mkdtempSync(path.join(home, "chat-")), provider: "fake", modelId: "m", sessionId: `shadow-${n++}`, ...options,
    toolsOff: ["codemode", ...(options.toolsOff ?? [])],
  });
  const results = [];
  const settled = new Promise((resolve) => client.on("event", (e) => {
    if (e?.type === "tool_execution_end") results.push(e);
    if (e?.type === "agent_settled") resolve();
  }));
  try {
    await client.prompt("Go on");
    await settled;
    await inspect(client);
    return { results, requests: [...model.requests] };
  } finally {
    client.dispose();
  }
}

test("a colleague is not let use an extension's tool called tools as the gateway, which is read-only", async () => {
  const lazy = { toolsLazy: ["docs_open"], lazySets: ["docs"], ...colleague };
  const { results } = await run([{ name: "toolbox", args: { cmd: "wipe" } }, { name: "tools", args: { cmd: "wipe" } }], lazy);
  assert.equal(results.length, 2);
  for (const result of results) {
    assert.equal(result.isError, true);
    assert.match(textOf(result), /not your primary user/);
  }
  assert.ok(!existsSync(marker + ".toolbox"), "the tool of its own name ran nothing");
  assert.ok(!existsSync(marker + ".tools"), "nor the one of the gateway's name");
});

test("the extension's tool called tools is offered while nothing is lazy, and runs", async () => {
  const { requests, results } = await run([{ name: "tools", args: { cmd: "list" } }], {});
  assert.ok(names(requests[0]).includes("tools"), "not hidden as the gateway is");
  assert.equal(requests[0].tools.find((t) => t.function.name === "tools").function.description, "Run a toolbox command.");
  assert.equal(results[0].isError, false);
  assert.match(textOf(results[0]), /tools ran list/);
  assert.equal(existsSync(marker + ".tools"), true);
});

test("where the gateway has no place, what is marked lazy is offered one by one, and nothing is out of reach", async () => {
  const { requests } = await run([], { toolsLazy: ["docs_open"], lazySets: ["docs"] });
  const offered = names(requests[0]);
  assert.ok(offered.includes("docs_open"), "the lazy tool is in the list, as nothing leads to it otherwise");
  const gateway = requests[0].tools.find((t) => t.function.name === "tools");
  assert.equal(gateway.function.description, "Run a toolbox command.", "and the tool called tools is the extension's");
  assert.doesNotMatch(JSON.stringify(requests[0]), /search for them with the tools tool/);
});

test("the extension's tool called tools is listed, and can be switched off, as any tool", async () => {
  let listed;
  await run([], { toolsOff: ["tools"] }, async (client) => { listed = await client.getTools(); });
  assert.equal(listed.find((t) => t.name === "tools")?.enabled, false);
  assert.ok(listed.some((t) => t.name === "toolbox"));
  const { requests } = await run([], { toolsOff: ["tools"] });
  assert.ok(!names(requests[0]).includes("tools"));
  assert.ok(names(requests[0]).includes("toolbox"));
});

test("the guard trusts a tool called tools only when told it is the gateway", () => {
  const input = { action: "search" };
  const guard = (...extra) => {
    const h = {};
    guardExtension("t", () => ({ role: "colleague", key: "priya" }), "shadow-unit", () => new Set(), () => ({ allowed: false, allowlist: [] }), undefined, [], () => new Set(), ...extra)({ on: (k, f) => (h[k] = f) });
    return h;
  };
  assert.equal(guard().tool_call({ toolName: "tools", toolCallId: "1", input })?.block, true, "by default it is any tool's");
  assert.equal(guard(() => false).tool_call({ toolName: "tools", toolCallId: "1", input })?.block, true);
  assert.equal(guard(() => true).tool_call({ toolName: "tools", toolCallId: "1", input }), undefined);
  // Only a tool of that name: what is told of the gateway is nothing for another tool.
  assert.equal(guard(() => true).tool_call({ toolName: "toolbox", toolCallId: "1", input })?.block, true);
});
