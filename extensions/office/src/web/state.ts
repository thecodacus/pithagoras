import { useEffect, useSyncExternalStore } from "react";
import { api, type OfficeState } from "./api";

/**
 * How the office stands, as the server half last said -- shared by the library page, the per-home chat panels,
 * the tool cards and the editor badges. One question at a time, one poll while any of them is on screen:
 * GET /state every 5 s (plan 5.7 tier 1), asked again straight after whatever changed it.
 */

let known: OfficeState | null = null;
const listeners = new Set<() => void>();
let watchers = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let inflight: Promise<void> | null = null;

function publish(state: OfficeState): void {
  known = state;
  for (const listener of listeners) listener();
}

/** Ask again now (after a create/rename/delete/settings change), and only once at a time. */
export function refreshOfficeState(): Promise<void> {
  inflight ??= api.state().then(publish, () => {}).finally(() => void (inflight = null));
  return inflight;
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** A hook: the newest answer of GET /state. Starts the shared 5 s poll while a first user mounts, ends it when the last goes. */
export function useOfficeState(): OfficeState | null {
  useEffect(() => {
    watchers += 1;
    if (watchers === 1) {
      void refreshOfficeState();
      timer = setInterval(() => void refreshOfficeState(), 5000);
    }
    return () => {
      watchers -= 1;
      if (watchers === 0 && timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    };
  }, []);
  return useSyncExternalStore(subscribe, () => known);
}
