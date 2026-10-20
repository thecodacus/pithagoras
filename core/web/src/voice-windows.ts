/**
 * Where the windows go in voice mode: one in the middle, one at the side.
 *
 * A window an extension brought (`x:<extension>/<id>`) that says where it
 * goes (`place`) is placed first, at the side or in the middle, and in the
 * other place when that one is taken: the terminal's asks for the side. The
 * conversation and pictures fill whichever is left, the side first — beside a
 * full orb, which moves over for it — and the middle when the side is taken,
 * and an extension's window that does not say where it goes (Files') after
 * them. At most two are open at once (see use-work-panels.ts), so there is
 * always a place.
 */
export type VoiceWindow = "pictures" | "conversation" | `x:${string}`;

export function placeWindows(
  open: Partial<Record<VoiceWindow, boolean>>,
  /** Where a window an extension brought goes when it has the choice (its entry's `place`). */
  wants: Partial<Record<VoiceWindow, "side" | "middle">> = {},
): { main?: VoiceWindow; side?: VoiceWindow } {
  let main: VoiceWindow | undefined;
  let side: VoiceWindow | undefined;
  const brought = (Object.keys(open) as VoiceWindow[]).filter((window) => window.startsWith("x:") && open[window]);
  // One that says where it goes is placed before those that take whatever is left; where its place is taken, it has
  // the other.
  for (const window of brought) {
    const want = wants[window];
    if (!want) continue;
    if (want === "side") {
      if (!side) side = window;
      else if (!main) main = window;
    } else if (!main) main = window;
    else if (!side) side = window;
  }
  for (const window of ["conversation", "pictures", ...brought.filter((window) => !wants[window])] as const) {
    if (!open[window]) continue;
    if (!side) side = window;
    else if (!main) main = window;
  }
  return { main, side };
}

/** The orb and its buttons, standing on their own, need about this much width. */
const PRESENCE_WIDTH = 280;

/**
 * The widest stretch across the stage that no window covers, when the orb
 * fits in it — where it goes once windows have been sized by hand, as it
 * would with nothing open. Null when there is no such stretch: the orb then
 * waits in its dock under the windows.
 *
 * Only across: the windows take the stage's height, so a gap between them
 * runs from top to bottom.
 */
export function freeStrip(stage: { left: number; right: number }, windows: { left: number; right: number }[], least = PRESENCE_WIDTH): { center: number; width: number } | null {
  const taken = windows
    .map(w => ({ left: Math.max(stage.left, w.left), right: Math.min(stage.right, w.right) }))
    .filter(w => w.right > w.left)
    .sort((a, b) => a.left - b.left);
  let best: { center: number; width: number } | null = null;
  let from = stage.left;
  for (const w of [...taken, { left: stage.right, right: stage.right }]) {
    const width = w.left - from;
    if (width >= least && (!best || width > best.width)) best = { center: from + width / 2, width };
    from = Math.max(from, w.right);
  }
  return best;
}

/** A window, or what it keeps clear of, in the page's coordinates. */
export type Box = { left: number; top: number; right: number; bottom: number };

/** Kept clear between two windows, so that neither's edge or shadow is taken for the other's — and between a window and the dock. */
export const GAP = 16;
/** Smaller than this a window is no use: a header and a few lines. */
export const MIN = { width: 280, height: 180 };

/**
 * Where the orb is, as the voice stage says on its `data-orb` and its styles
 * and the windows follow: in its dock; standing free in a gap the windows
 * leave; beside a single window; or, with nothing open, not said.
 */
export type Orb = "dock" | "free" | "beside";

/**
 * The voice dock's measures, as the stage's styles set them (see `--dock-*`
 * on .voice-stage in stage.css): its width, at most, and its height; how far
 * above the stage's bottom its middle is; and what it keeps clear at the
 * stage's sides.
 */
export type DockSize = { width: number; height: number; middle: number; inset: number };

export function dockSize(stage: Element): DockSize {
  const style = getComputedStyle(stage);
  const px = (name: string) => parseFloat(style.getPropertyValue(name)) || 0;
  return { width: px("--dock-width"), height: px("--dock-height"), middle: px("--dock-middle"), inset: px("--dock-inset") };
}

/** Where the dock is on a stage: centred at its foot. */
export function dockBox(stage: Box, size: DockSize): Box {
  const width = Math.min(size.width, stage.right - stage.left - 2 * size.inset);
  const middle = (stage.left + stage.right) / 2, y = stage.bottom - size.middle;
  return { left: middle - width / 2, right: middle + width / 2, top: y - size.height / 2, bottom: y + size.height / 2 };
}

/**
 * Where a window goes with the orb back in its dock, where it reaches under
 * the dock: ending GAP above it. Null when it does not reach under it. A
 * window can reach down there while the orb stands elsewhere, and the dock
 * coming back would be drawn over it.
 *
 * Shorter, down to `least` — the smallest the window may be. One that would
 * have to be smaller moves up instead, as far as `ceiling`, the top of its area.
 */
export function clearOfDock(dock: Box, window: Box, least: number, ceiling: number): { top: number; height: number } | null {
  if (window.right <= dock.left || window.left >= dock.right || window.bottom <= dock.top) return null;
  const bottom = dock.top - GAP;
  if (bottom - window.top >= least) return { top: window.top, height: bottom - window.top };
  const top = Math.max(ceiling, bottom - least);
  return { top, height: Math.max(least, bottom - top) };
}
