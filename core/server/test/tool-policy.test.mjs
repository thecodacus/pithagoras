import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toolEnabled,
  defaultsFor,
  effectiveOff,
  exceptionsFor,
  toolSetOf,
  toolSource,
} from "../dist/tool-policy.js";

const none = { off: [], on: [] };

test("with nothing said anywhere, a tool is on", () => {
  assert.equal(toolEnabled("web_search", [], none), true);
});

test("a default takes effect where a conversation is silent", () => {
  assert.equal(toolEnabled("web_search", ["web_search"], none), false);
});

test("a conversation may switch off what the default leaves on", () => {
  assert.equal(toolEnabled("web_search", [], { off: ["web_search"], on: [] }), false);
});

test("and switch on what the default has off", () => {
  assert.equal(toolEnabled("web_search", ["web_search"], { off: [], on: ["web_search"] }), true);
});

test("off wins over on, so a contradiction fails closed", () => {
  assert.equal(
    toolEnabled("web_search", [], { off: ["web_search"], on: ["web_search"] }),
    false
  );
});

test("what pi is told is everything off, however it got that way", () => {
  const off = effectiveOff(["a", "b", "c"], ["b"], { off: ["a"], on: [] });
  assert.deepEqual(off, ["a", "b"]);
});

test("a tool nobody has loaded is still named, so its switch is not lost", () => {
  assert.deepEqual(effectiveOff([], ["gone"], none), ["gone"]);
});

test("wanting exactly the default writes nothing down", () => {
  const e = exceptionsFor(["b"], ["b"], ["a", "b"]);
  assert.deepEqual(e, { off: [], on: [] });
});

test("switching off something the default leaves on is written as an exception", () => {
  assert.deepEqual(exceptionsFor(["a"], [], ["a", "b"]), { off: ["a"], on: [] });
});

test("switching on something the default has off is written the other way", () => {
  assert.deepEqual(exceptionsFor([], ["a"], ["a", "b"]), { off: [], on: ["a"] });
});

/** The reason exceptions are stored rather than the whole picture. */
test("a default changed later reaches a conversation that never disagreed", () => {
  const exceptions = exceptionsFor([], [], ["a", "b"]);
  assert.deepEqual(exceptions, { off: [], on: [] });
  assert.equal(toolEnabled("a", ["a"], exceptions), false);
});

test("but not one that did", () => {
  const exceptions = exceptionsFor([], ["a"], ["a"]);
  assert.deepEqual(exceptions, { off: [], on: ["a"] });
  assert.equal(toolEnabled("a", ["a"], exceptions), true);
});

test("a tool is filed under the MCP server pi's namespace says it is of, and under its package otherwise", () => {
  assert.equal(toolSource({ source: "browser", server: "browser" }), "browser");
  assert.equal(toolSource({ source: "jira", server: "my-jira" }), "my-jira");
  // No other tool is any server's, whatever its name starts like: a name is never taken apart.
  assert.equal(toolSource({ source: "pi-web-access" }), "pi-web-access");
  assert.equal(toolSetOf({ source: "pi-web-access" }), "pi-web-access");
  assert.equal(toolSetOf({ source: "  " }), "built in", "a tool that says nothing of where it came from is pi's own");
  assert.equal(toolSetOf({ source: "x", server: "jira" }), "jira");
});

test("a default-off tool nobody was shown is left alone, not switched on", () => {
  // The page only ever lists what this run registered. Walking the defaults as
  // well wrote an "on" exception for every tool that was merely not loaded —
  // and that exception outlives the default it silently cancelled.
  const exceptions = exceptionsFor(["web_search"], ["browser_browser_click"], ["web_search"]);
  assert.deepEqual(exceptions.on, []);
  assert.deepEqual(exceptions.off, ["web_search"]);
});

test("a default-off tool that was shown and left on is written down as on", () => {
  const exceptions = exceptionsFor([], ["ast_grep_search"], ["ast_grep_search", "web_search"]);
  assert.deepEqual(exceptions.on, ["ast_grep_search"]);
  assert.deepEqual(exceptions.off, []);
});

test("an off somebody set here survives the default coming to agree with it", () => {
  // Off in this chat, then off by default too, then an unrelated switch is
  // flipped and the page sends the whole picture back. Written down from
  // scratch, T would drop out — and switching the default back on would then
  // turn it on in a chat that had never been told to.
  const held = { off: ["T"], on: [] };
  const again = exceptionsFor(["T", "other"], ["T"], ["T", "other"], held);
  assert.deepEqual(again.off, ["T", "other"]);
  assert.equal(toolEnabled("T", [], again), false);
});

test("an on somebody set here survives the same way", () => {
  const held = { off: [], on: ["T"] };
  const again = exceptionsFor(["other"], [], ["T", "other"], held);
  assert.deepEqual(again.on, ["T"]);
  assert.equal(toolEnabled("T", ["T"], again), true);
});

test("what the chat held is dropped once the switch is flipped back", () => {
  const held = { off: ["T"], on: [] };
  // T is wanted on again, and the default leaves it on: nothing left to say.
  assert.deepEqual(exceptionsFor([], [], ["T"], held), { off: [], on: [] });
});

test("without anything held, nothing changes", () => {
  assert.deepEqual(exceptionsFor(["T"], ["T"], ["T"]), { off: [], on: [] });
});

test("a project bends the default, in both directions", () => {
  assert.deepEqual(defaultsFor(["a", "b"], { off: ["c"], on: ["a"] }), ["b", "c"]);
});

test("a project that says nothing leaves the default as it is", () => {
  assert.deepEqual(defaultsFor(["b", "a"], none), ["a", "b"]);
  assert.deepEqual(defaultsFor([], none), []);
});

test("a conversation holds its exceptions against what its project leaves", () => {
  const project = defaultsFor(["a"], { off: ["b"], on: ["a"] });
  // Nothing said in the conversation: the project's picture.
  assert.deepEqual(effectiveOff(["a", "b", "c"], project, none), ["b"]);
  // Its own word beats the project's, either way.
  assert.deepEqual(effectiveOff(["a", "b", "c"], project, { off: ["a"], on: ["b"] }), ["a"]);
  // And wanting what the project says writes nothing down.
  assert.deepEqual(exceptionsFor(["b"], project, ["a", "b", "c"]), { off: [], on: [] });
});
