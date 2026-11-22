/**
 * Understory as the agent's memory: an MCP server in pi's mcp.json, named `understory`, whose tools pi makes the chats'
 * as `mcp__understory__memory_*`. Written and removed with `portal.mcp.set`, read with `portal.mcp.get`.
 */

/** The MCP server Understory is in pi's mcp.json; its tools arrive as `mcp__understory__memory_*`. */
export const UNDERSTORY = "understory";
export const UNDERSTORY_TOKEN_ENV = "MEMORY_UNDERSTORY_AUTH_TOKEN";

export const understoryDefaultUrl = (): string => process.env.MEMORY_UNDERSTORY_URL?.trim() || "http://localhost:3800/mcp";

/**
 * The entry for mcp.json. Its tools are in the agent's list rather than behind `tool_search` (the portal is asked for
 * that with `direct` when it is written): memory the agent has to go looking for first is memory it does not use. A token
 * from the environment stays there, named rather than copied into the file (`${NAME}`, which pi expands); the one made
 * for the Understory the portal runs is written in, beside the keys pi keeps in the same folder.
 */
export function understoryEntry(url: string, auth: { tokenEnv?: string; token?: string } = {}): Record<string, unknown> {
  const token = auth.token || (auth.tokenEnv ? `\${${auth.tokenEnv}}` : "");
  return { url, ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) };
}

/** The token an entry calls Understory with: written in its `Authorization` header (the Understory the portal runs), or named from the environment. */
export function understoryTokenOf(entry: Record<string, unknown> | undefined): string | undefined {
  const header = (entry?.headers as { Authorization?: unknown } | undefined)?.Authorization;
  const token = typeof header === "string" ? /^Bearer\s+(.+)$/i.exec(header.trim())?.[1] : undefined;
  if (!token) return undefined;
  const named = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(token);
  return named ? process.env[named[1]] || undefined : token;
}

/** Said to the agent in place of MEMORY.md, while Understory holds its memory. */
export const UNDERSTORY_RULE =
  "Your long-term memory is Understory, reached through the mcp__understory__memory_* tools, not a MEMORY.md file. " +
  "Before relying on what you think you know about the person, their work or earlier decisions, look it up with mcp__understory__memory_query. " +
  "When you learn something worth having next week — a decision and why, a preference you were corrected on, how something is set up — record it with mcp__understory__memory_add, or mcp__understory__memory_update where it is already there.";
