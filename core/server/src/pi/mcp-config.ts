import type { LoadedMcpConfig, McpServerConfig, McpServerEntry } from "@earendil-works/pi-coding-agent";

/**
 * pi's MCP support, as the portal needs it: pi reads `mcp.json`, connects the servers and registers their tools itself.
 * The portal adds no runtime to that. What it does is hand pi, for each chat, the same configuration pi would read and
 * the two values the chat decides: whether the server is on (`enabled`) and how its tools reach the model (`exposure`).
 *
 * pi's own reading and checking of the file are used as they are, not written again here. pi does not export them from its
 * package root, so they are taken from the files of the package, which this module is the one place to know about; a pi
 * that moves them is found by the test that loads them (mcp-config.test.mjs).
 */

export interface PiMcp {
  /** The global `mcp.json` of the agent folder and, for a trusted project, its `.pi/mcp.json`: with the entries that are not valid left out and reported. */
  loadMcpConfig(options: { agentDir: string; cwd: string; projectTrusted: boolean }): LoadedMcpConfig;
  /** One entry of `mcpServers`: a copy of it, or the message that says what is wrong with it. */
  validateMcpServerConfig(name: string, raw: unknown): McpServerConfig | string;
  /** The name pi gives a server's tool, `mcp__<server>__<tool>` with every character but letters, digits and `_` as `_`. */
  createMcpToolName(server: string, tool: string): string;
  /** Whether a tool name matches any of the entries, each an exact name or a pattern where `*` matches any characters (as `toolExposure`'s keys). */
  createToolNameMatcher(entries: readonly string[]): (name: string) => boolean;
}

let loaded: PiMcp | undefined;

/** pi's reading and checking, imported the first time: a chat is started with them in hand, as pi reads its configuration without waiting. */
export async function piMcp(): Promise<PiMcp> {
  if (loaded) return loaded;
  const root = import.meta.resolve("@earendil-works/pi-coding-agent");
  const [config, servers, tools] = await Promise.all([
    import(new URL("./extensions/mcp/config.js", root).href),
    import(new URL("./core/mcp-servers.js", root).href),
    import(new URL("./extensions/mcp/tools.js", root).href),
  ]);
  loaded = { loadMcpConfig: config.loadMcpConfig, validateMcpServerConfig: servers.validateMcpServerConfig, createMcpToolName: tools.createMcpToolName, createToolNameMatcher: servers.createToolNameMatcher };
  return loaded;
}

/**
 * What the portal decides of a server's exposure. A server that is on is `direct` for pi: its tools are registered and
 * active, and whether the model is offered each one or finds them through `tool_search` is the portal's own lazy setting,
 * the same one as for any other tool (see lazyMember in sdk-client.ts), so pi's own `deferred` and `codemode`, which declare
 * tools only when pi's tool search or a script asks, are not used. A server the file switches off or hides stays so, and so do
 * the tools a `toolExposure` in the file hides or gives to scripts (one it calls `deferred` is `direct`, see below). Whether a tool is on for a chat is the chat's tool switch,
 * as for every tool: a server is connected whatever the chat has switched off of it, so that its tools can be switched on again.
 */
export function forChat(config: McpServerConfig): McpServerConfig {
  if (config.enabled === false || config.exposure === "hidden") return config;
  // A tool the file calls `deferred` would be reached by pi's own tool search, which is not the portal's: it is `direct` for pi, and behind the portal's `tool_search` where the server is lazy.
  const tools = config.toolExposure;
  const toolExposure = tools && Object.values(tools).includes("deferred") ? Object.fromEntries(Object.entries(tools).map(([tool, how]) => [tool, how === "deferred" ? "direct" : how])) : tools;
  return { ...config, exposure: "direct", ...(toolExposure ? { toolExposure } : {}) };
}

/**
 * pi's configuration for a chat, as `createMcpExtension` is asked for it at each start and reload of the chat: every
 * server of the file as pi reads it, each given the exposure the portal decides (see forChat). `onServers` is told the
 * servers, by which their tools are told apart (see SdkPiClient.serverOf).
 *
 * A server the user's file defines stays what the user's file says: pi lets a trusted project's `.pi/mcp.json` define a server
 * of the same name anew, with another command, and its tools would carry the namespace of the user's server, which the guard
 * trusts by name (see serverWords in guard.ts). A project may still override such a server's `enabled`, `exposure` and
 * `toolExposure` (pi's own rule, to turn one off in one project), but not switch on what the person has switched off or
 * hidden, a tool of it included: that server would start with the person's own command, environment and headers. A project may bring servers of its
 * own, which are nobody's the person has said is theirs.
 *
 * `autoEnableCodemode` is off: whether the code tool is on is a switch of the portal's, and a server's tool a file gives
 * to scripts must not turn it on.
 */
export function configForChat(
  pi: PiMcp,
  ctx: { cwd: string; isProjectTrusted(): boolean },
  agentDir: string,
  onServers: (servers: readonly McpServerEntry[]) => void,
): LoadedMcpConfig {
  const trusted = ctx.isProjectTrusted();
  const config = pi.loadMcpConfig({ agentDir, cwd: ctx.cwd, projectTrusted: trusted });
  const own = trusted ? new Map(pi.loadMcpConfig({ agentDir, cwd: ctx.cwd, projectTrusted: false }).servers.map((entry) => [entry.name, entry])) : new Map<string, McpServerEntry>();
  const servers = config.servers.map((entry) => {
    const user = own.get(entry.name);
    const redefined = entry.scope === "project" && entry.override === undefined;
    const kept = user && (redefined || (user.config.enabled === false || user.config.exposure === "hidden")) ? user : entry;
    // pi's merge of a project's override replaces `toolExposure` whole: a tool the person hid stays hidden. pi takes an exact name before any pattern, and the first pattern that matches, so the person's entries go first and a project's entry that names what theirs match (a tool or a pattern) is dropped.
    const hidden = Object.entries(user?.config.toolExposure ?? {}).filter(([, how]) => how === "hidden");
    let config = kept.config;
    if (kept === entry && hidden.length) {
      const held = pi.createToolNameMatcher(hidden.map(([tool]) => tool));
      const theirs = Object.entries(entry.config.toolExposure ?? {}).filter(([tool]) => !held(tool));
      config = { ...entry.config, toolExposure: { ...Object.fromEntries(hidden), ...Object.fromEntries(theirs) } };
    }
    return { ...kept, config: forChat(config) };
  });
  onServers(servers);
  return { ...config, servers, autoEnableCodemode: false };
}

/**
 * The servers of the user's file that pi connects for a chat, by name: not a project's own (that file is not the user's to
 * change in Settings) and not one that is switched off or hidden. What a chat that is running can lose when the file
 * changes under it (see serversWithdrawn in mcp-origin.ts).
 */
export function connectedFromUserFile(servers: readonly McpServerEntry[]): string[] {
  return servers.filter((entry) => entry.scope === "global" && entry.config.enabled !== false && entry.config.exposure !== "hidden").map((entry) => entry.name);
}
