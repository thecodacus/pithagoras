import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fakeModel } from "./fake-model.mjs";
import { inProcessHome } from "./server-harness.mjs";

/**
 * What an extension's server half adds to a chat's pi (`portal.chats.extend`), as pi runs it. Its tools are filed
 * under the package's name, as a package's pi extension's are, each package's apart, so the tools list has a box for
 * each and a lazy mark names it. One installed while the chat's pi runs is in it after a reload, and one removed is not.
 */
const home = inProcessHome("pithagoras-extension-tools-");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
mkdirSync(process.env.WORKSPACE_ROOT, { recursive: true });
const model = await fakeModel();
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify(model.models()));

const host = await import("../dist/extension-host.js");
const { createSession } = await import("../dist/db.js");
const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
test.after(() => host.stopServerHalves());

/** A package's server half that adds one tool to every chat's pi. */
function half(name, tool) {
  const dir = path.join(home, "packages", name.replace("/", "-"));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "server.js");
  writeFileSync(
    file,
    `export default function (portal) {
  portal.chats.extend((pi) => pi.registerTool({
    name: ${JSON.stringify(tool)}, label: ${JSON.stringify(tool)}, description: "A tool of ${name}.",
    parameters: { type: "object", properties: {} },
    async execute() { return { content: [{ type: "text", text: "done" }], details: {} }; },
  }));
}
`,
  );
  return { name, version: "1.0.0", file, rev: "1" };
}

test("a server half's tools are filed under its package's name, and a reload has the server halves as they are then", async () => {
  const work = mkdtempSync(path.join(process.env.WORKSPACE_ROOT, "chat-"));
  createSession({ id: "c1", title: "A chat", workspace: work, executor: "host" });
  const notes = half("@codacus/notes", "notes_add");
  await host.syncServerHalves([notes]);
  const client = await SdkPiClient.create({ cwd: work, sessionDir: mkdtempSync(path.join(home, "pi-")), provider: "fake", modelId: "m", sessionId: "c1" });
  try {
    const sources = async () => Object.fromEntries((await client.getTools()).filter((tool) => tool.name.endsWith("_add")).map((tool) => [tool.name, tool.source]));
    assert.deepEqual(await sources(), { notes_add: "@codacus/notes" });

    await host.syncServerHalves([notes, half("pithagoras-board", "board_add")]);
    await client.reload();
    assert.deepEqual(await sources(), { notes_add: "@codacus/notes", board_add: "pithagoras-board" }, "installed since the chat's pi started");

    await host.syncServerHalves([notes]);
    await client.reload();
    assert.deepEqual(await sources(), { notes_add: "@codacus/notes" }, "removed since");
  } finally {
    client.dispose();
  }
});
