import { test } from "node:test";
import assert from "node:assert/strict";
import { inProcessHome } from "./helpers.mts";

// What the portal's own tools cost in every request: their description, their schema and the line pi lists them
// by in the system prompt. Written for a model that reads each token before it can answer, so a text that grows
// back fails here. The caps are the lengths agreed for each tool (about a quarter of a token to the character is
// the measure, as in the review of issue #183), with a little room for a word to be changed.
inProcessHome("pitha-tool-texts-");
const { ToolsGateway } = await import("../core/server/src/pi/tools-gateway.ts");
const { askPrimaryTool } = await import("../core/server/src/pi/ask-primary.ts");
const { askQuestionTool } = await import("../core/server/src/pi/ask-question.ts");
const { heartbeatTool } = await import("../core/server/src/pi/heartbeat-tool.ts");
const { reportTool } = await import("../core/server/src/pi/report-tool.ts");
const { routineTools } = await import("../core/server/src/pi/routine-tools.ts");
const { default: subagentTool } = await import("../extensions/subagent/src/pi.ts");
const { settingsOf } = await import("../extensions/subagent/src/settings.ts");
const { piDependency } = await import("../core/server/src/pi/package.ts");

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

const all: Registered[] = [];
load(new ToolsGateway(["browser", "media"]).extension, all);
load(askPrimaryTool("s"), all);
load(askQuestionTool(), all);
load(heartbeatTool("a", "s"), all);
load(reportTool(null), all);
load(routineTools("s"), all);
load((pi) => subagentTool(pi, () => settingsOf({ mode: "interrupt" })), all);
// The shape that depends on a setting is looked at as well: a subagent that runs in the background.
const subagentBackground: Registered[] = [];
load((pi) => subagentTool(pi, () => settingsOf({ mode: "background" })), subagentBackground);

/** The most each tool may cost, in tokens: what was agreed, as the review of issue #183 measured it, and 10 for a changed word. */
const ROOM = 10;
const AGREED: Record<string, number> = {
  tools: 154,
  ask_primary: 218,
  ask_question: 393,
  activity_note: 131,
  report: 88,
  routines_list: 43,
  routine_create: 209,
  routine_update: 142,
  routine_run: 41,
  subagent: 118,
  "subagent#background": 136,
};

test("every tool of the portal's own is within the length agreed for it", () => {
  const tools: [string, Registered][] = [
    ...all.map((tool): [string, Registered] => [tool.name, tool]),
    ["subagent#background", subagentBackground[0]],
  ];
  assert.deepEqual(tools.map(([key]) => key).sort(), Object.keys(AGREED).sort(), "a tool without an agreed length, or an agreed length without a tool");
  for (const [key, tool] of tools) {
    assert.ok(cost(tool) <= AGREED[key] + ROOM, `${key} costs ${cost(tool)} tokens, more than the ${AGREED[key]} agreed (and ${ROOM} of room)`);
  }
});

test("all of them together stay near the length agreed", () => {
  // The review measured 6,880 tokens for these texts and proposed 4,550, of which the 988 of the picture and video tools are
  // the Media extension's now, and the 1,426 of the browser tools and their rules the Browser extension's; the rules are
  // counted once, as pi prints each once.
  const rules = new Set(all.flatMap((tool) => (tool.promptGuidelines ?? []).map((line) => line.trim())));
  const total = all.reduce((sum, tool) => sum + cost(tool), 0) + [...rules].reduce((sum, line) => sum + tokens(`- ${line}`), 0);
  assert.ok(total <= 2286, `${total} tokens, where 2,136 were agreed`);
});

test("a tool's snippet does not begin with its own name again, as pi lists it as `- name: snippet`", () => {
  for (const tool of all) {
    if (!tool.promptSnippet) continue;
    assert.doesNotMatch(tool.promptSnippet, new RegExp(`^${tool.name}\\b`), tool.name);
  }
});

test("a value outside the list of an enum is refused before the tool runs, as it was with a union of constants", async () => {
  const { validateToolArguments } = await piDependency("@earendil-works/pi-ai");
  const find = (name: string) => all.find((tool) => tool.name === name)!;
  const check = (name: string, args: Record<string, unknown>) =>
    validateToolArguments(find(name), { type: "toolCall", id: "1", name, arguments: args });
  const refused = (name: string, args: Record<string, unknown>) => assert.throws(() => check(name, args), /Validation failed/, `${name} ${JSON.stringify(args)}`);

  assert.equal(check("tools", { action: "describe", name: "x" }).action, "describe");
  refused("tools", { action: "destroy" });
  assert.equal(check("ask_question", { questions: [{ question: "Q?", kind: "ranking", options: ["a", "b"] }] }).questions[0].kind, "ranking");
  refused("ask_question", { questions: [{ question: "Q?", kind: "sorting" }] });
});
