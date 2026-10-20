/**
 * A board as the server half keeps it and the page draws it: what the routes answer with, and what each board's file
 * holds. Types only, shared by both halves.
 */

/** Who did something: the person in the portal, or an agent, known by the chat whose tool did it. */
export type Actor = { kind: "person" } | { kind: "agent"; chat: { id: string; title: string } };

/** The fields of a card that an edit can change, as its activity names them. */
export type CardField = "title" | "description" | "labels" | "assignee" | "due";

/** One thing done to a card, kept in its activity. */
export interface Activity {
  /** When, in milliseconds as `Date.now()` counts them. */
  at: number;
  by: Actor;
  did: "created" | "edited" | "moved" | "archived" | "restored" | "noted";
  /** For `created` and `restored`: the column it is in, by its name then. */
  column?: string;
  /** For `moved`: the columns it went from and to, by their names then. */
  from?: string;
  to?: string;
  /** For `edited`: what changed. */
  fields?: CardField[];
  /** What was said with it: a progress note. All of a `noted`. */
  note?: string;
}

export interface Card {
  id: string;
  title: string;
  /** Plain text, or Markdown shown as its text. */
  description: string;
  labels: string[];
  /** A person or an agent, as free text; empty for nobody. */
  assignee: string;
  /** A day, `YYYY-MM-DD`, or none. */
  due: string | null;
  /** The id of the column it is in. An archived card keeps its column, for when it is restored. */
  column: string;
  archived: boolean;
  created: number;
  updated: number;
  /** Oldest first; only the newest are kept (see ACTIVITY_KEPT). */
  activity: Activity[];
}

export interface Column {
  id: string;
  name: string;
}

export interface Board {
  id: string;
  name: string;
  description: string;
  /** Changes with every write to the board: a page that has this one has the board as it is. */
  version: number;
  created: number;
  updated: number;
  /** Left to right. */
  columns: Column[];
  /** In their order: a column's cards are those with its id, top first. */
  cards: Card[];
}

/** A board in the list of boards: what its switcher and the agent's list of boards need. */
export interface BoardSummary {
  id: string;
  name: string;
  description: string;
  version: number;
  updated: number;
  /** Each column, with how many cards are in it that are not archived. */
  columns: { id: string; name: string; cards: number }[];
  archived: number;
}

/** The list of boards, in their order, and a version of the whole list that changes with every write to any board. */
export interface BoardList {
  version: string;
  boards: BoardSummary[];
}
