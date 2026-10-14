import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, RefObject } from "react";
import { GAP, MIN, dockBox, dockSize, type Box } from "../voice-windows";
import { followPointer } from "../pointer-drag";
import { STEP, arrowSteps } from "../resize-keys";

import { t } from "../i18n";
type Edge = "e" | "w" | "s" | "se" | "sw";

/**
 * Where a window sits is decided by the voice stage's layout — centred, at
 * the side, one of two — through classes and transforms. Dragging an edge
 * takes it out of that: the window is pinned where it is, in pixels, and from
 * then on its size is the person's. `clearSize` hands it back to the layout;
 * the stage does that when the arrangement of windows changes.
 *
 * The canvas panel is not placed by the stage but hangs from the top right of
 * its own corner, so it is only given a size: its left edge and its bottom
 * move, and the corner stays.
 */
type ResizeMode = "pin" | "anchored";

/**
 * Sized by hand, and how: `data-sized` holds the ResizeMode — whether the
 * window was pinned where it is or only given a size.
 */
export function clearSize(el: HTMLElement | null) {
  if (!el?.dataset.sized) return;
  for (const p of ["left", "top", "right", "bottom", "width", "height", "transform", "maxWidth", "maxHeight"] as const) el.style[p] = "";
  delete el.dataset.sized;
}

/** Every window a voice stage or a chat can have open, the canvas included. */
export const WINDOWS = ".voice-browser-window.is-open, .voice-terminal-window.is-open, .voice-files-window.is-open, .session-canvases.is-open .canvas-panel";
/** Kept clear at the edges of the area a window lives in. */
const EDGE = 8;

/**
 * The windows open around `root` — a chat's workspace, which holds the voice
 * stage's windows and the canvas — that are there to be seen: not one hidden
 * under a maximized browser. What the orb makes room for and what a window
 * being resized stops at are the same windows.
 */
export function openWindows(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(WINDOWS)].filter(w => {
    const o = w.getBoundingClientRect();
    return o.width > 0 && o.height > 0 && getComputedStyle(w).visibility !== "hidden";
  });
}

/** The chat's workspace: the voice stage's windows and the canvas are all in it. */
export const workspaceOf = (el: Element) => el.closest<HTMLElement>(".session-workspace");
/** The chat's voice stage, for a window in it or for the canvas, which hangs beside it. */
const stageOf = (el: Element) => el.closest<HTMLElement>(".voice-stage") ?? workspaceOf(el)?.querySelector<HTMLElement>(".voice-stage") ?? null;

/**
 * How far a window's edges may go, in the page's coordinates: inside the area
 * it belongs to — the voice stage, or the chat's workspace for the canvas,
 * which hangs over it and would otherwise reach under the sidebar.
 */
export function areaFor(el: HTMLElement): Box {
  const area = (el.closest(".voice-stage") ?? workspaceOf(el))?.getBoundingClientRect() ?? { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  return { left: area.left + EDGE, top: area.top, right: area.right - EDGE, bottom: area.bottom - EDGE };
}

/**
 * What a window being resized must stay clear of (see `clear`): the other
 * windows, the stage's buttons, and the voice dock while the orb is in it.
 * The orb standing free is not one: it moves aside for a window rather than
 * holding one back (see the effect in VoiceStage that places it).
 *
 * Measured once, as the drag begins — nothing else moves while it goes on —
 * but for the dock: the orb can go back to it during the drag, so whether it
 * is there is asked at every move, of the stage's `data-orb`, which needs no
 * layout. Where it is is where the stage's styles put it, not where the orb
 * is on its way there.
 */
function obstaclesFor(el: HTMLElement): () => Box[] {
  const fixed: Box[] = openWindows(workspaceOf(el) ?? document).filter(other => other !== el && !other.contains(el) && !el.contains(other)).map(o => o.getBoundingClientRect());
  const stage = stageOf(el);
  const buttons = stage?.querySelector<HTMLElement>(".voice-utilities")?.getBoundingClientRect();
  if (buttons?.width) fixed.push(buttons);
  const dock = stage && dockBox(stage.getBoundingClientRect(), dockSize(stage));
  return () => (dock && stage.dataset.orb === "dock" ? [...fixed, dock] : fixed);
}

/**
 * The window a drag would make, kept clear of every obstacle.
 *
 * Only the edges being dragged give way, and only toward an obstacle they
 * were clear of when the drag began: one to the right stops the right edge,
 * one to the left the left edge, one below the bottom. One off at a corner
 * could stop either: the one that has to give up less does, so the window
 * slides along the other's edge instead of catching on its corner. No edge is
 * pushed back past where it started.
 *
 * GAP is kept on each side — except where the window already stood closer
 * when the drag began, which is as close as it is kept: a window that ends
 * a few pixels above the dock can still be widened alongside it, over free
 * space, where it would never meet it.
 */
export function clear(from: Box, want: Box, edge: Edge, others: Box[]): Box {
  const out = { ...want };
  // What was kept between the two on one axis: GAP, or less if it stood closer; GAP where they overlap on it.
  const kept = (gap: number) => (gap < 0 ? GAP : Math.min(GAP, gap));
  for (const o of others) {
    const x = kept(Math.max(o.left - from.right, from.left - o.right)), y = kept(Math.max(o.top - from.bottom, from.top - o.bottom));
    if (!(out.left < o.right + x && out.right > o.left - x && out.top < o.bottom + y && out.bottom > o.top - y)) continue;
    const ways: { side: "right" | "left" | "bottom"; to: number; cost: number }[] = [];
    if (edge.includes("e") && o.left >= from.right - 1) ways.push({ side: "right", to: Math.min(out.right, Math.max(from.right, o.left - GAP)), cost: out.right - (o.left - GAP) });
    if (edge.includes("w") && o.right <= from.left + 1) ways.push({ side: "left", to: Math.max(out.left, Math.min(from.left, o.right + GAP)), cost: o.right + GAP - out.left });
    if (edge.includes("s") && o.top >= from.bottom - 1) ways.push({ side: "bottom", to: Math.min(out.bottom, Math.max(from.bottom, o.top - GAP)), cost: out.bottom - (o.top - GAP) });
    const way = ways.sort((a, b) => a.cost - b.cost)[0];
    if (way) out[way.side] = way.to;
  }
  return out;
}

/** Between the smallest a window may be and what there is room for — never more than the room. */
const fit = (want: number, least: number, room: number) => Math.min(room, Math.max(Math.min(least, room), want));

/**
 * Sizing a window by one of its edges: `move` takes the edge as far as the
 * pointer or a key has gone from where it was, and `end` is called once it is
 * let go. Measured once, here: nothing else moves while it goes on.
 */
function sizing(el: HTMLElement, edge: Edge, mode: ResizeMode) {
  const box = el.getBoundingClientRect();
  const area = areaFor(el), obstacles = obstaclesFor(el);
  const parent = (el.offsetParent as HTMLElement | null)?.getBoundingClientRect() ?? { left: 0, top: 0, width: innerWidth, height: innerHeight, right: innerWidth, bottom: innerHeight };
  const start = { left: box.left - parent.left, top: box.top - parent.top, width: box.width, height: box.height };
  // In voice mode a window goes no deeper than just above the dock, where
  // the orb goes back to — whether it is there now or standing free. Dragged
  // to the stage's foot beside an orb standing free, two windows reached
  // under the dock; drawn over the orb, it went back to the dock, over them,
  // and they were lifted clear of it again: a flicker, and a window's foot
  // under the dock's buttons.
  const stage = stageOf(el);
  const floor = stage ? dockBox(stage.getBoundingClientRect(), dockSize(stage)).top - GAP : Infinity;
  // Heard by whatever arranges itself around the windows — the voice orb.
  const moved = () => el.dispatchEvent(new Event("panel-resize", { bubbles: true }));
  // Taken out of the layout only once the pointer moves: a press on an edge
  // that goes nowhere leaves the window, and the orb, as they were.
  let dragging = false;
  const take = () => {
    dragging = true;
    if (mode === "pin") {
      Object.assign(el.style, { left: `${start.left}px`, top: `${start.top}px`, width: `${start.width}px`, height: `${start.height}px`, right: "auto", bottom: "auto", transform: "none" });
    }
    el.style.maxWidth = "none"; el.style.maxHeight = "none";
    el.dataset.sized = mode;
    // No sliding into place while dragging, and no frame under the pointer taking the moves.
    el.style.transition = "none";
    document.body.classList.add("is-resizing");
  };
  const move = (dx: number, dy: number) => {
    if (!dragging && !dx && !dy) return;
    if (!dragging) take();
    // Where the pointer takes each edge, within the area — never pulled in
    // from where it already is — and then clear of what is around it.
    const want = { ...box.toJSON() as Box };
    if (edge.includes("e")) want.right = box.left + fit(start.width + dx, MIN.width, Math.max(area.right, box.right) - box.left);
    if (edge.includes("w")) want.left = box.right - fit(start.width - dx, MIN.width, box.right - Math.min(area.left, box.left));
    if (edge.includes("s")) want.bottom = box.top + fit(start.height + dy, MIN.height, Math.max(Math.min(area.bottom, floor), box.bottom) - box.top);
    const got = clear(box, want, edge, obstacles());
    const width = Math.max(0, got.right - got.left), height = Math.max(0, got.bottom - got.top);
    if (edge.includes("e") || edge.includes("w")) el.style.width = `${width}px`;
    // Growing leftwards: the right edge stays where it was.
    if (edge.includes("w") && mode === "pin") el.style.left = `${start.left + start.width - width}px`;
    if (edge.includes("s")) el.style.height = `${height}px`;
    moved();
  };
  const end = () => {
    if (!dragging) return;
    // The size drawn before the transition is back: a step taken by a key would slide there, and the next step measure it half way.
    void el.offsetWidth;
    el.style.transition = "";
    document.body.classList.remove("is-resizing");
    moved();
  };
  return { move, end };
}

function begin(e: ReactPointerEvent, el: HTMLElement, edge: Edge, mode: ResizeMode) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  const { move, end } = sizing(el, edge, mode);
  // Over when the pointer is let go — or when the window closes mid-drag and
  // takes the handle with it (see followPointer).
  followPointer(e, (ev) => move(ev.clientX - e.clientX, ev.clientY - e.clientY), end);
}

/** The keys of the grip: an arrow takes the edge or corner a step that way, Home, Enter or Space hand the window back to the layout. */
function keys(e: ReactKeyboardEvent, el: HTMLElement, edge: Edge, mode: ResizeMode) {
  const reset = e.key === "Home" || e.key === "Enter" || e.key === " ";
  const dx = arrowSteps(e, "x") * STEP, dy = arrowSteps(e, "y") * STEP;
  if (!reset && !dx && !dy) return;
  e.preventDefault();
  if (reset) {
    clearSize(el);
    return void el.dispatchEvent(new Event("panel-resize", { bubbles: true }));
  }
  // An edge that is not the grip's does not move: Up and Down leave a side grip where it is.
  const { move, end } = sizing(el, edge, mode);
  move(edge.includes("e") || edge.includes("w") ? dx : 0, edge.includes("s") ? dy : 0);
  end();
}

/**
 * Grips on a window's edges and bottom corners. Hidden on phones, where windows take the width.
 * One of them, a bottom corner, is reached with Tab and sized with the arrow keys, for whoever has no pointer.
 */
export function ResizeHandles({ target, mode = "pin", edges = ["e", "w", "s", "se", "sw"] }: { target: RefObject<HTMLElement>; mode?: ResizeMode; edges?: Edge[] }) {
  const name: Record<Edge, string> = { e: t("Drag the right edge to resize"), w: t("Drag the left edge to resize"), s: t("Drag the bottom edge to resize"), se: t("Drag the bottom right corner to resize"), sw: t("Drag the bottom left corner to resize") };
  const keyed = edges.includes("se") ? "se" : edges.includes("sw") ? "sw" : null;
  return <>{edges.map(edge => edge === keyed
    ? <div key={edge} className={`resize-handle resize-${edge}`} role="button" tabIndex={0} title={name[edge]} aria-label={t("Resize the window")}
        aria-description={t("The arrow keys make the window larger or smaller, Home gives it back to the layout.")}
        onPointerDown={e => { if (target.current) begin(e, target.current, edge, mode); }}
        onKeyDown={e => { if (target.current) keys(e, target.current, edge, mode); }} />
    : <div key={edge} className={`resize-handle resize-${edge}`} aria-hidden="true" title={name[edge]}
        onPointerDown={e => { if (target.current) begin(e, target.current, edge, mode); }} />)}</>;
}
