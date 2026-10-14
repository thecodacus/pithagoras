import { test } from "node:test";
import assert from "node:assert/strict";
import {
  displayName,
  groupSummary,
  groupTools,
  nextOff,
  toggleOpen,
  toolTitle,
} from "../core/web/src/tool-groups.ts";

const tool = (name: string, source: string, enabled = true) => ({
  name,
  source,
  enabled,
  description: undefined,
});

test("tools are grouped by what they came from", () => {
  const groups = groupTools([
    tool("web_search", "pi-web-access"),
    tool("bash", "built in"),
    tool("web_fetch", "pi-web-access"),
  ]);
  assert.deepEqual(groups.map((g) => [g.source, g.tools.length]), [
    ["pi-web-access", 2],
    ["built in", 1],
  ]);
});

test("what was installed comes before what was always there", () => {
  const groups = groupTools([tool("bash", "built in"), tool("todo", "rpiv-todo")]);
  assert.deepEqual(groups.map((g) => g.source), ["rpiv-todo", "built in"]);
});

test("a group knows whether all of it is on, off, or neither", () => {
  const [group] = groupTools([
    tool("a", "pkg", true),
    tool("b", "pkg", false),
  ]);
  assert.equal(group.allOn, false);
  assert.equal(group.allOff, false);
  assert.equal(groupTools([tool("a", "pkg", true)])[0].allOn, true);
  assert.equal(groupTools([tool("a", "pkg", false)])[0].allOff, true);
});

test("a tool with no source of its own is not its own group", () => {
  const groups = groupTools([tool("a", ""), tool("b", "  ")]);
  assert.deepEqual(groups.map((g) => g.source), ["built in"]);
  assert.equal(groups[0].tools.length, 2);
});

test("tools within a group read in order", () => {
  const [group] = groupTools([tool("zed", "pkg"), tool("alpha", "pkg")]);
  assert.deepEqual(group.tools.map((t) => t.name), ["alpha", "zed"]);
});

test("switching one off adds it to what is written down", () => {
  assert.deepEqual(nextOff([], ["web_search"], false), ["web_search"]);
});

test("switching it back on takes it out again", () => {
  assert.deepEqual(nextOff(["web_search", "todo"], ["web_search"], true), ["todo"]);
});

test("a whole group goes at once", () => {
  assert.deepEqual(nextOff([], ["web_search", "web_fetch"], false), ["web_fetch", "web_search"]);
  assert.deepEqual(nextOff(["web_search", "web_fetch"], ["web_search", "web_fetch"], true), []);
});

test("switching off what is already off changes nothing", () => {
  assert.deepEqual(nextOff(["a"], ["a"], false), ["a"]);
});

/**
 * An extension that is not loaded right now still has its switches remembered,
 * or reinstalling it would quietly bring back tools somebody turned off.
 */
test("a name the session has never heard of is kept", () => {
  assert.deepEqual(nextOff(["gone_tool"], ["web_search"], false), ["gone_tool", "web_search"]);
});

test("a group shut says whether anything in it is off", () => {
  const [group] = groupTools([tool("a", "ext"), tool("b", "ext")]);
  assert.equal(groupSummary(group), "2 on");
});

test("a group with something switched off says how much", () => {
  const [group] = groupTools([tool("a", "ext"), tool("b", "ext", false)]);
  assert.equal(groupSummary(group), "1 of 2 off");
});

test("a group switched off entirely says so without counting", () => {
  const [group] = groupTools([tool("a", "ext", false), tool("b", "ext", false)]);
  assert.equal(groupSummary(group), "2 off");
});

test("opening a group and shutting it again", () => {
  assert.deepEqual(toggleOpen([], "pi-web-access"), ["pi-web-access"]);
  assert.deepEqual(toggleOpen(["pi-lens", "pi-web-access"], "pi-lens"), ["pi-web-access"]);
});

test("the browser is a group like any other", () => {
  const [group] = groupTools([
    tool("browser_browser_click", "browser"),
    tool("browser_browser_navigate", "browser", false),
  ]);
  assert.equal(group.source, "browser");
  assert.equal(groupSummary(group), "1 of 2 off");
});

test("a package with a scope is headed by the part people say out loud", () => {
  assert.equal(displayName("@juicesharp/rpiv-ask-user-question"), "rpiv-ask-user-question");
  assert.equal(displayName("@forecastx/deep-research"), "deep-research");
  assert.equal(displayName("pi-web-access"), "pi-web-access");
  assert.equal(displayName("built in"), "built in");
});

test("a name that was given wins over the one derived", () => {
  const names = { "@forecastx/deep-research": "Deep Research", browser: "Browser" };
  assert.equal(displayName("@forecastx/deep-research", names), "Deep Research");
  assert.equal(displayName("browser", names), "Browser");
  assert.equal(displayName("pi-lens", names), "pi-lens");
});

test("a name of nothing but spaces is not a name", () => {
  assert.equal(displayName("@a/b", { "@a/b": "   " }), "b");
});

test("the portal's code mode is a group of its own called Code mode, after what is installed and before what is built in", () => {
  const groups = groupTools([
    { ...tool("codemode", "codemode", false), inline: true as const, description: "Raw JavaScript, at length" },
    tool("bash", "built in"),
    tool("web_search", "pi-web-access"),
  ]);
  assert.deepEqual(groups.map((g) => displayName(g.source)), ["pi-web-access", "Code mode", "built in"]);
  assert.equal(groupSummary(groups[1]), "1 off");
  // What a person is told about it, not the model's instructions for writing a script.
  assert.match(toolTitle(groups[1].tools[0]) ?? "", /^Lets the model write a script that calls the other tools/);
});

test("an extension's tool called codemode stays with its extension", () => {
  const [group] = groupTools([{ ...tool("codemode", "my-codemode"), description: "Mine" }]);
  assert.equal(displayName(group.source), "my-codemode");
  assert.equal(toolTitle(group.tools[0]), "Mine");
});
