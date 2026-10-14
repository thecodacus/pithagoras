/** The part of `Storage` this needs. */
export interface RawStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SafeStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/**
 * Browser storage that cannot take the page down.
 *
 * `localStorage` throws — on the property access itself, not only on a full
 * quota — in a private window, with site data blocked, or in a sandboxed
 * frame. Read while a component is first drawn, that is a white screen instead
 * of a remembered panel width. Here a read that fails finds nothing and a write
 * that fails is dropped: what is kept in storage is a convenience.
 *
 * `open` is called on every use rather than once, because it is the property
 * access that throws.
 */
export function guarded(open: () => RawStorage): SafeStorage {
  return {
    get(key) {
      try {
        return open().getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        open().setItem(key, value);
      } catch {
        // Not remembered, but the page works.
      }
    },
    remove(key) {
      try {
        open().removeItem(key);
      } catch {
        // Nothing to forget.
      }
    },
  };
}

/** Kept until it is cleared: page preferences. */
export const local = guarded(() => localStorage);
/** Kept until the tab is closed, and through a reload: something half done. */
export const session = guarded(() => sessionStorage);
