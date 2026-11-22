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
  loaded = { loadMcpConfig: config.loadMcpConfig, validateMcpServerConfig: servers.validateMcpServerConfig, createMcpToolName: tools.createMcpToolName };
  return loaded;
}

/**
 * What a chat decides of a server. The server is on unless the file says it is off or hides it, or every tool of it the
 * portal has seen is switched off for the chat (`off`: nothing is to be had of a server whose tools are all off, and it is
 * not started for it). A server that is on is `direct` for pi: its tools are registered and active, and whether the
 * model is offered each one or finds them through `tool_search` is the portal's own lazy setting, the same one as for any
 * other tool (see lazyMember in sdk-client.ts), so pi's own `deferred` and `codemode`, which declare tools only when
 * pi's tool search or a script asks, are not used. A hidden server stays hidden, and so do the tools a `toolExposure` in the
 * file hides or gives to scripts.
 */
export function forChat(config: McpServerConfig, off: boolean): McpServerConfig {
  if (config.enabled === false || config.exposure === "hidden") return config;
  if (off) return { ...config, enabled: false };
  return { ...config, exposure: "direct" };
}

/**
 * pi's configuration for a chat, as `createMcpExtension` is asked for it at each start and reload of the chat: every
 * server of the file as pi reads it, each given what the chat decides of it. `onServers` is told the servers, by which
 * their tools are told apart (see SdkPiClient.serverOf).
 *
 * A server the user's file defines stays what the user's file says: pi lets a trusted project's `.pi/mcp.json` define a server
 * of the same name anew, with another command, and its tools would carry the namespace of the user's server, which the guard
 * trusts by name (see serverWords in guard.ts). A project may still override such a server's `enabled`, `exposure` and
 * `toolExposure` (pi's own rule), and bring servers of its own, which are nobody's the person has said is theirs.
 *
 * `autoEnableCodemode` is off: whether the code tool is on is a switch of the portal's, and a server's tool a file gives
 * to scripts must not turn it on.
 */
export function configForChat(
  pi: PiMcp,
  ctx: { cwd: string; isProjectTrusted(): boolean },
  agentDir: string,
  off: (server: string) => boolean,
  onServers: (servers: readonly McpServerEntry[]) => void,
): LoadedMcpConfig {
  const trusted = ctx.isProjectTrusted();
  const config = pi.loadMcpConfig({ agentDir, cwd: ctx.cwd, projectTrusted: trusted });
  const own = trusted ? new Map(pi.loadMcpConfig({ agentDir, cwd: ctx.cwd, projectTrusted: false }).servers.map((entry) => [entry.name, entry])) : new Map<string, McpServerEntry>();
  const servers = config.servers.map((entry) => {
    const user = own.get(entry.name);
    const kept = entry.scope === "project" && entry.override === undefined && user ? user : entry;
    return { ...kept, config: forChat(kept.config, off(kept.name)) };
  });
  onServers(servers);
  return { ...config, servers, autoEnableCodemode: false };
}
