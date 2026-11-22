import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toolEnabled,
  defaultsFor,
  effectiveOff,
  exceptionsFor,
  toolSetOf,
  BUILT_IN_SET,
  MCP_GATEWAY,
  defaultsAsShown,
  defaultsToStore,
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

test("a tool is filed under the set it says it came from: an MCP server's tools under the server, pi's own under none", () => {
  assert.equal(toolSetOf({ source: "browser" }), "browser");
  assert.equal(toolSetOf({ source: "pi-web-access" }), "pi-web-access");
  assert.equal(toolSetOf({ source: "  " }), "built in");
  assert.equal(toolSetOf({ source: "" }), BUILT_IN_SET);
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

test("a leftover `mcp` entry of pi-mcp-adapter keeps the tools of every MCP server off in that list, and a tool switched on by name is on", () => {
  for (const gateway of MCP_GATEWAY) {
    assert.equal(toolEnabled("mcp__jira__search", [], { off: [gateway], on: [] }), false, `${gateway} off in the list's own exceptions`);
    assert.equal(toolEnabled("mcp__jira__search", [gateway], none), false, `${gateway} off by the layers below`);
    assert.equal(toolEnabled("mcp__jira__search", [gateway], { off: [], on: [gateway] }), true, "the list switches the adapter's tool on again");
    assert.equal(toolEnabled("mcp__jira__search", [gateway], { off: [], on: ["mcp__jira__search"] }), true, "a tool on by name");
    assert.equal(toolEnabled("web_search", [gateway], none), true, "other tools are as they were");
  }
  // What pi is told for a project that had MCP off: the server's tools the portal knows are off.
  assert.deepEqual(effectiveOff(["mcp__jira__search", "web_search"], [], { off: ["mcp"], on: [] }), ["mcp", "mcp__jira__search"]);
  assert.deepEqual(defaultsFor(["mcp"], none), ["mcp"], "and the entry goes on to the chats of the project");
});

test("a leftover `mcp` entry holds pi's three tools for the resources of the servers off too, which reach every server", () => {
  for (const tool of ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]) {
    assert.equal(toolEnabled(tool, ["mcp"], none), false);
    assert.equal(toolEnabled(tool, ["mcp"], { off: [], on: [tool] }), true, "on by name");
    assert.equal(toolEnabled(tool, [], none), true, "as any tool without the entry");
  }
});

test("the portal-wide default has no `on` list: with a leftover `mcp` entry, the page is given the MCP tools as off, one by one, and switching one on takes the entry away", () => {
  const known = ["mcp__jira__search", "mcp__jira__create", "web_search"];
  // What the page shows: every MCP tool off, as it is in every new chat.
  const shown = defaultsAsShown(known, ["mcp"]);
  assert.deepEqual(shown, ["mcp", "mcp__jira__create", "mcp__jira__search"]);
  // One switched on: the page sends the rest of the list back.
  const stored = defaultsToStore(shown.filter((name) => name !== "mcp__jira__search"), ["mcp__jira__search", "mcp__jira__create"]);
  assert.deepEqual(stored, ["mcp__jira__create"]);
  assert.equal(toolEnabled("mcp__jira__search", stored, none), true);
  assert.equal(toolEnabled("mcp__jira__create", stored, none), false, "the others stay off");
  // Nothing switched on, or no MCP tool known yet: the entry stays, and keeps the unseen servers' tools off.
  assert.deepEqual(defaultsToStore(shown, ["mcp__jira__search", "mcp__jira__create"]), shown);
  assert.deepEqual(defaultsToStore(["mcp"], []), ["mcp"]);
  assert.deepEqual(defaultsToStore(["web_search"], ["mcp__jira__search"]), ["web_search"], "no entry, nothing to do");
});

test("a layer with an `on` list switches one MCP tool on under a leftover entry, and writes only that one", () => {
  const known = ["mcp__jira__search", "mcp__jira__create"];
  const wantedOff = defaultsAsShown(known, ["mcp"]).filter((name) => name !== "mcp__jira__search");
  assert.deepEqual(exceptionsFor(wantedOff, ["mcp"], known), { off: [], on: ["mcp__jira__search"] });
});
