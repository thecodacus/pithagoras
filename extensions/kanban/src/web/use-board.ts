import { useCallback, useEffect, useRef, useState } from "react";
import type { Board, BoardList } from "../types";
import { portal } from "../portal";
import { api } from "./api";

/**
 * The boards as the server half has them, kept up to date while the page or the panel is visible: the version of what
 * is shown is asked for every few seconds, which is answered with only the version while nothing changed, and at once
 * when the page becomes visible again. What an agent does shows up by itself.
 */

/** How often the version of what is shown is asked for. */
export const EVERY_MS = 3000;

/** Why a request failed, in words. */
export const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Calls `look` every `every` ms while the page is visible, and at once when it becomes visible again. */
function useWhileVisible(look: () => void, every = EVERY_MS) {
  const latest = useRef(look);
  latest.current = look;
  useEffect(() => {
    let timer: number | undefined;
    const later = () => {
      window.clearTimeout(timer);
      if (document.visibilityState === "visible") timer = window.setTimeout(now, every);
    };
    const now = () => {
      latest.current();
      later();
    };
    const seen = () => (document.visibilityState === "visible" ? now() : window.clearTimeout(timer));
    document.addEventListener("visibilitychange", seen);
    later();
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", seen);
    };
  }, [every]);
}

/**
 * One request at a time: asked while one is out, it is asked again once that one is back, so that a look asked for
 * after a change is not lost in one that started before it.
 */
function useOneAtATime(work: () => Promise<void>) {
  const out = useRef(false);
  const again = useRef(false);
  const latest = useRef(work);
  latest.current = work;
  return useCallback(async () => {
    if (out.current) {
      again.current = true;
      return;
    }
    out.current = true;
    try {
      do {
        again.current = false;
        await latest.current();
      } while (again.current);
    } finally {
      out.current = false;
    }
  }, []);
}

/** The list of boards. `refresh` asks for it at once: after a board was made, renamed or deleted here. */
export function useBoardList() {
  const [list, setList] = useState<BoardList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const have = useRef<string>();
  const refresh = useOneAtATime(async () => {
    try {
      const got = await api.list(have.current);
      if (!("unchanged" in got)) {
        have.current = got.version;
        setList(got);
      }
      setError(null);
    } catch (e) {
      setError(reason(e));
    }
  });
  useEffect(() => void refresh(), [refresh]);
  useWhileVisible(refresh);
  return { list, error, refresh };
}

export interface BoardState {
  board: Board | null;
  /** It could not be fetched; `gone` when there is no such board. */
  error: string | null;
  gone: boolean;
  /** Shows a board a change made here answered with, unless a newer one is shown already. */
  apply(board: Board): void;
  /** Shows the board as it is after a change made here, before the server has answered: a card dropped where it was dropped. */
  preview(board: Board): void;
  /** Asks for the board at once. */
  refresh(): Promise<void>;
  /**
   * Keeps what is shown as it is, while a card is being dragged or a move made here is on its way: the newest board
   * that comes meanwhile is shown when the returned function is called. Returns that function.
   */
  hold(): () => void;
}

/** A board, by its id, kept up to date (see above); nothing for no board. */
export function useBoard(id: string | null): BoardState {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const shown = useRef<Board | null>(null);
  const held = useRef(0);
  const waiting = useRef<Board | null>(null);
  /** What is shown is a change made here that the server has not answered yet: it is not the board at its version. */
  const previewed = useRef(false);
  const wanted = useRef(id);
  wanted.current = id;

  const show = useCallback((next: Board) => {
    if (next.id !== wanted.current) return;
    const now = shown.current;
    // An answer that left before a later change came back after it: what is shown is newer.
    if (now?.id === next.id && next.version < now.version) return;
    if (held.current) {
      if (!waiting.current || waiting.current.version <= next.version) waiting.current = next;
      return;
    }
    shown.current = next;
    previewed.current = false;
    setBoard(next);
  }, []);

  const refresh = useOneAtATime(async () => {
    const asked = wanted.current;
    if (!asked) return;
    try {
      const have = shown.current?.id === asked && !previewed.current ? shown.current.version : undefined;
      const got = await api.board(asked, have);
      if (asked !== wanted.current) return;
      if (!("unchanged" in got)) show(got);
      setError(null);
      setGone(false);
    } catch (e) {
      if (asked !== wanted.current) return;
      setError(reason(e));
      setGone(e instanceof portal.api.ApiError && e.status === 404);
    }
  });

  useEffect(() => {
    shown.current = null;
    waiting.current = null;
    previewed.current = false;
    setBoard(null);
    setError(null);
    setGone(false);
    void refresh();
  }, [id, refresh]);
  useWhileVisible(refresh);

  const preview = useCallback((next: Board) => {
    shown.current = next;
    previewed.current = true;
    setBoard(next);
  }, []);
  const hold = useCallback(() => {
    held.current++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      held.current--;
      const next = waiting.current;
      if (!held.current && next) {
        waiting.current = null;
        show(next);
      }
    };
  }, [show]);

  return { board, error, gone, apply: show, preview, refresh, hold };
}
