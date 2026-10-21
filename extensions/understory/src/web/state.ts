import { useEffect, useSyncExternalStore } from "react";
import { api, type UnderstoryState } from "./api";

/**
 * How Understory stands, as the server half last said, for the sidebar's
 * entry: asked again whenever it is drawn anew, and taken from the page in
 * Settings each time it reads it, so that Understory switched on or off there
 * is followed at once. An answer that does not come keeps the last one.
 */

let known: UnderstoryState | null = null;
const listeners = new Set<() => void>();
let asking: Promise<void> | null = null;

/**
 * Nothing known: as the extension is loaded, which the portal does again when its server half comes or goes, with
 * the module it already has. What the server half that went said is no answer of the one there now.
 */
export function forget(): void {
  known = null;
}

/** What the page in Settings read: the sidebar follows it. */
export function publish(state: UnderstoryState): void {
  known = state;
  for (const listener of listeners) listener();
}

/** Asks the server half how Understory stands; one question at a time. */
function refresh(): Promise<void> {
  asking ??= api
    .state()
    .then(publish, () => {})
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

/** A hook: how Understory stands, asked again as the component that uses it is first drawn. */
export function useUnderstoryState(): UnderstoryState | null {
  useEffect(() => {
    void refresh();
  }, []);
  return useSyncExternalStore(subscribe, () => known);
}
