import { useMemo, useRef } from "react";

/**
 * An object of functions that is the same object in every draw, and whose
 * functions always do what the latest draw's did. For a memoised child that is
 * handed what it can do: functions made anew for each draw would make it draw
 * again each time, and the functions are only called when someone clicks.
 * Which functions there are is fixed at the first draw.
 */
export function useStableActions<T extends Record<string, (...args: any[]) => any>>(fns: T): T {
  const latest = useRef(fns);
  latest.current = fns;
  return useMemo(() => Object.fromEntries(Object.keys(fns).map((name) => [name, (...args: any[]) => latest.current[name](...args)])) as T, []);
}
