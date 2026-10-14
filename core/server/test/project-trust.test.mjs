import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fakeModel } from "./fake-model.mjs";
import { inProcessHome } from "./server-harness.mjs";

/**
 * While the sandbox is on, the folder a chat works in is the agent's to write,
 * and pi and the MCP adapter run inside the portal, as root: what they would run
 * from the folder is not taken from it, and its skills are. The MCP part needs
 * no root and runs anywhere; a chat's pi, as the portal runs it, needs the
 * sandbox, and runs as root on Linux.
 */
inProcessHome("pithagoras-project-trust-");

const { withoutFolderMcp } = await import("../dist/sandbox/project-trust.js");

test("the MCP adapter's handlers and commands are given a folder of the portal's, and nothing else's are", async () => {
  const seen = {};
  const ctx = { cwd: "/workspaces/project", answer() { return this.cwd; } };
  const adapter = {
    resolvedPath: "/data/home/.pi/agent/npm/node_modules/pi-mcp-adapter/index.ts",
    handlers: new Map([["session_start", [(_event, c) => { seen.start = c.cwd; seen.bound = c.answer(); }]]]),
    commands: new Map([["mcp", { name: "mcp", handler: (_args, c) => { seen.command = c.cwd; } }]]),
  };
  const other = {
    resolvedPath: "/data/home/.pi/agent/extensions/notes/index.ts",
    handlers: new Map([["session_start", [(_event, c) => { seen.other = c.cwd; }]]]),
    commands: new Map(),
  };
  const result = withoutFolderMcp({ extensions: [adapter, other], errors: [] });
  for (const extension of result.extensions) for (const handler of extension.handlers.get("session_start")) await handler({}, ctx);
  await adapter.commands.get("mcp").handler("", ctx);
  assert.match(seen.start, /[\\/]sandbox[\\/]mcp$/);
  assert.equal(seen.command, seen.start);
  assert.equal(seen.bound, "/workspaces/project", "the context's own methods still work on it");
  assert.equal(seen.other, "/workspaces/project");
});

const linuxRoot = process.platform === "linux" && process.getuid?.() === 0;
const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;
const why = !linuxRoot ? "needs root on Linux, as the portal runs in its image" : !has("setpriv") || !has("sudo") || !has("useradd") ? "needs setpriv, sudo and useradd" : false;

test("with the sandbox on, a folder's extensions are not loaded and its skills are", { skip: why }, async () => {
  const exists = (kind, name) => spawnSync("getent", [kind, name]).status === 0;
  if (!exists("group", "pi-sandbox")) execFileSync("groupadd", ["--gid", "10010", "pi-sandbox"]);
  if (!exists("passwd", "pi-tools")) execFileSync("useradd", ["--uid", "10002", "--user-group", "--no-create-home", "--shell", "/usr/sbin/nologin", "pi-tools"]);

  const model = await fakeModel(() => "Done.");
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify(model.models()));

  // A project the agent could have written: an extension, which would run inside the portal, and skills, which are text.
  const project = mkdtempSync(path.join(process.env.WORKSPACE_ROOT, "project-"));
  mkdirSync(path.join(project, ".pi", "extensions"), { recursive: true });
  writeFileSync(path.join(project, ".pi", "extensions", "folder.ts"), `
export default function (pi) {
  pi.registerTool({ name: "folder_tool", label: "Folder", description: "From the folder", parameters: { type: "object", properties: {} },
    async execute() { return { content: [{ type: "text", text: "ran" }], details: {} }; } });
}
`);
  for (const [dir, name] of [[".pi", "handy"], [".agents", "also"]]) {
    mkdirSync(path.join(project, dir, "skills", name), { recursive: true });
    writeFileSync(path.join(project, dir, "skills", name, "SKILL.md"), `---\nname: "${name}"\ndescription: "Use when testing."\n---\n# ${name}\n`);
  }

  const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
  const { parsePolicy, saveSandboxPolicy, defaultRules } = await import("../dist/sandbox/policy.js");
  let n = 0;
  const loaded = async () => {
    const client = await SdkPiClient.create({ cwd: project, sessionDir: mkdtempSync(path.join(process.env.WORKSPACE_ROOT, "chat-")), provider: "fake", modelId: "m", sessionId: `trust-${n++}` });
    try {
      const tools = (await client.getTools()).map((tool) => tool.name);
      const skills = client.session.resourceLoader.getSkills().skills.map((skill) => skill.name);
      return { tools, skills };
    } finally {
      client.dispose();
    }
  };

  const off = await loaded();
  assert.ok(off.tools.includes("folder_tool"), "with the sandbox off the folder is trusted as before");
  assert.ok(off.skills.includes("handy") && off.skills.includes("also"));

  // Switched on, not applied: applying writes the system's sudo rules, which the sandbox's own test, run beside this one, relies on.
  const policy = parsePolicy({ enabled: true, rules: defaultRules(), trusted: [] });
  saveSandboxPolicy(policy);
  const on = await loaded();
  assert.equal(on.tools.includes("folder_tool"), false, "the folder's extension does not run inside the portal");
  assert.ok(on.skills.includes("handy"), "its .pi/skills");
  assert.ok(on.skills.includes("also"), "its .agents/skills");

  saveSandboxPolicy({ ...policy, enabled: false });
});
