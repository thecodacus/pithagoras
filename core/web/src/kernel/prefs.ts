import type { SafeStorage } from "../safe-storage";
import { createStore } from "./store";

/**
 * What a person chose for how the page looks and behaves, kept in this browser: the sidebar's width, how the chats are
 * grouped, where the panels dock. A scope keeps one interface's keys apart from another's; the stock interface has
 * none, and its keys are the ones the portal has always kept, so that nobody loses a layout. Nothing here follows the
 * person to another browser.
 */
export function createPrefs(storage: SafeStorage, scope?: string) {
  // A colon, which no package name has: with a dot, package `a` with key `b.c` and package `a.b` with key `c` were one key.
  const prefix = scope ? `ui.${scope}:` : "";
  /** Counts the changes, so that a hook has something to compare: a key's value is read from storage when asked. */
  const changes = createStore(0);
  /**
   * What was chosen while this page is open and storage did not keep (null: removed), by key: a private window,
   * blocked site data, a full quota. The choice still takes effect for as long as the page is open, as it did when each
   * part kept it in its own state. Where storage keeps it, storage is what is read, so two readers of a key agree.
   */
  const unkept = new Map<string, string | null>();
  const stored = (key: string): string | null => (unkept.has(key) ? unkept.get(key)! : storage.get(prefix + key));
  const read = (key: string, fallback: string): string => stored(key) ?? fallback;
  const write = (key: string, value: string | null) => {
    if (value === null) storage.remove(prefix + key);
    else storage.set(prefix + key, value);
    if (storage.get(prefix + key) === value) unkept.delete(key);
    else unkept.set(key, value);
    changes.set(changes.get() + 1);
  };
  return {
    get: read,
    set(key: string, value: string): void {
      if (stored(key) !== value) write(key, value);
    },
    remove(key: string): void {
      if (stored(key) !== null) write(key, null);
    },
    /** Told after any key changed: the hook reads the one it wants again. */
    subscribe: changes.subscribe,
    /** What the hook compares: the value of `key` now. */
    snapshot: read,
  };
}

export type Prefs = ReturnType<typeof createPrefs>;
