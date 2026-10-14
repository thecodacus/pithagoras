import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

/**
 * What Settings shows, kept between one opening and the next.
 *
 * Each page used to fetch when it was switched to, then draw: the dialog
 * opened on a placeholder that one part at a time turned into the page, and
 * the rail's extension settings arrived last of all. Kept here, a page that
 * was seen before draws at once and is quietly brought up to date, and what
 * is fetched ahead of time is there before anyone asks.
 */

type Entry = { value?: unknown; at: number; pending?: Promise<unknown> };
const store = new Map<string, Entry>();
const listeners = new Map<string, Set<(value: unknown) => void>>();

export function peek<T>(key: string): T | undefined {
  return store.get(key)?.value as T | undefined;
}

function publish(key: string, value: unknown) {
  store.set(key, { value, at: Date.now() });
  for (const fn of listeners.get(key) ?? []) fn(value);
}

/**
 * The value, fetched unless one younger than `freshMs` is kept. Asking again
 * while a fetch is on its way waits for that one rather than starting another
 * — unless `anew`: after a change, one on its way may have asked the server
 * before it, so a new one is started, and the other's answer is not kept.
 */
export function load<T>(key: string, fetcher: () => Promise<T>, freshMs = 0, anew = false): Promise<T> {
  const had = store.get(key);
  if (had?.pending && !anew) return had.pending as Promise<T>;
  if (had && "value" in had && had.value !== undefined && Date.now() - had.at < freshMs) return Promise.resolve(had.value as T);
  const pending: Promise<T> = fetcher().then(
    (value) => {
      // Forgotten while on its way: what it brings is from before the change
      // that made it stale, and must not land over what was fetched since.
      const now = store.get(key);
      if (now?.pending === pending) publish(key, value);
      else if (now?.pending) return now.pending as Promise<T>;
      return value;
    },
    (e) => {
      const entry = store.get(key);
      if (entry?.pending === pending) store.set(key, { value: entry.value, at: entry.at });
      throw e;
    },
  );
  store.set(key, { ...had, at: had?.at ?? 0, pending });
  return pending;
}

/**
 * Drop a kept value, so the next look fetches it: after a change that makes
 * it stale. A fetch still on its way is let go too — its answer is not kept.
 */
export function forget(key: string) {
  const had = store.get(key);
  if (had) store.set(key, { value: had.value, at: 0 });
}

/**
 * A kept value in a component: drawn from what is kept at once, fetched
 * again on mount when older than `freshMs`, and updated wherever else the
 * same key is loaded.
 */
export function useCached<T>(key: string, fetcher: () => Promise<T>, { freshMs = 3000, onError }: { freshMs?: number; onError?: (e: Error) => void } = {}) {
  const [value, setValue] = useState<T | undefined>(() => peek<T>(key));
  const [failed, setFailed] = useState<Error | null>(null);

  useEffect(() => {
    const fn = (v: unknown) => setValue(v as T);
    let set = listeners.get(key);
    if (!set) listeners.set(key, (set = new Set()));
    set.add(fn);
    return () => void set!.delete(fn);
  }, [key]);

  const fetch = useCallback(
    (fresh: number, anew = false) =>
      load(key, fetcher, fresh, anew).then(
        (v) => {
          setFailed(null);
          return v;
        },
        (e: Error) => {
          setFailed(e);
          onError?.(e);
          return undefined;
        },
      ),
    // The fetcher and handler are the caller's; the key is what names the data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  useEffect(() => {
    void fetch(freshMs);
  }, [fetch]);

  /** Fetched again, after a change: never answered by a fetch that started before it. */
  const reload = useCallback(() => fetch(0, true), [fetch]);
  return { value, failed, reload };
}

/**
 * For `onError`: only the failure of a refresh, which a page shows as a banner
 * over what it has. A first read that failed is the page's to say, where the
 * page would be, with a way to try again (`failed`, `LoadFailed`); a banner on
 * top of that would stay after the retry worked.
 */
export const refreshFailed = (key: string, onError: (message: string) => void) => (e: Error) => {
  if (peek(key) !== undefined) onError(e.message);
};

/**
 * What Settings needs first, fetched before it is opened — a moment after the
 * portal loads — so that opening it draws the page rather than a placeholder.
 */
export function prefetchSettings() {
  const quietly = (p: Promise<unknown>) => void p.catch(() => {});
  quietly(load("extensions", api.extensions, 30_000));
  quietly(load("settings", api.settings, 30_000));
  quietly(load("models", api.allModels, 30_000));
  quietly(load("report-targets", api.reportTargets, 30_000));
  quietly(load("providers", api.providers, 30_000));
}
