/**
 * The tabs of Settings, by the segment of the route that opens each: kept
 * apart from the dialog so that the app can tell a tab from anything else
 * without loading the dialog.
 */
export const TAB_IDS = [
  "models",
  "general",
  "channels",
  "people",
  "add-ons",
  "tools",
  "sandbox",
  "media",
  "skills",
  "mcp",
  "extensions",
  "browser",
  "authentication",
  "shortcuts",
  "logs",
  "about",
  "advanced",
] as const;

export type Tab = (typeof TAB_IDS)[number];

/** Whether a path segment of the settings route names one of the tabs. */
export const isTab = (id: string): id is Tab => (TAB_IDS as readonly string[]).includes(id);
