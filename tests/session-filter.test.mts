import { test } from "node:test";
import assert from "node:assert/strict";
import { filterSessions, olderThan } from "../core/web/src/session-filter.ts";

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

const DAY = 86_400_000;
const now = Date.parse("2026-03-01T12:00:00Z");
const ago = (days: number) => new Date(now - days * DAY).toISOString();

test("older than: only chats untouched for that many days, never a pinned or busy one", () => {
  const chats = [
    { id: "new", pinned: false, updated_at: ago(2) },
    { id: "old", pinned: false, updated_at: ago(40) },
    { id: "old-pinned", pinned: true, updated_at: ago(40) },
    { id: "old-busy", pinned: false, updated_at: ago(40) },
    { id: "edge", pinned: false, updated_at: ago(30) },
    { id: "older", pinned: false, updated_at: ago(31) },
  ];
  const picked = olderThan(chats, 30, (s) => s.id === "old-busy", now).map((s) => s.id);
  assert.deepEqual(picked, ["old", "older"]);
});

test("older than: reads the server's timestamps, which carry no zone", () => {
  const chats = [{ id: "a", pinned: false, updated_at: "2026-01-01 00:00:00" }];
  assert.equal(olderThan(chats, 30, () => false, now).length, 1);
  assert.equal(olderThan(chats, 90, () => false, now).length, 0);
});
