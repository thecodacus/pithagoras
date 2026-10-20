import type { Actor, Board, Card } from "../types";
import { addCard, addColumn, archiveCard, cardsIn, columnId, editCard, findCard, moveCard, restoreCard } from "./board";
import { boardText, listText } from "./describe";
import { flag, integer, object, text, texts } from "./schema";
import type { KanbanStore } from "./store";
import { KanbanError } from "./validate";

/**
 * Kanban's tools in a chat's pi, registered by the server half (`portal.chats.extend`), so that they work on the same
 * store as the page: what an agent does shows on the page, and what the person does there is what the agent reads.
 * Settings → Tools is told of them (`portal.tools.offer`).
 *
 * An agent reads the boards, makes a board, adds a column, adds, changes, moves and archives a card, and writes notes
 * on a card. It cannot delete a board, a column or a card: that is the person's, on the page. Whatever it does is in
 * the card's activity as its chat's, and the board it worked on last is the one its chat's panel opens on.
 */

/** What a tool answers: its words for the model, and what it did, for its card in the chat (web/ToolCard.tsx). */
export type ToolResult = { content: { type: "text"; text: string }[]; details: CallDetails };

/** What a call did, as its card in the chat draws it. */
export interface CallDetails {
  did: "listed" | "read" | "created-board" | "added-column" | "added-card" | "updated-card" | "moved-card" | "archived-card";
  board?: { id: string; name: string };
  card?: { id: string; title: string; column: string };
  /** The column added, or the column a card went to. */
  column?: string;
  /** The column a card came from. */
  from?: string;
  /** The fields an update changed. */
  fields?: string[];
  /** How many boards there are, for a list of them. */
  boards?: number;
}

/** Where a tool works: the store, as its chat's agent. */
export interface ToolContext {
  store: KanbanStore;
  chat: string;
  by: Actor;
}

/** One of the tools, as pi registers it, but made for no chat: `run` is its `execute`, given where it works. */
export interface KanbanTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  run(context: ToolContext, params: any): Promise<ToolResult>;
}

const answer = (said: string, details: CallDetails): ToolResult => ({ content: [{ type: "text", text: said }], details });
const quote = (text: string) => JSON.stringify(text);
const boardOf = (board: Board) => ({ id: board.id, name: board.name });
const columnName = (board: Board, column: string) => board.columns.find((c) => c.id === column)?.name ?? column;
const cardOf = (board: Board, card: Card) => ({ id: card.id, title: card.title, column: columnName(board, card.column) });
/** A position as the tools take it, 1 the first, as an index from 0. */
const place = (position: unknown) => {
  if (position === undefined || position === null) return undefined;
  if (typeof position !== "number" || !Number.isInteger(position) || position < 1) throw new KanbanError("invalid", "position is a whole number from 1");
  return position - 1;
};
/** Where a card is in its column, 1 the top. */
const positionOf = (board: Board, card: Card) => cardsIn(board, card.column).indexOf(card) + 1;
/** The board a call worked on is the one its chat's panel opens on next. */
const touched = async (context: ToolContext, board: Board) => {
  await context.store.touch(context.chat, board.id);
  return board;
};

const BOARD = text("The board's id (b-…) or its exact name.");
const CARD = text("The card's id (c-…), as kanban_board gives it.");
const NOTE = text("A note for the card's activity: what was done, what is left, a question.");

export const TOOLS: KanbanTool[] = [
  {
    name: "kanban_boards",
    label: "kanban boards",
    description: "List the kanban boards, with how many cards each column holds.",
    parameters: object({}),
    run: async ({ store }) => {
      const list = store.list();
      return answer(listText(list), { did: "listed", boards: list.boards.length });
    },
  },
  {
    name: "kanban_board",
    label: "kanban board",
    description:
      "Read a kanban board: its columns, and their cards top first with ids, labels, assignee, due date, description and latest note. " +
      "Filter by column, label or assignee. Archived cards are left out unless archived is true.",
    parameters: object(
      {
        board: BOARD,
        column: text("Only this column, by its id or name."),
        label: text("Only cards with this label."),
        assignee: text("Only cards assigned to this person or agent."),
        archived: flag("Also list the archived cards."),
      },
      ["column", "label", "assignee", "archived"],
    ),
    run: async (context, p) => {
      const board = await touched(context, context.store.resolve(p.board));
      return answer(boardText(board, { column: p.column, label: p.label, assignee: p.assignee, archived: p.archived === true }), { did: "read", board: boardOf(board) });
    },
  },
  {
    name: "kanban_create_board",
    label: "kanban create board",
    description: "Make a kanban board. Its columns are To do, In progress and Done unless named. No two boards share a name.",
    parameters: object({ name: text("The board's name."), description: text("What the board is for."), columns: texts("Its columns' names, left to right.") }, ["description", "columns"]),
    run: async (context, p) => {
      const board = await touched(context, await context.store.createBoard({ name: p.name, description: p.description, columns: p.columns }));
      return answer(`Made board ${board.id} ${quote(board.name)} with the columns ${board.columns.map((c) => `${c.name} (${c.id})`).join(", ")}.`, { did: "created-board", board: boardOf(board) });
    },
  },
  {
    name: "kanban_add_column",
    label: "kanban add column",
    description: "Add a column to a kanban board: at the right end, or at position (1 is the leftmost).",
    parameters: object({ board: BOARD, name: text("The column's name."), position: integer("Where it goes, 1 the leftmost.") }, ["position"]),
    run: async (context, p) => {
      const at = place(p.position);
      const { board, result: column } = await context.store.edit(() => context.store.resolve(p.board), (b) => addColumn(b, p.name, columnId(b), at));
      await touched(context, board);
      return answer(`Added column ${column.id} ${quote(column.name)} to board ${board.id} ${quote(board.name)}. Its columns now: ${board.columns.map((c) => c.name).join(", ")}.`, {
        did: "added-column",
        board: boardOf(board),
        column: column.name,
      });
    },
  },
  {
    name: "kanban_add_card",
    label: "kanban add card",
    description: "Add a card to a kanban board: at the bottom of the first column, unless column and position (1 is the top) say where.",
    parameters: object(
      {
        board: BOARD,
        title: text("What the card is, in a line."),
        column: text("The column, by its id or name."),
        position: integer("Its place in the column, 1 the top."),
        description: text("More about it: plain text or Markdown."),
        labels: texts("Short labels."),
        assignee: text("Who does it: a person or an agent."),
        due: text("Due day, YYYY-MM-DD."),
      },
      ["column", "position", "description", "labels", "assignee", "due"],
    ),
    run: async (context, p) => {
      const at = place(p.position);
      const { store, by } = context;
      const { board, result: card } = await store.edit(
        () => store.resolve(p.board),
        (b, now) => addCard(b, { title: p.title, description: p.description, labels: p.labels, assignee: p.assignee, due: p.due, column: p.column, at }, store.cardId(), by, now),
      );
      await touched(context, board);
      return answer(`Added card ${card.id} ${quote(card.title)} to ${columnName(board, card.column)}, position ${positionOf(board, card)}, on board ${board.id} ${quote(board.name)}.`, {
        did: "added-card",
        board: boardOf(board),
        card: cardOf(board, card),
      });
    },
  },
  {
    name: "kanban_update_card",
    label: "kanban update card",
    description:
      "Change a kanban card: give only what changes. Labels replace its labels; an empty assignee or due clears it; archived false restores an archived card. " +
      "A note goes in the card's activity, with the change or alone: use it for progress.",
    parameters: object(
      {
        card: CARD,
        title: text("Its new title."),
        description: text("Its new description."),
        labels: texts("Its labels, all of them."),
        assignee: text("Who does it."),
        due: text("Due day, YYYY-MM-DD."),
        archived: flag("false restores it from the archive; true archives it."),
        note: NOTE,
      },
      ["title", "description", "labels", "assignee", "due", "archived", "note"],
    ),
    run: async (context, p) => {
      const { store, by } = context;
      if (p.archived !== undefined && typeof p.archived !== "boolean") throw new KanbanError("invalid", "archived is true or false");
      const { board, result } = await store.edit(
        () => store.boardOfCard(p.card),
        (b, now) => {
          const was = findCard(b, p.card).archived;
          // Restored before the change, archived after it: the card's activity says it in the order it was done.
          if (p.archived === false && was) restoreCard(b, p.card, by, now);
          const edit = editCard(b, p.card, { title: p.title, description: p.description, labels: p.labels, assignee: p.assignee, due: p.due }, by, now, p.note);
          if (p.archived === true && !was) archiveCard(b, p.card, by, now);
          const archived = p.archived !== undefined && p.archived !== was;
          if (!edit.fields.length && !edit.note && !archived) throw new KanbanError("invalid", `Nothing to change: the card ${edit.card.id} is as given`);
          return { ...edit, archived };
        },
      );
      await touched(context, board);
      const { card, fields, note, archived } = result;
      const done = [...(fields.length ? [`changed ${fields.join(", ")}`] : []), ...(archived ? [card.archived ? "archived it" : "restored it"] : []), ...(note ? ["noted it"] : [])];
      return answer(`Updated card ${card.id} ${quote(card.title)} on board ${board.id} ${quote(board.name)}: ${done.join(", ")}.`, {
        did: "updated-card",
        board: boardOf(board),
        card: cardOf(board, card),
        fields: [...fields, ...(archived ? [card.archived ? "archived" : "restored"] : []), ...(note ? ["note"] : [])],
      });
    },
  },
  {
    name: "kanban_move_card",
    label: "kanban move card",
    description: "Move a kanban card to a column: at the bottom, or at position (1 is the top). To reorder it, name its own column. A note goes in its activity.",
    parameters: object({ card: CARD, column: text("The column, by its id or name."), position: integer("Its place in the column, 1 the top."), note: NOTE }, ["position", "note"]),
    run: async (context, p) => {
      const { store, by } = context;
      const at = place(p.position);
      const { board, result } = await store.edit(
        () => store.boardOfCard(p.card),
        (b, now) => moveCard(b, p.card, p.column, at, by, now, p.note),
      );
      await touched(context, board);
      const { card, from, to } = result;
      const where = from === to ? `within ${to.name}` : `from ${from.name} to ${to.name}`;
      return answer(`Moved card ${card.id} ${quote(card.title)} ${where}, position ${positionOf(board, card)}, on board ${board.id} ${quote(board.name)}.`, {
        did: "moved-card",
        board: boardOf(board),
        card: cardOf(board, card),
        from: from.name,
        column: to.name,
      });
    },
  },
  {
    name: "kanban_archive_card",
    label: "kanban archive card",
    description: "Archive a kanban card that is done with: it leaves the board and is kept, for the person to restore. These tools cannot delete cards or boards.",
    parameters: object({ card: CARD, note: NOTE }, ["note"]),
    run: async (context, p) => {
      const { store, by } = context;
      const { board, result: card } = await store.edit(
        () => store.boardOfCard(p.card),
        (b, now) => archiveCard(b, p.card, by, now, p.note),
      );
      await touched(context, board);
      return answer(`Archived card ${card.id} ${quote(card.title)} on board ${board.id} ${quote(board.name)}. kanban_update_card with archived false restores it.`, {
        did: "archived-card",
        board: boardOf(board),
        card: cardOf(board, card),
      });
    },
  },
];

/** Registers them in a chat's pi as it loads. `context` is asked as each runs: the chat's title then. */
export function registerTools(pi: any, context: () => ToolContext): void {
  for (const { run, ...tool } of TOOLS) {
    pi.registerTool({ ...tool, execute: (_id: string, params: unknown) => run(context(), params ?? {}) });
  }
}

/** What Settings → Tools is told of them: all of them, always. */
export const offeredTools = (): { name: string; description: string }[] => TOOLS.map(({ name, description }) => ({ name, description }));
