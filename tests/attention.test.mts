import { test } from "node:test";
import assert from "node:assert/strict";
import { finishedRuns, tabTitle } from "../core/web/src/attention.ts";

test("the tab says what the chat is doing", () => {
  assert.equal(tabTitle(null, false), "Pithagoras");
  assert.equal(tabTitle({ title: "Fix login", status: "idle" }, false), "Fix login · Pithagoras");
  assert.equal(tabTitle({ title: "Fix login", status: "running" }, false), "● Fix login · working");
});

test("being asked something outranks working", () => {
  assert.equal(tabTitle({ title: "Fix login", status: "running" }, true), "❓ Fix login · asks you");
});

test("a chat without a name still has one in the tab", () => {
  assert.equal(tabTitle({ title: "  ", status: "idle" }, false), "New chat · Pithagoras");
});

test("a run that ended is reported, one that is still going is not", () => {
  const before = new Map([
    ["a", "running"],
    ["b", "running"],
    ["c", "idle"],
  ] as const);
  const now = [
    { id: "a", status: "idle" as const },
    { id: "b", status: "running" as const },
    { id: "c", status: "idle" as const },
  ];
  assert.deepEqual(
    finishedRuns(before, now).map((s) => s.id),
    ["a"],
  );
});

test("a run that failed is reported too", () => {
  const before = new Map([["a", "running"]] as const);
  assert.equal(finishedRuns(before, [{ id: "a", status: "error" as const }]).length, 1);
});

test("what was not seen before, or was cut off by a restart, is not news", () => {
  const before = new Map([["a", "running"]] as const);
  assert.deepEqual(finishedRuns(before, [{ id: "a", status: "interrupted" as const }]), []);
  assert.deepEqual(finishedRuns(new Map(), [{ id: "new", status: "idle" as const }]), []);
});

test("a sub-chat's run ending is not told on its own", () => {
  const before = new Map([["a", "running"], ["sub", "running"]] as const);
  const now = [{ id: "a", status: "running" as const }, { id: "sub", status: "idle" as const, parent: "a" }];
  assert.deepEqual(finishedRuns(before, now), []);
});

test("a sub-chat whose chat is not in the list is shown as a chat, so its run ending is told", () => {
  const before = new Map([["orphan", "running"]] as const);
  const now = [{ id: "orphan", status: "idle" as const, parent: "a channel chat" }];
  assert.deepEqual(finishedRuns(before, now).map((s) => s.id), ["orphan"]);
});
