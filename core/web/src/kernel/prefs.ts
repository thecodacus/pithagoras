import type { SafeStorage } from "../safe-storage";
import { createStore } from "./store";

/**
 * What a person chose for how the page looks and behaves, kept in this browser: the sidebar's width, how the chats are
 * grouped, where the panels dock. A scope keeps one interface's keys apart from another's; the stock interface has
 * none, and its keys are the ones the portal has always kept, so that nobody loses a layout. Nothing here follows the
 * person to another browser.
 */
export function createPrefs(storage: SafeStorage, scope?: string) {
  const prefix = scope ? `ui.${scope}.` : "";
  /** Counts the changes, so that a hook has something to compare: a key's value is read from storage when asked. */
  const changes = createStore(0);
  const read = (key: string, fallback: string): string => storage.get(prefix + key) ?? fallback;
  return {
    get: read,
    set(key: string, value: string): void {
      if (storage.get(prefix + key) === value) return;
      storage.set(prefix + key, value);
      changes.set(changes.get() + 1);
    },
    remove(key: string): void {
      if (storage.get(prefix + key) === null) return;
      storage.remove(prefix + key);
      changes.set(changes.get() + 1);
    },
    /** Told after any key changed: the hook reads the one it wants again. */
    subscribe: changes.subscribe,
    /** What the hook compares: the value of `key` now. */
    snapshot: read,
  };
}

export type Prefs = ReturnType<typeof createPrefs>;
