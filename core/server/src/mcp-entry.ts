import { NAME_RE, problemForWrite, readMcpFile, writeMcpFile, type McpFile } from "./api/mcp.js";
import { setMcpApprove } from "./db.js";
import { approvePatterns } from "./pi/mcp-origin.js";

/**
 * One server in pi's mcp.json, written by a feature rather than in Settings →
 * MCP. The entry given is the entry written, once pi's own check accepts it;
 * one that keeps what somebody added to the entry by hand reads it first
 * (`mcpServer`) and passes it on. The chats are not reloaded here: the caller
 * says when.
 *
 * `approve` is the server's patterns of tools whose calls the person confirms first (see mcpApprove in db.ts): they replace what the
 * server had, and a server written without them has none, so one given a name that another had is not gated by that one's list. They are
 * in place before the file is written, so that no chat connects the server without them.
 */
export async function setMcpServer(name: string, entry: Record<string, unknown> | undefined, approve?: unknown): Promise<void> {
  if (!NAME_RE.test(name)) throw new TypeError("An MCP server's name is letters, digits, underscore or dash");
  const patterns = approve === undefined || entry === undefined ? [] : approvePatterns(approve, name);
  if (typeof patterns === "string") throw new TypeError(patterns);
  const problem = entry === undefined ? null : await problemForWrite(name, entry);
  if (problem) throw new TypeError(problem);
  // Read as late as can be, and written with nothing between: a server saved in the meantime stays.
  const config = readable();
  setMcpApprove(name, patterns);
  if (entry) config.mcpServers[name] = entry;
  else delete config.mcpServers[name];
  writeMcpFile(config, "extension");
}

/** mcp.json as it is now, or a refusal while it cannot be parsed: that is the person's to fix, and nothing is written over it. */
function readable(): McpFile {
  const { config, error } = readMcpFile();
  if (error) throw Object.assign(new Error(`Fix mcp.json first: ${error}`), { status: 409 });
  return config;
}
