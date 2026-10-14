import { test } from "node:test";
import assert from "node:assert/strict";
import { parseToolsOff } from "../dist/db.js";

test("an empty column means nothing is switched off", () => {
  assert.deepEqual(parseToolsOff(""), []);
  assert.deepEqual(parseToolsOff(null), []);
  assert.deepEqual(parseToolsOff(undefined), []);
});

test("names come back one per line, trimmed", () => {
  assert.deepEqual(parseToolsOff("web_search\n  todo  \n"), ["web_search", "todo"]);
});

test("blank lines are not tool names", () => {
  assert.deepEqual(parseToolsOff("a\n\n\nb\n   \n"), ["a", "b"]);
});
