import { test } from "node:test";
import assert from "node:assert/strict";
import { filterSessions } from "../core/web/src/session-filter.ts";

const list = [
  { title: "Fix login", workspace: "/home/me/webapp" },
  { title: "Write report", workspace: "/home/me/docs" },
  { title: "Refactor", workspace: "/srv/Webapp" },
];
const folders: Record<string, string> = { "Fix login": "webapp", "Write report": "docs", Refactor: "Elsewhere" };
const folderOf = (s: { title: string }) => folders[s.title] ?? "";

test("nothing typed is everything", () => {
  assert.equal(filterSessions(list, "").length, 3);
  assert.equal(filterSessions(list, "   ").length, 3);
  assert.equal(filterSessions(list, "", folderOf).length, 3);
});

test("matches the name, in any case", () => {
  assert.deepEqual(filterSessions(list, "LOGIN").map((s) => s.title), ["Fix login"]);
});

test("matches the folder's name when it is given, in any case", () => {
  assert.deepEqual(filterSessions(list, "WEBAPP", folderOf).map((s) => s.title), ["Fix login"]);
  assert.deepEqual(filterSessions(list, "elsewhere", folderOf).map((s) => s.title), ["Refactor"]);
});

test("never matches the path the chat works in", () => {
  // Nothing of it is shown, so a chat must not be found by it: not by the root it is under, nor by the last part
  // where no folder name was given.
  assert.deepEqual(filterSessions(list, "webapp"), []);
  assert.deepEqual(filterSessions(list, "home/me"), []);
  assert.deepEqual(filterSessions(list, "srv", folderOf), []);
  assert.deepEqual(filterSessions(list, "home", folderOf), []);
});

test("a word is not glued to the next field", () => {
  // "login webapp" would match if the name and the folder were joined without a gap; "loginwebapp" must not.
  assert.equal(filterSessions(list, "loginwebapp", folderOf).length, 0);
});

test("nothing matching is nothing", () => {
  assert.deepEqual(filterSessions(list, "zzz"), []);
});
