import { test } from "node:test";
import assert from "node:assert/strict";
import { inProcessHome } from "../../../tests/helpers.mts";
import { piDependency } from "../../../core/server/src/pi/package.ts";
import { startKanban } from "./portal.mts";

/**
 * The agent's kanban tools, as the portal gives them to a chat's pi: what each does to the same boards the page shows,
 * what it answers, the chat it is put down to, what it cannot do, and how the portal lists them.
 */

inProcessHome("pithagoras-kanban-tools-");
const kanban = await startKanban();
kanban.chat("chat-a", "Fix the build");
kanban.chat("chat-b", "Plan the release");
const NAMES = ["kanban_boards", "kanban_board", "kanban_create_board", "kanban_add_column", "kanban_add_card", "kanban_update_card", "kanban_move_card", "kanban_archive_card"];

/** Calls a tool in a chat: what it said, and what it gave its card. */
async function call(chat: string, tool: string, params: Record<string, unknown>) {
  const result = await kanban.tools(chat)[tool].execute("call", params);
  return { text: result.content[0].text as string, details: result.details };
}
const board = async (id: string) => (await kanban.ask("GET", `/boards/${id}`)).body;

test("every chat has the eight tools, on by default, each and each of its parameters described, and Settings → Tools is told of them", async () => {
  const tools = kanban.tools("chat-a");
  assert.deepEqual(Object.keys(tools).sort(), [...NAMES].sort());
  for (const tool of Object.values(tools)) {
    assert.ok(tool.description.length > 30, tool.name);
    assert.ok(!tool.offByDefault, `${tool.name} is on by default`);
    for (const [name, schema] of Object.entries(tool.parameters.properties) as [string, any][]) assert.ok(schema.description?.length > 5, `${tool.name}.${name}`);
  }
  assert.deepEqual(kanban.offered().map((t) => t.name).sort(), [...NAMES].sort());
  // Nothing of them deletes.
  assert.ok(!NAMES.some((name) => /delete|remove/.test(name)));
});

test("their parameters are what pi checks a call against", async () => {
  const { validateToolArguments } = await piDependency("@earendil-works/pi-ai");
  const tools = kanban.tools("chat-a");
  const check = (name: string, args: Record<string, unknown>) => validateToolArguments(tools[name], { type: "toolCall", id: "1", name, arguments: args });
  assert.equal(check("kanban_move_card", { card: "c-2345", column: "Done", position: 1 }).position, 1);
  assert.throws(() => check("kanban_move_card", { card: "c-2345" }), /Validation failed/);
  assert.throws(() => check("kanban_add_card", { board: "b", title: "x", position: 0 }), /Validation failed/);
  assert.deepEqual(check("kanban_add_card", { board: "b", title: "x", labels: ["a", "b"] }).labels, ["a", "b"]);
  assert.equal(check("kanban_boards", {}) !== undefined, true);
});

test("an agent makes a board, fills it and moves its cards, and every step is in the cards' activity as its chat's", async () => {
  const made = await call("chat-a", "kanban_create_board", { name: "Build fixes", description: "What breaks the build.", columns: ["Found", "Fixing", "Fixed"] });
  const id = made.details.board.id;
  assert.match(made.text, new RegExp(`^Made board ${id} "Build fixes" with the columns Found \\(col-`));
  assert.deepEqual(made.details, { did: "created-board", board: { id, name: "Build fixes" } });

  const column = await call("chat-a", "kanban_add_column", { board: "build fixes", name: "Blocked", position: 2 });
  assert.match(column.text, /Its columns now: Found, Blocked, Fixing, Fixed\.$/);

  const first = await call("chat-a", "kanban_add_card", { board: id, title: "Flaky login test", labels: ["test", "flaky"], assignee: "agent", due: "2026-10-25", description: "Fails one run in five." });
  const card = first.details.card.id;
  assert.match(first.text, new RegExp(`^Added card ${card} "Flaky login test" to Found, position 1, on board ${id} "Build fixes"\\.$`));
  await call("chat-a", "kanban_add_card", { board: id, title: "Slow bundle", column: "found", position: 1 });

  const moved = await call("chat-a", "kanban_move_card", { card, column: "Fixing", note: "Found the race: the session expires early." });
  assert.equal(moved.text, `Moved card ${card} "Flaky login test" from Found to Fixing, position 1, on board ${id} "Build fixes".`);
  assert.deepEqual(moved.details, { did: "moved-card", board: { id, name: "Build fixes" }, card: { id: card, title: "Flaky login test", column: "Fixing" }, from: "Found", column: "Fixing" });

  const updated = await call("chat-a", "kanban_update_card", { card, labels: ["test"], note: "Patched; watching the next runs." });
  assert.match(updated.text, /changed labels, noted it\.$/);
  // Renamed since its pi loaded: the chat is put down as it is called now.
  kanban.rename("chat-a", "Fix the build, again");
  await call("chat-a", "kanban_move_card", { card, column: "Fixed", position: 1 });

  const now = await board(id);
  const c = now.cards.find((x: any) => x.id === card);
  const agent = (title: string) => ({ kind: "agent", chat: { id: "chat-a", title } });
  assert.deepEqual(
    c.activity.map((a: any) => [a.did, a.by, a.from ?? a.column ?? a.fields, a.note]),
    [
      ["created", agent("Fix the build"), "Found", undefined],
      ["moved", agent("Fix the build"), "Found", "Found the race: the session expires early."],
      ["edited", agent("Fix the build"), ["labels"], "Patched; watching the next runs."],
      ["moved", agent("Fix the build, again"), "Fixing", undefined],
    ],
  );
  assert.deepEqual(now.cards.filter((x: any) => x.column === now.columns[0].id).map((x: any) => x.title), ["Slow bundle"]);
});

test("kanban_board reads a board with its ids, filtered by column, label or assignee, archived cards only when asked", async () => {
  const { details } = await call("chat-b", "kanban_create_board", { name: "Release" });
  const id = details.board.id;
  const add = (p: Record<string, unknown>) => call("chat-b", "kanban_add_card", { board: id, ...p });
  const a = (await add({ title: "Write notes", labels: ["docs"], assignee: "Ada", due: "2020-01-01", description: "The changes since 0.1." })).details.card.id;
  const b = (await add({ title: "Tag the release", column: "In progress", assignee: "agent" })).details.card.id;
  const c = (await add({ title: "Old idea", labels: ["docs"] })).details.card.id;
  await call("chat-b", "kanban_update_card", { card: a, note: "Draft is in docs/notes.md" });
  await call("chat-b", "kanban_archive_card", { card: c, note: "Not doing this." });

  const all = (await call("chat-b", "kanban_board", { board: "Release" })).text;
  assert.match(all, new RegExp(`^Board ${id} "Release", version \\d+\\nColumns, left to right: To do \\(col-\\w+\\), In progress \\(col-\\w+\\), Done \\(col-\\w+\\)`));
  assert.ok(all.includes(`1. ${a} "Write notes" [docs], assignee: Ada, due 2020-01-01 (overdue)\n   The changes since 0.1.\n   Latest note, by the agent of chat "Plan the release": Draft is in docs/notes.md`), all);
  assert.ok(all.includes(`In progress (col-`) && all.includes(`1. ${b} "Tag the release" assignee: agent`), all);
  assert.match(all, /Done \(col-\w+\): no cards/);
  assert.ok(!all.includes("Old idea"));
  assert.match(all, /1 archived card is not shown \(archived: true shows them\)\.$/);

  const docs = (await call("chat-b", "kanban_board", { board: id, label: "DOCS", archived: true })).text;
  assert.ok(docs.includes('Only the cards with label "DOCS".'));
  assert.ok(docs.includes("Write notes") && !docs.includes("Tag the release"));
  assert.ok(docs.includes(`Archived: 1 card\n- ${c} "Old idea" [docs] (archived, from To do)`), docs);

  const ada = (await call("chat-b", "kanban_board", { board: id, assignee: "ada" })).text;
  assert.ok(ada.includes("Write notes") && !ada.includes("Tag the release"));
  const doing = (await call("chat-b", "kanban_board", { board: id, column: "in progress" })).text;
  assert.ok(doing.includes("Tag the release") && !doing.includes("\nTo do (col-"));

  const list = (await call("chat-b", "kanban_boards", {})).text;
  assert.match(list, new RegExp(`- ${id} "Release": To do 1, In progress 1, Done 0 \\(2 cards, 1 archived\\)`));
});

test("a card is archived and restored, and a call that changes nothing, or names what is not there, is refused with what is there", async () => {
  const { details } = await call("chat-b", "kanban_create_board", { name: "Archive" });
  const id = details.board.id;
  const card = (await call("chat-b", "kanban_add_card", { board: id, title: "Done with" })).details.card.id;
  const archived = await call("chat-b", "kanban_archive_card", { card });
  assert.match(archived.text, /kanban_update_card with archived false restores it\.$/);
  await assert.rejects(call("chat-b", "kanban_archive_card", { card }), /archived already/);
  await assert.rejects(call("chat-b", "kanban_move_card", { card, column: "Done" }), /restore it first/);
  const restored = await call("chat-b", "kanban_update_card", { card, archived: false });
  assert.match(restored.text, /restored it\.$/);
  assert.deepEqual(restored.details.fields, ["restored"]);
  await assert.rejects(call("chat-b", "kanban_update_card", { card }), /Nothing to change/);
  await assert.rejects(call("chat-b", "kanban_update_card", { card: "c-zzzz", title: "x" }), /no card "c-zzzz" on any board/);
  await assert.rejects(call("chat-b", "kanban_board", { board: "Nope" }), /There is no board "Nope"\. The boards: .*Archive \(b-/);
  await assert.rejects(call("chat-b", "kanban_add_card", { board: id, title: "x", column: "Later" }), /no column "Later"\. Its columns: To do \(col-/);
  await assert.rejects(call("chat-b", "kanban_create_board", { name: "archive" }), /There is a board called "Archive" already/);
  await assert.rejects(call("chat-b", "kanban_add_card", { board: id, title: "x", position: 0 }), /position is a whole number from 1/);
});

test("an agent cannot delete: no tool does, and its board, columns and cards stay whatever it sends", async () => {
  const { details } = await call("chat-b", "kanban_create_board", { name: "Kept safe" });
  const id = details.board.id;
  const card = (await call("chat-b", "kanban_add_card", { board: id, title: "Stays" })).details.card.id;
  const tools = kanban.tools("chat-b");
  assert.equal(Object.keys(tools).filter((n) => /delete|remove|drop/.test(n)).length, 0);
  // Nothing a call can carry takes something away: an empty title is refused, not a card gone.
  await assert.rejects(call("chat-b", "kanban_update_card", { card, title: "" }), /must not be empty/);
  await call("chat-b", "kanban_update_card", { card, archived: true });
  const now = await board(id);
  assert.equal(now.cards.length, 1);
  assert.equal(now.columns.length, 3);
});

test("the board a chat's agent worked on last is the one its panel opens on, each chat its own", async () => {
  const one = (await call("chat-a", "kanban_create_board", { name: "Chat A's" })).details.board.id;
  const two = (await call("chat-b", "kanban_create_board", { name: "Chat B's" })).details.board.id;
  assert.equal((await kanban.ask("GET", "/chats/chat-a/board")).body.board, one);
  assert.equal((await kanban.ask("GET", "/chats/chat-b/board")).body.board, two);
  await call("chat-a", "kanban_board", { board: two });
  assert.equal((await kanban.ask("GET", "/chats/chat-a/board")).body.board, two);
  // Listing the boards is not working on one.
  await call("chat-a", "kanban_boards", {});
  assert.equal((await kanban.ask("GET", "/chats/chat-a/board")).body.board, two);
});
