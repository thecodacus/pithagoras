import type { Activity, Board, BoardList, Card } from "../types";
import { cardsIn, findColumn } from "./board";
import { today } from "./validate";

/**
 * What the agent's tools answer, as text for a model to act on: short, with every id it may use next, in the order the
 * board has them.
 */

/** At most `max` characters of a text, on one line. */
const cut = (text: string, max: number) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

const quote = (text: string) => JSON.stringify(text);

/** Who did something, for the agent: the person, or an agent by its chat. */
const who = (entry: Activity) => (entry.by.kind === "person" ? "the person" : `the agent of chat ${quote(entry.by.chat.title)}`);

/** One card, in a line, with what is known of it on the lines under it. */
export function cardText(card: Card, board: Board, now = new Date()): string {
  const facts = [
    card.labels.length ? `[${card.labels.join(", ")}]` : "",
    card.assignee ? `assignee: ${card.assignee}` : "",
    card.due ? `due ${card.due}${card.due < today(now) ? " (overdue)" : ""}` : "",
  ].filter(Boolean);
  const lines = [`${card.id} ${quote(card.title)}${facts.length ? ` ${facts.join(", ")}` : ""}`];
  if (card.archived) lines[0] += ` (archived, from ${board.columns.find((c) => c.id === card.column)?.name ?? "a column that is gone"})`;
  if (card.description) lines.push(`   ${cut(card.description, 300)}`);
  const noted = [...card.activity].reverse().find((entry) => entry.note);
  if (noted) lines.push(`   Latest note, by ${who(noted)}: ${cut(noted.note!, 200)}`);
  return lines.join("\n");
}

/** The boards, with how many cards each column holds. */
export function listText(list: BoardList): string {
  if (!list.boards.length) return "There are no boards yet. Make one with kanban_create_board.";
  const lines = list.boards.map((board) => {
    const columns = board.columns.map((c) => `${c.name} ${c.cards}`).join(", ");
    const total = board.columns.reduce((n, c) => n + c.cards, 0);
    return `- ${board.id} ${quote(board.name)}: ${columns} (${total} cards${board.archived ? `, ${board.archived} archived` : ""})${board.description ? `. ${cut(board.description, 160)}` : ""}`;
  });
  return `${list.boards.length === 1 ? "1 board" : `${list.boards.length} boards`}:\n${lines.join("\n")}`;
}

export interface BoardFilter {
  column?: string;
  label?: string;
  assignee?: string;
  archived?: boolean;
}

/** A board: its columns in order, each with its cards top first, as the filter leaves them. */
export function boardText(board: Board, filter: BoardFilter = {}, now = new Date()): string {
  const only = filter.column ? findColumn(board, filter.column) : undefined;
  const label = filter.label?.trim().toLowerCase();
  const assignee = filter.assignee?.trim().toLowerCase();
  const kept = (card: Card) => (!label || card.labels.some((l) => l.toLowerCase() === label)) && (!assignee || card.assignee.toLowerCase() === assignee);
  const said: string[] = [];
  if (label) said.push(`label ${quote(filter.label!.trim())}`);
  if (assignee) said.push(`assignee ${quote(filter.assignee!.trim())}`);
  const lines = [`Board ${board.id} ${quote(board.name)}, version ${board.version}${board.description ? `: ${cut(board.description, 300)}` : ""}`];
  lines.push(`Columns, left to right: ${board.columns.map((c) => `${c.name} (${c.id})`).join(", ")}`);
  if (said.length) lines.push(`Only the cards with ${said.join(" and ")}.`);
  for (const column of only ? [only] : board.columns) {
    const cards = cardsIn(board, column.id).filter(kept);
    lines.push("", `${column.name} (${column.id}): ${cards.length ? (cards.length === 1 ? "1 card" : `${cards.length} cards`) : "no cards"}`);
    cards.forEach((card, i) => lines.push(`${i + 1}. ${cardText(card, board, now)}`));
  }
  const archived = board.cards.filter((c) => c.archived && (!only || c.column === only.id) && kept(c));
  if (filter.archived) {
    lines.push("", `Archived: ${archived.length ? (archived.length === 1 ? "1 card" : `${archived.length} cards`) : "no cards"}`);
    archived.forEach((card) => lines.push(`- ${cardText(card, board, now)}`));
  } else if (archived.length) lines.push("", `${archived.length === 1 ? "1 archived card is" : `${archived.length} archived cards are`} not shown (archived: true shows them).`);
  return lines.join("\n");
}
