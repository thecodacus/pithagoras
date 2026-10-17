import { before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fakeModel } from "./fake-model.mjs";
import { freePort, inProcessHome, serverEnv, startServer } from "./server-harness.mjs";

/**
 * A tool registered with `offByDefault: true` is off in every chat until somebody switches it on: from the first
 * message of the first chat that has it, and as a default the portal writes down once, after which it is a default
 * like any other. Real pi and the portal's own client.
 */
const home = inProcessHome("pithagoras-off-by-default-");
mkdirSync(path.join(process.env.PI_CODING_AGENT_DIR, "extensions"), { recursive: true });
mkdirSync(process.env.WORKSPACE_ROOT, { recursive: true });

writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "extensions", "risky.ts"), `
const text = (t) => ({ content: [{ type: "text", text: t }], details: {} });
const tool = (name, more) => ({
  name,
  label: name,
  description: "Does " + name + ".",
  parameters: { type: "object", properties: {} },
  async execute() { return text(name + " ran"); },
  ...more,
});
export default function (pi) {
  pi.registerTool(tool("box_run", { offByDefault: true }));
  pi.registerTool(tool("box_look"));
}
`);

const model = await fakeModel(() => "Done.");
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify(model.models()));
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "m" }));

const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
const db = await import("../dist/db.js");
const { rememberTools, remembered, setToolDefaultsOff, toolDefaultsOff } = db;

const names = (request) => (request.tools ?? []).map((t) => t.function.name);

let base;
before(async () => {
  ({ base } = await startServer(serverEnv(home, await freePort())));
});
// Each test starts where nobody has seen the tool.
beforeEach(() => db.getDb().exec("DELETE FROM settings WHERE key IN ('tools_seen', 'tools_off_default')"));

const json = async (url, method = "GET", body) => {
  const res = await fetch(base + url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(res.ok, `${url}: ${res.status} ${await res.clone().text()}`);
  return res.json();
};

test("a real chat: not offered at its first message, written down as off by default, and offered once the chat switches it on", async () => {
  const chat = await json("/api/sessions", "POST", {});
  async function ask() {
    const first = model.requests.length;
    await json(`/api/sessions/${chat.id}/prompt`, "POST", { message: "Go on" });
    for (let i = 0; i < 400 && !(model.requests.length > first && db.getSession(chat.id).status !== "running"); i++) await new Promise((r) => setTimeout(r, 50));
    return names(model.requests.slice(first).find((request) => request.tools?.length));
  }
  const offered = await ask();
  assert.ok(offered.includes("box_look"));
  assert.ok(!offered.includes("box_run"));
  assert.ok((await json("/api/tools")).off.includes("box_run"), "switched off by default in Settings");
  const listed = await json(`/api/sessions/${chat.id}/tools`);
  assert.equal(listed.tools.find((t) => t.name === "box_run").enabled, false);
  // Switched on in this chat: everything else as it was.
  const off = listed.tools.filter((t) => !t.enabled && t.name !== "box_run").map((t) => t.name);
  await json(`/api/sessions/${chat.id}/tools`, "PUT", { off });
  assert.ok((await ask()).includes("box_run"));

  // One installed while the chat is open comes with a reload, and is off there too.
  writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "extensions", "later.ts"), `
export default function (pi) {
  pi.registerTool({ name: "box_late", label: "box_late", description: "Does box_late.", parameters: { type: "object", properties: {} }, offByDefault: true,
    async execute() { return { content: [{ type: "text", text: "late ran" }], details: {} }; } });
}
`);
  await json(`/api/sessions/${chat.id}/prompt`, "POST", { message: "/reload" });
  const reloaded = await ask();
  assert.ok(reloaded.includes("box_run"), "what was switched on stays on");
  assert.ok(!reloaded.includes("box_late"));
  assert.equal((await json(`/api/sessions/${chat.id}/tools`)).tools.find((t) => t.name === "box_late").enabled, false);
  assert.ok((await json("/api/tools")).off.includes("box_late"));
});

async function chat(id, options) {
  const client = await SdkPiClient.create({
    cwd: mkdtempSync(path.join(process.env.WORKSPACE_ROOT, "chat-")), sessionDir: mkdtempSync(path.join(home, "chat-")), provider: "fake", modelId: "m",
    sessionId: id, toolsOff: ["codemode"], ...options,
  });
  const ask = async () => {
    const settled = new Promise((resolve) => client.on("event", (e) => e?.type === "agent_settled" && resolve()));
    await client.prompt("Go on");
    await settled;
    return model.requests.at(-1);
  };
  return { client, ask };
}

test("one the portal has not seen yet is off from the first message, says so, and is on once the portal's switches say", async () => {
  const seen = new Set();
  const { client, ask } = await chat("first", { toolsSeen: () => seen });
  try {
    const offered = names(await ask());
    assert.ok(offered.includes("box_look"));
    assert.ok(!offered.includes("box_run"), "not offered before the portal has written its default down");
    const reported = await client.getTools();
    assert.deepEqual(reported.find((t) => t.name === "box_run"), { ...reported.find((t) => t.name === "box_run"), offByDefault: true, enabled: false });
    assert.equal("offByDefault" in reported.find((t) => t.name === "box_look"), false);
    // Switches the portal sends before it has seen the tool (another default changed) do not name it: it stays off.
    await client.setToolsOff(["codemode"]);
    assert.ok(!names(await ask()).includes("box_run"));
    // The portal was told of it, and somebody switched it on: the portal's switches are the last word.
    for (const tool of reported) seen.add(tool.name);
    await client.setToolsOff(["codemode"]);
    assert.ok(names(await ask()).includes("box_run"));
    // And a reload does not take it back.
    await client.reload();
    assert.ok(names(await ask()).includes("box_run"));
  } finally {
    client.dispose();
  }
});

test("one the portal has seen is as its switches say: on where nobody switched it off", async () => {
  const { client, ask } = await chat("seen", { toolsSeen: () => new Set(["box_run", "box_look"]) });
  try {
    assert.ok(names(await ask()).includes("box_run"));
  } finally {
    client.dispose();
  }
});

test("the portal writes the default down the first time it is told of the tool, and once: what somebody chooses after stands", () => {
  const before = toolDefaultsOff();
  const report = [
    remembered({ name: "box_run", source: "risky", offByDefault: true }),
    remembered({ name: "box_look", source: "risky" }),
  ];
  // Returned, for the chats that are running without knowing it to be told.
  assert.deepEqual(rememberTools(report), ["box_run"]);
  assert.deepEqual(toolDefaultsOff(), [...before, "box_run"].sort());
  // Switched on by default.
  setToolDefaultsOff(before);
  assert.deepEqual(rememberTools(report), []);
  assert.deepEqual(toolDefaultsOff(), before, "not switched off again");
});
