import type { ChatMode } from "./api";
import { translate } from "./extensions/strings";
import { labelOf, msg } from "./i18n";

/**
 * How a chat mode is named on the page, apart from the picker that draws it: the kernel asks about a mode that asks
 * first (kernel/chats.ts), and needs its words without the picker. The portal's own are named here in the page's
 * language, with the same English as the server's list (core/server/src/chat-modes.ts); an extension's through its own
 * translations; a mode neither knows is shown as the server names it.
 */
const LABELS: Record<string, string> = {
  standard: msg("Standard mode"),
  code: msg("Code mode"),
};
const DESCRIPTIONS: Record<string, string> = {
  standard: msg("The agent as this chat would have it anyway: the tools that Settings → Tools, its agent and its project switch on."),
  code: msg("The model works through one tool: it writes a short JavaScript script that calls the chat's tools, and is given only what the script puts out."),
};

/** What a mode is called on the page. */
export const modeLabel = (mode: ChatMode): string => (mode.extension ? translate(mode.extension, mode.label) : labelOf(LABELS, mode.id, () => mode.label));
/** The line that says what a mode does. */
export const modeDescription = (mode: ChatMode): string =>
  mode.extension ? translate(mode.extension, mode.description) : labelOf(DESCRIPTIONS, mode.id, () => mode.description);
/** What a mode that asks first says, in the page's language. */
export const modeConfirm = (mode: ChatMode): string | undefined => (mode.confirm && mode.extension ? translate(mode.extension, mode.confirm) : mode.confirm);
