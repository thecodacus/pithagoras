import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { scratch } from "../../../tests/helpers.mts";
import { KanbanStore } from "../src/server/store.ts";
import { addCard, addColumn, archiveCard, columnId, deleteCard, editCard, moveCard, moveColumn, noteCard, removeColumn, renameColumn, restoreCard } from "../src/server/board.ts";
import { isId } from "../src/server/ids.ts";
import { ACTIVITY_KEPT } from "../src/server/validate.ts";
import type { Actor, Board } from "../src/types.ts";

/**
 * The boards as the server half keeps them: a JSON file for each board and an index, in a folder of its own, written
 * whole, one write at a time. What one store wrote, another opened on the same folder reads.
 */

const PERSON: Actor = { kind: "person" };
const AGENT: Actor = { kind: "agent", chat: { id: "chat-1", title: "Fix the build" } };
const open = (dir = scratch("kanban-store-")) => ({ dir, store: KanbanStore.open(dir) });
const titles = (board: Board, column: string) => board.cards.filter((c) => c.column === column && !c.archived).map((c) => c.title);
/** Adds cards to the first column, one write each. */
async function withCards(store: KanbanStore, id: string, ...names: string[]) {
  let board = store.board(id);
  for (const title of names) board = (await store.edit(id, (b, now) => addCard(b, { title }, store.cardId(), PERSON, now))).board;
  return board;
}

test("a board is made with the default columns, short ids an agent can type, and version 1; its file and the index are on disk", async () => {
  const { dir, store } = open();
  const board = await store.createBoard({ name: "  Release   0.2 ", description: "What ships." });
  assert.equal(board.name, "Release 0.2");
  assert.equal(board.version, 1);
  assert.ok(isId("board", board.id), board.id);
  assert.match(board.id, /^b-[2-9a-hj-km-np-z]{4}$/);
  assert.deepEqual(board.columns.map((c) => c.name), ["To do", "In progress", "Done"]);
  assert.ok(board.columns.every((c) => /^col-[2-9a-hj-km-np-z]{4}$/.test(c.id)));
  assert.equal(new Set(board.columns.map((c) => c.id)).size, 3);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "boards", `${board.id}.json`), "utf8")), board);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "index.json"), "utf8")).boards, [board.id]);
  // Named columns, in their order.
  const other = await store.createBoard({ name: "Homelab", columns: ["Ideas", "Doing"] });
  assert.deepEqual(other.columns.map((c) => c.name), ["Ideas", "Doing"]);
  assert.deepEqual(store.list().boards.map((b) => b.name), ["Release 0.2", "Homelab"]);
});

test("names are checked: none empty, no two boards alike, no two columns of a board alike, whatever the capitals", async () => {
  const { store } = open();
  await assert.rejects(store.createBoard({ name: "   " }), { code: "invalid", message: /must not be empty/ });
  await assert.rejects(store.createBoard({ name: 3 }), { code: "invalid", message: /must be text/ });
  await assert.rejects(store.createBoard({ name: "x".repeat(81) }), { code: "invalid", message: /at most 80/ });
  const board = await store.createBoard({ name: "Plans" });
  await assert.rejects(store.createBoard({ name: "PLANS" }), { code: "conflict", message: new RegExp(board.id) });
  await assert.rejects(store.createBoard({ name: "Two", columns: ["A", "a"] }), { code: "conflict" });
  await assert.rejects(store.edit(board.id, (b) => addColumn(b, "to DO", columnId(b))), { code: "conflict", message: /To do/ });
  await assert.rejects(store.renameBoard(board.id, { name: "" }), { code: "invalid" });
  const other = await store.createBoard({ name: "Other" });
  await assert.rejects(store.renameBoard(other.id, { name: "plans" }), { code: "conflict" });
  // A refused write changes nothing, its version included.
  assert.equal(store.board(board.id).version, 1);
  assert.equal(store.board(other.id).name, "Other");
});

test("every write gives the board its next version, and the list a version of its own that changes with any of them", async () => {
  const { store } = open();
  const a = await store.createBoard({ name: "A" });
  const b = await store.createBoard({ name: "B" });
  const versions = [store.list().version];
  const card = (await withCards(store, a.id, "One")).cards[0];
  versions.push(store.list().version);
  assert.equal(store.board(a.id).version, 2);
  await store.edit(a.id, (board, now) => editCard(board, card.id, { title: "One, changed" }, PERSON, now));
  versions.push(store.list().version);
  assert.equal(store.board(a.id).version, 3);
  await store.renameBoard(b.id, { name: "B2" });
  versions.push(store.list().version);
  assert.equal(store.board(b.id).version, 2);
  await store.deleteBoard(b.id);
  versions.push(store.list().version);
  // Never the same twice, a deletion that lowers the sum of the versions included.
  assert.equal(new Set(versions).size, versions.length, versions.join(" "));
});

test("cards keep their order: added at the bottom or at a place, moved within a column and to another, archived out of sight and restored to the bottom", async () => {
  const { store } = open();
  const made = await store.createBoard({ name: "Order" });
  const [todo, doing] = made.columns.map((c) => c.id);
  let board = await withCards(store, made.id, "A", "B", "C");
  assert.deepEqual(titles(board, todo), ["A", "B", "C"]);
  const id = (title: string) => board.cards.find((c) => c.title === title)!.id;
  const edit = async (change: (b: Board, now: number) => unknown) => (board = (await store.edit(made.id, change)).board);

  await edit((b, now) => addCard(b, { title: "Top", at: 0 }, store.cardId(), PERSON, now));
  assert.deepEqual(titles(board, todo), ["Top", "A", "B", "C"]);
  await edit((b, now) => moveCard(b, id("C"), todo, 1, PERSON, now));
  assert.deepEqual(titles(board, todo), ["Top", "C", "A", "B"]);
  await edit((b, now) => moveCard(b, id("A"), "In progress", undefined, AGENT, now));
  assert.deepEqual(titles(board, todo), ["Top", "C", "B"]);
  assert.deepEqual(titles(board, doing), ["A"]);
  // A place past the end is the bottom.
  await edit((b, now) => moveCard(b, id("Top"), doing, 99, PERSON, now));
  assert.deepEqual(titles(board, doing), ["A", "Top"]);
  // Archived, it is out of the column's order, and places are counted without it.
  await edit((b, now) => archiveCard(b, id("C"), PERSON, now));
  assert.deepEqual(titles(board, todo), ["B"]);
  await edit((b, now) => moveCard(b, id("A"), todo, 0, PERSON, now));
  assert.deepEqual(titles(board, todo), ["A", "B"]);
  await assert.rejects(store.edit(made.id, (b, now) => moveCard(b, id("C"), doing, 0, PERSON, now)), { code: "conflict", message: /archived/ });
  await edit((b, now) => restoreCard(b, id("C"), PERSON, now));
  assert.deepEqual(titles(board, todo), ["A", "B", "C"]);
  // A column is found by its id or its name, whatever the capitals; one that is not there says which there are.
  await assert.rejects(store.edit(made.id, (b, now) => moveCard(b, id("B"), "Nowhere", 0, PERSON, now)), { code: "missing", message: /To do \(col-/ });
  await edit((b, now) => moveCard(b, id("B"), "DONE", 0, PERSON, now));
  assert.deepEqual(titles(board, made.columns[2].id), ["B"]);
  await edit((b) => deleteCard(b, id("B")));
  assert.equal(board.cards.some((c) => c.title === "B"), false);
});

test("a card's fields are checked, and an edit records only what changed, with who did it", async () => {
  const { store } = open();
  const made = await store.createBoard({ name: "Fields" });
  const id = (await store.edit(made.id, (b, now) => addCard(b, { title: "Write the docs", labels: "docs, Docs ,  web,", assignee: " Aria ", due: "2026-10-30" }, store.cardId(), AGENT, now))).result.id;
  let card = store.board(made.id).cards[0];
  assert.match(id, /^c-[2-9a-hj-km-np-z]{4}$/);
  assert.deepEqual([card.labels, card.assignee, card.due], [["docs", "web"], "Aria", "2026-10-30"]);
  assert.deepEqual(card.activity.map((a) => [a.did, a.column, a.by]), [["created", "To do", AGENT]]);
  const change = (patch: Record<string, unknown>, note?: unknown) => store.edit(made.id, (b, now) => editCard(b, id, patch, PERSON, now, note));
  for (const [patch, why] of [
    [{ due: "2026-02-30" }, /not a day of the calendar/],
    [{ due: "30.10.2026" }, /YYYY-MM-DD/],
    [{ title: "" }, /must not be empty/],
    [{ labels: Array.from({ length: 13 }, (_, i) => `l${i}`) }, /at most 12 labels/],
    [{ labels: ["x".repeat(33)] }, /at most 32/],
    [{ labels: 7 }, /list of texts/],
    [{ assignee: "x".repeat(81) }, /at most 80/],
  ] as const) await assert.rejects(change(patch), { code: "invalid", message: why });
  // The same value is no change; a note alone is a note.
  const same = await change({ title: "Write the docs", labels: ["docs", "web"] });
  assert.deepEqual(same.result.fields, []);
  await change({ title: "Write the guide", due: "", assignee: "" }, "Started on the outline");
  card = store.board(made.id).cards[0];
  assert.deepEqual([card.title, card.due, card.assignee], ["Write the guide", null, ""]);
  assert.deepEqual(card.activity.at(-1), { at: card.activity.at(-1)!.at, by: PERSON, did: "edited", fields: ["title", "assignee", "due"], note: "Started on the outline" });
  await store.edit(made.id, (b, now) => noteCard(b, id, "Halfway", AGENT, now));
  assert.deepEqual(store.board(made.id).cards[0].activity.at(-1)?.note, "Halfway");
  await assert.rejects(store.edit(made.id, (b, now) => noteCard(b, id, "  ", AGENT, now)), { code: "invalid" });
});

test("a card's activity keeps its newest lines only", async () => {
  const { store } = open();
  const made = await store.createBoard({ name: "Busy" });
  const id = (await store.edit(made.id, (b, now) => addCard(b, { title: "Chatty" }, store.cardId(), PERSON, now))).result.id;
  for (let i = 1; i <= ACTIVITY_KEPT + 10; i++) await store.edit(made.id, (b, now) => noteCard(b, id, `note ${i}`, AGENT, now));
  const activity = store.board(made.id).cards[0].activity;
  assert.equal(activity.length, ACTIVITY_KEPT);
  assert.equal(activity.at(-1)!.note, `note ${ACTIVITY_KEPT + 10}`);
  assert.equal(activity[0].note, "note 11", "the oldest went first, the creation with them");
});

test("columns are added at a place, renamed, moved, and taken away only empty or with somewhere for their cards", async () => {
  const { store } = open();
  const made = await store.createBoard({ name: "Columns" });
  let board = await withCards(store, made.id, "Card one");
  const edit = async (change: (b: Board, now: number) => unknown) => (board = (await store.edit(made.id, change)).board);
  await edit((b) => addColumn(b, "Review", columnId(b), 2));
  assert.deepEqual(board.columns.map((c) => c.name), ["To do", "In progress", "Review", "Done"]);
  await edit((b) => renameColumn(b, "review", "Checked"));
  await edit((b) => moveColumn(b, "Checked", 0));
  assert.deepEqual(board.columns.map((c) => c.name), ["Checked", "To do", "In progress", "Done"]);
  await edit((b) => removeColumn(b, "Checked"));
  // One with a card (an archived one counts) needs a column for it.
  await edit((b, now) => archiveCard(b, b.cards[0].id, PERSON, now));
  await assert.rejects(store.edit(made.id, (b) => removeColumn(b, "To do")), { code: "conflict", message: /1 cards: say which column/ });
  await assert.rejects(store.edit(made.id, (b) => removeColumn(b, "To do", "To do")), { code: "invalid" });
  const moved = (await store.edit(made.id, (b) => removeColumn(b, "To do", "Done"))).result;
  assert.equal(moved.moved, 1);
  board = store.board(made.id);
  assert.deepEqual(board.columns.map((c) => c.name), ["In progress", "Done"]);
  assert.equal(board.cards[0].column, board.columns[1].id);
  assert.equal(board.cards[0].archived, true, "an archived card stays archived");
  await edit((b) => removeColumn(b, "Done", "In progress"));
  await assert.rejects(store.edit(made.id, (b) => removeColumn(b, "In progress")), { code: "conflict", message: /at least one column/ });
});

test("what is written is what another store opened on the folder reads, and a board deleted is gone from both", async () => {
  const { dir, store } = open();
  const a = await store.createBoard({ name: "Kept" });
  await withCards(store, a.id, "Survives a restart");
  const b = await store.createBoard({ name: "Deleted" });
  await store.touch("chat-a", b.id);
  await store.touch("chat-b", a.id);
  await store.deleteBoard(b.id);
  assert.equal(existsSync(path.join(dir, "boards", `${b.id}.json`)), false);
  assert.equal(store.touched("chat-a"), null, "a chat's board that was deleted is forgotten");
  const again = KanbanStore.open(dir);
  assert.deepEqual(again.list(), store.list());
  assert.deepEqual(again.board(a.id), store.board(a.id));
  assert.equal(again.touched("chat-b"), a.id);
  await again.forgetChat("chat-b");
  assert.equal(KanbanStore.open(dir).touched("chat-b"), null);
});

test("a file is written whole beside its place and renamed over it: what a write cut off left is swept, and a board written while the index was not is listed", async () => {
  const { dir, store } = open();
  const a = await store.createBoard({ name: "First" });
  const b = await store.createBoard({ name: "Second" });
  // No file beside the boards once the writes are done.
  assert.deepEqual(readdirSync(path.join(dir, "boards")).sort(), [`${a.id}.json`, `${b.id}.json`].sort());
  assert.deepEqual(readdirSync(dir).sort(), ["boards", "index.json"]);
  // A write cut off before its rename leaves its temporary file, and the board as it was.
  writeFileSync(path.join(dir, "boards", `.${a.id}.json.0123456789ab.tmp`), "{ half");
  writeFileSync(path.join(dir, `.index.json.0123456789ab.tmp`), "{ half");
  // The index as it was before the second board: a crash between the board's file and the index.
  const index = JSON.parse(readFileSync(path.join(dir, "index.json"), "utf8"));
  writeFileSync(path.join(dir, "index.json"), JSON.stringify({ ...index, boards: [a.id] }));
  // A file that is not a board's is left alone, and said in the log.
  writeFileSync(path.join(dir, "boards", "b-zzzz.json"), "not json");
  const said: string[] = [];
  const again = KanbanStore.open(dir, (line) => said.push(line));
  assert.deepEqual(again.list().boards.map((x) => x.name), ["First", "Second"]);
  assert.deepEqual(readdirSync(path.join(dir, "boards")).filter((f) => f.endsWith(".tmp")), []);
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
  assert.deepEqual(said, ["kanban: the file of the board b-zzzz could not be read, and is left out"]);
  assert.equal(readFileSync(path.join(dir, "boards", "b-zzzz.json"), "utf8"), "not json");
});

test("a write that cannot be put in place changes nothing: not the file, not what is read", async () => {
  const { dir, store } = open();
  const made = await store.createBoard({ name: "Safe" });
  const file = path.join(dir, "boards", `${made.id}.json`);
  const before = readFileSync(file, "utf8");
  // The folder the boards are in is a file now: no file can be written in it.
  renameSync(path.join(dir, "boards"), path.join(dir, "boards-away"));
  writeFileSync(path.join(dir, "boards"), "");
  await assert.rejects(store.edit(made.id, (b, now) => addCard(b, { title: "Lost" }, store.cardId(), PERSON, now)));
  assert.equal(store.board(made.id).version, 1);
  assert.equal(store.board(made.id).cards.length, 0);
  // The next write after it goes through as ever.
  renameSync(path.join(dir, "boards"), path.join(dir, "boards-file"));
  renameSync(path.join(dir, "boards-away"), path.join(dir, "boards"));
  assert.equal(readFileSync(file, "utf8"), before);
  const { board } = await store.edit(made.id, (b, now) => addCard(b, { title: "Kept" }, store.cardId(), PERSON, now));
  assert.equal(board.version, 2);
});

test("an index that cannot be written leaves the boards listed as their files say, as the next start reads them", async () => {
  const { dir, store } = open();
  const kept = await store.createBoard({ name: "Kept" });
  const gone = await store.createBoard({ name: "Gone" });
  // The index's place is a folder with something in it: no file can be renamed over it.
  rmSync(path.join(dir, "index.json"));
  mkdirSync(path.join(dir, "index.json", "in-the-way"), { recursive: true });
  // The board's file is removed, and the board is gone from the list with it.
  await assert.rejects(store.deleteBoard(gone.id), { code: "EISDIR" });
  assert.equal(existsSync(path.join(dir, "boards", `${gone.id}.json`)), false);
  assert.deepEqual(store.list().boards.map((b) => b.name), ["Kept"]);
  assert.throws(() => store.resolve("Gone"), { code: "missing" });
  // A board whose file is written is listed, and its name is taken.
  await assert.rejects(store.createBoard({ name: "Made" }), { code: "EISDIR" });
  assert.deepEqual(store.list().boards.map((b) => b.name), ["Kept", "Made"]);
  await assert.rejects(store.createBoard({ name: "made" }), { code: "conflict" });
  // What a start reads.
  const again = KanbanStore.open(dir);
  assert.deepEqual(again.list().boards.map((b) => [b.id, b.name]), store.list().boards.map((b) => [b.id, b.name]));
  assert.equal(again.list().boards[0].id, kept.id);
  // With its place free again, the index is written as ever.
  rmSync(path.join(dir, "index.json"), { recursive: true });
  await store.renameBoard(kept.id, { name: "Still kept" });
  await store.touch("chat-1", kept.id);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "index.json"), "utf8")).boards, store.list().boards.map((b) => b.id));
});

test("writes asked for at once are made one after the other, each on the board the one before left", async () => {
  const { dir, store } = open();
  const made = await store.createBoard({ name: "Busy" });
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) => store.edit(made.id, (b, now) => addCard(b, { title: `Card ${i}` }, store.cardId(), i % 2 ? AGENT : PERSON, now))));
  // Each its own version, in the order asked.
  assert.deepEqual(results.map((r) => r.board.version), Array.from({ length: 40 }, (_, i) => i + 2));
  const board = store.board(made.id);
  assert.equal(board.version, 41);
  assert.deepEqual(board.cards.map((c) => c.title), Array.from({ length: 40 }, (_, i) => `Card ${i}`));
  assert.equal(new Set(board.cards.map((c) => c.id)).size, 40, "no id twice");
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "boards", `${made.id}.json`), "utf8")), board);
  // A refused one in between leaves the others be.
  const mixed = await Promise.allSettled([
    store.edit(made.id, (b, now) => addCard(b, { title: "Before" }, store.cardId(), PERSON, now)),
    store.edit(made.id, (b, now) => addCard(b, { title: "" }, store.cardId(), PERSON, now)),
    store.edit(made.id, (b, now) => addCard(b, { title: "After" }, store.cardId(), PERSON, now)),
  ]);
  assert.deepEqual(mixed.map((r) => r.status), ["fulfilled", "rejected", "fulfilled"]);
  assert.equal(store.board(made.id).version, 43);
  // Two boards of one name asked for at once: one is made.
  const names = await Promise.allSettled([store.createBoard({ name: "Same" }), store.createBoard({ name: "same" })]);
  assert.deepEqual(names.map((r) => r.status), ["fulfilled", "rejected"]);
});

test("a card id is unique across the boards, and names its board", async () => {
  const { store } = open();
  const a = await store.createBoard({ name: "A" });
  const b = await store.createBoard({ name: "B" });
  const one = (await withCards(store, a.id, "On A")).cards[0];
  const two = (await withCards(store, b.id, "On B")).cards[0];
  assert.notEqual(one.id, two.id);
  assert.equal(store.boardOfCard(two.id).id, b.id);
  assert.throws(() => store.boardOfCard("c-zzzz"), { code: "missing" });
  assert.equal(store.resolve(a.id).id, a.id);
  assert.equal(store.resolve(" b ").id, b.id, "by its name, capitals aside");
  assert.throws(() => store.resolve("C"), { code: "missing", message: /The boards: A \(b-/ });
});
