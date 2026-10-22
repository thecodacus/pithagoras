import { CODEMODE_TOOL } from "./pi/codemode.js";
import type { ToolExceptions } from "./tool-policy.js";

/**
 * Chat modes: how a chat works, chosen above the message box before its first message and fixed once it has one.
 * A chat keeps its mode in sessions.mode: NULL for Standard, a mode of the portal's by its name, one the person made
 * as "custom/<id>", an extension's as "<package>/<id>". What a mode does past its tool layer is done by whoever
 * provides it: the portal where it starts a chat's pi (session-manager.ts), an extension in its chats.extend factory.
 */
export interface ChatModeEntry {
  /** What a chat stores. */
  id: string;
  /** What the picker calls it, in English. */
  label: string;
  /** The line under the label, in English. */
  description: string;
  /** Its tool layer, between a routine's and the chat's own switches (see toolDefaultsForSession). */
  tools?: ToolExceptions;
  /** Its chats work through the code tool alone, in pi's `only` presentation (see codemode.ts). */
  codemode?: boolean;
  /** Said in its chats' system prompt, after the portal's own rules (a mode the person made). */
  instructions?: string;
  /** What a chat is put on as it is put in the mode (a mode the person made). */
  provider?: string;
  model?: string;
  thinkingLevel?: string;
}

/** What a chat is when it says nothing about its mode. Stored as NULL. */
export const STANDARD = "standard";
/** What a chat in a mode the person made stores before the mode's id (Settings → Modes). */
export const CUSTOM = "custom/";

/** The portal's own modes, first in the picker. The page has the same English in its table (ModePicker.tsx). */
export const CORE_MODES: readonly ChatModeEntry[] = [
  { id: STANDARD, label: "Standard mode", description: "The agent as this chat would have it anyway: the tools that Settings → Tools, its agent and its project switch on." },
  {
    id: "code",
    label: "Code mode",
    description: "The model works through one tool: it writes a short JavaScript script that calls the chat's tools, and is given only what the script puts out.",
    tools: { off: [], on: [CODEMODE_TOOL] },
    codemode: true,
  },
];
