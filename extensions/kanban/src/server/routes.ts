import type { Request, RequestHandler, Response, Router } from "express";
import type { Actor } from "../types";
import { addCard, addColumn, archiveCard, columnId, deleteCard, editCard, moveCard, moveColumn, noteCard, removeColumn, renameColumn, restoreCard } from "./board";
import type { KanbanStore } from "./store";
import { KanbanError, index } from "./validate";

/**
 * The page's routes, at /api/x/pithagoras-kanban/…: the boards, and what the page does to one. A change answers with
 * the board as it is after it, with its version. Asked with `?have=<version>`, a board, or the list of boards, that is
 * still at that version is answered with only its version and `unchanged`, which is what the page asks every few
 * seconds while it is open.
 *
 * What the person does here is theirs in a card's activity. Deleting a board or a card is done only here: the agent's
 * tools cannot.
 */

const STATUS: Record<KanbanError["code"], number> = { invalid: 400, missing: 404, conflict: 409 };
const PERSON: Actor = { kind: "person" };

export function routes(router: Router, json: RequestHandler, store: KanbanStore, log: (text: string) => void) {
  /** Answers with what `work` gives, or with why it was refused. */
  const answer = (work: (req: Request) => unknown) => async (req: Request, res: Response) => {
    try {
      res.json(await work(req));
    } catch (e) {
      if (e instanceof KanbanError) res.status(STATUS[e.code]).json({ error: e.message, code: e.code });
      else {
        log(`kanban: ${(e as Error).message}`);
        res.status(500).json({ error: "The board could not be saved" });
      }
    }
  };
  const body = (req: Request): Record<string, unknown> => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) throw new KanbanError("invalid", "The request has no JSON body");
    return req.body;
  };
  const boardId = (req: Request) => String(req.params.board);
  /** A change to the board the address names, answered with the board after it. */
  const change = (work: (req: Request) => Parameters<KanbanStore["edit"]>[1]) =>
    answer(async (req) => (await store.edit(boardId(req), work(req))).board);

  router.get(
    "/boards",
    answer((req) => {
      const list = store.list();
      return req.query.have === list.version ? { version: list.version, unchanged: true } : list;
    }),
  );
  router.post(
    "/boards",
    json,
    answer((req) => {
      const { name, description, columns } = body(req);
      return store.createBoard({ name, description, columns });
    }),
  );
  router.get(
    "/boards/:board",
    answer((req) => {
      const board = store.board(boardId(req));
      return req.query.have === String(board.version) ? { version: board.version, unchanged: true } : board;
    }),
  );
  router.patch(
    "/boards/:board",
    json,
    answer((req) => {
      const { name, description } = body(req);
      return store.renameBoard(boardId(req), { name, description });
    }),
  );
  router.delete(
    "/boards/:board",
    answer(async (req) => {
      await store.deleteBoard(boardId(req));
      return { deleted: boardId(req) };
    }),
  );

  // Columns.
  router.post(
    "/boards/:board/columns",
    json,
    change((req) => {
      const { name, index: at } = body(req);
      return (board) => addColumn(board, name, columnId(board), index(at));
    }),
  );
  router.patch(
    "/boards/:board/columns/:column",
    json,
    change((req) => {
      const { name } = body(req);
      return (board) => renameColumn(board, req.params.column, name);
    }),
  );
  router.post(
    "/boards/:board/columns/:column/move",
    json,
    change((req) => {
      const at = index(body(req).index);
      if (at === undefined) throw new KanbanError("invalid", "Say where the column goes: index");
      return (board) => moveColumn(board, req.params.column, at);
    }),
  );
  router.delete(
    "/boards/:board/columns/:column",
    change((req) => (board) => removeColumn(board, req.params.column, req.query.to === undefined ? undefined : String(req.query.to))),
  );

  // Cards.
  router.post(
    "/boards/:board/cards",
    json,
    change((req) => {
      const { title, description, labels, assignee, due, column, index: at } = body(req);
      const place = index(at);
      return (board, now) => addCard(board, { title, description, labels, assignee, due, column, at: place }, store.cardId(), PERSON, now);
    }),
  );
  router.patch(
    "/boards/:board/cards/:card",
    json,
    change((req) => {
      const { title, description, labels, assignee, due } = body(req);
      return (board, now) => editCard(board, req.params.card, { title, description, labels, assignee, due }, PERSON, now);
    }),
  );
  router.post(
    "/boards/:board/cards/:card/move",
    json,
    change((req) => {
      const { column, index: at } = body(req);
      const place = index(at);
      return (board, now) => moveCard(board, req.params.card, column, place, PERSON, now);
    }),
  );
  router.post(
    "/boards/:board/cards/:card/archive",
    change((req) => (board, now) => archiveCard(board, req.params.card, PERSON, now)),
  );
  router.post(
    "/boards/:board/cards/:card/restore",
    change((req) => (board, now) => restoreCard(board, req.params.card, PERSON, now)),
  );
  router.post(
    "/boards/:board/cards/:card/notes",
    json,
    change((req) => {
      const { text } = body(req);
      return (board, now) => noteCard(board, req.params.card, text, PERSON, now);
    }),
  );
  router.delete(
    "/boards/:board/cards/:card",
    change((req) => (board) => deleteCard(board, req.params.card)),
  );

  /** The board this chat's agent last worked on with a tool, for its panel to open on. */
  router.get(
    "/chats/:chat/board",
    answer((req) => ({ board: store.touched(String(req.params.chat)) })),
  );
}
