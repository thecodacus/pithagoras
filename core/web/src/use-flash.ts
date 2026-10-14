import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A mark that something worked, which goes by itself: `[on, flash, clear]`.
 *
 * Each `flash()` starts the time over, so a second save soon after the first
 * keeps its tick for as long as the first had, and a timer left over from the
 * first does not take it away. Nothing is left running when the page is
 * closed or the component goes.
 */
export function useFlash(ms = 2000): [boolean, () => void, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clear = useCallback(() => {
    clearTimeout(timer.current);
    setOn(false);
  }, []);
  const flash = useCallback(() => {
    clearTimeout(timer.current);
    setOn(true);
    timer.current = setTimeout(() => setOn(false), ms);
  }, [ms]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [on, flash, clear];
}
