import { readMcpFile, validateEntry, writeMcpFile, type McpFile } from "./api/mcp.js";
import { SERVER_NAME_RE, fromAdapterEntry } from "./mcp-config.js";

/**
 * One server in pi's mcp.json, written by a feature rather than in Settings → MCP. The entry given is the entry written;
 * one that keeps what somebody added to the entry by hand reads it first (`mcpServer`) and passes it on.
 *
 * The entry is pi's: `{ url | command, headers, env, exposure, toolExposure, … }`. An extension that still writes the
 * adapter's keys (`directTools`, `includeTools`, `approveTools`, `auth: "bearer"`, `lifecycle` …) has them translated, for
 * this release, and gets a line in the log; what the entry says about confirming tools comes back as `approve`.
 *
 * The chats are not reloaded here: the caller says when.
 */
export async function setMcpServer(name: string, entry: Record<string, unknown> | undefined): Promise<{ entry?: Record<string, unknown>; approve: string[] }> {
  if (!SERVER_NAME_RE.test(name)) throw new TypeError("An MCP server's name is letters, digits, dash or underscore");
  // A file that cannot be read is refused before anything is changed.
  const before = readable();
  let written = entry;
  let approve: string[] = [];
  if (entry) {
    if (typeof entry !== "object" || Array.isArray(entry)) throw new TypeError("Server must be an object");
    const translated = fromAdapterEntry(entry);
    written = translated.entry;
    approve = translated.approve;
    if (translated.notes.length) console.warn(`[portal] the MCP server "${name}" was written in the old adapter's keys (${translated.notes.join("; ")}): write pi's own, the old ones are read for this release only`);
    const problem = validateEntry(name, written, Object.keys(before.mcpServers));
    if (problem) throw new TypeError(problem);
  }
  // Read after the checks, and written with none between: a server saved in the meantime stays.
  const config = readable();
  if (written) config.mcpServers[name] = written;
  else delete config.mcpServers[name];
  writeMcpFile(config);
  return { ...(written ? { entry: written } : {}), approve };
}

/** mcp.json as it is now, or a refusal while it cannot be parsed: that is the person's to fix, and nothing is written over it. */
function readable(): McpFile {
  const { config, error } = readMcpFile();
  if (error) throw Object.assign(new Error(`Fix mcp.json first: ${error}`), { status: 409 });
  return config;
}
