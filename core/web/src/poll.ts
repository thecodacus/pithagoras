/** What of `document` polling needs to know. */
export interface Visibility {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/**
 * Calls `tick` every `ms` while the page is on screen, and stops while it is not.
 *
 * A tab nobody is looking at has no use for the session list, and a phone that
 * has been put away should not keep its radio awake for it. Coming back is not
 * left to the next tick: the page may have been hidden for an hour, so it asks
 * at once and then carries on. Returns what stops it.
 */
export function pollWhileVisible(
  tick: () => void,
  ms: number,
  doc: Visibility = document,
): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const start = () => {
    if (timer === null) timer = setInterval(tick, ms);
  };
  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const onChange = () => {
    if (doc.hidden) return stop();
    tick();
    start();
  };
  doc.addEventListener("visibilitychange", onChange);
  if (!doc.hidden) start();
  return () => {
    doc.removeEventListener("visibilitychange", onChange);
    stop();
  };
}

/**
 * How long to wait before reconnecting after the `failures`-th failure in a row
 * (the first is 1): two seconds, then doubling up to a quarter of a minute.
 *
 * A fixed two seconds is right for a blip and wrong for a server that is down —
 * every open tab then asks thirty times a minute, and a restart that takes a
 * minute is met by all of them at once.
 */
export function reconnectDelay(failures: number): number {
  return Math.min(15_000, 2000 * 2 ** Math.max(0, failures - 1));
}
