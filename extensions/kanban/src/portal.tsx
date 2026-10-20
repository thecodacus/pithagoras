import type { MouseEvent, ReactNode } from "react";
import type { Portal, SelectOption } from "@pithagoras/extension-api";

/** The portal the extension was loaded into, for every part of it: set before anything is registered. */
export let portal: Portal;

export function setPortal(given: Portal): void {
  portal = given;
}

// The extension's texts, in the language in effect: its own German where it has it (see de.ts).
export const t = (text: string, vars?: Record<string, string | number>) => portal.t(text, vars);
export const tp = (n: number, one: string, other: string, vars?: Record<string, string | number>) => portal.tp(n, one, other, vars);
/** A text to be translated where it is shown, marked here as one: a title the portal draws, a label kept in a table. */
export const msg = <T extends string>(text: T): T => text;

/** Where the Boards page is, on a board or on none. */
export const boardsPage = (board?: string) => `/x/${portal.extension}/boards${board ? `?board=${encodeURIComponent(board)}` : ""}`;

/** The board last opened on the Boards page in this browser: the one a chat's panel opens on when its agent has used none. */
const LAST = "pithagoras-kanban.board";
export const lastBoard = {
  get: () => portal.ui.storage.local.get(LAST),
  set: (id: string) => portal.ui.storage.local.set(LAST, id),
};

/**
 * A link to a page of the portal: an address like any other, which opens in a new tab or window when asked to, and
 * in this one goes there through the portal's own router, without loading the page again.
 */
export function Link({ to, className, children, label }: { to: string; className?: string; children: ReactNode; label?: string }) {
  const go = (e: MouseEvent<HTMLAnchorElement>) => {
    // A middle click, or one with a key held, is the browser's: a new tab, a new window.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    portal.navigate(to);
  };
  return (
    <a href={to} onClick={go} className={className} aria-label={label}>
      {children}
    </a>
  );
}

/** The portal's own Select, whose props say what it holds, drawn as a component of the extension's. */
export function Select<T extends string | number = string>(props: {
  value: T;
  onChange: (value: T) => void;
  options: SelectOption<T>[];
  placeholder?: ReactNode;
  disabled?: boolean;
  className?: string;
  size?: "sm" | "md";
  "aria-label"?: string;
  id?: string;
}) {
  const Own = portal.ui.Select as (props: unknown) => ReactNode;
  return <Own {...props} />;
}
