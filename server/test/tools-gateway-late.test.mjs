import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fakeModel, resultsIn } from "./fake-model.mjs";
import { inProcessHome } from "./server-harness.mjs";

/**
 * An extension registers a tool called `tools`, the name of the portal's gateway, after the switches were applied:
 * an MCP server that connects late and brings a tool of that name. From then on nothing leads to the lazy tools,
 * so they are offered one by one, and taking the lazy mark away brings them back like any tool. Real pi and the
 * portal's own client.
 */
const home = inProcessHome("pithagoras-tools-late-");
mkdirSync(path.join(process.env.PI_CODING_AGENT_DIR, "extensions"), { recursive: true });
mkdirSync(process.env.WORKSPACE_ROOT, { recursive: true });

writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "extensions", "late.ts"), `
const text = (t) => ({ content: [{ type: "text", text: t }], details: {} });
export default function (pi) {
  pi.registerTool({
    name: "docs_open",
    label: "Open document",
    description: "Open a document by its id.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    async execute(_id, p) { return text("opened " + p.id); },
  });
  // At the first message, when the switches have long been applied, as a server's tools are when it has connected.
  let registered = false;
  pi.on("before_agent_start", () => {
    if (registered) return;
    registered = true;
    pi.registerTool({
      name: "tools",
      label: "Toolbox",
      description: "Run a toolbox command.",
      parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
      async execute(_id, p) { return text("tools ran " + p.cmd); },
    });
  });
}
`);

let script = [];
const model = await fakeModel((request) => script[resultsIn(request)] ?? "Done.");
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify(model.models()));

const { SdkPiClient } = await import("../dist/pi/sdk-client.js");

const names = (request) => (request.tools ?? []).map((t) => t.function.name);

test("a tool called tools that registers after the switches leaves the lazy tools offered one by one, and the lazy mark can be taken away", async () => {
  script = [];
  model.requests.length = 0;
  const client = await SdkPiClient.create({
    cwd: mkdtempSync(path.join(process.env.WORKSPACE_ROOT, "chat-")), sessionDir: mkdtempSync(path.join(home, "chat-")), provider: "fake", modelId: "m",
    // Code mode off, as a chat starts on the portal's defaults: on, pi adds how a script calls each tool to its description.
    sessionId: "late-1", toolsLazy: ["docs_open"], lazySets: ["docs"], toolsOff: ["codemode"],
  });
  try {
    const ask = async () => {
      const settled = new Promise((resolve) => client.on("event", (e) => e?.type === "agent_settled" && resolve()));
      await client.prompt("Go on");
      await settled;
      return model.requests.at(-1);
    };
    const first = await ask();
    assert.equal(first.tools.find((t) => t.function.name === "tools")?.function.description, "Run a toolbox command.", "the extension's tool is the one called tools");
    assert.ok(names(first).includes("docs_open"), "the lazy tool is offered by its own name, as nothing else leads to it");
    assert.ok(names(await ask()).includes("docs_open"), "and so it is at the next message");

    await client.setToolsOff(["codemode"], { tools: [], sets: [] });
    const unmarked = await ask();
    assert.ok(names(unmarked).includes("docs_open"), "with the mark taken away it is offered as any tool");
    assert.ok(names(unmarked).includes("tools"));
  } finally {
    client.dispose();
  }
});

test("the lazy tool that is offered by its own name runs when called", async () => {
  script = [{ name: "docs_open", args: { id: "d-9" } }];
  model.requests.length = 0;
  const client = await SdkPiClient.create({
    cwd: mkdtempSync(path.join(process.env.WORKSPACE_ROOT, "chat-")), sessionDir: mkdtempSync(path.join(home, "chat-")), provider: "fake", modelId: "m",
    sessionId: "late-2", toolsLazy: ["docs_open"], lazySets: ["docs"],
  });
  try {
    const ended = [];
    const settled = new Promise((resolve) => client.on("event", (e) => {
      if (e?.type === "tool_execution_end") ended.push(e);
      if (e?.type === "agent_settled") resolve();
    }));
    await client.prompt("Go on");
    await settled;
    assert.equal(ended[0]?.isError, false);
    assert.match(JSON.stringify(ended[0]?.result), /opened d-9/);
  } finally {
    client.dispose();
  }
});
