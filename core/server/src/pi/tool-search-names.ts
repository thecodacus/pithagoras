/**
 * The name the tool to a conversation's lazy tools is known by, in a module of its own: the guard reads it as it
 * loads, the pages read it too, and none of them may wait on everything the tool needs.
 */

/** The tool that finds, describes and calls the tools a conversation has as lazy. pi's own tool search has the same name. */
export const TOOL_SEARCH = "tool_search";

/**
 * What this tool was called before: `tools`. Chats that were written then have its calls in their history, and the pages
 * and channels still draw those as the tool they called. Nothing registers a tool of this name any more; one an extension
 * brings is only its own.
 */
export const LEGACY_GATEWAY_TOOL = "tools";

/** Whether this is the name of the tool, or the one it had: for reading a call, never for deciding what a tool may do. */
export const isSearchTool = (name: unknown): boolean => name === TOOL_SEARCH || name === LEGACY_GATEWAY_TOOL;

/**
 * What the portal puts on the end of a call through the tool, which says which tool it called: pi's end event of a call
 * names the tool (`tool_search`) and carries no arguments, and the pages that draw a picture or open the browser from a
 * tool's name read it there. See calledThrough for the start.
 */
export const CALLED_TOOL_KEY = "portalCalledTool";

/**
 * The call a call of the tool makes: the tool it calls, and the arguments it gives it. Nothing for a search or a
 * describe, which call nothing. The arguments are an object or the JSON text of one, as the tool takes them. The portal's
 * pages and its client read it alike, so a lazy tool looks like itself to both.
 */
export function calledThrough(args: unknown): { name: string; args: Record<string, unknown> } | undefined {
  const plain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!plain(args) || args.action !== "call" || typeof args.name !== "string") return undefined;
  const name = args.name.trim();
  if (!name) return undefined;
  let given: unknown = args.args;
  if (typeof given === "string") {
    try {
      given = JSON.parse(given);
    } catch {
      given = undefined;
    }
  }
  return { name, args: plain(given) ? given : {} };
}

/**
 * The tool an event of pi's is of, for a call that may have gone through the tool to a lazy one: the end of such a call
 * names `tool_search` and carries no arguments, so the portal puts the tool it called on it (CALLED_TOOL_KEY). Any other
 * event is of the tool it names. The page and a channel read the portal's pictures by this, so a picture a lazy tool made
 * or showed is told like one of a direct call.
 */
export function calledToolOf(payload: any): string {
  // pi has spelled the name both ways.
  const name = String(payload?.toolName ?? payload?.name ?? "");
  const called = isSearchTool(name) ? payload?.[CALLED_TOOL_KEY] : undefined;
  return typeof called === "string" && called ? called : name;
}

/**
 * What a search or a describe puts on its result's details: the names of the tools whose words it shows (their names,
 * descriptions and parameters). The guard reads it to tell whether the result holds text from an MCP server the person has
 * not said is their own (see untrustedResult): the tool says which tools it quoted, and the guard says whose they are.
 */
export const LISTED_TOOLS_KEY = "portalListedTools";
