import { useEffect, useRef } from "react";

/**
 * What something that covers the page does, as the portal's own viewer does
 * it: it goes away with the browser's back button, and the page behind it
 * holds still.
 */

/**
 * Its history entry, as the portal marks its own: the entry keeps the page's
 * state, so that the router, which reads that state, does not take it for a
 * place of its own. A reload over one is the portal's to take off.
 */
const MARK = "pithagorasOverlay";

interface Entry {
  token: string;
  /** The browser took it off: back was pressed. */
  popped: boolean;
}

/**
 * An entry whose thing was just closed, and is taken off in a moment. In
 * development React opens, closes and opens it again at once to see that it
 * can: that second opening picks the entry up instead of leaving one behind.
 */
let leaving: { entry: Entry; timer: number } | null = null;

/**
 * Closed by back, as it is on a phone, where back is the way out. While it is
 * open there is one entry more in the history; back takes it off and the thing
 * closes, and if it closes in any other way its entry is taken off again by
 * going back, unless the page has moved on since.
 */
export function useBackToClose(close: () => void): void {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    let entry: Entry;
    if (leaving) {
      window.clearTimeout(leaving.timer);
      entry = leaving.entry;
      leaving = null;
    } else {
      entry = { token: `${Date.now()}.${Math.random()}`, popped: false };
      history.pushState({ ...history.state, [MARK]: entry.token }, "");
    }
    const onPop = () => {
      if (history.state?.[MARK] === entry.token) return;
      entry.popped = true;
      latest.current();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      const held = entry;
      leaving = {
        entry: held,
        timer: window.setTimeout(() => {
          if (leaving?.entry === held) leaving = null;
          if (!held.popped && history.state?.[MARK] === held.token) history.back();
        }, 0),
      };
    };
  }, []);
}

/** How many things hold the page still: the last one to let go gives it back. */
let held = 0;
let before: { html: string; body: string } | null = null;

/**
 * The page behind does not scroll while it is open: a touch or a wheel that
 * is not caught by the thing on top would otherwise reach it, and on a phone
 * drag the whole screen along.
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
