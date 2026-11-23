import { test } from "node:test";
import assert from "node:assert/strict";
import { rank, wordsOf, type Rankable } from "../core/server/src/pi/tool-rank.ts";

/** The ranking of the tool search: BM25 over a tool's name, its description, its parameters' names and its group's. */
const tool = (name: string, description: string, params: string[] = [], group = "docs"): Rankable => ({ name, description, params, group });

const TOOLS = [
  tool("docs_open", "Open a document by its id.", ["id"]),
  tool("docs_export", "Export a document as a PDF file.", ["id", "format"]),
  tool("notes_add", "Add a note to the notebook.", ["note"], "notes"),
  tool("browser_screenshot", "Take a picture of the page that is open.", ["ref"], "browser"),
  tool("browser_navigate", "Go to an address.", ["url"], "browser"),
];

test("words break at underscores, hyphens, dots and camel humps, and are lower case", () => {
  assert.deepEqual(wordsOf("docs_open"), ["docs", "open"]);
  assert.deepEqual(wordsOf("getPageText"), ["get", "page", "text"]);
  assert.deepEqual(wordsOf("Jira-create.issue"), ["jira", "create", "issue"]);
  assert.deepEqual(wordsOf("  "), []);
});

test("a tool whose name or text has the query's words is a hit, best first, and the others are not", () => {
  assert.deepEqual(rank(TOOLS, "pdf").map((t) => t.name), ["docs_export"]);
  assert.deepEqual(rank(TOOLS, "document").map((t) => t.name).sort(), ["docs_export", "docs_open"]);
  assert.deepEqual(rank(TOOLS, "teapot"), []);
});

test("a word in a tool's name counts for more than one in its description", () => {
  const found = rank([tool("a_tool", "Do things with a screenshot."), tool("screenshot", "Do things.")], "screenshot");
  assert.deepEqual(found.map((t) => t.name), ["screenshot", "a_tool"]);
});

test("the start of a word finds the word, from three letters on", () => {
  assert.deepEqual(rank(TOOLS, "screen").map((t) => t.name), ["browser_screenshot"]);
  assert.deepEqual(rank(TOOLS, "pd").map((t) => t.name), [], "two letters are not a start of a word");
});

test("the name of a group finds the group's tools", () => {
  assert.deepEqual(rank(TOOLS, "browser").map((t) => t.name).sort(), ["browser_navigate", "browser_screenshot"]);
  assert.deepEqual(rank(TOOLS, "notes").map((t) => t.name), ["notes_add"]);
});

test("a parameter's name finds a tool", () => {
  assert.deepEqual(rank(TOOLS, "format").map((t) => t.name), ["docs_export"]);
  assert.deepEqual(rank(TOOLS, "url").map((t) => t.name), ["browser_navigate"]);
});

test("a word that few tools have counts for more than one that many do", () => {
  const many = [tool("a", "open the thing"), tool("b", "open the other thing"), tool("c", "open a third thing, a rare zebra")];
  assert.equal(rank(many, "open zebra")[0].name, "c");
});

test("a query of no words is every tool, in the order given, and the result is the same for the same query", () => {
  assert.deepEqual(rank(TOOLS, "  ").map((t) => t.name), TOOLS.map((t) => t.name));
  assert.deepEqual(rank(TOOLS, "open").map((t) => t.name), rank([...TOOLS], "open").map((t) => t.name));
  // Ties are broken by name: the answer does not depend on the order the tools were registered in.
  const a = rank([tool("b_x", "same"), tool("a_x", "same")], "same").map((t) => t.name);
  const b = rank([tool("a_x", "same"), tool("b_x", "same")], "same").map((t) => t.name);
  assert.deepEqual(a, b);
});
