import { followPackages, switchPackage } from "./api/extensions.js";
import { ADAPTER_SPEC, NAME_RE, mcpAdapter, readMcpFile, validateEntry, writeMcpFile } from "./api/mcp.js";
import { pi } from "./api/packages.js";
import { setTrustedMcpServers, trustedMcpServers } from "./db.js";

/**
 * One server in pi's mcp.json, written by a feature rather than in Settings →
 * MCP: by an extension (`portal.mcp.set`), or by the portal's own Understory.
 * The entry given is the entry written; one that keeps what somebody added to
 * the entry by hand reads it first (`mcpServer`) and passes it on.
 *
 * Writing one makes sure of pi-mcp-adapter, without which no entry is a tool.
 * `trusted` adds the server to the guard's trusted ones (Settings → Guard),
 * where the person can take it out again. The chats are not reloaded here:
 * the caller says when.
 */
export async function setMcpServer(name: string, entry: Record<string, unknown> | undefined, options: { trusted?: boolean } = {}): Promise<void> {
  if (!NAME_RE.test(name)) throw new TypeError("An MCP server's name is letters, digits, dot, dash or underscore");
  const problem = entry === undefined ? null : validateEntry(entry);
  if (problem) throw new TypeError(problem);
  const { config, error } = readMcpFile();
  if (error) throw Object.assign(new Error(`Fix mcp.json first: ${error}`), { status: 409 });
  if (entry) {
    const adapter = mcpAdapter();
    if (!adapter) await pi(["install", ADAPTER_SPEC]);
    else if (!adapter.enabled) await switchPackage(adapter.source, true);
    // A package installed or switched on: the server halves follow, as for any other.
    if (!adapter?.enabled) await followPackages();
    config.mcpServers[name] = entry;
  } else {
    delete config.mcpServers[name];
  }
  writeMcpFile(config);
  if (entry && options.trusted) setTrustedMcpServers([...trustedMcpServers(), name]);
}
