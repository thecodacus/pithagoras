import type { Board, BoardList } from "../types";
import { portal } from "../portal";

/**
 * What the page and the panel ask of Kanban's server half, at the address the portal gives the package
 * (`portal.api.url`). A change answers with the board as it is after it.
 */

/** A JSON route of the server half. */
const call = <T>(path: string, init?: RequestInit): Promise<T> => portal.api.json<T>(portal.api.url(path), init);
const send = <T>(method: string, path: string, body?: unknown): Promise<T> => call<T>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const at = (id: string) => `/boards/${encodeURIComponent(id)}`;
const card = (board: string, id: string) => `${at(board)}/cards/${encodeURIComponent(id)}`;
const column = (board: string, id: string) => `${at(board)}/columns/${encodeURIComponent(id)}`;

/** What a list or a board is answered with when the page has it as it is: only its version. */
export type Unchanged = { unchanged: true };

/** What an edit of a card on the page sends: the fields the person changed. */
export type CardPatch = Partial<{ title: string; description: string; labels: string[]; assignee: string; due: string | null }>;

export const api = {
  /** The boards; with `have`, the version of the list the page has, only `unchanged` while it is that. */
  list: (have?: string) => call<BoardList | Unchanged>(`/boards${have ? `?have=${encodeURIComponent(have)}` : ""}`),
  /** A board; with `have`, the version the page has, only `unchanged` while it is that. */
  board: (id: string, have?: number) => call<Board | Unchanged>(`${at(id)}${have !== undefined ? `?have=${have}` : ""}`),
  createBoard: (name: string) => send<Board>("POST", "/boards", { name }),
  renameBoard: (id: string, change: { name?: string; description?: string }) => send<Board>("PATCH", at(id), change),
  deleteBoard: (id: string) => send<{ deleted: string }>("DELETE", at(id)),

  addColumn: (board: string, name: string) => send<Board>("POST", `${at(board)}/columns`, { name }),
  renameColumn: (board: string, id: string, name: string) => send<Board>("PATCH", column(board, id), { name }),
  moveColumn: (board: string, id: string, index: number) => send<Board>("POST", `${column(board, id)}/move`, { index }),
  /** `to`: the column its cards go to, where it has any. */
  removeColumn: (board: string, id: string, to?: string) => send<Board>("DELETE", `${column(board, id)}${to ? `?to=${encodeURIComponent(to)}` : ""}`),

  addCard: (board: string, columnId: string, title: string) => send<Board>("POST", `${at(board)}/cards`, { column: columnId, title }),
  editCard: (board: string, id: string, patch: CardPatch) => send<Board>("PATCH", card(board, id), patch),
  /** `index`: its place among the column's cards that are not archived, 0 the top. */
  moveCard: (board: string, id: string, columnId: string, index: number) => send<Board>("POST", `${card(board, id)}/move`, { column: columnId, index }),
  archiveCard: (board: string, id: string) => send<Board>("POST", `${card(board, id)}/archive`),
  restoreCard: (board: string, id: string) => send<Board>("POST", `${card(board, id)}/restore`),
  noteCard: (board: string, id: string, text: string) => send<Board>("POST", `${card(board, id)}/notes`, { text }),
  deleteCard: (board: string, id: string) => send<Board>("DELETE", card(board, id)),

  /** The board a chat's agent last worked on with a tool, while it is there. */
  touched: (chat: string) => call<{ board: string | null }>(`/chats/${encodeURIComponent(chat)}/board`),
};
