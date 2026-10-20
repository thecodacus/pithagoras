import type { Activity, Actor, Board, Card, CardField, Column } from "../types";
import { newId } from "./ids";
import { ACTIVITY_KEPT, KanbanError, LIMITS, due, labels, line, prose } from "./validate";

/**
 * What can be done to one board, on the board itself: no file, no version. The store (store.ts) gives each of these a
 * copy of the board, and keeps it, with a new version, once it is written. Each checks what it is given and throws a
 * KanbanError before it changes anything.
 */

export const DEFAULT_COLUMNS = ["To do", "In progress", "Done"];

/** What a card is made with: its title, and what else is known of it. */
export interface CardInput {
  title: unknown;
  description?: unknown;
  labels?: unknown;
  assignee?: unknown;
  due?: unknown;
}

/** What an edit of a card may change: any of its fields, each checked as when it was made. */
export type CardPatch = Partial<Record<CardField, unknown>>;

const missing = (message: string) => new KanbanError("missing", message);
const conflict = (message: string) => new KanbanError("conflict", message);

/** A new board, with its columns: the default ones unless others are named. */
export function makeBoard(input: { name: unknown; description?: unknown; columns?: unknown }, id: string, now: number): Board {
  const name = line(input.name, "A board's name", LIMITS.boardName);
  const description = input.description === undefined ? "" : prose(input.description, "A board's description", LIMITS.boardDescription);
  const names = input.columns === undefined || (Array.isArray(input.columns) && input.columns.length === 0) ? DEFAULT_COLUMNS : input.columns;
  if (!Array.isArray(names)) throw new KanbanError("invalid", "Columns must be a list of names");
  if (names.length > LIMITS.columns) throw new KanbanError("invalid", `A board has at most ${LIMITS.columns} columns`);
  const board: Board = { id, name, description, version: 0, created: now, updated: now, columns: [], cards: [] };
  for (const given of names) board.columns.push({ id: columnId(board), name: columnName(board, given) });
  return board;
}

/** A column's name, checked: one line, and not the name of another column of the board, whatever its capitals. */
function columnName(board: Board, value: unknown, except?: Column): string {
  const name = line(value, "A column's name", LIMITS.columnName);
  const same = board.columns.find((c) => c !== except && c.name.toLowerCase() === name.toLowerCase());
  if (same) throw conflict(`The board has a column called "${same.name}" already (${same.id})`);
  return name;
}

/** A column of the board, by its id or its name (capitals aside). */
export function findColumn(board: Board, ref: unknown): Column {
  if (typeof ref !== "string" || !ref.trim()) throw new KanbanError("invalid", "Name a column by its id or its name");
  const want = ref.trim();
  const found = board.columns.find((c) => c.id === want) ?? board.columns.find((c) => c.name.toLowerCase() === want.toLowerCase());
  if (!found) throw missing(`The board "${board.name}" has no column "${want}". Its columns: ${board.columns.map((c) => `${c.name} (${c.id})`).join(", ")}`);
  return found;
}

/** A card of the board, by its id. */
export function findCard(board: Board, id: unknown): Card {
  const card = typeof id === "string" ? board.cards.find((c) => c.id === id.trim()) : undefined;
  if (!card) throw missing(`The board "${board.name}" has no card "${String(id)}"`);
  return card;
}

/** The cards in a column that are not archived, top first. */
export const cardsIn = (board: Board, column: string) => board.cards.filter((c) => c.column === column && !c.archived);

/** A column's name, as it is now. */
const nameOf = (board: Board, column: string) => board.columns.find((c) => c.id === column)?.name ?? column;

/**
 * Puts a card at `place` among the cards of `column` that are not archived (0 the top; nothing, or past the end, the
 * bottom). Archived cards keep their places among the others, out of sight.
 */
function place(board: Board, card: Card, column: string, at?: number) {
  const rest = board.cards.filter((c) => c !== card);
  const there = rest.filter((c) => c.column === column && !c.archived);
  const i = Math.min(at ?? there.length, there.length);
  const where = i < there.length ? rest.indexOf(there[i]) : there.length ? rest.indexOf(there[there.length - 1]) + 1 : rest.length;
  rest.splice(where, 0, card);
  card.column = column;
  board.cards = rest;
}

/** Adds a line to a card's activity, and lets go of the oldest beyond what is kept. */
function record(card: Card, entry: Omit<Activity, "at" | "by">, by: Actor, now: number) {
  card.activity.push({ at: now, by, ...entry });
  if (card.activity.length > ACTIVITY_KEPT) card.activity.splice(0, card.activity.length - ACTIVITY_KEPT);
}

/** A note, as given with a change: one checked text, or nothing. */
function noteOf(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return prose(value, "A note", LIMITS.note) || undefined;
}

export function renameBoard(board: Board, change: { name?: unknown; description?: unknown }) {
  if (change.name === undefined && change.description === undefined) throw new KanbanError("invalid", "Give a name or a description");
  if (change.name !== undefined) board.name = line(change.name, "A board's name", LIMITS.boardName);
  if (change.description !== undefined) board.description = prose(change.description, "A board's description", LIMITS.boardDescription);
}

export function addColumn(board: Board, name: unknown, id: string, at?: number): Column {
  if (board.columns.length >= LIMITS.columns) throw conflict(`A board has at most ${LIMITS.columns} columns`);
  const column = { id, name: columnName(board, name) };
  board.columns.splice(Math.min(at ?? board.columns.length, board.columns.length), 0, column);
  return column;
}

export function renameColumn(board: Board, ref: unknown, name: unknown): Column {
  const column = findColumn(board, ref);
  column.name = columnName(board, name, column);
  return column;
}

/** Puts a column at `at` among the columns, 0 the first. */
export function moveColumn(board: Board, ref: unknown, at: number): Column {
  const column = findColumn(board, ref);
  board.columns = board.columns.filter((c) => c !== column);
  board.columns.splice(Math.min(at, board.columns.length), 0, column);
  return column;
}

/**
 * Takes a column away. One with cards (archived ones count: they come back to their column) goes only when another
 * column is named for them: they go to its bottom, in their order, archived ones still archived. The last column stays.
 */
export function removeColumn(board: Board, ref: unknown, moveTo?: unknown): { column: Column; moved: number; to?: Column } {
  const column = findColumn(board, ref);
  if (board.columns.length === 1) throw conflict("A board keeps at least one column");
  const cards = board.cards.filter((c) => c.column === column.id);
  let to: Column | undefined;
  if (cards.length) {
    if (moveTo === undefined || moveTo === null || moveTo === "") throw conflict(`The column "${column.name}" has ${cards.length} cards: say which column they go to`);
    to = findColumn(board, moveTo);
    if (to === column) throw new KanbanError("invalid", "Its cards go to another column than the one taken away");
    for (const card of cards) {
      board.cards = board.cards.filter((c) => c !== card);
      board.cards.push(card);
      card.column = to.id;
    }
  }
  board.columns = board.columns.filter((c) => c !== column);
  return { column, moved: cards.length, ...(to ? { to } : {}) };
}

export function addCard(board: Board, input: CardInput & { column?: unknown; at?: number }, id: string, by: Actor, now: number): Card {
  if (board.cards.length >= LIMITS.cards) throw conflict(`A board holds at most ${LIMITS.cards} cards, archived ones included: delete some first`);
  const column = input.column === undefined || input.column === null || input.column === "" ? board.columns[0] : findColumn(board, input.column);
  const card: Card = {
    id,
    title: line(input.title, "A card's title", LIMITS.title),
    description: input.description === undefined ? "" : prose(input.description, "A card's description", LIMITS.description),
    labels: input.labels === undefined ? [] : labels(input.labels),
    assignee: input.assignee === undefined ? "" : line(input.assignee, "The assignee", LIMITS.assignee, { empty: true }),
    due: input.due === undefined ? null : due(input.due),
    column: column.id,
    archived: false,
    created: now,
    updated: now,
    activity: [],
  };
  place(board, card, column.id, input.at);
  record(card, { did: "created", column: column.name }, by, now);
  return card;
}

/**
 * Changes what is given of a card's fields. What is the same as it was is not a change; a note is kept with the change
 * in its activity, or on its own when nothing else changed. Returns what changed.
 */
export function editCard(board: Board, id: unknown, patch: CardPatch, by: Actor, now: number, note?: unknown): { card: Card; fields: CardField[]; note?: string } {
  const card = findCard(board, id);
  const next: Partial<Pick<Card, CardField>> = {};
  if (patch.title !== undefined) next.title = line(patch.title, "A card's title", LIMITS.title);
  if (patch.description !== undefined) next.description = prose(patch.description, "A card's description", LIMITS.description);
  if (patch.labels !== undefined) next.labels = labels(patch.labels);
  if (patch.assignee !== undefined) next.assignee = line(patch.assignee, "The assignee", LIMITS.assignee, { empty: true });
  if (patch.due !== undefined) next.due = due(patch.due);
  const said = noteOf(note);
  const fields = (Object.keys(next) as CardField[]).filter((field) => JSON.stringify(next[field]) !== JSON.stringify(card[field]));
  if (!fields.length && !said) return { card, fields };
  for (const field of fields) Object.assign(card, { [field]: next[field] });
  card.updated = now;
  record(card, fields.length ? { did: "edited", fields, ...(said ? { note: said } : {}) } : { did: "noted", note: said }, by, now);
  return { card, fields, ...(said ? { note: said } : {}) };
}

/** Moves a card to a column, at `at` among its cards (0 the top; nothing for the bottom). An archived card is not moved. */
export function moveCard(board: Board, id: unknown, columnRef: unknown, at: number | undefined, by: Actor, now: number, note?: unknown): { card: Card; from: Column; to: Column } {
  const card = findCard(board, id);
  if (card.archived) throw conflict(`The card ${card.id} is archived: restore it first`);
  const from = board.columns.find((c) => c.id === card.column)!;
  const to = findColumn(board, columnRef);
  const said = noteOf(note);
  place(board, card, to.id, at);
  card.updated = now;
  // Only a change of column is a line of the activity: an order within a column is not news.
  if (from !== to) record(card, { did: "moved", from: from.name, to: to.name, ...(said ? { note: said } : {}) }, by, now);
  else if (said) record(card, { did: "noted", note: said }, by, now);
  return { card, from, to };
}

export function archiveCard(board: Board, id: unknown, by: Actor, now: number, note?: unknown): Card {
  const card = findCard(board, id);
  if (card.archived) throw conflict(`The card ${card.id} is archived already`);
  const said = noteOf(note);
  card.archived = true;
  card.updated = now;
  record(card, { did: "archived", ...(said ? { note: said } : {}) }, by, now);
  return card;
}

/** Takes a card out of the archive, to the bottom of its column. */
export function restoreCard(board: Board, id: unknown, by: Actor, now: number): Card {
  const card = findCard(board, id);
  if (!card.archived) throw conflict(`The card ${card.id} is not archived`);
  card.archived = false;
  card.updated = now;
  place(board, card, card.column);
  record(card, { did: "restored", column: nameOf(board, card.column) }, by, now);
  return card;
}

export function deleteCard(board: Board, id: unknown): Card {
  const card = findCard(board, id);
  board.cards = board.cards.filter((c) => c !== card);
  return card;
}

/** A note on a card, on its own: progress, a question, an answer. */
export function noteCard(board: Board, id: unknown, text: unknown, by: Actor, now: number): Card {
  const card = findCard(board, id);
  const note = noteOf(text);
  if (!note) throw new KanbanError("invalid", "A note must not be empty");
  card.updated = now;
  record(card, { did: "noted", note }, by, now);
  return card;
}

/** A column id that is not one of the board's. */
export const columnId = (board: Board) => newId("column", (id) => board.columns.some((c) => c.id === id));
