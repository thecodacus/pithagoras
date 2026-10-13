import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./helpers.mts";

// What the portal's own tools cost in every request: their description, their schema and the line pi lists them
// by in the system prompt. Written for a model that reads each token before it can answer, so a text that grows
// back fails here. The caps are the lengths agreed for each tool (about a quarter of a token to the character is
// the measure, as in the review of issue #183), with a little room for a word to be changed.
inProcessHome("pitha-tool-texts-");
const { putSetting } = await import("../server/src/db.ts");
const { CanvasTools } = await import("../server/src/pi/canvas-tools.ts");
const { ToolsGateway } = await import("../server/src/pi/tools-gateway.ts");
const { browserTools } = await import("../server/src/browser/tools.ts");
const { askPrimaryTool } = await import("../server/src/pi/ask-primary.ts");
const { askQuestionTool } = await import("../server/src/pi/ask-question.ts");
const { GenerateImageTool } = await import("../server/src/pi/generate-image-tool.ts");
const { EditImageTool } = await import("../server/src/pi/edit-image-tool.ts");
const { GenerateVideoTool } = await import("../server/src/pi/generate-video-tool.ts");
const { showImageTool } = await import("../server/src/pi/show-image-tool.ts");
const { showVideoTool } = await import("../server/src/pi/show-video-tool.ts");
const { heartbeatTool } = await import("../server/src/pi/heartbeat-tool.ts");
const { reportTool } = await import("../server/src/pi/report-tool.ts");
const { routineTools } = await import("../server/src/pi/routine-tools.ts");
const { default: notes } = await import("../extensions/notes/index.ts");
const { default: subagent } = await import("../extensions/subagent/index.ts");
const { piDependency } = await import("../server/src/pi/package.ts");

interface Registered {
  name: string;
  description: string;
  parameters: any;
  promptSnippet?: string;
  promptGuidelines?: string[];
}

/** What an extension is given of pi, to register its tools in. */
function load(extension: (pi: any) => unknown, into: Registered[]) {
  extension({
    registerTool: (tool: Registered) => into.push(tool),
    on: () => {},
    events: { on: () => () => {}, emit: () => {} },
    appendEntry: () => {},
    sendMessage: () => {},
  });
}

const tokens = (text: string) => Math.ceil(text.length / 4);
/** A tool's cost as the model is charged for it: the description, the schema and the line pi lists it by. */
const cost = (tool: Registered) =>
  tokens(tool.description) + tokens(JSON.stringify(tool.parameters)) + (tool.promptSnippet ? tokens(`- ${tool.name}: ${tool.promptSnippet}`) : 0);

putSetting("image_generation", JSON.stringify({ enabled: true, baseUrl: "https://images.example.com/v1", editEnabled: true, editMultiple: false }));
putSetting("video_generation", JSON.stringify({ enabled: true, baseUrl: "https://videos.example.com/v1" }));

const all: Registered[] = [];
load(new CanvasTools("s").extension as any, all);
load(new ToolsGateway(["browser", "media"]).extension, all);
load(browserTools("s"), all);
load(askPrimaryTool("s"), all);
load(askQuestionTool(), all);
load(new GenerateImageTool("/nowhere").extension, all);
const editOne: Registered[] = [];
load(new EditImageTool("/nowhere").extension, editOne);
load(new GenerateVideoTool("/nowhere").extension, all);
load(showImageTool("/nowhere"), all);
load(showVideoTool("/nowhere"), all);
load(heartbeatTool("a", "s"), all);
load(reportTool(null), all);
load(routineTools("s"), all);
load(notes, all);
const agentDir = process.env.PI_CODING_AGENT_DIR!;
writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ subagentMode: "interrupt" }));
load(subagent, all);
// The shapes that depend on a setting are looked at as well: several pictures to an edit, and a subagent that runs in the background.
putSetting("image_generation", JSON.stringify({ enabled: true, baseUrl: "https://images.example.com/v1", editEnabled: true, editMultiple: true }));
const editSeveral: Registered[] = [];
load(new EditImageTool("/nowhere").extension, editSeveral);
writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ subagentMode: "background" }));
const subagentBackground: Registered[] = [];
load(subagent, subagentBackground);

/** The most each tool may cost, in tokens: what was agreed, as the review of issue #183 measured it, and 10 for a changed word. */
const ROOM = 10;
const AGREED: Record<string, number> = {
  canvas_list: 21,
  canvas_create: 50,
  canvas_read: 59,
  canvas_write: 161,
  canvas_delete: 51,
  tools: 154,
  browser_navigate: 90,
  browser_back: 43,
  browser_snapshot: 169,
  browser_click: 99,
  browser_type: 128,
  browser_select: 118,
  browser_key: 82,
  browser_scroll: 138,
  browser_find: 109,
  browser_get_text: 148,
  browser_screenshot: 105,
  ask_primary: 218,
  ask_question: 393,
  generate_image: 143,
  edit_image: 318,
  "edit_image#several": 383,
  generate_video: 317,
  show_image: 105,
  show_video: 105,
  activity_note: 131,
  report: 88,
  routines_list: 43,
  routine_create: 209,
  routine_update: 142,
  routine_run: 41,
  note: 49,
  subagent: 103,
  "subagent#background": 121,
};

test("every tool of the portal's own is within the length agreed for it", () => {
  const tools: [string, Registered][] = [
    ...[...all, ...editOne].map((tool): [string, Registered] => [tool.name, tool]),
    ["edit_image#several", editSeveral[0]],
    ["subagent#background", subagentBackground[0]],
  ];
  assert.deepEqual(tools.map(([key]) => key).sort(), Object.keys(AGREED).sort(), "a tool without an agreed length, or an agreed length without a tool");
  for (const [key, tool] of tools) {
    assert.ok(cost(tool) <= AGREED[key] + ROOM, `${key} costs ${cost(tool)} tokens, more than the ${AGREED[key]} agreed (and ${ROOM} of room)`);
  }
});

test("all of them together stay near the length agreed", () => {
  // The review measured 6,880 tokens for these texts and proposed 4,550; the rules are counted once, as pi prints each once.
  const rules = new Set([...all, ...editOne].flatMap((tool) => (tool.promptGuidelines ?? []).map((line) => line.trim())));
  const total = [...all, ...editOne].reduce((sum, tool) => sum + cost(tool), 0) + [...rules].reduce((sum, line) => sum + tokens(`- ${line}`), 0);
  assert.ok(total <= 4700, `${total} tokens, where 4,550 were agreed`);
});

test("a tool's snippet does not begin with its own name again, as pi lists it as `- name: snippet`", () => {
  for (const tool of [...all, ...editOne]) {
    if (!tool.promptSnippet) continue;
    assert.doesNotMatch(tool.promptSnippet, new RegExp(`^${tool.name}\\b`), tool.name);
  }
});

test("what the browser tools share is said once, as a rule, and not in each description", () => {
  const browser = all.filter((tool) => tool.name.startsWith("browser_"));
  assert.equal(browser.length, 11);
  for (const tool of browser) {
    assert.doesNotMatch(tool.description, /what changed|Nothing on screen changed|no longer|take a fresh browser_snapshot/i, `${tool.name}: the answer of an action and the stale ref are rules`);
  }
  // The ref is described the same, briefly, in every schema that takes one.
  const refs = ["browser_click", "browser_type", "browser_select"].map((name) => browser.find((tool) => tool.name === name)!.parameters.properties.ref.description as string);
  assert.equal(new Set(refs).size, 1);
  assert.ok(refs[0].length < 100, refs[0]);
});

test("a value outside the list of an enum is refused before the tool runs, as it was with a union of constants", async () => {
  const { validateToolArguments } = await piDependency("@earendil-works/pi-ai");
  const find = (name: string) => all.find((tool) => tool.name === name)!;
  const check = (name: string, args: Record<string, unknown>) =>
    validateToolArguments(find(name), { type: "toolCall", id: "1", name, arguments: args });
  const refused = (name: string, args: Record<string, unknown>) => assert.throws(() => check(name, args), /Validation failed/, `${name} ${JSON.stringify(args)}`);

  assert.deepEqual(check("canvas_write", { canvas_id: "c", revision: 1, operation: "append", content: "x" }).operation, "append");
  refused("canvas_write", { canvas_id: "c", revision: 1, operation: "prepend", content: "x" });
  assert.equal(check("tools", { action: "describe", name: "x" }).action, "describe");
  refused("tools", { action: "destroy" });
  assert.equal(check("browser_snapshot", { mode: "index" }).mode, "index");
  assert.equal(check("browser_snapshot", {}).mode, undefined, "the mode may be left out");
  refused("browser_snapshot", { mode: "html" });
  assert.equal(check("browser_scroll", { direction: "up" }).direction, "up");
  refused("browser_scroll", { direction: "left" });
  assert.equal(check("ask_question", { questions: [{ question: "Q?", kind: "ranking", options: ["a", "b"] }] }).questions[0].kind, "ranking");
  refused("ask_question", { questions: [{ question: "Q?", kind: "sorting" }] });
});
