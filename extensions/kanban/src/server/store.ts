import { randomBytes } from "node:crypto";
import { promises as fs, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { Board, BoardList } from "../types";
import { makeBoard, renameBoard } from "./board";
import { isId, newId } from "./ids";
import { KanbanError, LIMITS } from "./validate";

/**
 * The boards, kept as JSON in the extension's own folder of the portal's data folder (`portal.dataDir()`), where no
 * agent can reach them: a file for each board, `boards/<id>.json`, and `index.json` with the order of the boards and
 * the board each chat's agent last worked on. Every file is written whole beside its place and renamed over it, so a
 * crash or a full disk leaves the one before.
 *
 * All of them are read once, as the store opens, and kept in memory: what is read is what was last written. Every
 * write goes through one queue, one after the other, whether a page or an agent asked for it: each works on a copy of
 * the board as the write before it left it, and the copy is the board only once its file is written.
 */

interface Index {
  /** Changes when a board is made or deleted. */
  version: number;
  /** The boards' ids, in their order. */
  boards: string[];
  /** The board each chat's agent last worked on, by the chat's id. */
  chats: Record<string, string>;
}

const TEMP = /^\..+\.[0-9a-f]{12}\.tmp$/;

/** Writes `text` to `file` whole: into a file beside it, synced, then renamed over it. */
async function writeWhole(file: string, text: string) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, file);
  } catch (e) {
    // What was written of it, where anything was: the error is the write's, not this.
    await fs.rm(temp, { force: true }).catch(() => {});
    throw e;
  }
}

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

/** Whether what a board's file holds has the shape of one. */
const isBoard = (value: any): value is Board =>
  !!value && typeof value.id === "string" && typeof value.name === "string" && Number.isInteger(value.version) && Array.isArray(value.columns) && Array.isArray(value.cards);

export class KanbanStore {
  private boards = new Map<string, Board>();
  private index: Index = { version: 0, boards: [], chats: {} };
  private queue: Promise<unknown> = Promise.resolve();
  private readonly folder: string;

  private constructor(
    private readonly dir: string,
    private readonly log: (text: string) => void,
  ) {
    this.folder = path.join(dir, "boards");
  }

  /** The store in `dir`, read whole. A board's file that cannot be read is left where it is, and said in the log. */
  static open(dir: string, log: (text: string) => void = () => {}): KanbanStore {
    const store = new KanbanStore(dir, log);
    store.load();
    return store;
  }

  private load() {
    mkdirSync(this.folder, { recursive: true, mode: 0o700 });
    // What a write that was cut off left beside its file.
    for (const at of [this.dir, this.folder]) for (const name of readdirSync(at)) if (TEMP.test(name)) rmSync(path.join(at, name), { force: true });
    const index = readJson(path.join(this.dir, "index.json")) as Partial<Index> | undefined;
    const files = readdirSync(this.folder).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).filter((id) => isId("board", id));
    for (const id of files) {
      const board = readJson(path.join(this.folder, `${id}.json`));
      if (isBoard(board) && board.id === id) this.boards.set(id, board);
      else this.log(`kanban: the file of the board ${id} could not be read, and is left out`);
    }
    // The index's order, then a board whose file was written while the index was not (a write cut off between the two).
    const listed = Array.isArray(index?.boards) ? index.boards.filter((id): id is string => typeof id === "string" && this.boards.has(id)) : [];
    const order = [...new Set(listed), ...[...this.boards.keys()].filter((id) => !listed.includes(id)).sort((a, b) => this.boards.get(a)!.created - this.boards.get(b)!.created)];
    const chats = Object.fromEntries(Object.entries(index?.chats ?? {}).filter(([, board]) => typeof board === "string" && this.boards.has(board)));
    this.index = { version: Number.isInteger(index?.version) ? index!.version! : 0, boards: order, chats };
  }

  /** Runs `work` after every write asked for before it, and before any asked for after. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const done = this.queue.then(work, work);
    this.queue = done.catch(() => {});
    return done;
  }

  /**
   * The index follows the boards' files as soon as they are written or removed, whether its own file is written after
   * them or not: a start lists a board whose file the index does not name, and leaves out one it names that has none.
   */
  private writeIndex(next: Index) {
    this.index = next;
    return writeWhole(path.join(this.dir, "index.json"), JSON.stringify(next, null, 2));
  }

  private writeBoard(board: Board) {
    return writeWhole(path.join(this.folder, `${board.id}.json`), JSON.stringify(board, null, 2)).then(() => {
      this.boards.set(board.id, board);
    });
  }

  /** The boards in their order, with a version of the list: it is another one after any write to any board. */
  list(): BoardList {
    const boards = this.index.boards.map((id) => this.boards.get(id)!);
    const sum = boards.reduce((n, board) => n + board.version, 0);
    return {
      version: `${this.index.version}.${sum}`,
      boards: boards.map((board) => ({
        id: board.id,
        name: board.name,
        description: board.description,
        version: board.version,
        updated: board.updated,
        columns: board.columns.map((column) => ({ ...column, cards: board.cards.filter((c) => c.column === column.id && !c.archived).length })),
        archived: board.cards.filter((c) => c.archived).length,
      })),
    };
  }

  /** A board by its id. */
  board(id: string): Board {
    const board = this.boards.get(id);
    if (!board) throw new KanbanError("missing", `There is no board ${id}`);
    return board;
  }

  /** A board by its id, or by its name (capitals aside: no two boards are called alike). */
  resolve(ref: unknown): Board {
    if (typeof ref !== "string" || !ref.trim()) throw new KanbanError("invalid", "Name a board by its id or its name");
    const want = ref.trim();
    const found = this.boards.get(want) ?? [...this.boards.values()].find((b) => b.name.toLowerCase() === want.toLowerCase());
    if (!found) {
      const known = this.list().boards.map((b) => `${b.name} (${b.id})`).join(", ");
      throw new KanbanError("missing", `There is no board "${want}". ${known ? `The boards: ${known}` : "There are no boards yet."}`);
    }
    return found;
  }

  /** The board a card is on, by the card's id. */
  boardOfCard(card: unknown): Board {
    const id = typeof card === "string" ? card.trim() : "";
    for (const board of this.boards.values()) if (board.cards.some((c) => c.id === id)) return board;
    throw new KanbanError("missing", `There is no card "${String(card)}" on any board`);
  }

  /** A card id that no board has. */
  cardId(): string {
    return newId("card", (id) => [...this.boards.values()].some((b) => b.cards.some((c) => c.id === id)));
  }

  /** The board a chat's agent last worked on, while it is there. */
  touched(chat: string): string | null {
    return this.index.chats[chat] ?? null;
  }

  private nameFree(name: string, except?: string) {
    const same = [...this.boards.values()].find((b) => b.id !== except && b.name.toLowerCase() === name.toLowerCase());
    if (same) throw new KanbanError("conflict", `There is a board called "${same.name}" already (${same.id})`);
  }

  createBoard(input: { name: unknown; description?: unknown; columns?: unknown }): Promise<Board> {
    return this.serial(async () => {
      if (this.boards.size >= LIMITS.boards) throw new KanbanError("conflict", `There can be at most ${LIMITS.boards} boards`);
      const now = Date.now();
      const board = makeBoard(input, newId("board", (id) => this.boards.has(id)), now);
      this.nameFree(board.name);
      board.version = 1;
      // The board first, then the index: a crash between leaves a board the next start finds and lists.
      await this.writeBoard(board);
      await this.writeIndex({ ...this.index, version: this.index.version + 1, boards: [...this.index.boards, board.id] });
      return board;
    });
  }

  /** A change to a board's name or description. */
  renameBoard(id: string, change: { name?: unknown; description?: unknown }): Promise<Board> {
    return this.edit(id, (board) => {
      renameBoard(board, change);
      this.nameFree(board.name, board.id);
    }).then(({ board }) => board);
  }

  deleteBoard(id: string): Promise<void> {
    return this.serial(async () => {
      this.board(id);
      // The file first, then the index: a crash between leaves the index naming a board that the next start leaves out.
      await fs.rm(path.join(this.folder, `${id}.json`), { force: true });
      this.boards.delete(id);
      const chats = Object.fromEntries(Object.entries(this.index.chats).filter(([, board]) => board !== id));
      await this.writeIndex({ version: this.index.version + 1, boards: this.index.boards.filter((b) => b !== id), chats });
    });
  }

  /**
   * A change to a board: `change` is given a copy of the board as the writes before it left it (found by its id, or
   * for a board named by an agent by `find`), and the time, and changes the copy or throws. The copy, with the next
   * version, is the board once it is written.
   */
  edit<T>(id: string | (() => Board), change: (board: Board, now: number) => T): Promise<{ board: Board; result: T }> {
    return this.serial(async () => {
      const current = typeof id === "string" ? this.board(id) : id();
      const board = structuredClone(current);
      const now = Date.now();
      const result = change(board, now);
      board.version = current.version + 1;
      board.updated = now;
      await this.writeBoard(board);
      return { board, result };
    });
  }

  /** Remembers the board a chat's agent worked on last. */
  touch(chat: string, board: string): Promise<void> {
    return this.serial(async () => {
      if (this.index.chats[chat] === board || !this.boards.has(board)) return;
      await this.writeIndex({ ...this.index, chats: { ...this.index.chats, [chat]: board } });
    });
  }

  /** A chat that is gone: what it worked on last is not kept. */
  forgetChat(chat: string): Promise<void> {
    return this.serial(async () => {
      if (!(chat in this.index.chats)) return;
      const { [chat]: _gone, ...chats } = this.index.chats;
      await this.writeIndex({ ...this.index, chats });
    });
  }

  /** Done when every write asked for so far is. */
  idle(): Promise<void> {
    return this.queue.then(() => {});
  }
}
