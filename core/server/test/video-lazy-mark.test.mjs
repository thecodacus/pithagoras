import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fakeModel, resultsIn } from "./fake-model.mjs";
import { inProcessHome } from "./server-harness.mjs";

/**
 * The start of a call of the portal's generate_video says it is the portal's own, so the chat draws the clip it makes;
 * a call through the tools tool, where generate_video is lazy, says so too. Nothing answers at the video address: the
 * mark is on the start, whatever the call comes to.
 */
const home = inProcessHome("pithagoras-video-lazy-");

/** What the model calls first: `named`, with `call` as its arguments. */
let named = "generate_video";
let call = { prompt: "A fox in the snow" };
const offered = [];
const model = await fakeModel((request) => {
  offered.push((request.tools ?? []).map((t) => t.function?.name));
  return resultsIn(request) > 0 ? "Done." : { name: named, args: call };
});
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify(model.models()));

const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
const { saveVideoGeneration } = await import("../dist/video-generation.js");

// An address nothing listens on: the call fails at once, after its start.
saveVideoGeneration({ enabled: true, baseUrl: "http://127.0.0.1:9/v1" });

/** One message to a new conversation: the starts and ends of the calls it led to. */
async function run(options = {}) {
  const folder = path.join(home, `chat-${Math.random().toString(36).slice(2)}`);
  mkdirSync(folder);
  const client = await SdkPiClient.create({
    cwd: folder, sessionDir: mkdtempSync(path.join(home, "s-")), provider: "fake", modelId: "m", sessionId: `video-${path.basename(folder)}`, ...options,
  });
  const started = [];
  const ended = [];
  const settled = new Promise((resolve) => client.on("event", (e) => {
    if (e?.type === "tool_execution_start") started.push(e);
    if (e?.type === "tool_execution_end") ended.push(e);
    if (e?.type === "agent_settled") resolve();
  }));
  try {
    await client.prompt("Make a clip");
    await settled;
    return { started, ended };
  } finally {
    client.dispose();
  }
}

test("a direct call of the portal's generate_video says at its start that it is the portal's", async () => {
  named = "generate_video";
  call = { prompt: "A fox in the snow" };
  const { started } = await run();
  assert.ok(offered.at(-1).includes("generate_video"));
  assert.equal(started.at(-1).toolName, "generate_video");
  assert.equal(started.at(-1).portalVideo, true);
});

test("a lazy generate_video called through the tools tool says so at its start too, and its end says which tool it was", async () => {
  named = "tools";
  call = { action: "call", name: "generate_video", args: { prompt: "A fox in the snow" } };
  const { started, ended } = await run({ toolsLazy: ["generate_video"] });
  assert.ok(!offered.at(-1).includes("generate_video") && offered.at(-1).includes("tools"), "it is reached through the gateway");
  assert.equal(started.at(-1).toolName, "tools");
  assert.equal(started.at(-1).portalVideo, true, "the start says the call is of the portal's tool, as a direct call's does");
  assert.equal(ended.at(-1).portalCalledTool, "generate_video");
});
