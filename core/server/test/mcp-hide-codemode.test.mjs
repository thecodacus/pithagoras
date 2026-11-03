import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fakeModel } from "./fake-model.mjs";
import { inProcessHome } from "./server-harness.mjs";

// Issue #336, in a chat whose mode works through the code tool (pi's `only` presentation): the model is not declared
// the `mcp` tool there, it reads the tool's description in the code tool's, which pi writes from the tools a script
// can call. A server whose tools are all off is not to be named in it either.
const home = inProcessHome("pithagoras-mcp-hide-codemode-");
const agent = process.env.PI_CODING_AGENT_DIR;
mkdirSync(path.join(agent, "extensions"), { recursive: true });
writeFileSync(path.join(agent, "mcp.json"), JSON.stringify({ mcpServers: { jira: { command: "j" }, secretsrv: { command: "s" } } }));
writeFileSync(path.join(agent, "mcp-cache.json"), JSON.stringify({
  version: 1,
  servers: {
    jira: { tools: [{ name: "search" }, { name: "create_issue" }] },
    secretsrv: { tools: [{ name: "read" }, { name: "delete" }], instructions: "use secretsrv_delete with care" },
  },
}));
// The adapter's `mcp` tool as far as its description goes (buildProxyDescription, pi-mcp-adapter 2.18.0).
writeFileSync(path.join(agent, "extensions", "mcp.ts"), `
export default function (pi) {
  pi.registerTool({
    name: "mcp",
    label: "MCP",
    description:
      "MCP gateway - connect to MCP servers and call their tools. Non-MCP Pi tools should be called directly, not through mcp.\\n" +
      "\\nServers: jira (2 tools), secretsrv (2 tools)\\n" +
      "\\nServer instructions (truncated - full text via mcp({ instructions: \\"name\\" })):\\n  secretsrv: use secretsrv_delete with care\\n" +
      "\\nUsage:\\n  mcp({ })                              → Show server status\\n",
    parameters: { type: "object", properties: { server: { type: "string" } } },
    async execute() {
      return { content: [{ type: "text", text: "status" }], details: {} };
    },
  });
}
`);

const model = await fakeModel(() => "Done.");
writeFileSync(path.join(agent, "models.json"), JSON.stringify(model.models()));
const { SdkPiClient } = await import("../dist/pi/sdk-client.js");

/** What the model is told in a chat's first request: each declared tool's description by its name. */
async function told(options) {
  const client = await SdkPiClient.create({
    cwd: mkdtempSync(path.join(process.env.WORKSPACE_ROOT, "chat-")),
    sessionDir: mkdtempSync(path.join(home, "chat-")),
    provider: "fake", modelId: "m", sessionId: `mcp-hide-${model.requests.length}`, dialogs: false, ...options,
  });
  const settled = new Promise((resolve) => client.on("event", (e) => e?.type === "agent_settled" && resolve()));
  try {
    const asked = model.requests.length;
    await client.prompt("Go on");
    await settled;
    return Object.fromEntries((model.requests[asked].tools ?? []).map((t) => [t.function?.name ?? t.name, t.function?.description ?? t.description ?? ""]));
  } finally {
    client.dispose();
  }
}

test("in the code tool's only presentation, the code tool's description names no server whose tools are all off", async () => {
  const off = ["secretsrv_read", "secretsrv_delete"];
  const only = await told({ codemode: "only", toolsOff: off });
  assert.deepEqual(Object.keys(only), ["codemode"], "the mcp tool is read in the code tool's description alone");
  assert.match(only.codemode, /jira \(2 tools\)/, "it is there");
  assert.doesNotMatch(only.codemode, /secretsrv/);

  // Beside the code tool, the mcp tool is declared, and neither names it.
  const on = await told({ toolsOff: off });
  assert.match(on.mcp, /jira \(2 tools\)/);
  assert.doesNotMatch(JSON.stringify(on), /secretsrv/);

  const all = await told({ codemode: "only" });
  assert.match(all.codemode, /secretsrv \(2 tools\)/, "named while any of its tools is on");
});
