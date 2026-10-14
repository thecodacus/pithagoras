import { useEffect, useRef, type RefObject } from "react";
import { isEscape } from "./shortcuts";

/**
 * Closes a popover on a press outside it, or on Escape.
 *
 * `within` is what counts as inside: the popover and the button that opens
 * it, and nothing more. A whole toolbar counted as inside let a menu stay open
 * under the next one opened from the same toolbar.
 *
 * Escape is taken before anything else hears it, as the voice settings card
 * does: it closes the menu and does not also stop the run. Focus goes back to
 * the button, where a keyboard user left it.
 */
export function useDismiss(
  open: boolean,
  within: RefObject<HTMLElement | null>[],
  close: () => void,
  trigger?: RefObject<HTMLElement | null>,
): void {
  const latest = useRef({ within, close, trigger });
  latest.current = { within, close, trigger };
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // A list a select inside the popover opened, portaled to the body: still inside.
      if ((target as Element).closest?.("[data-popover-layer]")) return;
      if (!latest.current.within.some((r) => r.current?.contains(target))) latest.current.close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (!isEscape(e)) return;
      e.preventDefault();
      e.stopPropagation();
      latest.current.close();
      latest.current.trigger?.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
}
