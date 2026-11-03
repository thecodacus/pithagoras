import { msg, t } from "./i18n";

/**
 * The extensions that come with Pithagoras, by package name, as a person is told of them before one is installed: what
 * it is called and what it does in one line. The package's own description is longer than a row, and English only. An
 * extension the portal ships that is not here is shown by its package name and that description.
 */
const KNOWN: Record<string, { label: string; line: string }> = {
  "pithagoras-terminal": { label: msg("Terminal"), line: msg("A shell beside the chat, and the jobs the agent left running") },
  "pithagoras-files": { label: msg("Files"), line: msg("Browse, read and edit a chat's folder beside the conversation") },
  "pithagoras-themes": { label: msg("Themes"), line: msg("More colours: Forest, Ocean, Rose, Amber, Mono, Dusk and Warm") },
  "pithagoras-git": { label: msg("Git"), line: msg("What changed in a chat's folder, commits, branches and pull requests") },
  "pithagoras-canvas": { label: msg("Canvases"), line: msg("Documents the agent writes beside the conversation, which you can edit") },
  "pithagoras-media": { label: msg("Media"), line: msg("Pictures and videos the agent makes, and a page that keeps them") },
  "pithagoras-docs": { label: msg("Documents"), line: msg("Documents in a chat's folder, on a page of their own") },
  "pithagoras-docker": { label: msg("Docker for extensions"), line: msg("Containers that other extensions run in, and a page to see and control them") },
  "pithagoras-browser": { label: msg("Browser"), line: msg("A browser the agent drives with its tools, which you can watch") },
  "pithagoras-voice": { label: msg("Voice"), line: msg("Speech recognition and speech synthesis on this machine, for voice mode") },
  "pithagoras-voice-servers": { label: msg("Voice servers"), line: msg("Voice mode through speech servers of your own") },
  "pithagoras-understory": { label: msg("Understory"), line: msg("The agent's memory: notes it keeps, which you can read") },
  "pithagoras-kanban": { label: msg("Kanban"), line: msg("Boards beside a chat, which the agent keeps track of its work on") },
  "pithagoras-creator": { label: msg("Creator mode"), line: msg("A chat mode in which the agent writes extensions for the portal") },
  "pithagoras-subagent": { label: msg("Subagents"), line: msg("Hand a task to a second agent, and watch every subagent at work") },
};

/** What a shipped extension is called: its name here, or its package name. */
export const shippedLabel = (name: string): string => (KNOWN[name] ? t(KNOWN[name].label) : name);

/** One line on what it does: ours, or the package's own description where the portal ships more than this table knows. */
export const shippedLine = (name: string, description?: string): string | undefined => (KNOWN[name] ? t(KNOWN[name].line) : description);
