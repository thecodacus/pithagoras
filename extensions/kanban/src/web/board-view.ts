import type { Board, Card } from "../types";

/** What the page reads of a board: its columns' cards, and a card moved the way the server half moves it. */

/** The cards of a column that are not archived, top first. */
export const cardsIn = (board: Board, column: string) => board.cards.filter((c) => c.column === column && !c.archived);

/**
 * The board with a card moved to `column`, at `index` among its cards that are not archived (0 the top), as the server
 * half moves it (server/board.ts): shown at once while the move is on its way.
 */
export function moved(board: Board, card: string, column: string, index: number): Board {
  const which = board.cards.find((c) => c.id === card);
  if (!which) return board;
  const rest = board.cards.filter((c) => c !== which);
  const there = rest.filter((c) => c.column === column && !c.archived);
  const i = Math.min(index, there.length);
  const where = i < there.length ? rest.indexOf(there[i]) : there.length ? rest.indexOf(there[there.length - 1]) + 1 : rest.length;
  rest.splice(where, 0, { ...which, column });
  return { ...board, cards: rest };
}

/** Where a card is: its column, and its place among the column's cards. */
export function placeOf(board: Board, card: Card) {
  return { column: card.column, index: cardsIn(board, card.column).indexOf(card) };
}

/** A due day, `YYYY-MM-DD`, as a date of this browser's calendar. */
export const dayOf = (due: string) => {
  const [y, m, d] = due.split("-").map(Number);
  return new Date(y, m - 1, d);
};

/** Today, `YYYY-MM-DD` on this browser's calendar. */
export function today(now = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** A card due before today. */
export const overdue = (card: Card, now = new Date()) => !!card.due && card.due < today(now);
