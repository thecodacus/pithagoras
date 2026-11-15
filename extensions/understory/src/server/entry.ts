/**
 * Understory as the agent's memory: an MCP server in pi's mcp.json, named `understory`, whose tools pi's own MCP support
 * makes the chats' as `mcp__understory__memory_*`. Written and removed with `portal.mcp.set`, read with `portal.mcp.get`.
 */

/** The MCP server Understory is in pi's mcp.json; its tools arrive as `mcp__understory__memory_*`. */
export const UNDERSTORY = "understory";
export const UNDERSTORY_TOKEN_ENV = "MEMORY_UNDERSTORY_AUTH_TOKEN";

export const understoryDefaultUrl = (): string => process.env.MEMORY_UNDERSTORY_URL?.trim() || "http://localhost:3800/mcp";

/**
 * The entry for mcp.json. Its tools directly in the agent's list rather than behind `tool_search`: memory the agent has
 * to go looking for first is memory it does not use (the person's own mark of the server still decides, once they set
 * one). A token from the environment stays there, named rather than copied into the file (`Bearer ${NAME}`, which pi
 * fills in); the one made for the Understory the portal runs is written in, beside the keys pi keeps in the same folder.
 */
export function understoryEntry(url: string, auth: { tokenEnv?: string; token?: string } = {}): Record<string, unknown> {
  return {
    url,
    exposure: "direct",
    ...(auth.token ? { headers: { Authorization: `Bearer ${auth.token}` } } : auth.tokenEnv ? { headers: { Authorization: `Bearer \${${auth.tokenEnv}}` } } : {}),
  };
}

/** The name an entry's headers give the Authorization header, in whatever case it was written: HTTP takes them alike. */
export function authorizationKey(headers: unknown): string | undefined {
  return headers && typeof headers === "object" ? Object.keys(headers).find((key) => key.toLowerCase() === "authorization") : undefined;
}

/** The token an entry calls Understory with: written in it (the Understory the portal runs), or named from the environment. */
export function understoryTokenOf(entry: Record<string, unknown> | undefined): string | undefined {
  const headers = entry?.headers;
  const key = authorizationKey(headers);
  const header = key ? (headers as Record<string, unknown>)[key] : undefined;
  const bearer = typeof header === "string" ? /^Bearer\s+(.+)$/.exec(header)?.[1]?.trim() : undefined;
  if (!bearer) return undefined;
  // `${NAME}` is pi's way of naming an environment variable.
  const named = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(bearer)?.[1];
  return named ? process.env[named] || undefined : bearer;
}

/** Said to the agent in place of MEMORY.md, while Understory holds its memory. */
export const UNDERSTORY_RULE =
  "Your long-term memory is Understory, reached through the mcp__understory__memory_* tools, not a MEMORY.md file. " +
  "Before relying on what you think you know about the person, their work or earlier decisions, look it up with mcp__understory__memory_query. " +
  "When you learn something worth having next week — a decision and why, a preference you were corrected on, how something is set up — record it with mcp__understory__memory_add, or mcp__understory__memory_update where it is already there.";
