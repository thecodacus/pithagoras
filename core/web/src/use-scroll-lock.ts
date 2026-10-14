import { useEffect } from "react";

/** How many things hold the page still: the last one to let go gives it back. */
let held = 0;
let before: { html: string; body: string } | null = null;

/**
 * The page behind something that covers it does not scroll while it is open.
 *
 * The app keeps its own scrolling in boxes inside it, so what this stops is a
 * touch or a wheel that is not caught by the thing on top reaching the page,
 * which on a phone drags the whole screen along, and the address bar with it.
 */
export function useScrollLock(): void {
  useEffect(() => {
    const [html, body] = [document.documentElement, document.body];
    if (held++ === 0) {
      before = { html: html.style.overflow, body: body.style.overflow };
      html.style.overflow = body.style.overflow = "hidden";
    }
    return () => {
      if (--held === 0 && before) {
        html.style.overflow = before.html;
        body.style.overflow = before.body;
        before = null;
      }
    };
  }, []);
}
