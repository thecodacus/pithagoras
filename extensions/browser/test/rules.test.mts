import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fakeModel } from "../../../core/server/test/fake-model.mjs";
import { inProcessHome } from "../../../tests/helpers.mts";
import { serveBrowser } from "./portal.mts";

/**
 * The rules the model is told about the browser, for each way its tools can be switched.
 *
 * pi prints a tool's rules in the system prompt only while the tool is active, so a rule that one tool
 * alone carries is gone when that tool is switched off. The rule that a page is data and never
 * instructions is the one that must not go: the guard's short envelope relies on it being said
 * (pageEnvelope in core's guard.ts). It is the portal's, said while any tool that declares outside content
 * is on, as every browser tool does. Real pi and the portal's own client, a model that only answers, and the
 * tools as Browser's server half gives them to a chat.
 */
const home = inProcessHome("pithagoras-browser-rules-");
mkdirSync(path.join(process.env.PI_CODING_AGENT_DIR!, "extensions"), { recursive: true });

const model = await fakeModel(() => "Done.");
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, "models.json"), JSON.stringify(model.models()));

const browser = await serveBrowser();
assert.equal((await fetch(`${browser.at}/connect`, { method: "POST" })).status, 200);
const { SdkPiClient } = await import("../../../core/server/dist/pi/sdk-client.js");
const { OUTSIDE_CONTENT_GUIDELINE } = await import("../../../core/server/dist/pi/guard.js");
const { BROWSER_READING_RULE, BROWSER_SCREENSHOT_RULE } = await import("../../../core/server/dist/pi/browser-mcp-rules.js");
const { ACTIONS_RULE, REFS_RULE, browserTools } = await import("../src/server/tools.ts");

const systemOf = (request) =>
  request.messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
const names = (request) => (request.tools ?? []).map((t) => t.function.name);

let n = 0;
/** The first request a conversation sends, with the browser tools switched as `options` say. */
async function ask(options = {}) {
  model.requests.length = 0;
  const cwd = mkdtempSync(path.join(process.env.WORKSPACE_ROOT!, "chat-"));
  const sessionId = `rules-${n++}`;
  browser.chat(sessionId, cwd);
  const client = await SdkPiClient.create({
    cwd,
    sessionDir: mkdtempSync(path.join(home, "chat-")),
    provider: "fake",
    modelId: "m",
    sessionId,
    ...options,
  });
  const settled = new Promise((resolve) => client.on("event", (e) => e?.type === "agent_settled" && resolve()));
  try {
    await client.prompt("Hello");
    await settled;
    return model.requests[0];
  } finally {
    client.dispose();
  }
}

/** The tools as the extension registers them, by name. */
const registered: Record<string, any> = {};
browserTools("s")({ registerTool: (t: any) => (registered[t.name] = t) });
const NAMES = Object.keys(registered);

/** The tools whose answers or arguments the shared rules are about: a rule is said while one of them is on. */
const ACTING = ["browser_snapshot", "browser_click", "browser_type", "browser_select", "browser_key"];
const WITH_REFS = ["browser_snapshot", "browser_find", "browser_click", "browser_type", "browser_select", "browser_scroll", "browser_get_text", "browser_screenshot"];

/** What the rules are, for a set of browser tools that is on: the page is data wherever there is one, the others where they concern one. */
const expected = (on) => ({
  untrusted: on.length > 0,
  actions: on.some((name) => ACTING.includes(name)),
  refs: on.some((name) => WITH_REFS.includes(name)),
});
/** Which of the rules a system prompt has. */
const has = (text) => ({
  untrusted: text.includes(OUTSIDE_CONTENT_GUIDELINE),
  actions: text.includes(ACTIONS_RULE),
  refs: text.includes(REFS_RULE),
});

test("every browser tool declares that what it reads is outside content, so the rule that a page is data stays whichever of them is switched off", () => {
  assert.equal(NAMES.length, 11);
  for (const [name, tool] of Object.entries(registered)) assert.equal(tool.guard?.outside, true, name);
});

test("for every set of browser tools that is on, the rules of their own pi prints are the ones that concern them", () => {
  const all = [...NAMES];
  for (let mask = 0; mask < 1 << all.length; mask++) {
    const on = all.filter((_, i) => mask & (1 << i));
    // What pi's buildRules collects: the rules of each active tool. The rule that a page is data is not one of them.
    const printed = on.flatMap((name) => registered[name].promptGuidelines ?? []).join("\n");
    assert.deepEqual(has(printed), { ...expected(on), untrusted: false }, `with ${on.join(", ") || "none"} on`);
  }
});

test("a conversation is told what the browser tools that are on need, whichever of the others are off", async () => {
  /** A new conversation, with the tools in `off` switched off and `lazy` kept out of its list: the rules are those of what is on. */
  const check = async (label: string, { off = [] as string[], lazy = [] as string[] } = {}) => {
    const request = await ask({ toolsOff: off, ...(lazy.length ? { toolsLazy: lazy, lazySets: ["pithagoras-browser"] } : {}) });
    const on = NAMES.filter((name) => !off.includes(name));
    assert.deepEqual(names(request).filter((name) => name.startsWith("browser_")), on.filter((name) => !lazy.includes(name)), `${label}: the tools offered`);
    const system = systemOf(request);
    assert.deepEqual(has(system), expected(on), label);
    // Browser's tools have rules of their own, and a Playwright server's, of which there is none here, are not said.
    assert.ok(!system.includes(BROWSER_READING_RULE) && !system.includes(BROWSER_SCREENSHOT_RULE), `${label}: no Playwright rules`);
  };
  await check("all on");
  // One tool off at a time: the rule that a page is data used to go with browser_snapshot alone.
  for (const off of NAMES) await check(`${off} off`, { off: [off] });
  // One tool on at a time.
  for (const on of NAMES) await check(`only ${on} on`, { off: NAMES.filter((name) => name !== on) });
  // Every one off: nothing is said about the browser.
  await check("all off", { off: [...NAMES] });
  // Lazy tools: the gateway says the rules of those that are on and not switched off.
  await check("all lazy", { lazy: [...NAMES] });
  await check("all lazy, browser_snapshot off", { lazy: [...NAMES], off: ["browser_snapshot"] });
  await check("one lazy, the rest off", { lazy: ["browser_navigate"], off: NAMES.filter((name) => name !== "browser_navigate") });
  await check("some lazy, some off", { lazy: ["browser_key", "browser_find"], off: ["browser_snapshot", "browser_click", "browser_type"] });
});
