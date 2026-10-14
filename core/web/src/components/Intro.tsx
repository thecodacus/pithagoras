import { useEffect, useState } from "react";
import { fancy } from "../motion";

/** How long it is on the page: the doors are open by a second, and it is gone a beat after. */
const LENGTH = 1150;

/**
 * Whether this is the portal being opened, rather than reloaded or come back
 * to: nobody wants a flourish each time they refresh to see a change.
 */
const opening = () => {
  const [navigation] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
  return !navigation || navigation.type === "navigate";
};

/**
 * What opening the portal looks like: its mark lights up and two doors part
 * on it. It lies over the page for a second and takes no click, tab or
 * touch: what is underneath is already being drawn and can be used. Nothing
 * of it exists unless the animations are on (see motion.ts).
 */
export function Intro() {
  const [shown, setShown] = useState(() => fancy() && opening());
  useEffect(() => {
    if (!shown) return;
    const timer = window.setTimeout(() => setShown(false), LENGTH);
    return () => window.clearTimeout(timer);
  }, [shown]);
  if (!shown) return null;
  return (
    <div className="app-intro" aria-hidden="true" data-intro="">
      <i className="app-intro-glow" />
      <i className="app-intro-door is-left" />
      <i className="app-intro-door is-right" />
      <i className="app-intro-seam" />
      <div className="app-intro-mark">
        <i className="app-intro-ring" />
        <i className="app-intro-ring is-late" />
        <img src="/icon-192.png" alt="" draggable={false} />
      </div>
    </div>
  );
}
