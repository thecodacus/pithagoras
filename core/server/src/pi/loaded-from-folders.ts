import os from "node:os";
import path from "node:path";
import { bundledPath } from "../bundled.js";
import { channelsPath } from "../data-dir.js";
import { piAgentDir } from "../pi-settings.js";
import { AGENT_NAME_FILE, CONTEXT_FILES, WATCH_FILE } from "./context-files.js";

/**
 * What the portal, pi, the MCP adapter and the agent's heartbeat load out of a
 * folder on their own, with nobody asked: the one place that says it.
 *
 * What somebody who is not the primary user may write is held to this list (see
 * writesInstructions in guard.ts), and so is the page on roles in the guide, which
 * a test compares with it. A file here becomes the agent's instructions or its
 * config, or a process of the portal, in the primary user's next conversation or
 * the agent's next look, whoever wrote it. Anything pi, the adapter or the portal
 * learns to load is added here and nowhere else; the guard then holds it, and a
 * test fails until the page names it.
 *
 * Not on it, on purpose: what a project contains and somebody runs (a script, a
 * Makefile, `.git/hooks`), the portal's own database, a file on PATH, a shell
 * profile. Nothing loads those when a conversation opens.
 */

/** Who reads it. */
export type LoadedBy = "portal" | "heartbeat" | "pi" | "mcp";

/** What a write there becomes, which is what the refusal says. */
export type LoadedAs = "context" | "watch" | "agent-name" | "instructions" | "tools" | "code";

export interface LoadedEntry {
  /** Its name in a folder, or its path from there (`.vscode/mcp.json`). Told apart from case, as a file system may not. */
  name: string;
  by: LoadedBy;
  as: LoadedAs;
  /** A folder: everything in it is read, at any depth. */
  folder?: boolean;
  /** Read from the folder a conversation runs in and from every folder above it, so it counts wherever it is. */
  above?: boolean;
}

/**
 * What is read out of the folder a conversation or a look runs in: an agent's
 * home, and any folder of a project.
 */
export const LOADED_IN_FOLDERS: LoadedEntry[] = [
  // The portal hands the agent's own files to pi as its context (extraContextFiles in sdk-client.ts) ...
  ...CONTEXT_FILES.map((name): LoadedEntry => ({ name, by: "portal", as: "context" })),
  // ... reads which agent a kept folder belongs to from its name (agents.ts) ...
  { name: AGENT_NAME_FILE, by: "portal", as: "agent-name" },
  // ... and the heartbeat asks what it is told to watch from this one, as the primary user's own words.
  { name: WATCH_FILE, by: "heartbeat", as: "watch" },
  // pi: the project's instructions, from the folder and from every one above it, and the folders it loads
  // its settings, system prompt, extensions, skills, prompts and themes from, and its packages.
  // The MCP adapter's `.pi/mcp.json` and `.agents/mcp.json` are in them.
  // pi reads the first of these a folder has, AGENTS.override.md before AGENTS.md (pi 1.x).
  { name: "AGENTS.override.md", by: "pi", as: "instructions", above: true },
  { name: "AGENTS.md", by: "pi", as: "instructions", above: true },
  { name: "CLAUDE.md", by: "pi", as: "instructions", above: true },
  { name: ".pi", by: "pi", as: "instructions", folder: true },
  { name: ".agents", by: "pi", as: "instructions", folder: true },
  // The MCP adapter: the tool servers it starts, each a process of the portal, from the folder's own config
  // and from the ones it imports (`.vscode/mcp.json`, and an `opencode.json` found from here up to the git root).
  { name: ".mcp.json", by: "mcp", as: "tools" },
  { name: ".vscode/mcp.json", by: "mcp", as: "tools" },
  { name: "opencode.json", by: "mcp", as: "tools", above: true },
];

export interface LoadedPlace {
  /** A folder, or a file, by its whole path. */
  path: string;
  by: LoadedBy;
  as: LoadedAs;
}

/**
 * What is read from a place of its own: pi's agent folder, the folders that ship
 * with the portal and are handed to pi or loaded by it, the folder channel
 * packages are installed in, and the MCP adapter's configs in the home of the
 * user the portal runs as and in the folder the portal itself runs in (it reads
 * that one for every conversation, as it starts). Asked each time, as they can be
 * moved by the environment.
 */
export function loadedPlaces(): LoadedPlace[] {
  const home = os.homedir();
  const places: (LoadedPlace | undefined)[] = [
    { path: piAgentDir(), by: "pi", as: "instructions" },
    // pi's user skills (`~/.agents/skills`) and the adapter's user-wide config (`~/.agents/mcp.json`), for every conversation.
    { path: path.join(home, ".agents"), by: "pi", as: "instructions" },
    ...["skills", "extensions"].map((name) => ofBundled(name, "pi", "instructions")),
    ofBundled("channels", "portal", "code"),
    { path: channelsPath(), by: "portal", as: "code" },
    // pi-mcp-adapter's config.ts: the shared config, and the ones it can import from other tools.
    ...[
      path.join(".config", "mcp", "mcp.json"),
      path.join(".cursor", "mcp.json"),
      path.join(".claude", "mcp.json"),
      ".claude.json",
      path.join(".claude", "claude_desktop_config.json"),
      path.join("Library", "Application Support", "Claude", "claude_desktop_config.json"),
      path.join(".codex", "config.toml"),
      path.join(".codex", "config.json"),
      path.join(".config", "opencode", "opencode.json"),
      path.join(".windsurf", "mcp.json"),
    ].map((file): LoadedPlace => ({ path: path.join(home, file), by: "mcp", as: "tools" })),
    // Its project config, from the folder the portal runs in: the same names it reads from a conversation's folder.
    ...LOADED_IN_FOLDERS.filter((entry) => entry.by === "mcp").map((entry): LoadedPlace => ({ path: path.join(process.cwd(), ...entry.name.split("/")), by: entry.by, as: entry.as })),
  ];
  return places.filter((place): place is LoadedPlace => place !== undefined);
}

function ofBundled(name: string, by: LoadedBy, as: LoadedAs): LoadedPlace | undefined {
  const dir = bundledPath(name);
  return dir === undefined ? undefined : { path: dir, by, as };
}

/** The parts of a path, lower case, with nothing between separators. */
const partsOf = (where: string): string[] => where.toLowerCase().split(/[\\/]+/).filter(Boolean);

/**
 * The entry of LOADED_IN_FOLDERS that reads `where`, or undefined: a file by its
 * name, or a file in a folder that is read from, as `readsFrom` says of the
 * folder it would be read from. Without `readsFrom` there is no folder to hold
 * it to, and every folder is.
 */
export function loadedAt(where: string, readsFrom?: (folder: string) => boolean): LoadedEntry | undefined {
  const parts = partsOf(where);
  for (const entry of LOADED_IN_FOLDERS) {
    const want = partsOf(entry.name);
    if (entry.folder) {
      if (parts.includes(want[0])) return entry;
      continue;
    }
    if (want.some((part, i) => parts[parts.length - want.length + i] !== part)) continue;
    if (entry.above || !readsFrom) return entry;
    let folder = where;
    for (let i = 0; i < want.length; i++) folder = path.dirname(folder);
    if (readsFrom(folder)) return entry;
  }
  return undefined;
}
