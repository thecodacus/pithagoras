import { followPackages, switchPackage } from "./api/extensions.js";
import { ADAPTER_SPEC, NAME_RE, mcpAdapter, readMcpFile, validateEntry, writeMcpFile, type McpFile } from "./api/mcp.js";
import { pi } from "./api/packages.js";

/**
 * One server in pi's mcp.json, written by a feature rather than in Settings →
 * MCP. The entry given is the entry written; one that keeps what somebody
 * added to the entry by hand reads it first (`mcpServer`) and passes it on.
 *
 * Writing one makes sure of pi-mcp-adapter, without which no entry is a tool.
 * The chats are not reloaded here: the caller says when.
 */
export async function setMcpServer(name: string, entry: Record<string, unknown> | undefined): Promise<void> {
  if (!NAME_RE.test(name)) throw new TypeError("An MCP server's name is letters, digits, dot, dash or underscore");
  const problem = entry === undefined ? null : validateEntry(entry);
  if (problem) throw new TypeError(problem);
  // A file that cannot be read is refused before anything is installed.
  readable();
  if (entry) {
    const adapter = mcpAdapter();
    if (!adapter) await pi(["install", ADAPTER_SPEC]);
    else if (!adapter.enabled) await switchPackage(adapter.source, true);
    // A package installed or switched on: the server halves follow, as for any other.
    if (!adapter?.enabled) await followPackages();
  }
  // Read after those waits, and written with none between: a server saved in the meantime stays.
  const config = readable();
  if (entry) config.mcpServers[name] = entry;
  else delete config.mcpServers[name];
  writeMcpFile(config);
}

/** mcp.json as it is now, or a refusal while it cannot be parsed: that is the person's to fix, and nothing is written over it. */
function readable(): McpFile {
  const { config, error } = readMcpFile();
  if (error) throw Object.assign(new Error(`Fix mcp.json first: ${error}`), { status: 409 });
  return config;
}
