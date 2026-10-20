import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Board, Card } from "../types";
import { placeOf } from "./board-view";

/**
 * Dragging a card with the pointer, within its column and to another. A mouse or a pen drags once it has moved a few
 * pixels; a finger once it has been held still for a moment, so that a finger that moves at once scrolls the board as
 * it always does. While a card is dragged, the board is not scrolled by the touch, and is scrolled by the drag near
 * its edges. A board that snaps to its columns (the page on a phone) turns to the next column instead, once the
 * pointer has stayed near its edge for a moment.
 *
 * Where it would go is found under the pointer: the column (`data-kb-column`) and, among that column's other cards
 * (`data-kb-card`), the first whose middle is below the pointer. Escape, or a drop outside the columns, puts it back.
 */

export interface DropAt {
  column: string;
  /** Among the column's cards that are not archived, the dragged one left out: 0 the top. */
  index: number;
}

export interface Dragging {
  card: Card;
  at: DropAt | null;
  /** Where the pointer is, and where on the card it holds it. */
  x: number;
  y: number;
  dx: number;
  dy: number;
  width: number;
}

/** How far a mouse moves before it drags, and a finger before it scrolls instead; how long a finger holds before it drags. */
const MOUSE_PX = 5;
const FINGER_PX = 8;
const HOLD_MS = 300;
/** How near an edge the pointer scrolls what holds the cards, and how fast at most. */
const EDGE_PX = 48;
const SPEED_PX = 14;
/** How long the pointer stays near an edge of a board that snaps to its columns before it turns to the next. */
const TURN_MS = 600;

/**
 * Whether a finger is dragging a card now. A card says no to the browser's scrolling while it is (CardTile.tsx): the
 * browser asks a card's own touch listener whether to scroll before the touch starts, so a listener added once the
 * drag has begun is asked too late.
 */
let fingerHolding = false;
export const fingerHolds = () => fingerHolding;

/** The place under (x, y), or none outside the columns. */
function dropAt(x: number, y: number, card: string): DropAt | null {
  const column = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-kb-column]");
  if (!column) return null;
  const others = [...column.querySelectorAll<HTMLElement>("[data-kb-card]")].filter((el) => el.dataset.kbCard !== card);
  const below = others.findIndex((el) => {
    const box = el.getBoundingClientRect();
    return y < box.top + box.height / 2;
  });
  return { column: column.dataset.kbColumn!, index: below === -1 ? others.length : below };
}

/** Which way `el` can scroll sideways towards an edge the pointer at `x` is near: -1 left, 1 right, 0 neither. */
function edgeOf(el: HTMLElement, x: number): -1 | 0 | 1 {
  const box = el.getBoundingClientRect();
  if (x - box.left < EDGE_PX && el.scrollLeft > 0) return -1;
  if (box.right - x < EDGE_PX && el.scrollLeft + el.clientWidth < el.scrollWidth) return 1;
  return 0;
}

/** Scrolls `el` towards the edge the pointer is near, and says whether it did. */
function nudge(el: HTMLElement | null, x: number, y: number): boolean {
  if (!el) return false;
  const box = el.getBoundingClientRect();
  const speed = (into: number) => Math.ceil(SPEED_PX * (1 - Math.max(0, into) / EDGE_PX));
  let moved = false;
  if (el.scrollWidth > el.clientWidth) {
    const left = x - box.left;
    const right = box.right - x;
    if (left < EDGE_PX && el.scrollLeft > 0) ((el.scrollLeft -= speed(left)), (moved = true));
    else if (right < EDGE_PX && el.scrollLeft + el.clientWidth < el.scrollWidth) ((el.scrollLeft += speed(right)), (moved = true));
  }
  if (el.scrollHeight > el.clientHeight) {
    const top = y - box.top;
    const bottom = box.bottom - y;
    if (top < EDGE_PX && el.scrollTop > 0) ((el.scrollTop -= speed(top)), (moved = true));
    else if (bottom < EDGE_PX && el.scrollTop + el.clientHeight < el.scrollHeight) ((el.scrollTop += speed(bottom)), (moved = true));
  }
  return moved;
}

/**
 * `onDrop` is given the card and where it was let go, when that is another place than it was. `hold` keeps the board
 * as it is shown while the card is dragged (see use-board.ts). `scroller` is what holds the columns.
 */
export function useCardDrag({ board, onDrop, hold, scroller }: { board: Board | null; onDrop: (card: Card, at: DropAt) => void; hold: () => () => void; scroller: () => HTMLElement | null }) {
  const [dragging, setDragging] = useState<Dragging | null>(null);
  const live = useRef<{ end: () => void } | null>(null);
  const latest = useRef({ board, onDrop, hold, scroller });
  latest.current = { board, onDrop, hold, scroller };

  // Whatever is going on ends with the part that drew it.
  useEffect(() => () => live.current?.end(), []);

  const grab = useCallback((card: Card, e: ReactPointerEvent<HTMLElement>) => {
    if (live.current || (e.pointerType === "mouse" && e.button !== 0) || (e.target as Element).closest("[data-kb-nodrag]")) return;
    const el = e.currentTarget;
    const finger = e.pointerType === "touch";
    const pointer = e.pointerId;
    const start = { x: e.clientX, y: e.clientY };
    let last = start;
    let started = false;
    let armed = !finger;
    let release: (() => void) | null = null;
    let current: Dragging | null = null;
    let frame = 0;
    let timer = 0;
    /** Whether what holds the columns snaps to them; since when the pointer has been near its edge (0: it is not). */
    let snaps = false;
    let near = 0;

    const set = (next: Dragging | null) => {
      current = next;
      setDragging(next);
    };
    const begin = () => {
      started = true;
      fingerHolding = finger;
      release = latest.current.hold();
      const box = el.getBoundingClientRect();
      const from = latest.current.board ? placeOf(latest.current.board, card) : null;
      set({ card, at: from, x: last.x, y: last.y, dx: last.x - box.left, dy: last.y - box.top, width: box.width });
      const holder = latest.current.scroller();
      snaps = !!holder && getComputedStyle(holder).scrollSnapType !== "none";
      document.documentElement.classList.add("kb-dragging");
      frame = requestAnimationFrame(scroll);
    };
    // Near an edge, what holds the cards scrolls, and so does the column under the pointer.
    const scroll = () => {
      if (!current) return;
      const holder = latest.current.scroller();
      const column = document.elementFromPoint(last.x, last.y)?.closest<HTMLElement>("[data-kb-column]")?.querySelector<HTMLElement>("[data-kb-cards]") ?? null;
      const moved = snaps ? turn(holder) : nudge(holder, last.x, last.y);
      if (!moved) nudge(column, last.x, last.y);
      frame = requestAnimationFrame(scroll);
    };
    // Scrolled a little at a time, a board that snaps to its columns would snap back to the one it is on: it turns a
    // whole column, and the browser puts it in place.
    const turn = (holder: HTMLElement | null) => {
      const way = holder && edgeOf(holder, last.x);
      if (!holder || !way) {
        near = 0;
        return false;
      }
      const now = performance.now();
      if (!near) near = now;
      if (now - near < TURN_MS) return false;
      near = now;
      holder.scrollBy({ left: way * holder.clientWidth, behavior: "smooth" });
      return true;
    };
    // What is under the pointer changes as anything under it scrolls: the place is found again.
    const scrolled = () => {
      if (current) set({ ...current, at: dropAt(last.x, last.y, card.id) });
    };
    const end = () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", end);
      document.removeEventListener("contextmenu", still);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("scroll", scrolled, true);
      document.documentElement.classList.remove("kb-dragging");
      fingerHolding = false;
      live.current = null;
      if (started) set(null);
      release?.();
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointer) return;
      last = { x: ev.clientX, y: ev.clientY };
      const far = Math.hypot(last.x - start.x, last.y - start.y);
      if (!started) {
        // A finger that moves before it was held long enough is scrolling.
        if (!armed && far > FINGER_PX) return end();
        if (armed && far > MOUSE_PX) begin();
        return;
      }
      set({ ...current!, x: last.x, y: last.y, at: dropAt(last.x, last.y, card.id) });
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== pointer) return;
      const at = current?.at;
      const was = started;
      end();
      if (!was) return;
      // The click that follows letting go is not a click on the card.
      const swallow = (c: MouseEvent) => (c.stopPropagation(), c.preventDefault());
      window.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", swallow, true), 0);
      const { board: now } = latest.current;
      const from = now?.cards.find((c) => c.id === card.id);
      if (!at || !now || !from) return;
      const place = placeOf(now, from);
      if (place.column !== at.column || place.index !== at.index) latest.current.onDrop(from, at);
    };
    // No menu comes up for the long press of a finger that drags.
    const still = (ev: Event) => {
      if (armed && finger) ev.preventDefault();
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || !started) return;
      ev.preventDefault();
      ev.stopPropagation();
      end();
    };

    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", end);
    document.addEventListener("contextmenu", still);
    document.addEventListener("keydown", key, true);
    document.addEventListener("scroll", scrolled, true);
    if (finger)
      timer = window.setTimeout(() => {
        armed = true;
        begin();
      }, HOLD_MS);
    live.current = { end };
  }, []);

  return { dragging, grab };
}
