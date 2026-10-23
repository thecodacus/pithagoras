import type { ReactNode } from "react";
import type { Portal } from "@pithagoras/extension-api";

/** The portal the browser half was loaded into, for every part of it: set before anything is registered. */
export let portal: Portal;

export function setPortal(given: Portal): void {
  portal = given;
}

// The extension's texts, in the language in effect: its own German where it has it (see de.ts).
export const t = (text: string, vars?: Record<string, string | number>) => portal.t(text, vars);
export const tx = (text: string, vars: Record<string, ReactNode>) => portal.tx(text, vars);
export { msg } from "./mode";
