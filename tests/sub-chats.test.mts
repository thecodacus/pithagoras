import { test } from "node:test";
import assert from "node:assert/strict";
import { familiesFound, familyRunning, searchFolderOf, shownStatus, splitSubChats, topOf } from "../core/web/src/sub-chats.ts";
import { groupByFolder } from "../core/web/src/session-folders.ts";
import { filterSessions } from "../core/web/src/session-filter.ts";

type Chat = { id: string; title: string; workspace: string; updated_at: string; status: "idle" | "running" | "error" | "interrupted"; parent?: string; asking?: boolean; pinned?: boolean };
const chat = (id: string, extra: Partial<Chat> = {}): Chat => ({ id, title: id, workspace: "/w/site", updated_at: "2026-10-01", status: "idle", ...extra });

const list = [
  chat("build", { title: "Build the site" }),
  chat("links", { title: "Check the links", parent: "build", updated_at: "2026-10-09" }),
  chat("logo", { title: "Fix the logo", workspace: "/w/notes" }),
  chat("images", { title: "Shrink the images", parent: "build", status: "running" }),
];
const ids = (chats: readonly { id: string }[]) => chats.map((c) => c.id);

test("sub-chats are listed under their chat, in the order given, and not on their own", () => {
  const { top, under } = splitSubChats(list);
  assert.deepEqual(ids(top), ["build", "logo"]);
  assert.deepEqual(ids(under.get("build")!), ["links", "images"]);
  assert.equal(under.get("logo"), undefined);
});

test("a sub-chat whose chat is not in the list is listed on its own rather than lost", () => {
  const { top, under } = splitSubChats([chat("orphan", { parent: "a channel chat" }), chat("other")]);
  assert.deepEqual(ids(top), ["orphan", "other"]);
  assert.equal(under.size, 0);
});

test("a folder counts and dates its chats without their sub-chats", () => {
  const places = { home: "/data/agent", projects: [{ name: "site", path: "/w/site" }] };
  const site = groupByFolder(splitSubChats(list).top, places).find((f) => f.key === "project:site")!;
  assert.deepEqual(ids(site.sessions), ["build"], "the sub-chats are under it, not beside it");
  assert.equal(site.lastActive, "2026-10-01", "a sub-chat's later change is not its folder's");
});

test("a search that finds a sub-chat keeps its chat, with only the sub-chats found under it", () => {
  const all = splitSubChats(list);
  const found = familiesFound(all, filterSessions(list, "links"));
  assert.deepEqual(ids(found.top), ["build"]);
  assert.deepEqual(ids(found.under.get("build")!), ["links"]);
});

test("a search that finds only the chat keeps all of its sub-chats under it", () => {
  const found = familiesFound(splitSubChats(list), filterSessions(list, "build"));
  assert.deepEqual(ids(found.top), ["build"]);
  assert.deepEqual(ids(found.under.get("build")!), ["links", "images"]);
});

test("a search that finds neither a chat nor its sub-chats leaves both out", () => {
  const found = familiesFound(splitSubChats(list), filterSessions(list, "logo"));
  assert.deepEqual(ids(found.top), ["logo"]);
  assert.equal(found.under.size, 0);
});

test("a chat shows as running while a sub-chat runs, and as waiting for you while one asks", () => {
  assert.equal(shownStatus(chat("a")), "idle");
  assert.equal(shownStatus(chat("a", { status: "error" }), [chat("b")]), "error");
  assert.equal(shownStatus(chat("a"), [chat("b"), chat("c", { status: "running" })]), "running");
  assert.equal(shownStatus(chat("a", { status: "running" }), [chat("b", { asking: true })]), "asking", "a person is needed before anything else");
  assert.equal(shownStatus(chat("b", { status: "running", asking: true })), "asking", "a sub-chat's own row says so too");
});

test("a chat runs for a folder and a count while it or a sub-chat works, whatever its mark shows", () => {
  assert.equal(familyRunning(chat("a")), false);
  assert.equal(familyRunning(chat("a"), [chat("b", { status: "running" })]), true);
  // Its mark says it waits for you; it still runs.
  assert.equal(familyRunning(chat("a", { status: "running" }), [chat("b", { asking: true })]), true);
});

test("the chat that holds a sub-chat is found by either id", () => {
  const all = splitSubChats(list);
  assert.equal(topOf(all, "images")?.id, "build");
  assert.equal(topOf(all, "build")?.id, "build");
  assert.equal(topOf(all, "gone"), undefined);
  assert.equal(topOf(all, null), undefined);
});

test("a search by folder does not find a pinned chat through its sub-chats", () => {
  const chats = [
    chat("notes", { title: "Notes", pinned: true }),
    chat("draft", { title: "Draft", parent: "notes" }),
    chat("plan", { title: "Plan" }),
  ];
  const folderOf = searchFolderOf(chats, () => "Billing");
  assert.deepEqual(ids(familiesFound(splitSubChats(chats), filterSessions(chats, "billing", folderOf)).top), ["plan"]);
  assert.deepEqual(ids(familiesFound(splitSubChats(chats), filterSessions(chats, "draft", folderOf)).top), ["notes"], "its title still finds it");
});
