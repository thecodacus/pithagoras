import { msg } from "./i18n";

/**
 * The tabs of Settings: the one list of them. The rail draws the groups in this order (the dialog adds an icon to each
 * by its id), a route's segment names a tab by its id, and the app tells a tab from anything else with `isTab`
 * without loading the dialog. In the order a person setting the portal up needs them: where the models come from and
 * how they are used, then what the agent can do, who it talks to, and last the portal itself.
 */
export const SETTINGS_GROUPS = [
  {
    label: msg("Models"),
    tabs: [
      { id: "models", label: msg("Providers"), hint: msg("Where the models come from") },
      { id: "general", label: msg("Defaults"), hint: msg("Model, effort and context for new chats") },
    ],
  },
  {
    label: msg("Agent"),
    tabs: [
      { id: "tools", label: msg("Tools"), hint: msg("What the agent may reach for, by default") },
      { id: "modes", label: msg("Modes"), hint: msg("Your own ways a chat can work, chosen above the message box") },
      { id: "sandbox", label: msg("Sandbox"), hint: msg("What the agent may read, change and run") },
      { id: "guard", label: msg("Guard"), hint: msg("What the agent is held to after it reads something untrusted") },
      { id: "skills", label: msg("Skills"), hint: msg("Procedures the agent can reach for") },
      { id: "mcp", label: msg("MCP"), hint: msg("Servers the agent can pull tools from") },
      { id: "extensions", label: msg("Extensions"), hint: msg("Install and manage packages") },
    ],
  },
  {
    label: msg("Reach"),
    tabs: [
      { id: "channels", label: msg("Channels"), hint: msg("Two-way links into the agent") },
      { id: "people", label: msg("People"), hint: msg("Who the agent will talk to") },
    ],
  },
  {
    label: msg("Portal"),
    tabs: [
      { id: "browser", label: msg("This browser"), hint: msg("Theme, notifications, confirmations") },
      { id: "authentication", label: msg("Authentication"), hint: msg("The password, and signing in through a provider") },
      { id: "shortcuts", label: msg("Shortcuts"), hint: msg("Keyboard shortcuts, and changing them") },
      { id: "logs", label: msg("Logs"), hint: msg("What the server prints, and a file to take away") },
      { id: "about", label: msg("About"), hint: msg("Where this portal keeps things") },
      { id: "advanced", label: msg("Advanced"), hint: msg("pi's raw settings file") },
    ],
  },
] as const;

export type Tab = (typeof SETTINGS_GROUPS)[number]["tabs"][number]["id"];

/** Every tab, in the order of the rail. */
export const TABS: readonly { id: Tab; label: string; hint: string }[] = SETTINGS_GROUPS.flatMap((group) => [...group.tabs] as { id: Tab; label: string; hint: string }[]);

export const TAB_IDS: readonly Tab[] = TABS.map((tab) => tab.id);

/** Whether a path segment of the settings route names one of the tabs. */
export const isTab = (id: string): id is Tab => (TAB_IDS as readonly string[]).includes(id);
