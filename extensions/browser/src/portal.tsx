import type { MouseEvent, ReactNode } from "react";
import type { Portal } from "@pithagoras/extension-api";

/** The portal the extension was loaded into, for every part of it: set before anything is registered. */
export let portal: Portal;

export function setPortal(given: Portal): void {
  portal = given;
}

// The extension's texts, in the language in effect: its own German where it has it (see de.ts).
export const t = (text: string, vars?: Record<string, string | number>) => portal.t(text, vars);
export const tx = (text: string, vars: Record<string, ReactNode>) => portal.tx(text, vars);
/** A text to be translated where it is shown, marked here as one: a title the portal draws, a label kept in a table. */
export const msg = <T extends string>(text: T): T => text;

/**
 * A link to a page of the portal: an address like any other, which opens in a
 * new tab or window when asked to, and in this one goes there through the
 * portal's own router, without loading the page again.
 */
export function Link({ to, className, children }: { to: string; className?: string; children: ReactNode }) {
  const go = (e: MouseEvent<HTMLAnchorElement>) => {
    // A middle click, or one with a key held, is the browser's: a new tab, a new window, a download.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    portal.navigate(to);
  };
  return (
    <a href={to} onClick={go} className={className}>
      {children}
    </a>
  );
}
