import type { Portal } from "@pithagoras/extension-api";

/** The portal the extension was loaded into, for every part of it: set before anything is registered. */
export let portal: Portal;

export function setPortal(given: Portal): void {
  portal = given;
}

/** A text in the language in effect: the extension's own German where it has it. */
export const t = (text: string, vars?: Record<string, string | number>) => portal.t(text, vars);

/** A text to be translated where it is shown, marked here as one: a tab's name, a shortcut's label. */
export const msg = (text: string) => text;
