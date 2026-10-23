import type { Portal } from "@pithagoras/extension-api";

/**
 * pithagoras-office: its browser half. The Office tab (the library, with the full-bleed editor), the panels and tool
 * cards in the agent and project homes, and its page in Settings come in wave W4; this placeholder exists so the web
 * bundle builds until then. Its styles are in style.css.
 */
export default function office(_: Portal): void {
  // TODO (W4/W5): nav.page "office", the /x/pithagoras-office/office page, chat panels and tool cards, settings.page,
  // office-editor.ts (api.js + DocsAPI.DocEditor).
}
