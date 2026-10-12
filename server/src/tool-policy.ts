/**
 * Which tools a conversation may use, given a default and its own exceptions.
 *
 * Kept apart from the database and from pi so the rule can be read in one
 * place and tested without either: a default that applies everywhere, and a
 * conversation that may disagree about any tool in either direction.
 *
 * There are three layers, each an exception to the one before it: the
 * portal-wide default, a project's exceptions to it, and a conversation's
 * exceptions to what the project leaves. The project's layer is folded into
 * the default with `defaultsFor`, so a conversation is judged against "what its
 * project starts it with" and nothing else here has to know projects exist.
 */

/**
 * The MCP the portal attaches the agent's browser as.
 *
 * Its tools arrive named `browser_<whatever>`, and they are switched here like
 * any other server's: having the browser is having its tools, and there is no
 * second switch for it. The globe beside the composer only shows or hides the
 * view of the browser the agent is driving.
 */
export const BROWSER_MCP = "browser";

/**
 * The portal's own browser tools (browser/tools.ts): browser tools by name,
 * whatever MCP servers there are, since they come from no server.
 */
export const PORTAL_BROWSER_TOOLS = [
  "browser_navigate",
  "browser_back",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_select",
  "browser_key",
  "browser_scroll",
  "browser_find",
  "browser_get_text",
  "browser_screenshot",
] as const;

/**
 * Which MCP server a tool came through, if any.
 *
 * Everything behind the adapter registers itself as one package, so a machine
 * with three servers attached had one group of forty tools called
 * `pi-mcp-adapter`. Nobody thinks of them that way: they think "the browser
 * one", "the Jira one". The adapter names a tool `<server>_<tool>`, so the
 * server is recoverable from the name given the list of configured servers.
 *
 * The longest match wins, or a server called `browser` would claim the tools
 * of one called `browser_staging`.
 *
 * The prefix is the server's name with its hyphens as underscores, which is how
 * the adapter writes it: `brave-search` registers `brave_search_brave_web_search`.
 * What is returned is the name as configured.
 */
export function mcpServerOf(name: string, servers: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestLength = -1;
  for (const server of servers) {
    const prefix = server.replace(/-/g, "_");
    if (!name.startsWith(`${prefix}_`)) continue;
    if (prefix.length > bestLength) {
      best = server;
      bestLength = prefix.length;
    }
  }
  return best;
}

/**
 * Does this tool come from the agent's browser?
 *
 * `browsers` is the servers that are the browser, which the caller works out
 * from what they connect to; it defaults to the name the portal writes.
 *
 * Asked through mcpServerOf rather than by prefix, because the prefix is
 * ambiguous: a server called `browser_staging` names a tool
 * `browser_staging_click`, which starts with `browser_` and is not the
 * browser's. Whether a conversation may drive the signed-in Chromium hangs on
 * this answer, so it is the careful one.
 */
export function browserTool(
  name: string,
  servers: Iterable<string>,
  browsers: string[] = [BROWSER_MCP]
): boolean {
  if ((PORTAL_BROWSER_TOOLS as readonly string[]).includes(name)) return true;
  const server = mcpServerOf(name, servers);
  return server !== undefined && browsers.includes(server);
}


/** What to file a tool under: its MCP server where it has one, its package otherwise. */
export function toolSource(name: string, source: string, servers: Iterable<string>): string {
  return mcpServerOf(name, servers) ?? source;
}

export interface ToolExceptions {
  /** Off here, whatever the default says. */
  off: string[];
  /** On here, whatever the default says. */
  on: string[];
}

/** Is this tool on, for a conversation holding these exceptions? */
export function toolEnabled(
  name: string,
  defaultsOff: Iterable<string>,
  exceptions: ToolExceptions
): boolean {
  if (exceptions.off.includes(name)) return false;
  if (exceptions.on.includes(name)) return true;
  return ![...defaultsOff].includes(name);
}

/**
 * The tools that are off by default for a project: the portal-wide default,
 * bent by the project's own exceptions.
 *
 * A conversation in the project holds its exceptions against this, not against
 * the portal-wide default. What it stored before the project said anything is
 * kept as it is — an exception is a decision about one tool, and stays one
 * whatever the default under it becomes — while a tool it never mentioned
 * follows the project.
 */
export function defaultsFor(defaultsOff: string[], projectExceptions: ToolExceptions): string[] {
  return effectiveOff([], defaultsOff, projectExceptions);
}

/** Everything off for this conversation, which is what pi has to be told. */
export function effectiveOff(
  names: Iterable<string>,
  defaultsOff: string[],
  exceptions: ToolExceptions
): string[] {
  const seen = new Set([...names, ...defaultsOff, ...exceptions.off, ...exceptions.on]);
  return [...seen].filter((name) => !toolEnabled(name, defaultsOff, exceptions)).sort();
}

/**
 * What is wanted off, with what is held off and was not shown kept off. A page
 * says what it wants of the tools it listed; one it did not list — an MCP tool
 * the configuration leaves out for now, a package not loaded — it said nothing
 * about, and its switch is to be there when it is listed again.
 */
export function heldOffUnshown(wantedOff: Iterable<string>, shown: Iterable<string>, held: ToolExceptions): string[] {
  const listed = new Set(shown);
  return [...new Set([...wantedOff, ...held.off.filter((name) => !listed.has(name))])];
}

/**
 * The exceptions to store, given what somebody wants off in this conversation.
 *
 * The page says what it wants the result to be; this works out what has to be
 * written down to get there. Anything already true by default is not written
 * down at all, so a later change to the default still reaches this
 * conversation — which is the point of having one.
 *
 * What the conversation already holds is the exception to that. Something
 * somebody switched here on purpose is theirs, even where the default has since
 * come to agree with it: dropping it on the next unrelated flip would leave a
 * chat that follows whatever the default does next, when it was told not to.
 */
export function exceptionsFor(
  wantedOff: Iterable<string>,
  defaultsOff: string[],
  known: Iterable<string>,
  held: ToolExceptions = { off: [], on: [] }
): ToolExceptions {
  const off = new Set(wantedOff);
  const defaults = new Set(defaultsOff);
  const exceptions: ToolExceptions = { off: [], on: [] };
  // Only the tools the caller answered about. Walking the defaults as well
  // would write an "on" exception for every default-off tool the caller never
  // saw — an extension that failed to load, a server that is not attached —
  // and that exception outlives the default it was silently cancelling.
  for (const name of new Set([...known, ...off])) {
    if (off.has(name) && (!defaults.has(name) || held.off.includes(name))) exceptions.off.push(name);
    if (!off.has(name) && (defaults.has(name) || held.on.includes(name))) exceptions.on.push(name);
  }
  exceptions.off.sort();
  exceptions.on.sort();
  return exceptions;
}
