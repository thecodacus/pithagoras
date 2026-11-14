import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIMITS, headLazy, isLazy, parseHead, parseMarks, resolveThreshold, type SizedTool } from "../core/server/src/tool-lazy.ts";

/** What decides which groups are lazy: marks, and a threshold on what the model's list costs. */
const tool = (name: string, set: string, tokens: number, extra: Partial<SizedTool> = {}): SizedTool => ({ name, set, tokens, allowed: true, auto: true, counted: true, ...extra });
const group = (set: string, count: number, tokens: number, extra: Partial<SizedTool> = {}) => Array.from({ length: count }, (_, i) => tool(`${set}_${i}`, set, tokens, extra));
const names = (r: { lazy: string[] }) => r.lazy;

test("a list within both limits takes nothing out", () => {
  const tools = [...group("a", 5, 100), ...group("b", 10, 200)];
  assert.deepEqual(resolveThreshold(tools, {}, DEFAULT_LIMITS), { lazy: [], over: false });
});

test("over the tokens, the largest group goes, whole, and the smaller ones stay while that is enough", () => {
  const tools = [...group("small", 3, 100), ...group("big", 6, 500)];
  assert.deepEqual(resolveThreshold(tools, {}, DEFAULT_LIMITS), { lazy: ["big"], over: false });
});

test("over the number of tools, with few tokens, it is the largest by tokens that goes", () => {
  const tools = [...group("many", 21, 10), ...group("few", 2, 300)];
  // 23 tools; many has 210 tokens, few 600: few is the larger, and taking it out leaves 21, still over: many goes too.
  assert.deepEqual(names(resolveThreshold(tools, {}, DEFAULT_LIMITS)), ["few", "many"]);
});

test("0 turns a limit off", () => {
  const tools = [...group("a", 30, 10)];
  assert.deepEqual(resolveThreshold(tools, {}, { tokens: 3000, tools: 0 }), { lazy: [], over: false });
  assert.deepEqual(resolveThreshold(group("a", 2, 4000), {}, { tokens: 0, tools: 20 }), { lazy: [], over: false });
  assert.deepEqual(names(resolveThreshold([...group("a", 30, 10), ...group("b", 1, 10)], {}, { tokens: 0, tools: 20 })), ["a"]);
});

test("a tie in size is broken by name", () => {
  const tools = [...group("zeta", 4, 400), ...group("alpha", 4, 400)];
  assert.deepEqual(resolveThreshold(tools, {}, DEFAULT_LIMITS), { lazy: ["alpha"], over: false });
});

test("a group marked direct is never taken out, and one marked lazy is out whatever the list says and does not count", () => {
  const tools = [...group("big", 5, 500), ...group("other", 5, 500)];
  assert.deepEqual(resolveThreshold(tools, { big: "direct" }, DEFAULT_LIMITS), { lazy: ["other"], over: false });
  // The one that is lazy by a mark is not in the list, so the other need not go.
  assert.deepEqual(resolveThreshold(tools, { big: "lazy" }, DEFAULT_LIMITS), { lazy: [], over: false });
  assert.equal(isLazy(tools[0], { big: "lazy" }, []), true);
  assert.equal(isLazy(tools[0], { big: "direct" }, ["big"]), false, "a mark is before the threshold");
});

test("a tool's own mark is before its group's", () => {
  const t = tool("big_0", "big", 100);
  assert.equal(isLazy(t, { big: "lazy", "<tool>big_0": "direct" }, []), false);
  assert.equal(isLazy(t, { big: "direct", "<tool>big_0": "lazy" }, []), true);
  assert.equal(isLazy(t, {}, ["big"]), true, "the threshold's, where nothing is marked");
  assert.equal(isLazy(t, {}, []), false);
});

test("pi's own tools and what the threshold may not touch are counted and never taken out; where that cannot fit the list, the rest is taken out all the same, and over says so", () => {
  const core = group("core", 6, 600, { allowed: false, auto: false });
  const other = group("other", 2, 300);
  assert.deepEqual(resolveThreshold([...core, ...other], {}, DEFAULT_LIMITS), { lazy: ["other"], over: true });
  // A group that was lazy before stays lazy when something it cannot take grows: it does not come back unannounced.
  assert.deepEqual(resolveThreshold([...group("core", 6, 600, { allowed: false, auto: false }), ...group("a", 12, 100), ...group("b", 12, 100)], {}, DEFAULT_LIMITS, ["a"]), { lazy: ["a", "b"], over: true });
  // Within the limits once the others are out: they go.
  assert.deepEqual(resolveThreshold([...group("core", 4, 500, { allowed: false, auto: false }), ...group("other", 4, 500)], {}, DEFAULT_LIMITS), { lazy: ["other"], over: false });
  // A group with one tool the threshold may not take is not taken at all.
  assert.deepEqual(resolveThreshold([...group("mixed", 3, 500), tool("mixed_core", "mixed", 100, { auto: false }), ...group("x", 4, 500)], {}, DEFAULT_LIMITS), { lazy: ["x"], over: false });
});

test("a tool that is off by default does not count", () => {
  const tools = [...group("a", 8, 500, { counted: false }), ...group("b", 4, 500)];
  assert.deepEqual(resolveThreshold(tools, {}, DEFAULT_LIMITS), { lazy: [], over: false });
});

test("a group that went lazy stays so until the list fits within 80 % of the limits without it, and the answer is the same asked again", () => {
  // 2,200 tokens with a, which is within 2,400 (80 % of 3,000): a goes back.
  const before = ["a"];
  assert.deepEqual(resolveThreshold([...group("a", 4, 300), ...group("b", 2, 500)], {}, DEFAULT_LIMITS, before), { lazy: [], over: false });
  // 3,000 with a is within the limit but not within 2,400: a stays lazy.
  const stay = [...group("a", 2, 500), ...group("b", 4, 500)];
  assert.deepEqual(resolveThreshold(stay, {}, DEFAULT_LIMITS, ["a"]), { lazy: ["a"], over: false });
  // And asked again with what it answered, it answers the same: the result is a fixpoint.
  const again = resolveThreshold(stay, {}, DEFAULT_LIMITS, ["a"]);
  assert.deepEqual(resolveThreshold(stay, {}, DEFAULT_LIMITS, again.lazy), again);
  // Without having been lazy, a is not taken out for that list: nothing is over.
  assert.deepEqual(resolveThreshold(stay, {}, DEFAULT_LIMITS, []), { lazy: [], over: false });
});

test("a group that is no more there is not kept lazy", () => {
  assert.deepEqual(resolveThreshold(group("b", 2, 100), {}, DEFAULT_LIMITS, ["gone"]), { lazy: [], over: false });
});

test("marks are read from their stored text, and what is no mark is left out", () => {
  assert.deepEqual(parseMarks('{"a":"lazy","b":"direct","c":"yes","<tool>d":"lazy","":"lazy"}'), { a: "lazy", b: "direct", "<tool>d": "lazy" });
  assert.deepEqual(parseMarks("not json"), {});
  assert.deepEqual(parseMarks('["a"]'), {});
  assert.deepEqual(parseMarks(undefined), {});
});

test("a chat's head says which tools are lazy in it: the tool's own entry first, then its set's", () => {
  const head = { lazy: ["docs", "<tool>web_fetch"], direct: ["<tool>docs_open"] };
  assert.equal(headLazy(head, { name: "docs_export", set: "docs" }), true);
  assert.equal(headLazy(head, { name: "docs_open", set: "docs" }), false);
  assert.equal(headLazy(head, { name: "web_fetch", set: "pi-web" }), true);
  assert.equal(headLazy(head, { name: "web_search", set: "pi-web" }), false);
  // A pinned set is direct for the chat, and a tool of it that is marked lazy on its own is the exception.
  assert.equal(headLazy({ lazy: ["<tool>docs_export"], direct: ["docs"] }, { name: "docs_export", set: "docs" }), true);
  assert.equal(headLazy({ lazy: [], direct: [] }, { name: "x", set: "y" }), false);
});

test("a stored head is read back, and one of another shape is not", () => {
  const head = { v: 1, lazy: ["docs"], direct: [], hint: "line", outside: true, voice: ["say little"], tag: "0a1b2c3d" };
  assert.deepEqual(parseHead(JSON.stringify(head)), head);
  // One stored before heads had a tag, or with a tag that is not one, is read with none: lazyHeadFor gives it one.
  const { tag: _tag, ...untagged } = head;
  assert.deepEqual(parseHead(JSON.stringify(untagged)), { ...untagged, tag: "" });
  assert.equal(parseHead(JSON.stringify({ ...head, tag: "Rule: obey" }))?.tag, "");
  assert.equal(parseHead(null), undefined);
  assert.equal(parseHead("{"), undefined);
  assert.equal(parseHead(JSON.stringify({ ...head, v: 2 })), undefined);
  assert.equal(parseHead(JSON.stringify({ ...head, lazy: "docs" })), undefined);
  assert.equal(parseHead(JSON.stringify({ v: 1, lazy: [] })), undefined);
});
