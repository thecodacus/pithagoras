import { useEffect, useRef } from "react";

/**
 * Something that covers the page and should go away with the browser's back
 * button, as it does on a phone, where back is the way out: without a history
 * entry of its own, back leaves the chat, and the picture that was being looked
 * at is the last thing the person sees of it.
 *
 * While it is open there is one entry more in the history, with the page's own
 * state kept in it, so that the router, which reads that state, does not take
 * it for a place of its own. Back takes the entry off and the thing closes; if it
 * closes in any other way, its entry is taken off again by going back, unless
 * the page has moved on since (then it is left, as a step to the same place).
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

// A reload keeps the state of the entry it was opened over, though what was open is gone: back would take off
// an entry that holds nothing, and the person would press it twice to leave. It is taken off as the page comes up.
if (typeof window !== "undefined" && history.state?.[MARK]) history.back();

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
