import type { Portal } from "@pithagoras/extension-api";

/** The portal this extension is loaded into, for every part of it: set before anything is registered. */
export let portal: Portal;

export function setPortal(given: Portal): void {
  portal = given;
}

// A text in the language in effect: said as written until a translation is added (the browser half ships English only in v1).
export const t = (text: string, vars?: Record<string, string | number>): string => portal.t(text, vars);

/** The Office page -- and where it opens one document. */
export const officeUrl = (docId?: string): string =>
  `/x/${portal.extension}/office${docId ? `?doc=${encodeURIComponent(docId)}` : ""}`;
