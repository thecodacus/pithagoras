import { useEffect, useSyncExternalStore } from "react";
import { api, type BrowserState } from "./api";

/**
 * How the browser stands, as the server half last said, for the parts that
 * only need to know: the sidebar's entry, the buttons of the panel and of the
 * voice window, and the voice window. Asked again whenever one of them is
 * drawn anew (a chat opened, the page loaded) and each time the voice window
 * is opened, which stays drawn once it was, and taken from the Browser page
 * and its page in Settings each time they read it, so that an install, a
 * removal or the agent connected there is followed at once. An answer that
 * does not come keeps the last one, and says it did not come.
 */

type Known = { state: BrowserState | null; failed: boolean };

let known: Known = { state: null, failed: false };
const listeners = new Set<() => void>();
let asking: Promise<void> | null = null;

function set(next: Known): void {
  known = next;
  for (const listener of listeners) listener();
}

/**
 * Nothing known: as the extension is loaded, which the portal does again when its server half comes or goes, with
 * the module it already has. What the server half that went said is no answer of the one there now.
 */
export function forget(): void {
  known = { state: null, failed: false };
}

/** What the Browser page or its page in Settings read: everything else follows it. */
export function publish(state: BrowserState): void {
  set({ state, failed: false });
}

/** Asks the server half how the browser stands; one question at a time. */
export function refresh(): Promise<void> {
  asking ??= api
    .state()
    .then(publish, () => set({ state: known.state, failed: true }))
    .finally(() => {
      asking = null;
    });
  return asking;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** A hook: how the browser stands, asked again as the component that uses it is first drawn. */
export function useBrowserState(): Known {
  useEffect(() => {
    void refresh();
  }, []);
  return useSyncExternalStore(subscribe, () => known);
}

/**
 * Whether its web UI can be shown here: a container that runs, in a page that
 * is a secure context, since a frame is only one if every page above it is,
 * and over plain HTTP the client in it refuses to start.
 */
export const watchable = (state: BrowserState | null): boolean => window.isSecureContext && state?.install.container === "running";
