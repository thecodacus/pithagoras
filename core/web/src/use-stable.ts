import { useCallback, useRef } from "react";

/**
 * A function that is the same in every draw and runs what the latest draw passed.
 *
 * For what a page hands to a child that is memoised: a handler made anew with
 * each draw would make the child draw again with it, and a handler that closes
 * over the page's state cannot be made once.
 */
export function useStable<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useRef(fn);
  latest.current = fn;
  return useCallback((...args: A) => latest.current(...args), []);
}
