import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ELSEWHERE,
  HOME,
  folderFrom,
  groupByFolder,
  moveFolder,
  projectKey,
  readFolderOrder,
  readFolderSort,
  readOpenFolders,
  sortFolders,
  folderKeys,
  folderNameOf,
  hasMoreThanHome,
} from "../core/web/src/session-folders.ts";

const places = {
  home: "/data/agent",
  projects: [
    { name: "site", path: "/w/site" },
    { name: "notes", path: "/w/notes" },
    { name: "empty", path: "/w/empty" },
  ],
};

const chat = (id: string, workspace: string, updated_at: string) => ({ id, workspace, updated_at });

const chats = [
  chat("a", "/data/agent", "2026-09-28T10:00"),
  chat("b", "/w/site", "2026-09-28T12:00"),
  chat("c", "/w/site/docs", "2026-09-27T09:00"),
  chat("d", "/w/notes", "2026-09-28T11:00"),
  chat("e", "/w", "2026-09-20T08:00"),
];

const keys = (folders: { key: string }[]) => folders.map((f) => f.key);

test("chats go to Home, their project (a subfolder too) or Elsewhere", () => {
  const folders = groupByFolder(chats, places);
  assert.deepEqual(keys(folders), [HOME, projectKey("site"), projectKey("notes"), projectKey("empty"), ELSEWHERE]);
  const ids = Object.fromEntries(folders.map((f) => [f.key, f.sessions.map((s) => s.id)]));
  assert.deepEqual(ids, { [HOME]: ["a"], "project:site": ["b", "c"], "project:notes": ["d"], "project:empty": [], [ELSEWHERE]: ["e"] });
  assert.equal(folders[1].lastActive, "2026-09-28T12:00");
  assert.equal(folders[3].lastActive, "");
});

test("a folder named like the start of another is not it", () => {
  const folders = groupByFolder([chat("x", "/w/site-old", "1")], places);
  assert.deepEqual(folders.find((f) => f.key === ELSEWHERE)?.sessions.map((s) => s.id), ["x"]);
});

test("Elsewhere is only there with chats in it, Home and projects always", () => {
  assert.deepEqual(keys(groupByFolder([], places)), [HOME, "project:site", "project:notes", "project:empty"]);
});

test("without Home's place, nothing is taken for Home", () => {
  const folders = groupByFolder([chat("a", "/data/agent", "1")], { home: "", projects: [] });
  assert.deepEqual(folders.find((f) => f.key === ELSEWHERE)?.sessions.map((s) => s.id), ["a"]);
});

test("latest first: by their latest chat, empty ones by name, Elsewhere last", () => {
  const sorted = sortFolders(groupByFolder(chats, places), "recent");
  assert.deepEqual(keys(sorted), ["project:site", "project:notes", HOME, "project:empty", ELSEWHERE]);
});

test("by name: Home first, then the projects, Elsewhere last", () => {
  const sorted = sortFolders(groupByFolder(chats, places), "name");
  assert.deepEqual(keys(sorted), [HOME, "project:empty", "project:notes", "project:site", ELSEWHERE]);
});

test("your order: as put, with folders never put after, the latest first", () => {
  const sorted = sortFolders(groupByFolder(chats, places), "manual", ["project:notes", HOME]);
  assert.deepEqual(keys(sorted), ["project:notes", HOME, "project:site", "project:empty", ELSEWHERE]);
});

test("moving a folder keeps the order it was shown in, and the hidden ones where they were", () => {
  assert.deepEqual(moveFolder(["a", "b", "c"], "a", 1), ["b", "a", "c"]);
  assert.deepEqual(moveFolder(["a", "b", "c"], "c", 0), ["c", "a", "b"]);
  assert.deepEqual(moveFolder(["a", "b", "c"], "b", 9), ["a", "c", "b"]);
  // x is not shown, and keeps its place at the top; a is put ahead of what was never in the order.
  assert.deepEqual(moveFolder(["a", "b"], "b", 0, ["x", "a", "b"]), ["x", "b", "a"]);
  assert.deepEqual(moveFolder(["a", "b", "c"], "c", 0, ["x", "b"]), ["x", "c", "a", "b"]);
});

test("stored choices are read back as far as they are sound", () => {
  assert.deepEqual(readFolderOrder('["a", 3, "b", "a"]'), ["a", "b"]);
  assert.deepEqual(readFolderOrder("{}"), []);
  assert.deepEqual(readFolderOrder("nope"), []);
  assert.equal(readFolderSort("name"), "name");
  assert.equal(readFolderSort("sideways"), "recent");
  assert.equal(readFolderSort(null), "recent");
  assert.deepEqual(readOpenFolders('{"home": false, "x": 1, "project:a": true}'), { home: false, "project:a": true });
  assert.deepEqual(readOpenFolders("[]"), {});
});

test("a link's folder is found by its key", () => {
  const folders = groupByFolder(chats, places);
  assert.equal(folderFrom(folders, "project:notes")?.name, "notes");
  assert.equal(folderFrom(folders, "project:gone"), null);
  assert.equal(folderFrom(folders, null), null);
});

test("Home and the workspace root inside each other: each chat in the deepest", () => {
  // Home holds the root.
  const inHome = groupByFolder([chat("a", "/u/repos/site", "1"), chat("b", "/u", "1")], { home: "/u", projects: [{ name: "site", path: "/u/repos/site" }] });
  assert.deepEqual(inHome.map((f) => [f.key, f.sessions.map((s) => s.id)]), [[HOME, ["b"]], ["project:site", ["a"]]]);
  // The root holds Home, which is listed as a project there: it is Home, not a folder of its own.
  const places = { home: "/w/agent-home", projects: [{ name: "agent-home", path: "/w/agent-home" }, { name: "site", path: "/w/site" }] };
  const inRoot = groupByFolder([chat("a", "/w/agent-home", "1")], places);
  assert.deepEqual(inRoot.map((f) => [f.key, f.sessions.map((s) => s.id)]), [[HOME, ["a"]], ["project:site", []]]);
  assert.deepEqual(folderKeys(places), [HOME, "project:site", ELSEWHERE]);
});

test("Elsewhere can be asked for when empty", () => {
  assert.deepEqual(keys(groupByFolder([], places, { elsewhere: true })).at(-1), ELSEWHERE);
});

test("each agent's home is a folder named after it, the first one keeping Home's key", () => {
  const withAgents = {
    ...places,
    agents: [
      { id: "home", name: "Nova", home: "/data/agent" },
      { id: "scout", name: "Scout", home: "/data/agents/scout" },
    ],
  };
  const folders = groupByFolder([...chats, chat("s", "/data/agents/scout", "2026-09-28T13:00")], withAgents);
  assert.deepEqual(keys(folders).slice(0, 2), [HOME, "agent:scout"]);
  assert.deepEqual(folders.slice(0, 2).map((f) => [f.name, f.agent, f.sessions.map((s) => s.id)]), [
    ["Nova", "home", ["a"]],
    ["Scout", "scout", ["s"]],
  ]);
  assert.ok(folderKeys(withAgents).includes("agent:scout"));
  // Without the server saying which agent New starts chats with, no folder claims it.
  assert.deepEqual(folders.slice(0, 2).map((f) => f.newChats), [undefined, undefined]);
  // By name the first agent comes first, then the others, then the projects.
  assert.deepEqual(keys(sortFolders(folders, "name")).slice(0, 3), [HOME, "agent:scout", projectKey("empty")]);
});

test("a chat's folder is named, not its path; nothing until the places are known", () => {
  const nameOf = folderNameOf(chats, places);
  assert.deepEqual(chats.map((s) => nameOf(s)), ["Home", "site", "site", "notes", "Elsewhere"]);
  assert.equal(folderNameOf(chats, null)(chats[0]), "");
});

test("the folder of the agent that New starts chats with carries the flag, the others do not", () => {
  const agents = [
    { id: "home", name: "Nova", home: "/data/agent", newChats: false },
    { id: "scout", name: "Scout", home: "/data/agents/scout", newChats: true },
  ];
  const folders = groupByFolder([], { ...places, agents });
  assert.deepEqual(folders.slice(0, 2).map((f) => [f.key, f.newChats]), [
    [HOME, false],
    ["agent:scout", true],
  ]);
});

test("a project says which agent it works with, by name; a blank slate or an agent the server did not name says nothing", () => {
  const agents = [
    { id: "home", name: "Nova", home: "/data/agent" },
    { id: "scout", name: "Scout", home: "/data/agents/scout" },
  ];
  const linked = {
    home: "/data/agent",
    agents,
    projects: [
      { name: "site", path: "/w/site", agent: "scout" },
      { name: "notes", path: "/w/notes" },
      { name: "gone", path: "/w/gone", agent: "deleted" },
    ],
  };
  const folders = groupByFolder([], linked);
  assert.deepEqual(folders.filter((f) => f.kind === "project").map((f) => [f.name, f.with]), [
    ["site", "Scout"],
    ["notes", undefined],
    ["gone", undefined],
  ]);
  // The agents' homes are not projects, and say nothing of a link.
  assert.ok(folders.filter((f) => f.kind === "home").every((f) => f.with === undefined));
  // A server that names no agent has nothing to say a project is with.
  assert.equal(groupByFolder([], { home: "/data/agent", projects: [{ name: "site", path: "/w/site", agent: "home" }] })[1].with, undefined);
});

test("chats are gathered by folder when there is a project or a second agent, not for one agent alone", () => {
  const agent = (id: string) => ({ id, name: id, home: `/data/agents/${id}` });
  const bare = { home: "/data/agent", projects: [] };
  assert.equal(hasMoreThanHome(bare), false);
  assert.equal(hasMoreThanHome({ ...bare, agents: [agent("home")] }), false);
  assert.equal(hasMoreThanHome({ ...bare, agents: [agent("home"), agent("scout")] }), true);
  assert.equal(hasMoreThanHome({ ...bare, agents: [agent("home")], projects: [{ name: "site", path: "/w/site" }] }), true);
});
