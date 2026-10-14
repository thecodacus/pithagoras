import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fakeModel } from "./fake-model.mjs";
import { inProcessHome } from "./server-harness.mjs";

/**
 * The rule for spoken replies, against pi itself: which conversations have it
 * in the system prompt the model is sent.
 */
const home = inProcessHome("pithagoras-audio-rule-");

/** Each request's system prompt, in the order they came. */
const sent = [];
/** The names of the tools each request offered the model, in the same order. */
const offered = [];
/** Held until let go, for a run that is still going when the next message comes. */
let hold;
const model = await fakeModel(async (request) => {
  const system = request.messages.find((m) => m.role === "system" || m.role === "developer");
  sent.push(typeof system?.content === "string" ? system.content : system?.content?.map((c) => c.text).join("") ?? "");
  offered.push((request.tools ?? []).map((t) => t.function?.name));
  if (hold) await hold;
  return "Sure.";
});
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify(model.models()));


// Sets the prompt of every run while a test asks it to: adding to what it is
// given, as pi-background-tasks does with its shell policy, or writing its own.
// And takes a message out of pi's hands, as an input extension can.
mkdirSync(path.join(process.env.PI_CODING_AGENT_DIR, "extensions"), { recursive: true });
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "extensions", "policy.ts"), `
export default function (pi: any) {
  pi.on("before_agent_start", (event: any) => {
    if ((globalThis as any).addPolicy) return { systemPrompt: event.systemPrompt + "\\n\\nSHELL POLICY" };
    if ((globalThis as any).ownPrompt) return { systemPrompt: "AN EXTENSION'S OWN PROMPT" };
  });
  pi.on("input", (event: any) => (event.text.includes("take this") ? { action: "handled" } : undefined));
}
`);
// Compaction keeps as little as it can, so a message can be compacted away.
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));

const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
const { AUDIO_SYSTEM_RULE, DEFAULT_VOICE_INSTRUCTIONS, audioSystemRule } = await import("../dist/pi/voice-first.js");
const { getDb } = await import("../dist/db.js");

/** Saves the speaking instructions as Settings → Voice does; none takes them away again. */
function saveInstructions(text) {
  const saved = text === undefined ? {} : { responseInstructions: text };
  getDb().prepare("INSERT INTO settings (key, value) VALUES ('voice', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(saved));
}

let chats = 0;
/** `more` is what a conversation of the portal has beside these: its `sessionId`, as the portal opens one. */
const open = (sessionFile, more = {}) => {
  const dir = path.join(home, "chats", String(++chats));
  mkdirSync(dir, { recursive: true });
  return SdkPiClient.create({ cwd: process.env.WORKSPACE_ROOT, sessionDir: dir, sessionFile, provider: "fake", modelId: "m", ...more });
};
/** Waits for `ready`, and fails rather than waiting for ever. */
async function until(ready, what) {
  for (let i = 0; !ready(); i++) {
    assert.ok(i < 500, `waited 5 s for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
/** The end of the run going now, or a failure after 10 s. */
const settled = (client) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { client.off("event", on); reject(new Error("the run did not settle within 10 s")); }, 10_000);
  const on = (e) => { if (e?.type === "agent_settled") { clearTimeout(timer); client.off("event", on); resolve(); } };
  client.on("event", on);
});
/** Sends one message, and gives the system prompt its run was answered with. */
async function say(client, text, voice) {
  const before = sent.length;
  const done = settled(client);
  await client.prompt(text, voice ? { voice: true } : undefined);
  await done;
  assert.equal(sent.length, before + 1);
  return sent.at(-1);
}

test("a typed conversation's system prompt says nothing of [Audio mode]", async () => {
  // The model read the rule there as the message having the marker, and gave
  // a typed question a spoken answer: issue #26.
  const client = await open();
  try {
    assert.doesNotMatch(await say(client, "How do image models work?"), /Audio mode/);
    assert.doesNotMatch(await say(client, "And video ones?"), /Audio mode/);
  } finally {
    client.dispose();
  }
});

test("a conversation keeps the rule from its first spoken message on, reopened too", async () => {
  const client = await open();
  let file;
  try {
    assert.doesNotMatch(await say(client, "Typed first"), /Audio mode/);
    const spoken = await say(client, "Now spoken", true);
    assert.ok(spoken.includes(AUDIO_SYSTEM_RULE));
    // Typed again: the same prompt, so what the model cached of it still counts.
    assert.equal(await say(client, "Typed again"), spoken);
    file = client.sessionFile;
  } finally {
    client.dispose();
  }
  // After a restart, from what the conversation holds.
  const reopened = await open(file);
  try {
    assert.ok((await say(reopened, "Typed after a restart")).includes(AUDIO_SYSTEM_RULE));
  } finally {
    reopened.dispose();
  }
});

test("a spoken message sent while a typed run is going is answered with the rule", async () => {
  // Voice switched on while the agent works: the message waits for the run,
  // and is taken in by it without a new one starting.
  const client = await open();
  let release;
  hold = new Promise((resolve) => { release = resolve; });
  try {
    const before = sent.length;
    const done = settled(client);
    await client.prompt("Typed, and slow");
    await until(() => sent.length > before, "the first request");
    await client.prompt("Spoken meanwhile", { voice: true });
    hold = undefined;
    release();
    await done;
    assert.equal(sent.length, before + 2, "one run, two answers");
    assert.doesNotMatch(sent[before], /Audio mode/);
    assert.ok(sent[before + 1].includes(AUDIO_SYSTEM_RULE));
  } finally {
    hold = undefined;
    release?.();
    client.dispose();
  }
});

test("a spoken message queued into a run whose prompt an extension set is answered with the rule", async () => {
  globalThis.addPolicy = true;
  const client = await open();
  let release;
  hold = new Promise((resolve) => { release = resolve; });
  try {
    const before = sent.length;
    const done = settled(client);
    await client.prompt("Typed, and slow");
    await until(() => sent.length > before, "the first request");
    await client.prompt("Spoken meanwhile", { voice: true });
    hold = undefined;
    release();
    await done;
    assert.equal(sent.length, before + 2, "one run, two answers");
    assert.match(sent[before], /SHELL POLICY/);
    assert.doesNotMatch(sent[before], /Audio mode/);
    // What the extension added is still there, and the rule with it.
    assert.match(sent[before + 1], /SHELL POLICY/);
    assert.ok(sent[before + 1].includes(AUDIO_SYSTEM_RULE));
  } finally {
    hold = undefined;
    release?.();
    delete globalThis.addPolicy;
    client.dispose();
  }
});

test("a typed message after a queued spoken one does not take the rule away before it is answered", async () => {
  const client = await open();
  let release;
  hold = new Promise((resolve) => { release = resolve; });
  try {
    const before = sent.length;
    const done = settled(client);
    await client.prompt("Typed, and slow");
    await until(() => sent.length > before, "the first request");
    await client.prompt("Spoken meanwhile", { voice: true });
    await client.prompt("And typed after it");
    hold = undefined;
    release();
    await done;
    assert.ok(sent.length >= before + 2, "the queued messages were answered");
    assert.doesNotMatch(sent[before], /Audio mode/);
    for (const prompt of sent.slice(before + 1)) assert.ok(prompt.includes(AUDIO_SYSTEM_RULE));
  } finally {
    hold = undefined;
    release?.();
    client.dispose();
  }
});

test("a spoken message queued after the tools changed in a run whose prompt an extension set has the rule", async () => {
  globalThis.addPolicy = true;
  const client = await open();
  let release;
  hold = new Promise((resolve) => { release = resolve; });
  try {
    const before = sent.length;
    const done = settled(client);
    await client.prompt("Typed, and slow");
    await until(() => sent.length > before, "the first request");
    // pi builds its prompt again, and the one the extension set keeps the
    // prompt it was given: the two no longer match.
    client.session.setActiveToolsByName(["read"]);
    await client.prompt("Spoken meanwhile", { voice: true });
    hold = undefined;
    release();
    await done;
    assert.equal(sent.length, before + 2);
    assert.match(sent[before + 1], /SHELL POLICY/);
    assert.ok(sent[before + 1].includes(AUDIO_SYSTEM_RULE));
  } finally {
    hold = undefined;
    release?.();
    delete globalThis.addPolicy;
    client.dispose();
  }
});

test("a spoken message queued into a run whose prompt an extension wrote itself has the rule", async () => {
  globalThis.ownPrompt = true;
  const client = await open();
  let release;
  hold = new Promise((resolve) => { release = resolve; });
  try {
    const before = sent.length;
    const done = settled(client);
    await client.prompt("Typed, and slow");
    await until(() => sent.length > before, "the first request");
    await client.prompt("Spoken meanwhile", { voice: true });
    hold = undefined;
    release();
    await done;
    assert.equal(sent.length, before + 2);
    assert.equal(sent[before], "AN EXTENSION'S OWN PROMPT");
    // Nothing of pi's to put it after: at the end.
    assert.equal(sent[before + 1], `AN EXTENSION'S OWN PROMPT\n\n${AUDIO_SYSTEM_RULE}`);
  } finally {
    hold = undefined;
    release?.();
    delete globalThis.ownPrompt;
    client.dispose();
  }
});

test("a spoken message an extension takes leaves no rule behind", async () => {
  // Issue #26 again otherwise: the rule, and no spoken message it is about.
  const client = await open();
  try {
    assert.equal((await client.prompt("Please take this", { voice: true })).outcome, "handled");
    assert.doesNotMatch(await say(client, "Typed"), /Audio mode/);
    // Where one did reach the conversation, it stays.
    assert.ok((await say(client, "Spoken", true)).includes(AUDIO_SYSTEM_RULE));
    assert.equal((await client.prompt("Please take this", { voice: true })).outcome, "handled");
    assert.ok((await say(client, "Typed again")).includes(AUDIO_SYSTEM_RULE));
  } finally {
    client.dispose();
  }
});

test("a conversation whose spoken messages were compacted away opens without the rule", async () => {
  const client = await open();
  let file;
  try {
    await say(client, "Spoken", true);
    await say(client, "Typed");
    await client.session.compact();
    file = client.sessionFile;
  } finally {
    client.dispose();
  }
  const reopened = await open(file);
  try {
    assert.doesNotMatch(await say(reopened, "Typed after it"), /Audio mode/);
  } finally {
    reopened.dispose();
  }
});

test("a spoken conversation's prompt follows its tools during a run, and keeps the rule", async () => {
  const client = await open();
  let release;
  try {
    assert.match(await say(client, "Spoken", true), /- bash:/);
    hold = new Promise((resolve) => { release = resolve; });
    const before = sent.length;
    const done = settled(client);
    await client.prompt("Typed, and slow");
    await until(() => sent.length > before, "the first request");
    // Mid-run, as an MCP server connecting or an extension's tool going away
    // does it; the next turn of the same run is the one that must know.
    client.session.setActiveToolsByName(["read"]);
    await client.prompt("And one more");
    hold = undefined;
    release();
    await done;
    assert.equal(sent.length, before + 2, "one run, two answers");
    assert.doesNotMatch(sent[before + 1], /- bash:/);
    assert.ok(sent[before + 1].includes(AUDIO_SYSTEM_RULE));
  } finally {
    hold = undefined;
    release?.();
    client.dispose();
  }
});

test("with VOICE_RESPONSE_INSTRUCTIONS=false no conversation has the rule", async () => {
  process.env.VOICE_RESPONSE_INSTRUCTIONS = "false";
  const client = await open();
  try {
    assert.doesNotMatch(await say(client, "Spoken", true), /Audio mode/);
  } finally {
    client.dispose();
    delete process.env.VOICE_RESPONSE_INSTRUCTIONS;
  }
});

test("saved speaking instructions are used for voice turns instead of the built-in ones", async () => {
  saveInstructions("Answer in one word.");
  const client = await open();
  try {
    const spoken = await say(client, "Spoken", true);
    assert.ok(spoken.includes(audioSystemRule("Answer in one word.")));
    assert.ok(!spoken.includes(DEFAULT_VOICE_INSTRUCTIONS));
    // The note on what the marker means is still there around them.
    assert.match(spoken, /does not mean any request has it/);
    assert.equal(await say(client, "Typed again"), spoken);
  } finally {
    client.dispose();
    saveInstructions(undefined);
  }
  // Emptied, or never saved: the built-in ones.
  for (const none of [undefined, ""]) {
    saveInstructions(none);
    const again = await open();
    try {
      assert.ok((await say(again, "Spoken", true)).includes(AUDIO_SYSTEM_RULE));
    } finally {
      again.dispose();
    }
  }
});

test("instructions saved in the middle of a conversation apply from its next spoken message", async () => {
  saveInstructions("First wording.");
  const client = await open();
  try {
    const first = await say(client, "Spoken", true);
    assert.ok(first.includes(audioSystemRule("First wording.")));
    saveInstructions("Second wording.");
    // Typed messages keep the prompt the model has cached.
    assert.equal(await say(client, "Typed"), first);
    const second = await say(client, "Spoken again", true);
    assert.ok(second.includes(audioSystemRule("Second wording.")));
    assert.doesNotMatch(second, /First wording/);
    assert.equal(second.split("Do not read the marker aloud").length, 2, "the rule once");
    assert.equal(await say(client, "Spoken once more", true), second, "and then no change");
  } finally {
    client.dispose();
    saveInstructions(undefined);
  }
});

test("instructions saved while a run is going reach its next turn in place of the earlier ones", async () => {
  // The prompt an extension set for the run was made with the first wording.
  globalThis.addPolicy = true;
  saveInstructions("First wording.");
  const client = await open();
  let release;
  try {
    assert.ok((await say(client, "Spoken", true)).includes(audioSystemRule("First wording.")));
    hold = new Promise((resolve) => { release = resolve; });
    const before = sent.length;
    const done = settled(client);
    await client.prompt("Typed, and slow");
    await until(() => sent.length > before, "the first request");
    saveInstructions("Second wording.");
    await client.prompt("Spoken meanwhile", { voice: true });
    hold = undefined;
    release();
    await done;
    assert.equal(sent.length, before + 2, "one run, two answers");
    assert.ok(sent[before].includes(audioSystemRule("First wording.")));
    assert.match(sent[before + 1], /SHELL POLICY/);
    assert.ok(sent[before + 1].includes(audioSystemRule("Second wording.")));
    assert.doesNotMatch(sent[before + 1], /First wording/);
  } finally {
    hold = undefined;
    release?.();
    delete globalThis.addPolicy;
    client.dispose();
    saveInstructions(undefined);
  }
});

test("with VOICE_RESPONSE_INSTRUCTIONS=false saved speaking instructions are not used either", async () => {
  saveInstructions("Answer in one word.");
  process.env.VOICE_RESPONSE_INSTRUCTIONS = "false";
  const client = await open();
  try {
    const spoken = await say(client, "Spoken", true);
    assert.doesNotMatch(spoken, /Audio mode/);
    assert.doesNotMatch(spoken, /Answer in one word/);
  } finally {
    client.dispose();
    delete process.env.VOICE_RESPONSE_INSTRUCTIONS;
    saveInstructions(undefined);
  }
});

test("a prompt that could not be built again with new instructions keeps the earlier ones", async () => {
  saveInstructions("First wording.");
  const client = await open();
  let release;
  const activate = client.activate;
  const errors = console.error;
  try {
    assert.ok((await say(client, "Spoken", true)).includes(audioSystemRule("First wording.")));
    hold = new Promise((resolve) => { release = resolve; });
    const before = sent.length;
    const done = settled(client);
    await client.prompt("Typed, and slow");
    await until(() => sent.length > before, "the first request");
    saveInstructions("Second wording.");
    client.activate = () => { throw new Error("an extension failed to load"); };
    console.error = () => {};
    await client.prompt("Spoken meanwhile", { voice: true });
    hold = undefined;
    release();
    await done;
    assert.equal(sent.length, before + 2, "one run, two answers");
    // Not spoken to without any rules: the turn after it still has the first wording.
    assert.ok(sent[before + 1].includes(audioSystemRule("First wording.")));
    // And the next spoken message tries again.
    client.activate = activate;
    assert.ok((await say(client, "Spoken once more", true)).includes(audioSystemRule("Second wording.")));
  } finally {
    console.error = errors;
    hold = undefined;
    release?.();
    client.activate = activate;
    client.dispose();
    saveInstructions(undefined);
  }
});

test("image generation: the tool and what the voice rule says of it come and go together, with the add-on and a reload", async () => {
  const { saveImageGeneration } = await import("../dist/image-generation.js");
  const { GENERATE_IMAGE_VOICE_LINE } = await import("../dist/pi/generate-image-tool.js");
  const withLine = audioSystemRule(DEFAULT_VOICE_INSTRUCTIONS, GENERATE_IMAGE_VOICE_LINE);
  saveInstructions(undefined);
  saveImageGeneration({ enabled: false, baseUrl: "", apiKey: "" });
  // Said after each message: what the model was sent, in the system prompt and as tools.
  const state = (prompt) => ({ tool: offered.at(-1).includes("generate_image"), line: prompt.includes(GENERATE_IMAGE_VOICE_LINE) });

  // A conversation of the portal (it has a session id), with the add-on off: nothing of it, rule or no rule.
  const client = await open(undefined, { sessionId: "image-generation-chat" });
  try {
    assert.deepEqual(state(await say(client, "Typed, add-on off")), { tool: false, line: false });
    const off = await say(client, "Spoken, add-on off", true);
    assert.ok(off.includes(AUDIO_SYSTEM_RULE));
    assert.deepEqual(state(off), { tool: false, line: false });
    assert.ok(offered.at(-1).includes("show_image"), "the tools beside it are there");

    // Switched on, and the chat reloaded, as the page's switch does it: the tool and the line are in
    // the very next message, a typed one — not only from the next spoken message on.
    saveImageGeneration({ baseUrl: "http://127.0.0.1:9/v1", enabled: true });
    await client.reload();
    const on = await say(client, "Typed, after switching on");
    assert.deepEqual(state(on), { tool: true, line: true });
    assert.ok(on.includes(withLine));
    assert.deepEqual(state(await say(client, "Spoken, add-on on", true)), { tool: true, line: true });

    // And off again: both go with the reload.
    saveImageGeneration({ enabled: false });
    await client.reload();
    const gone = await say(client, "Typed, after switching off");
    assert.deepEqual(state(gone), { tool: false, line: false });
    assert.ok(gone.includes(AUDIO_SYSTEM_RULE), "the rule itself stays: the conversation is a spoken one");
  } finally {
    client.dispose();
  }

  // A typed conversation has the tool when the add-on is on, and no voice rule to say anything in.
  saveImageGeneration({ enabled: true });
  const typed = await open(undefined, { sessionId: "image-generation-typed" });
  try {
    const prompt = await say(typed, "Only typed");
    assert.deepEqual(state(prompt), { tool: true, line: false });
    assert.doesNotMatch(prompt, /Audio mode/);
  } finally {
    typed.dispose();
  }

  // Without a session id there is no tool: it is a conversation of the portal's that has pictures.
  const bare = await open();
  try {
    await say(bare, "No session id");
    assert.equal(offered.at(-1).includes("generate_image"), false);
    assert.equal(offered.at(-1).includes("show_image"), false);
  } finally {
    bare.dispose();
    saveImageGeneration({ enabled: false });
  }
});

test("image generation: the voice line is said only while the model has the tool, switched off in the chat or not", async () => {
  const { saveImageGeneration } = await import("../dist/image-generation.js");
  const { GENERATE_IMAGE_VOICE_LINE } = await import("../dist/pi/generate-image-tool.js");
  saveInstructions(undefined);
  saveImageGeneration({ baseUrl: "http://127.0.0.1:9/v1", enabled: true });
  const state = (prompt) => ({ tool: offered.at(-1).includes("generate_image"), line: prompt.includes(GENERATE_IMAGE_VOICE_LINE) });
  try {
    // Opened with it switched off (the chat's menu, a project's default, Settings → Tools): not offered, not spoken of.
    const client = await open(undefined, { sessionId: "image-generation-switched-off", toolsOff: ["generate_image"] });
    try {
      assert.deepEqual(state(await say(client, "Spoken, tool off", true)), { tool: false, line: false });
      // Switched on in the chat's menu: both come at the next message, a typed one.
      await client.setToolsOff([]);
      assert.deepEqual(state(await say(client, "Typed, tool on")), { tool: true, line: true });
      // And off again.
      await client.setToolsOff(["generate_image"]);
      assert.deepEqual(state(await say(client, "Typed, tool off again")), { tool: false, line: false });
      // Another tool switched off changes nothing about it.
      await client.setToolsOff(["show_image"]);
      assert.deepEqual(state(await say(client, "Typed, another tool off")), { tool: true, line: true });
    } finally {
      client.dispose();
    }
  } finally {
    saveImageGeneration({ enabled: false });
  }
});

test("video generation: the voice line is said only while the model has the tool, and says the clip is for the chat", async () => {
  const { saveVideoGeneration } = await import("../dist/video-generation.js");
  const { GENERATE_VIDEO_VOICE_LINE } = await import("../dist/pi/generate-video-tool.js");
  saveInstructions(undefined);
  saveVideoGeneration({ baseUrl: "http://127.0.0.1:9", enabled: true });
  const state = (prompt) => ({ tool: offered.at(-1).includes("generate_video"), line: prompt.includes(GENERATE_VIDEO_VOICE_LINE) });
  try {
    assert.match(GENERATE_VIDEO_VOICE_LINE, /not shown in a spoken conversation, only in the chat/);
    // Opened with it switched off (the chat's menu, a project's default, Settings → Tools): not offered, not spoken of.
    const client = await open(undefined, { sessionId: "video-generation-switched-off", toolsOff: ["generate_video"] });
    try {
      assert.deepEqual(state(await say(client, "Spoken, tool off", true)), { tool: false, line: false });
      // Switched on in the chat's menu: both come at the next message, a typed one.
      await client.setToolsOff([]);
      assert.deepEqual(state(await say(client, "Typed, tool on")), { tool: true, line: true });
      // And off again.
      await client.setToolsOff(["generate_video"]);
      assert.deepEqual(state(await say(client, "Typed, tool off again")), { tool: false, line: false });
      // show_video is another tool: switching it off changes nothing about the line of the tool that makes a clip.
      await client.setToolsOff(["show_video"]);
      assert.deepEqual(state(await say(client, "Typed, another tool off")), { tool: true, line: true });
    } finally {
      client.dispose();
    }
  } finally {
    saveVideoGeneration({ enabled: false });
  }
  // Off, or with no address, there is no tool and no line.
  const bare = await open(undefined, { sessionId: "video-generation-off" });
  try {
    assert.deepEqual(state(await say(bare, "Spoken, add-on off", true)), { tool: false, line: false });
  } finally {
    bare.dispose();
  }
});

test("image generation: where an extension has a tool of the same name, pi keeps that one and the voice line says nothing of the portal's", async () => {
  const { saveImageGeneration } = await import("../dist/image-generation.js");
  const { GENERATE_IMAGE_VOICE_LINE } = await import("../dist/pi/generate-image-tool.js");
  const extension = path.join(process.env.PI_CODING_AGENT_DIR, "extensions", "image-package.ts");
  writeFileSync(extension, `
export default function (pi: any) {
  pi.registerTool({ name: "generate_image", label: "generate image", description: "THIRD-PARTY generate_image", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "ok" }] }) });
}
`);
  saveInstructions(undefined);
  saveImageGeneration({ baseUrl: "http://127.0.0.1:9/v1", enabled: true });
  const client = await open(undefined, { sessionId: "image-generation-clash" });
  try {
    const prompt = await say(client, "Spoken, with an extension's tool of that name", true);
    assert.ok(offered.at(-1).includes("generate_image"), "the extension's tool is the one the model has");
    assert.equal(client.session.getAllTools().find((t) => t.name === "generate_image").sourceInfo.path.includes("image-package"), true);
    assert.equal(prompt.includes(GENERATE_IMAGE_VOICE_LINE), false, "not told of a tool it does not have");
    assert.ok(prompt.includes(AUDIO_SYSTEM_RULE));
  } finally {
    client.dispose();
    rmSync(extension, { force: true });
    saveImageGeneration({ enabled: false });
  }
});

test("image generation: only the portal's own generate_image is told from an extension's, whatever the extension is called", async () => {
  const { saveImageGeneration } = await import("../dist/image-generation.js");
  const { knownTools, portalOwned, remembered, rememberTools, shownTools } = await import("../dist/db.js");
  const folder = path.join(process.env.PI_CODING_AGENT_DIR, "extensions", "image-generation");
  const listed = async (client) => (await client.getTools()).find((t) => t.name === "generate_image");
  const menu = () => shownTools().some((t) => t.name === "generate_image");
  saveImageGeneration({ enabled: false, baseUrl: "", apiKey: "" });

  // A user's own extension in a folder named as the portal's is, with a tool of the same name, and the add-on never touched.
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, "index.ts"), `
export default function (pi: any) {
  pi.registerTool({ name: "generate_image", label: "generate image", description: "MY OWN generate_image", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "ok" }] }) });
}
`);
  try {
    const theirs = await open(undefined, { sessionId: "image-generation-own-extension" });
    try {
      const tool = await listed(theirs);
      assert.equal(tool.source, "image-generation", "the label is the same as the portal's tool has");
      assert.equal(tool.inline, undefined);
      rememberTools((await theirs.getTools()).map(remembered));
      assert.equal(menu(), true, "their tool stays in the menus while the add-on is off");
      // Under the portal's label, but reported as not its own: the settings pages keep it with the extension.
      assert.equal(portalOwned(knownTools().find((t) => t.name === "generate_image")), false);
    } finally {
      theirs.dispose();
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }

  // The portal's own, as a chat with the add-on on reports it: marked, and gone from the menus once it is off.
  saveImageGeneration({ baseUrl: "http://127.0.0.1:9/v1", enabled: true });
  const ours = await open(undefined, { sessionId: "image-generation-portal-tool" });
  try {
    const tool = await listed(ours);
    assert.equal(tool.source, "image-generation");
    assert.equal(tool.inline, true);
    rememberTools((await ours.getTools()).map(remembered));
    assert.equal(menu(), true);
    saveImageGeneration({ enabled: false });
    assert.equal(menu(), false);
  } finally {
    ours.dispose();
    saveImageGeneration({ enabled: false });
  }
});

test("image editing: the edit tool and what the voice rule says of it come and go with its own switch, apart from generation's", async () => {
  const { saveImageGeneration } = await import("../dist/image-generation.js");
  const { GENERATE_IMAGE_VOICE_LINE } = await import("../dist/pi/generate-image-tool.js");
  const { EDIT_IMAGE_VOICE_LINE } = await import("../dist/pi/edit-image-tool.js");
  saveInstructions(undefined);
  saveImageGeneration({ enabled: false, editEnabled: false, baseUrl: "http://127.0.0.1:9/v1", apiKey: "" });
  const state = (prompt) => ({
    generate: offered.at(-1).includes("generate_image"), edit: offered.at(-1).includes("edit_image"),
    generateLine: prompt.includes(GENERATE_IMAGE_VOICE_LINE), editLine: prompt.includes(EDIT_IMAGE_VOICE_LINE),
  });
  const client = await open(undefined, { sessionId: "image-editing-chat" });
  try {
    // An address alone is neither tool.
    assert.deepEqual(state(await say(client, "Spoken, both off", true)), { generate: false, edit: false, generateLine: false, editLine: false });

    // Editing on and the chat reloaded, as the page's switch does it: the tool and its line, and not generation's.
    saveImageGeneration({ editEnabled: true });
    await client.reload();
    const edit = await say(client, "Typed, editing on");
    assert.deepEqual(state(edit), { generate: false, edit: true, generateLine: false, editLine: true });
    assert.ok(edit.includes(audioSystemRule(DEFAULT_VOICE_INSTRUCTIONS, EDIT_IMAGE_VOICE_LINE)), "the line alone, as generation's is");

    // Both on: both lines.
    saveImageGeneration({ enabled: true });
    await client.reload();
    assert.deepEqual(state(await say(client, "Typed, both on")), { generate: true, edit: true, generateLine: true, editLine: true });

    // The edit tool switched off in the chat's menu: its line goes with it, at the next message.
    await client.setToolsOff(["edit_image"]);
    assert.deepEqual(state(await say(client, "Typed, edit_image off")), { generate: true, edit: false, generateLine: true, editLine: false });
    await client.setToolsOff([]);
    assert.deepEqual(state(await say(client, "Typed, edit_image on again")), { generate: true, edit: true, generateLine: true, editLine: true });

    // Editing off again: the tool and the line go with the reload, generation's stay.
    saveImageGeneration({ editEnabled: false });
    await client.reload();
    assert.deepEqual(state(await say(client, "Typed, editing off")), { generate: true, edit: false, generateLine: true, editLine: false });
  } finally {
    client.dispose();
    saveImageGeneration({ enabled: false, editEnabled: false });
  }
});
