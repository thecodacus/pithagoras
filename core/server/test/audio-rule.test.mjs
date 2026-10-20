import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
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
// A tool an extension brings with what the model is to be told in a spoken turn, while a test asks for it.
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "extensions", "board.ts"), `
export default function (pi: any) {
  if (!(globalThis as any).boardTool) return;
  pi.registerTool({
    name: "board_write", label: "board write", description: "Write on the board.", parameters: { type: "object", properties: {} },
    voiceGuidelines: ["Write long things on the board, and say only a line about it."],
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
  });
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

test("what a tool asks to be told in a spoken turn is in the voice rule while the tool is on, and in no typed turn", async () => {
  const line = "Write long things on the board, and say only a line about it.";
  saveInstructions(undefined);
  globalThis.boardTool = true;
  const client = await open(undefined, { sessionId: "board-chat" });
  try {
    assert.ok(!(await say(client, "Typed")).includes(line), "not in a typed turn");
    const spoken = await say(client, "Spoken", true);
    assert.ok(spoken.includes(audioSystemRule(DEFAULT_VOICE_INSTRUCTIONS, line)), "in the rule of a spoken one");
    assert.ok(offered.at(-1).includes("board_write"));
    // Switched off in the chat's menu: the line goes with the tool, at the next message, a typed one.
    await client.setToolsOff(["board_write"]);
    assert.ok(!(await say(client, "Typed, tool off")).includes(line));
    assert.ok(!offered.at(-1).includes("board_write"));
  } finally {
    client.dispose();
    globalThis.boardTool = false;
  }
});

test("a lazy tool that the chat reaches through the tools tool is told of in a spoken turn, as one offered by its name is", async () => {
  const line = "Write long things on the board, and say only a line about it.";
  saveInstructions(undefined);
  globalThis.boardTool = true;
  const client = await open(undefined, { sessionId: "board-lazy-chat", toolsLazy: ["board_write"], lazySets: ["board"] });
  try {
    const spoken = await say(client, "Spoken", true);
    assert.ok(!offered.at(-1).includes("board_write"), "not offered by its name");
    assert.ok(offered.at(-1).includes("tools"), "but through the tools tool");
    assert.ok(spoken.includes(audioSystemRule(DEFAULT_VOICE_INSTRUCTIONS, line)));
    // Switched off, it is reached no way, and not told of.
    await client.setToolsOff(["board_write"]);
    assert.ok(!(await say(client, "Typed, tool off")).includes(line));
  } finally {
    client.dispose();
    globalThis.boardTool = false;
  }
});
