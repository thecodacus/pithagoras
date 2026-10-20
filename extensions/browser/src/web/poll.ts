/**
 * Calls `tick` every `ms` while the page is on screen, and stops while it is
 * not: coming back, it asks at once and then carries on. Returns what stops it.
 */
export function pollWhileVisible(tick: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const start = () => {
    if (timer === null) timer = setInterval(tick, ms);
  };
  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const onChange = () => {
    if (document.hidden) return stop();
    tick();
    start();
  };
  document.addEventListener("visibilitychange", onChange);
  if (!document.hidden) start();
  return () => {
    document.removeEventListener("visibilitychange", onChange);
    stop();
  };
}
