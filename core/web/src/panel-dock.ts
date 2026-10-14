/**
 * Where the panels beside a chat go — the browser, Files, the terminal, Git
 * and the subagents: docked at the conversation's right, left or bottom, or
 * floating over it in a window that can be moved and sized. Each is carried
 * there by its header and dropped: at an edge it docks there, anywhere else
 * it floats where it was let go. Each goes on its own, so the terminal can
 * sit at the left while Files is at the right (see Places).
 *
 * Docked at the right is how they always were. At the bottom they take the
 * width under the conversation, and two of them sit side by side rather than
 * one above the other. Not at the top: there they came between the chat's
 * title and the conversation, and covered the conversation's start.
 * Floating, the window is kept inside the chat, however the chat is resized
 * after it was placed.
 *
 * Kept per browser, like the panels' width: where they go is a preference,
 * not something about one chat.
 */
export type Dock = "right" | "left" | "bottom" | "float";

const DOCKS: Dock[] = ["right", "left", "bottom", "float"];

export const isDock = (value: unknown): value is Dock => DOCKS.includes(value as Dock);

/** At the bottom: the panels take the width, and sit side by side. */
export const across = (dock: Dock) => dock === "bottom";

/**
 * What the conversation keeps beside docked panels: 320px of width, and 260px
 * of height — its composer and a few lines above it. The panels are held to
 * it however large they were made (the aside's max sizes in Chat), so a chat
 * made smaller by a window or the keyboard does not lose its composer.
 */
export const KEEP = { w: 320, h: 260 };
/** The least docked panels are made: at a side, and at the bottom. */
export const DOCKED_MIN = { w: 320, h: 160 };
/** Where the edge between two panels in one place starts, and the least either may have of the room. */
export const SPLIT = 0.55;
export const SPLIT_LEAST = 0.15;

/**
 * The size docked panels are dragged to in a chat of `area`'s size: no more
 * than leaves the conversation its room, and no less than of use — the
 * least winning where the chat is too small for both, so that what is kept
 * is never a height below it, or below nothing.
 */
export function dockedSize(want: { width: number; height: number }, area: { w: number; h: number }) {
  return {
    width: Math.round(Math.max(DOCKED_MIN.w, Math.min(want.width, area.w - KEEP.w))),
    height: Math.round(Math.max(DOCKED_MIN.h, Math.min(want.height, area.h - KEEP.h))),
  };
}

/** A floating window, in px from the chat's top left corner. */
export type Frame = { x: number; y: number; w: number; h: number };

/** Smaller than this a panel is no use: a header and a few lines. */
const FRAME_MIN = { w: 320, h: 200 };
/** Kept clear around a floating window placed for the first time. */
const MARGIN = 16;

/** What storage holds under a key, parsed, when it is an object: null for anything else. */
function readObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as unknown;
    return stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const isNumber = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** A frame, or null for anything that is not one. */
function toFrame(value: unknown): Frame | null {
  const f = value as Partial<Frame> | null;
  return f && typeof f === "object" && [f.x, f.y, f.w, f.h].every(isNumber) ? { x: f.x!, y: f.y!, w: f.w!, h: f.h! } : null;
}

/** A frame read back from storage, or null for anything that is not one. */
export const readFrame = (raw: string | null | undefined): Frame | null => toFrame(readObject(raw));

const clamp = (value: number, least: number, most: number) => Math.min(most, Math.max(least, value));

/**
 * Where a floating window goes in a chat of `area`'s size: where it was put,
 * made to fit — no larger than the chat, no smaller than it may be unless the
 * chat itself is, and wholly inside it. With nowhere put yet, at the top right,
 * where the docked panels were, and ending above the composer — the room
 * docked panels leave it (KEEP): it covered Send and Stop, and nothing could
 * be sent until it was moved.
 */
export function fitFrame(frame: Frame | null, area: { w: number; h: number }): Frame {
  const want = frame ?? { w: 520, h: 560, x: Infinity, y: MARGIN };
  const w = clamp(want.w, Math.min(FRAME_MIN.w, area.w), area.w);
  const least = Math.min(FRAME_MIN.h, area.h);
  const most = frame ? area.h : Math.min(Math.max(least, area.h - KEEP.h - MARGIN), Math.max(0, area.h - 2 * MARGIN));
  const h = clamp(want.h, least, most);
  const x = clamp(frame ? want.x : area.w - w - MARGIN, 0, area.w - w);
  const y = clamp(want.y, 0, area.h - h);
  return { x, y, w, h };
}

/**
 * Where panels carried to `at` (in px from the chat's top left) would go if
 * let go there: docked at the edge it is near, or floating. The edges reach
 * in far enough to hit without aiming, and no further than a sixth of the
 * chat, so that the middle is left for floating.
 */
export function dropTarget(at: { x: number; y: number }, area: { w: number; h: number }): Dock {
  const across = Math.min(96, area.w / 6), up = Math.min(96, area.h / 6);
  if (at.x <= across) return "left";
  if (at.x >= area.w - across) return "right";
  if (at.y >= area.h - up) return "bottom";
  return "float";
}

/**
 * Each panel goes where it was carried: the terminal at the left and Files at
 * the right, say. One that was never carried anywhere goes where all of them
 * went before they were placed one by one (`panelDock`), so that nothing moves
 * for someone who kept them on one side. Panels in the same place share it as
 * before: one above the other at a side, side by side at the bottom. Each
 * one floating has a window of its own (see Frames).
 */
export type Places = Partial<Record<string, Dock>>;

/** Places read back from storage: only those that are places a panel can go. */
export function readPlaces(raw: string | null | undefined): Places {
  return Object.fromEntries(Object.entries(readObject(raw) ?? {}).filter(([, place]) => isDock(place))) as Places;
}

/** A width at a side, a height at the bottom. */
export type Size = { width: number; height: number };

/**
 * The size of each place, kept by the place rather than by the panels in it:
 * a side made 400px wide stays so whichever panels are opened there, and a
 * panel carried to it takes that width.
 */
export type PlaceSizes = { left?: number; right?: number; bottom?: number; lead?: "left" | "right" };

/** Place sizes read back from storage: a height no smaller than docked panels are drawn, a width of anything. */
export function readPlaceSizes(raw: string | null | undefined): PlaceSizes {
  const stored = readObject(raw) ?? {};
  const sizes: PlaceSizes = {};
  for (const place of ["left", "right", "bottom"] as const) {
    const n = stored[place];
    // A side may have been made narrower than of use where both sides gave
    // way to each other (see fitSides): kept so, it is drawn as it was left.
    if (isNumber(n) && (place === "bottom" ? n >= DOCKED_MIN.h : n > 0)) sizes[place] = n;
  }
  if (stored.lead === "left" || stored.lead === "right") sizes.lead = stored.lead;
  return sizes;
}

/** The panels open, in their order, gathered by the place each goes: left, right, bottom, then floating. */
export function groupPanels<K extends string>(kinds: readonly K[], placeOf: (kind: K) => Dock): { place: Dock; kinds: K[] }[] {
  return DOCKS_IN_ORDER.map((place) => ({ place, kinds: kinds.filter((k) => placeOf(k) === place) })).filter((g) => g.kinds.length > 0);
}
const DOCKS_IN_ORDER: Dock[] = ["left", "right", "bottom", "float"];

/** The edge between docked panels and the conversation, which sizes them. */
export const EDGE = 4;

/**
 * The widths panels at the left and at the right are drawn at in a chat `w`
 * wide: each as it was made, unless together — with their edges — they
 * would leave the conversation less than its 320px. Then they give way: the
 * side sized last (`lead`) keeps its width, and the other gives way first,
 * as far as the least of use (or less, where it was made so, or the room is);
 * then the one sized last too. Neither sized yet, both in proportion to
 * their widths. It is what the page does itself (see sideStyle in Chat),
 * worked out here for what a drop would show.
 */
export function fitSides(left: number, right: number, w: number, lead?: "left" | "right"): { left: number; right: number } {
  const room = Math.max(0, w - KEEP.w - (left ? EDGE : 0) - (right ? EDGE : 0));
  if (left + right <= room) return { left, right };
  if (lead && left && right) {
    const other = lead === "left" ? right : left;
    const given = Math.max(Math.min(DOCKED_MIN.w, other, room), room - (lead === "left" ? left : right));
    return lead === "left" ? { left: room - given, right: given } : { left: given, right: room - given };
  }
  const scale = room / (left + right);
  return { left: left * scale, right: right * scale };
}

/**
 * Where a panel carried to `dock` would sit in the chat, as a frame — what a
 * drop there shows, as it would be drawn. `size` is the size it would have
 * there, and `others` the widths wanted at the sides without it: panels at a
 * side give way to the other side as fitSides has them, and panels at the
 * bottom sit under the conversation, between the sides.
 */
export function dockedFrameAmong(
  dock: Exclude<Dock, "float">,
  area: { w: number; h: number },
  size: Size,
  others: { left: number; right: number },
  lead?: "left" | "right",
): Frame {
  if (dock === "bottom") {
    const sides = fitSides(others.left, others.right, area.w, lead);
    const x = sides.left + (sides.left ? EDGE : 0), end = area.w - sides.right - (sides.right ? EDGE : 0);
    const h = Math.max(0, Math.min(size.height, area.h - KEEP.h));
    return { x, y: area.h - h, w: Math.max(0, end - x), h };
  }
  const sides = dock === "left" ? fitSides(size.width, others.right, area.w, lead) : fitSides(others.left, size.width, area.w, lead);
  const w = sides[dock];
  return { x: dock === "left" ? 0 : area.w - w, y: 0, w, h: area.h };
}

/** Where each floating panel was put, by panel: each floats in a window of its own. */
export type Frames = Partial<Record<string, Frame>>;

/** Frames read back from storage: only those that are frames. */
export function readFrames(raw: string | null | undefined): Frames {
  const frames: Frames = {};
  for (const [kind, value] of Object.entries(readObject(raw) ?? {})) {
    const f = toFrame(value);
    if (f) frames[kind] = f;
  }
  return frames;
}

/** How far a window put where another already is goes aside, down and to the left. */
const SPREAD = 32;

/**
 * Windows that would lie exactly on one another — two panels that floated
 * together before each had a window, both where that one was — are put
 * aside, each after the first a step down and to the left, so that both
 * are seen. The rest are where they were put.
 */
export function spreadFrames(frames: readonly Frame[], area: { w: number; h: number }): Frame[] {
  const out: Frame[] = [];
  for (const f of frames) {
    let g = f;
    const covers = () => out.some((o) => Math.abs(o.x - g.x) < 1 && Math.abs(o.y - g.y) < 1);
    for (let step = 1; covers() && step <= frames.length + 1; step++) {
      g = fitFrame({ ...f, x: f.x - SPREAD * step, y: f.y + SPREAD * step }, area);
      // Held at a corner of the chat: the other way.
      if (covers()) g = fitFrame({ ...f, x: f.x + SPREAD * step, y: f.y - SPREAD * step }, area);
    }
    out.push(g);
  }
  return out;
}
