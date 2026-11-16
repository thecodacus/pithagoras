import { createStore } from "./store";

/**
 * How wide the window is, as one choice of two: a phone's (the sidebar is a drawer, the panels cover the chat) or a
 * desk's (they sit beside it). One threshold for the whole page, so that the shell and the chat cannot disagree about
 * which they are in.
 */
export type Viewport = "phone" | "desk";

/** The width from which the page is a desk's. */
export const DESK_QUERY = "(min-width: 768px)";

/** The part of a `MediaQueryList` this uses; tests give their own. */
export interface Query {
  readonly matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

export function createViewport(query: Query) {
  const store = createStore<Viewport>(query.matches ? "desk" : "phone");
  const sync = () => store.set(query.matches ? "desk" : "phone");
  let watching = 0;
  return {
    store,
    /** Follows the window while something reads it. Returns the release. */
    watch(): () => void {
      if (watching++ === 0) {
        sync();
        query.addEventListener("change", sync);
      }
      return () => {
        if (--watching === 0) query.removeEventListener("change", sync);
      };
    },
  };
}
export type ViewportStore = ReturnType<typeof createViewport>;
