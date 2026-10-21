import { test } from "node:test";
import assert from "node:assert/strict";
import { inProcessHome } from "../../../tests/helpers.mts";
import { browserTools } from "../src/server/tools.ts";

/**
 * What Browser's tools cost in every request: their description, their schema and the line pi lists them by in the
 * system prompt, and the rules they share, which pi prints once. Written for a model that reads each token before it
 * can answer, so a text that grows back fails here. The caps are the lengths agreed for each when they were the
 * portal's (a quarter of a token to the character, as in the review of issue #183), with 10 for a changed word.
 */
inProcessHome("pithagoras-browser-texts-");
const all: any[] = [];
browserTools("s")({ registerTool: (tool: any) => all.push(tool) });

const tokens = (text: string) => Math.ceil(text.length / 4);
const cost = (tool: any) => tokens(tool.description) + tokens(JSON.stringify(tool.parameters)) + (tool.promptSnippet ? tokens(`- ${tool.name}: ${tool.promptSnippet}`) : 0);
const ROOM = 10;
const AGREED: Record<string, number> = {
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
};

test("each browser tool costs no more than was agreed, and the rules they share no more than they did", () => {
  assert.deepEqual(all.map((tool) => tool.name).sort(), Object.keys(AGREED).sort());
  for (const tool of all) assert.ok(cost(tool) <= AGREED[tool.name] + ROOM, `${tool.name} costs ${cost(tool)} tokens, more than the ${AGREED[tool.name]} agreed (and ${ROOM} of room)`);
  const rules = new Set(all.flatMap((tool) => (tool.promptGuidelines ?? []).map((line: string) => line.trim())));
  const said = [...rules].reduce((sum, line) => sum + tokens(`- ${line}`), 0);
  assert.ok(said <= 198 + ROOM, `the rules cost ${said} tokens`);
});

test("a tool's snippet does not begin with its own name again, as pi lists it as `- name: snippet`", () => {
  for (const tool of all) assert.doesNotMatch(tool.promptSnippet ?? "", new RegExp(`^${tool.name}\\b`), tool.name);
});

test("what the browser tools share is said once, as a rule, and not in each description", () => {
  for (const tool of all) {
    assert.doesNotMatch(tool.description, /what changed|Nothing on screen changed|no longer|take a fresh browser_snapshot/i, `${tool.name}: the answer of an action and the stale ref are rules`);
  }
  // The ref is described the same, briefly, in every schema that takes one.
  const refs = ["browser_click", "browser_type", "browser_select"].map((name) => all.find((tool) => tool.name === name)!.parameters.properties.ref.description as string);
  assert.equal(new Set(refs).size, 1);
  assert.ok(refs[0].length < 100, refs[0]);
});

test("a value outside the list of an enum is refused before the tool runs, and one that may be left out may be", async () => {
  const { piDependency } = await import("../../../core/server/src/pi/package.ts");
  const { validateToolArguments } = await piDependency("@earendil-works/pi-ai");
  const find = (name: string) => all.find((tool) => tool.name === name)!;
  const check = (name: string, args: Record<string, unknown>) => validateToolArguments(find(name), { type: "toolCall", id: "1", name, arguments: args });
  const refused = (name: string, args: Record<string, unknown>) => assert.throws(() => check(name, args), /Validation failed/, `${name} ${JSON.stringify(args)}`);

  assert.equal(check("browser_snapshot", { mode: "index" }).mode, "index");
  assert.equal(check("browser_snapshot", {}).mode, undefined, "the mode may be left out");
  refused("browser_snapshot", { mode: "html" });
  assert.equal(check("browser_scroll", { direction: "up" }).direction, "up");
  refused("browser_scroll", { direction: "left" });
  // What has to be there is asked for.
  refused("browser_navigate", {});
  assert.doesNotThrow(() => check("browser_back", {}));
});
