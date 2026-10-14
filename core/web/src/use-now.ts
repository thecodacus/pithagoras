import { useEffect, useState } from "react";

/**
 * The time, redrawn every `every` milliseconds (a second) while `on`: for an
 * elapsed time that counts, or one told in minutes, which wants no more than a
 * minute's. It is read again the moment `on` turns true, so a clock that was not
 * running does not show the second it stopped at.
 */
export function useNow(on: boolean, every = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), every);
    return () => window.clearInterval(t);
  }, [on, every]);
  return now;
}
