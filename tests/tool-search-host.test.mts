import { test } from "node:test";
import assert from "node:assert/strict";
import { inProcessHome } from "./helpers.mts";

/**
 * The tool search on its own, with a made-up pi session: what it hides, what it finds, what it refuses and how it
 * calls. The same tool run by pi itself is in core/server/test/tool-search.test.mjs; here the cases that real pi does not
 * let happen, such as a tool that is switched off and still active, are made.
 */
inProcessHome("pitha-tool-search-host-");
const { ToolSearch, RULE_LINES_NOTE } = await import("../core/server/src/pi/tool-search.ts");

const NO_HEAD = { v: 1 as const, lazy: [], direct: [], hint: "", outside: false, voice: [] };

interface Fake {
  name: string;
  description?: string;
  parameters?: unknown;
  promptGuidelines?: string[];
  group?: string;
}
const make = (list: Fake[], { off = [] as string[], inactive = [] as string[], lazyNames = list.map((t) => t.name), alias }: { off?: string[]; inactive?: string[]; lazyNames?: string[]; alias?: (name: string) => string | undefined } = {}) => {
  let registry: any[] | Error = list.map((t) => ({ ...t, sourceInfo: { path: `<inline:${t.group ?? "docs"}>` } }));
  const offNow = new Set(off);
  const search = new ToolSearch({ ...NO_HEAD, hint: "hint" });
  const session = {
    getAllTools: () => {
      if (registry instanceof Error) throw registry;
      return registry;
    },
    getActiveToolNames: () => (registry instanceof Error ? [] : registry.map((t: any) => t.name)).filter((n: string) => !inactive.includes(n)),
    extensionRunner: { getToolDefinition: () => definition },
  };
  let definition: unknown;
  const registered: any[] = [];
  search.extension({ registerTool: (d: any) => { definition = d; registered.push(d); }, on: () => {} });
  search.attach({ session: () => session, lazy: (tool) => lazyNames.includes(tool.name), off: () => offNow, label: (tool) => tool.group ?? "docs", alias });
  const run = (p: any, ctx: any = {}) => registered.at(-1).execute("call-1", p, undefined, undefined, ctx);
  const text = (r: any) => r.content.map((c: any) => c.text).join("\n");
  return { search, run, text, offNow, registered, breakRegistry: () => (registry = new Error("not bound yet")), add: (t: Fake) => { (registry as any[]).push({ ...t, sourceInfo: { path: "<inline:docs>" } }); } };
};

const DOCS: Fake[] = [
  { name: "docs_open", description: "Open a document by its id.", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "docs_export", description: "Export a document as a PDF file.", parameters: { type: "object", properties: { id: { type: "string" } } } },
  { name: "notes_add", description: "Add a note." },
];

test("what is hidden is the whole group, all that is registered of it, active or not, sorted; and the same at every call", () => {
  const { search } = make(DOCS, { lazyNames: ["docs_open", "docs_export"], inactive: ["docs_export"] });
  assert.deepEqual(search.hidden(), ["docs_export", "docs_open"]);
  assert.deepEqual(search.hidden(), search.hidden());
});

test("a tool that registers later in the group is hidden from its first request", () => {
  const { search, add } = make(DOCS, { lazyNames: ["docs_open", "docs_export", "docs_late"] });
  add({ name: "docs_late" });
  assert.deepEqual(search.hidden(), ["docs_export", "docs_late", "docs_open"]);
});

test("where the registry cannot be read, the hidden set is the last one that could be, and nothing throws", () => {
  const { search, breakRegistry } = make(DOCS, { lazyNames: ["docs_open"] });
  assert.deepEqual(search.hidden(), ["docs_open"]);
  breakRegistry();
  assert.deepEqual(search.hidden(), ["docs_open"]);
});

test("pi is given the hook that hides, and the tool is declared to the model alone", () => {
  const { registered } = make(DOCS);
  const definition = registered[0];
  assert.equal(definition.name, "tool_search");
  assert.equal(definition.exposure, "model-only");
  assert.deepEqual(definition.prepareLoadout({}), { hiddenDeclarations: ["docs_export", "docs_open", "notes_add"] });
  assert.deepEqual(definition.promptGuidelines, ["hint", RULE_LINES_NOTE]);
  // With nothing frozen to say, only the line about the rules.
  const bare = new ToolSearch(NO_HEAD);
  let seen: any;
  bare.extension({ registerTool: (d: any) => (seen = d), on: () => {} });
  assert.deepEqual(seen.promptGuidelines, [RULE_LINES_NOTE]);
});

test("a tool that is switched off is not found, not described and refused, though it is still active, and the tool is never run", async () => {
  const { run, text } = make(DOCS, { off: ["docs_export"], lazyNames: ["docs_open", "docs_export"] });
  assert.match(text(await run({ action: "search", query: "pdf" })), /No lazy tool matches/);
  await assert.rejects(run({ action: "describe", name: "docs_export" }), /There is no lazy tool called "docs_export"\. Use search/);
  let ran = false;
  await assert.rejects(run({ action: "call", name: "docs_export", args: {} }, { executeTool: async () => { ran = true; } }), /"docs_export" is switched off in this conversation, here as everywhere/);
  assert.equal(ran, false);
  // The one that is on is found.
  assert.match(text(await run({ action: "search", query: "open" })), /docs_open/);
});

test("a tool switched off in the middle of the chat is out of the search at once", async () => {
  const { run, text, offNow } = make(DOCS, { lazyNames: ["docs_open", "docs_export"] });
  assert.match(text(await run({ action: "search", query: "pdf" })), /docs_export/);
  offNow.add("docs_export");
  assert.match(text(await run({ action: "search", query: "pdf" })), /No lazy tool matches/);
  offNow.delete("docs_export");
  assert.match(text(await run({ action: "search", query: "pdf" })), /docs_export/);
});

test("a call is made through ctx.executeTool with the tool's name and its arguments, and what comes back is the tool's result", async () => {
  const { run } = make(DOCS, { lazyNames: ["docs_open"] });
  const calls: any[] = [];
  const result = { content: [{ type: "text", text: "opened 7" }], details: { x: 1 }, structuredContent: { y: 2 } };
  const ctx = { executeTool: async (...args: any[]) => (calls.push(args), { toolCall: {}, result, isError: false, durationMs: 1 }) };
  const done = await run({ action: "call", name: "docs_open", args: '{"id": "7"}' }, ctx);
  assert.equal(calls[0][0], "docs_open");
  assert.deepEqual(calls[0][1], { id: "7" });
  assert.deepEqual(done, result, "an outcome that is no error does not add an isError of its own");
  // A failure is the outcome's flag, as pi reads it.
  const failed = await run({ action: "call", name: "docs_open", args: {} }, { executeTool: async () => ({ toolCall: {}, result: { content: [{ type: "text", text: "no" }], details: {} }, isError: true }) });
  assert.equal(failed.isError, true);
  // Arguments that are not an object are the model's mistake and are said.
  await assert.rejects(run({ action: "call", name: "docs_open", args: "[1]" }, ctx), /args must be an object/);
  await assert.rejects(run({ action: "call", name: "docs_open" }, {}), /cannot be called from here/);
});

test("a name with another case, a hyphen or a dot, or one an alias knows, is the tool; a name two tools share is not guessed", async () => {
  const { run, text } = make([...DOCS, { name: "Docs-Open2" }, { name: "docs_open2" }], { lazyNames: ["docs_open", "Docs-Open2", "docs_open2"], alias: (name) => (name === "old_open" ? "docs_open" : undefined) });
  assert.match(text(await run({ action: "describe", name: "DOCS.OPEN" })), /^docs_open\n/);
  assert.match(text(await run({ action: "describe", name: "old_open" })), /^docs_open\n/);
  // `Docs-Open2` and `docs_open2` fold to one name: the exact one is found, and a spelling that fits both is not guessed.
  assert.match(text(await run({ action: "describe", name: "docs_open2" })), /^docs_open2\n/);
  await assert.rejects(run({ action: "describe", name: "docs.open2" }), /There is no lazy tool called/);
});

test("a tool that is not lazy is told to be called by its name", async () => {
  const { run } = make(DOCS, { lazyNames: ["docs_open"] });
  await assert.rejects(run({ action: "call", name: "notes_add", args: {} }, { executeTool: async () => ({}) }), /not a lazy tool: call it directly/);
});

test("a search finds by words, names the parameters, shows the best few's schema, and says how many more there are", async () => {
  const many = Array.from({ length: 20 }, (_, i): Fake => ({ name: `page_${i}`, description: `Reads page number ${i}.`, parameters: { type: "object", properties: { url: { type: "string" }, n: { type: "number" } }, required: ["url"] } }));
  const { run, text } = make(many);
  const found = text(await run({ action: "search", query: "page" }));
  assert.match(found, /^20 lazy tools matching "page":/);
  assert.equal(found.match(/^- page_/gm)?.length, 15, "fifteen hits");
  assert.match(found, /- page_\d+\(url, n\?\): Reads page number/);
  assert.equal(found.match(/^  parameters: /gm)?.length, 3, "the best three carry their schema");
  assert.match(found, /5 more match: narrow the search\./);
});

test("a schema that is too long to show is given as the names of its parameters", async () => {
  const big = { name: "big_tool", description: "Does a lot.", parameters: { type: "object", properties: Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`field_${i}`, { type: "string", description: "x".repeat(60) }])) } };
  const { run, text } = make([big]);
  const found = text(await run({ action: "search", query: "lot" }));
  assert.ok(found.length < 9100);
  assert.match(found, /parameters: \(field_0\?, field_1\?/);
  assert.match(found, /the full schema is over 1800 characters/);
});

test("the rules of a group's tools are said once for the group with its first hit, a tool's own with its hit and its describe, each as a Rule line", async () => {
  const shared = "Read a page before you quote it.";
  const { search, run, text } = make([
    { name: "page_read", description: "Read a page.", group: "web", promptGuidelines: [shared, "Own rule of read."] },
    { name: "page_scroll", description: "Scroll a page.", group: "web", promptGuidelines: [shared] },
    { name: "calc_add", description: "Add numbers.", group: "math", promptGuidelines: ["Calc rule."] },
  ]);
  const first = text(await run({ action: "search", query: "page" }));
  assert.equal(first.match(new RegExp(`^Rule: ${shared}$`, "gm"))?.length, 1);
  assert.match(first, /^Rule: Own rule of read\.$/m);
  assert.doesNotMatch(first, /Calc rule/, "a group that is not among the hits says nothing");
  const again = text(await run({ action: "search", query: "page" }));
  assert.doesNotMatch(again, new RegExp(shared), "not again while the model has it");
  assert.match(again, /Own rule of read/, "a tool's own rule comes with its hit each time");
  // The context was cut: the model has none of it, and is told again.
  search.forget();
  assert.match(text(await run({ action: "search", query: "page" })), new RegExp(`^Rule: ${shared}$`, "m"));
  // A group that has one tool with it has the rule as the tool's own.
  assert.match(text(await run({ action: "describe", name: "calc_add" })), /^Rule: Calc rule\.$/m);
});

test("a search with no words lists the groups, and says there are none where nothing is lazy", async () => {
  const { run, text } = make(DOCS, { lazyNames: ["docs_open", "docs_export"] });
  assert.match(text(await run({ action: "search" })), /^2 lazy tools in 1 group:\n- docs \(2\): docs_export, docs_open/);
  const none = make(DOCS, { lazyNames: [] });
  assert.match(none.text(await none.run({ action: "search", query: "open" })), /There are no lazy tools in this conversation/);
});

test("it owns the name only while pi holds its own definition under it", () => {
  const { search } = make(DOCS);
  assert.equal(search.owns(), true);
  assert.equal(search.taken(), false);
  const taken = make(DOCS);
  // An extension's tool of the same name is what pi keeps.
  (taken.search as any).definition = { another: true };
  assert.equal(taken.search.owns(), false);
  assert.equal(taken.search.taken(), true);
});

test("an action it does not know is said", async () => {
  const { run } = make(DOCS);
  await assert.rejects(run({ action: "destroy" }), /action is search, describe or call/);
});
