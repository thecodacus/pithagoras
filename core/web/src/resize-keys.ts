import type { KeyboardEvent } from "react";

/** How far an arrow key moves an edge or a corner that has the focus, in pixels; Shift makes it four times that. */
export const STEP = 24;

/**
 * The arrow keys of a grip that moves along one axis: how many steps the key
 * asks for — negative for left or up, four for a key with Shift — or 0 for
 * any other key, which is left to the page.
 */
export function arrowSteps(e: KeyboardEvent, axis: "x" | "y"): number {
  if (e.altKey || e.ctrlKey || e.metaKey) return 0;
  const sign = axis === "x" ? (e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0) : e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
  return sign * (e.shiftKey ? 4 : 1);
}
