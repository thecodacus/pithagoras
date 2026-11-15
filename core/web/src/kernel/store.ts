import { useRef, useSyncExternalStore } from "react";
import { sameValue } from "../extensions/chat-feed";

/**
 * A value held outside any component, that can be read, set, and listened to: the shape every store of the kernel's
 * data layer has. The state is immutable: a change is a new object, so that `useStore` (and `useSyncExternalStore`
 * under it) can tell with `===` whether anything changed.
 */
export interface Store<T> {
  get(): T;
  set(next: T): void;
  /** `set` with the next state made from the last. */
  update(change: (prev: T) => T): void;
  /** Called after each change, outside any draw. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  const store: Store<T> = {
    get: () => state,
    set(next) {
      if (Object.is(next, state)) return;
      state = next;
      // A listener that fails is its own failure: the others still hear of the change.
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch (e) {
          console.error("[portal] hearing a change failed:", e);
        }
      }
    },
    update: (change) => store.set(change(state)),
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  return store;
}

/**
 * A store's state in a component, drawn again when it changes. With `pick`, only what the component uses of it: it is
 * drawn again only when what it picked is no longer the same (`same`; by default the same value, or a list or object
 * holding the same values).
 */
export function useStore<T, P = T>(store: Store<T>, pick?: (state: T) => P, same: (a: P, b: P) => boolean = sameValue): P {
  const last = useRef<{ state: T; pick: typeof pick; picked: P } | null>(null);
  return useSyncExternalStore(store.subscribe, () => {
    const state = store.get();
    const was = last.current;
    if (was && was.state === state && was.pick === pick) return was.picked;
    const picked = pick ? pick(state) : (state as unknown as P);
    // The same as before: the one already handed out, so the component is not drawn again for it.
    last.current = { state, pick, picked: was && same(was.picked, picked) ? was.picked : picked };
    return last.current.picked;
  });
}

/**
 * A value worked out from other stores (or any source that says when it changes), read like a store. It listens to
 * its sources only while something listens to it, and gives back the same object while what it works out says the
 * same, so that a part drawn from it is not drawn again for a change it does not show.
 */
export function derived<T>(sources: readonly ((listener: () => void) => () => void)[], compute: () => T): Omit<Store<T>, "set" | "update"> {
  const listeners = new Set<() => void>();
  let stops: (() => void)[] = [];
  let last: { value: T } | undefined;
  const get = (): T => {
    const value = compute();
    // Kept while it is the same, and only judged where nothing listens: a listener keeps `last` current below.
    if (!last || !sameValue(last.value, value)) last = { value };
    return last.value;
  };
  const changed = () => {
    const before = last?.value;
    if (get() === before) return;
    for (const listener of [...listeners]) listener();
  };
  return {
    get,
    subscribe(listener) {
      if (!listeners.size) {
        get();
        stops = sources.map((source) => source(changed));
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          stops.forEach((stop) => stop());
          stops = [];
        }
      };
    },
  };
}
