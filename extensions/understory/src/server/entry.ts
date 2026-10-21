/**
 * Understory as the agent's memory: an MCP server in pi's mcp.json, named `understory`, whose tools pi-mcp-adapter
 * makes the chats' as `understory_memory_*`. Written and removed with `portal.mcp.set`, read with `portal.mcp.get`.
 */

/** The MCP server Understory is in pi's mcp.json; its tools arrive as `understory_memory_*`. */
export const UNDERSTORY = "understory";
export const UNDERSTORY_TOKEN_ENV = "MEMORY_UNDERSTORY_AUTH_TOKEN";

export const understoryDefaultUrl = (): string => process.env.MEMORY_UNDERSTORY_URL?.trim() || "http://localhost:3800/mcp";

/**
 * The entry for mcp.json. Its tools directly in the agent's list rather than
 * behind the adapter's proxy: memory the agent has to go looking for first is
 * memory it does not use. A token from the environment stays there, named
 * rather than copied into the file; the one made for the Understory the portal
 * runs is written in, beside the keys pi keeps in the same folder.
 */
export function understoryEntry(url: string, auth: { tokenEnv?: string; token?: string } = {}): Record<string, unknown> {
  return {
    url,
    lifecycle: "lazy",
    directTools: true,
    ...(auth.token ? { auth: "bearer", bearerToken: auth.token } : auth.tokenEnv ? { auth: "bearer", bearerTokenEnv: auth.tokenEnv } : {}),
  };
}

/** The token an entry calls Understory with: written in it (the Understory the portal runs), or named from the environment. */
export function understoryTokenOf(entry: Record<string, unknown> | undefined): string | undefined {
  if (typeof entry?.bearerToken === "string" && entry.bearerToken) return entry.bearerToken;
  if (typeof entry?.bearerTokenEnv === "string") return process.env[entry.bearerTokenEnv] || undefined;
  return undefined;
}

/** Said to the agent in place of MEMORY.md, while Understory holds its memory. */
export const UNDERSTORY_RULE =
  "Your long-term memory is Understory, reached through the understory_memory_* tools, not a MEMORY.md file. " +
  "Before relying on what you think you know about the person, their work or earlier decisions, look it up with understory_memory_query. " +
  "When you learn something worth having next week — a decision and why, a preference you were corrected on, how something is set up — record it with understory_memory_add, or understory_memory_update where it is already there.";
