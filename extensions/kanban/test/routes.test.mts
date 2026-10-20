import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "../../../tests/helpers.mts";
import { startKanban } from "./portal.mts";

/**
 * The page's routes, through the portal's own extension host: what they take, what they refuse and how, and the cheap
 * answer to a page that has a board or the list as it is.
 */

inProcessHome("pithagoras-kanban-routes-");
const kanban = await startKanban();
const { ask } = kanban;

test("boards are made, listed, read, renamed and deleted, and each is kept in the extension's own folder", async () => {
  const made = await ask("POST", "/boards", { name: "Launch", columns: ["Backlog", "Doing", "Shipped"] });
  assert.equal(made.status, 200);
  assert.deepEqual(made.body.columns.map((c: any) => c.name), ["Backlog", "Doing", "Shipped"]);
  const id = made.body.id;
  assert.deepEqual(JSON.parse(readFileSync(path.join(kanban.data, "boards", `${id}.json`), "utf8")).name, "Launch");
  const list = await ask("GET", "/boards");
  assert.deepEqual(list.body.boards.map((b: any) => [b.id, b.name, b.columns.map((c: any) => c.cards)]), [[id, "Launch", [0, 0, 0]]]);
  assert.equal(typeof list.body.version, "string");
  const renamed = await ask("PATCH", `/boards/${id}`, { name: "Launch 2", description: "Everything for the launch." });
  assert.deepEqual([renamed.body.name, renamed.body.description, renamed.body.version], ["Launch 2", "Everything for the launch.", 2]);
  assert.equal((await ask("GET", `/boards/${id}`)).body.name, "Launch 2");
  assert.deepEqual((await ask("DELETE", `/boards/${id}`)).body, { deleted: id });
  assert.equal((await ask("GET", `/boards/${id}`)).status, 404);
  assert.deepEqual((await ask("GET", "/boards")).body.boards, []);
});

test("a page that has the board, or the list, as it is, is answered with its version alone", async () => {
  const board = (await ask("POST", "/boards", { name: "Versions" })).body;
  const list = (await ask("GET", "/boards")).body;
  assert.deepEqual((await ask("GET", `/boards/${board.id}?have=${board.version}`)).body, { version: board.version, unchanged: true });
  assert.deepEqual((await ask("GET", `/boards?have=${encodeURIComponent(list.version)}`)).body, { version: list.version, unchanged: true });
  // An older version is answered with the board, and the list with the list.
  const changed = (await ask("POST", `/boards/${board.id}/cards`, { title: "New" })).body;
  assert.equal(changed.version, board.version + 1);
  const again = (await ask("GET", `/boards/${board.id}?have=${board.version}`)).body;
  assert.deepEqual(again, changed);
  const relisted = (await ask("GET", `/boards?have=${encodeURIComponent(list.version)}`)).body;
  assert.notEqual(relisted.version, list.version);
  assert.ok(relisted.boards.some((b: any) => b.id === board.id && b.columns[0].cards === 1));
});

test("columns and cards are changed through the board's routes, each answered with the board after it", async () => {
  const board = (await ask("POST", "/boards", { name: "Routes" })).body;
  const [todo, doing, done] = board.columns.map((c: any) => c.id);
  const at = `/boards/${board.id}`;
  let b = (await ask("POST", `${at}/columns`, { name: "Review", index: 2 })).body;
  const review = b.columns[2];
  assert.equal(review.name, "Review");
  b = (await ask("PATCH", `${at}/columns/${review.id}`, { name: "Checked" })).body;
  b = (await ask("POST", `${at}/columns/${review.id}/move`, { index: 3 })).body;
  assert.deepEqual(b.columns.map((c: any) => c.name), ["To do", "In progress", "Done", "Checked"]);
  b = (await ask("POST", `${at}/cards`, { title: "First", column: doing, labels: ["a"], due: "2026-11-01" })).body;
  const first = b.cards[0];
  assert.deepEqual([first.column, first.labels, first.due, first.activity[0].by], [doing, ["a"], "2026-11-01", { kind: "person" }]);
  b = (await ask("POST", `${at}/cards`, { title: "Second", column: doing, index: 0 })).body;
  assert.deepEqual(b.cards.filter((c: any) => c.column === doing).map((c: any) => c.title), ["Second", "First"]);
  b = (await ask("PATCH", `${at}/cards/${first.id}`, { description: "More on it", assignee: "Ada" })).body;
  assert.deepEqual(b.cards.find((c: any) => c.id === first.id).activity.at(-1).fields, ["description", "assignee"]);
  b = (await ask("POST", `${at}/cards/${first.id}/move`, { column: done, index: 0 })).body;
  assert.equal(b.cards.find((c: any) => c.id === first.id).column, done);
  b = (await ask("POST", `${at}/cards/${first.id}/notes`, { text: "Shipped on Friday" })).body;
  assert.equal(b.cards.find((c: any) => c.id === first.id).activity.at(-1).note, "Shipped on Friday");
  b = (await ask("POST", `${at}/cards/${first.id}/archive`)).body;
  assert.equal(b.cards.find((c: any) => c.id === first.id).archived, true);
  b = (await ask("POST", `${at}/cards/${first.id}/restore`)).body;
  assert.equal(b.cards.find((c: any) => c.id === first.id).archived, false);
  // A column with cards goes once they have somewhere to go.
  assert.equal((await ask("DELETE", `${at}/columns/${doing}`)).status, 409);
  b = (await ask("DELETE", `${at}/columns/${doing}?to=${todo}`)).body;
  assert.deepEqual(b.cards.filter((c: any) => c.column === todo).map((c: any) => c.title), ["Second"]);
  b = (await ask("DELETE", `${at}/cards/${first.id}`)).body;
  assert.equal(b.cards.some((c: any) => c.id === first.id), false);
});

test("what is not right is refused with a status and a sentence that says why", async () => {
  const board = (await ask("POST", "/boards", { name: "Refusals" })).body;
  const card = (await ask("POST", `/boards/${board.id}/cards`, { title: "Here" })).body.cards[0];
  const cases: [string, string, unknown, number, RegExp][] = [
    ["POST", "/boards", { name: "" }, 400, /must not be empty/],
    ["POST", "/boards", { name: "refusals" }, 409, /There is a board called "Refusals" already/],
    ["POST", "/boards", "[1, 2]", 400, /no JSON body/],
    ["GET", "/boards/b-zzzz", undefined, 404, /There is no board b-zzzz/],
    ["POST", `/boards/${board.id}/cards`, { title: "  " }, 400, /title must not be empty/],
    ["POST", `/boards/${board.id}/cards`, { title: "x", column: "Nope" }, 404, /no column "Nope"/],
    ["POST", `/boards/${board.id}/cards`, { title: "x", index: -1 }, 400, /whole number from 0/],
    ["POST", `/boards/${board.id}/cards`, { title: "x", due: "tomorrow" }, 400, /YYYY-MM-DD/],
    ["PATCH", `/boards/${board.id}/cards/c-zzzz`, { title: "x" }, 404, /no card "c-zzzz"/],
    ["POST", `/boards/${board.id}/cards/${card.id}/move`, { column: board.columns[1].id, index: 1.5 }, 400, /whole number/],
    ["POST", `/boards/${board.id}/cards/${card.id}/restore`, undefined, 409, /not archived/],
    ["POST", `/boards/${board.id}/cards/${card.id}/notes`, { text: "" }, 400, /must not be empty/],
    ["POST", `/boards/${board.id}/columns`, { name: "TO DO" }, 409, /column called "To do" already/],
    ["POST", `/boards/${board.id}/columns/${board.columns[0].id}/move`, {}, 400, /Say where the column goes/],
    ["PATCH", `/boards/${board.id}`, {}, 400, /Give a name or a description/],
  ];
  for (const [method, route, body, status, why] of cases) {
    const got = await ask(method, route, body);
    assert.equal(got.status, status, `${method} ${route}: ${JSON.stringify(got.body)}`);
    assert.match(got.body.error, why, `${method} ${route}`);
  }
  // None of it was written.
  assert.equal((await ask("GET", `/boards/${board.id}`)).body.version, 2);
});

test("a chat's panel is told the board its agent last worked on, and nothing for a chat that worked on none", async () => {
  kanban.chat("routes-chat", "Plan the week");
  const board = (await ask("POST", "/boards", { name: "Week" })).body;
  assert.deepEqual((await ask("GET", "/chats/routes-chat/board")).body, { board: null });
  await kanban.tools("routes-chat").kanban_board.execute("call", { board: "Week" });
  assert.deepEqual((await ask("GET", "/chats/routes-chat/board")).body, { board: board.id });
  // A chat that goes is forgotten.
  kanban.deleteChat("routes-chat");
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual((await ask("GET", "/chats/routes-chat/board")).body, { board: null });
});
