import { test } from "node:test";
import assert from "node:assert/strict";
import { isFiltered, isSwitchedOff, npmName, packageKey, packageLabel, setPackageEnabled, sourceOf, toolAvailability } from "../dist/extension-switch.js";

const toolAvailable = (tool, packages) => toolAvailability(packages)(tool);
const OFF = (source) => ({ source, extensions: [], skills: [], prompts: [], themes: [] });

test("a package is named by its source, in either form", () => {
  assert.equal(sourceOf("npm:pi-lens"), "npm:pi-lens");
  assert.equal(sourceOf({ source: "npm:pi-lens", skills: [] }), "npm:pi-lens");
  assert.equal(sourceOf({ skills: [] }), undefined);
  assert.equal(sourceOf(42), undefined);
});

test("only a package with every kind emptied is off", () => {
  assert.equal(isSwitchedOff("npm:a"), false);
  assert.equal(isSwitchedOff(OFF("npm:a")), true);
  assert.equal(isSwitchedOff({ source: "npm:a", extensions: [] }), false, "skills and the rest are still loaded");
  assert.equal(isSwitchedOff({ source: "npm:a", extensions: ["x.ts"], skills: [], prompts: [], themes: [] }), false);
  assert.equal(isSwitchedOff({ ...OFF("npm:a"), autoload: false }), false, "a delta over another scope is not off");
});

test("a hand-written filter is filtered, a plain entry and an off one are not", () => {
  assert.equal(isFiltered("npm:a"), false);
  assert.equal(isFiltered(OFF("npm:a")), false);
  assert.equal(isFiltered({ source: "npm:a", extensions: ["!legacy.ts"] }), true);
});

test("switching a plain package off empties what it brings, and on writes it plain again", () => {
  const off = setPackageEnabled(["npm:a", "npm:b"], "npm:a", false, {});
  assert.deepEqual(off.packages, [OFF("npm:a"), "npm:b"]);
  assert.deepEqual(off.stash, {}, "a plain entry has nothing worth keeping");

  const on = setPackageEnabled(off.packages, "npm:a", true, off.stash);
  assert.deepEqual(on.packages, ["npm:a", "npm:b"]);
});

test("a hand-written filter survives being switched off and on", () => {
  const filtered = { source: "npm:a", extensions: ["extensions/*.ts", "!extensions/legacy.ts"] };
  const off = setPackageEnabled([filtered], "npm:a", false, {});
  assert.deepEqual(off.packages, [OFF("npm:a")]);
  assert.deepEqual(off.stash, { "npm:a": filtered });

  const on = setPackageEnabled(off.packages, "npm:a", true, off.stash);
  assert.deepEqual(on.packages, [filtered]);
  assert.deepEqual(on.stash, {}, "given back, so not kept twice");
});

test("saying what is already so changes nothing", () => {
  const packages = ["npm:a", OFF("npm:b")];
  const stash = { keep: 1 };
  assert.deepEqual(setPackageEnabled(packages, "npm:a", true, stash), { packages, stash });
  assert.deepEqual(setPackageEnabled(packages, "npm:b", false, stash), { packages, stash });
});

test("the stash is not overwritten by switching off twice", () => {
  const filtered = { source: "npm:a", skills: ["a"] };
  const first = setPackageEnabled([filtered], "npm:a", false, {});
  const again = setPackageEnabled(first.packages, "npm:a", false, first.stash);
  assert.deepEqual(again.stash, { "npm:a": filtered });
});

test("a package that is not listed is reported, not invented", () => {
  assert.equal(setPackageEnabled(["npm:a"], "npm:zzz", false, {}), null);
});

test("the input is left as it was", () => {
  const packages = ["npm:a"];
  const stash = {};
  setPackageEnabled(packages, "npm:a", false, stash);
  assert.deepEqual(packages, ["npm:a"]);
  assert.deepEqual(stash, {});
});

test("other entries keep their place and their filters", () => {
  const other = { source: "npm:c", prompts: ["p.md"] };
  const out = setPackageEnabled(["npm:a", other, "npm:b"], "npm:b", false, {});
  assert.equal(out.packages[1], other);
  assert.deepEqual(out.packages[2], OFF("npm:b"));
});

test("a filter put aside earlier is not brought back over a plain entry written since", () => {
  const filtered = { source: "npm:a", extensions: ["!legacy.ts"] };
  const stash = setPackageEnabled([filtered], "npm:a", false, {}).stash;
  // settings.json edited by hand back to the plain entry, then switched off and on.
  const off = setPackageEnabled(["npm:a"], "npm:a", false, stash);
  assert.deepEqual(off.stash, {});
  const on = setPackageEnabled(off.packages, "npm:a", true, off.stash);
  assert.deepEqual(on.packages, ["npm:a"]);
});

test("an npm package is named without its prefix and its version", () => {
  assert.equal(npmName("npm:pi-lens"), "pi-lens");
  assert.equal(npmName("npm:pi-lens@1.2.0"), "pi-lens");
  assert.equal(npmName("npm:@juicesharp/rpiv-todo"), "@juicesharp/rpiv-todo");
  assert.equal(npmName("npm:@juicesharp/rpiv-todo@0.4.1"), "@juicesharp/rpiv-todo");
  assert.equal(npmName("git:github.com/user/repo"), undefined);
  assert.equal(npmName("../local/folder"), undefined);
});

test("a tool stays while its package is listed and on", () => {
  const tool = { source: "@juicesharp/rpiv-todo", package: "npm:@juicesharp/rpiv-todo" };
  assert.equal(toolAvailable(tool, ["npm:@juicesharp/rpiv-todo"]), true);
  assert.equal(toolAvailable(tool, [{ source: "npm:@juicesharp/rpiv-todo", extensions: ["x.ts"] }]), true);
});

test("a tool goes when its package is switched off or not listed any more", () => {
  const tool = { source: "@juicesharp/rpiv-todo", package: "npm:@juicesharp/rpiv-todo" };
  assert.equal(toolAvailable(tool, [OFF("npm:@juicesharp/rpiv-todo")]), false);
  assert.equal(toolAvailable(tool, ["npm:other"]), false);
  assert.equal(toolAvailable(tool, []), false);
});

test("a tool with no package behind it is always there", () => {
  // A folder of the user's own, a project's extension, pi itself: not listed in the user's packages.
  assert.equal(toolAvailable({ source: "built in", package: null }, []), true);
  assert.equal(toolAvailable({ source: "todo", package: null }, ["npm:other"]), true);
  // Recorded as no package's, so not taken for the user's package of the same name.
  assert.equal(toolAvailable({ source: "pi-lens", package: null }, [OFF("npm:pi-lens")]), true);
});

test("a package is the same package at another version or ref", () => {
  assert.equal(packageKey("npm:pi-lens@1.2.0"), packageKey("npm:pi-lens"));
  assert.equal(packageKey("npm:@juicesharp/rpiv-todo@0.5.0"), "npm:@juicesharp/rpiv-todo");
  assert.equal(packageKey("git:github.com/user/repo@v1"), "git:github.com/user/repo");
  assert.equal(packageKey("https://github.com/user/repo.git#main"), "git:github.com/user/repo");
  assert.equal(packageKey("git:git@github.com:user/repo@v2"), "git:github.com/user/repo");
  assert.equal(packageKey("/opt/ext"), "local:/opt/ext");
  assert.notEqual(packageKey("npm:pi-lens"), packageKey("npm:pi-lens-extra"));

  // pi install rewrote the entry for a new version: the tool recorded under the old one is still its.
  const tool = { source: "@juicesharp/rpiv-todo", package: "npm:@juicesharp/rpiv-todo@0.4.1" };
  assert.equal(toolAvailable(tool, ["npm:@juicesharp/rpiv-todo@0.5.0"]), true);
  assert.equal(toolAvailable(tool, [OFF("npm:@juicesharp/rpiv-todo@0.5.0")]), false);
});

test("a package that loads no extensions has no tools, whatever else it keeps", () => {
  const tool = { source: "pi-foo", package: "npm:pi-foo" };
  assert.equal(toolAvailable(tool, [{ source: "npm:pi-foo", extensions: [] }]), false);
  assert.equal(toolAvailable({ source: "pi-foo" }, [{ source: "npm:pi-foo", extensions: [], skills: ["s"] }]), false);
  assert.equal(toolAvailable(tool, [{ source: "npm:pi-foo", skills: [] }]), true);
});

test("a tool remembered before packages were recorded is found by its name when its package is off", () => {
  const old = { source: "@juicesharp/rpiv-todo" };
  assert.equal(toolAvailable(old, [OFF("npm:@juicesharp/rpiv-todo@0.4.1")]), false);
  assert.equal(toolAvailable(old, ["npm:@juicesharp/rpiv-todo"]), true);
  // Not listed: nothing says it was a package, so it is left alone.
  assert.equal(toolAvailable(old, []), true);
});

test("with autoload off, a package loads only the extensions it names", () => {
  const tool = { source: "pi-foo", package: "npm:pi-foo" };
  assert.equal(toolAvailable(tool, [{ source: "npm:pi-foo", autoload: false, skills: ["s"] }]), false);
  assert.equal(toolAvailable(tool, [{ source: "npm:pi-foo", autoload: false, extensions: ["x.ts"] }]), true);
});

test("a project that lists the package and loads it has its tools, whatever the user's entry says", () => {
  const tool = { source: "pi-foo", package: "npm:pi-foo" };
  assert.equal(toolAvailability([OFF("npm:pi-foo")], ["npm:pi-foo@2.0.0"])(tool), true);
  assert.equal(toolAvailability([OFF("npm:pi-foo")], [OFF("npm:pi-foo")])(tool), false);
  assert.equal(toolAvailability([OFF("npm:pi-foo")], ["npm:pi-foo"])({ source: "pi-foo" }), true);
});

test("a package is labelled as its tools were filed before it was recorded", () => {
  assert.equal(packageLabel("npm:@juicesharp/rpiv-todo@0.4.1"), "@juicesharp/rpiv-todo");
  assert.equal(packageLabel("/opt/pithagoras/extensions/subagent/"), "subagent");
  assert.equal(packageLabel("../../extensions/subagent"), "subagent");
  assert.equal(packageLabel("git:github.com/user/repo@v1"), "repo");
  assert.equal(packageLabel("https://github.com/user/repo.git#main"), "repo");
  assert.equal(packageLabel("git:git@github.com:user/repo"), "repo");
});

test("nothing is hidden when the packages could not be read", () => {
  const tool = { source: "x", package: "npm:x" };
  assert.equal(toolAvailable(tool, undefined), true);
  assert.equal(toolAvailable(tool, "garbage"), true);
});
