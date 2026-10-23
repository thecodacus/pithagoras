/**
 * Which tools a conversation may use, given a default and its own exceptions.
 *
 * Kept apart from the database and from pi so the rule can be read in one
 * place and tested without either: a default that applies everywhere, and a
 * conversation that may disagree about any tool in either direction.
 *
 * There are six layers, each an exception to the one before it: the
 * portal-wide default, an agent's, a project's, a routine's for its runs, a
 * chat's mode, and the conversation's own exceptions, which are the last word.
 * All but the last are folded into one default with `defaultsFor`
 * (`toolDefaultsFor` and `toolDefaultsForSession` in db.ts), so a conversation
 * is judged against "what it starts with" and nothing else here has to know the
 * layers exist.
 */

/**
 * The name the portal gave the MCP it attached the agent's browser as.
 *
 * Its tools arrive named `browser_<whatever>`, and they are switched here like
 * any other server's: having the browser is having its tools, and there is no
 * second switch for it.
 */
export const BROWSER_MCP = "browser";

/**
 * How the adapter starts the names of a server's tools, in its default `server` mode
 * (getServerPrefix): the server's name with its hyphens as underscores, and its dots
 * kept. `brave-search` registers `brave_search_brave_web_search`, and `docs.v2`
 * registers `docs.v2_search`. A tool's own dots are written as underscores
 * (formatToolName), a server's are not: `docs_v2_search` is the tool `v2_search` of
 * a server called `docs`.
 */
export function mcpPrefix(server: string): string {
  return server.replace(/-/g, "_");
}

/**
 * How the adapter starts the names of a server's tools in the naming it is set to
 * (`toolPrefix`, getServerPrefix): `server` is mcpPrefix; `short` leaves out a
 * closing `mcp` (`docs-mcp` names its tools `docs_…`); `mcp` puts `mcp__` before
 * it; `none` starts them with nothing, a tool's own name being all of it.
 */
export function mcpPrefixAs(server: string, naming: string): string {
  if (naming === "none") return "";
  if (naming === "short") return server.replace(/-?mcp$/i, "").replace(/-/g, "_") || "mcp";
  if (naming === "mcp") return `mcp__${mcpPrefix(server)}`;
  return mcpPrefix(server);
}

/**
 * Could a tool of this name be this server's, as the adapter names them? What
 * every place that tells a tool's server by its name goes by, so that none of
 * them gives a tool to a server another would not. In the naming given, the
 * default where none is: one that names a tool by its own name alone could have
 * a tool of any name.
 */
export function mcpClaims(server: string, name: string, naming = "server"): boolean {
  const prefix = mcpPrefixAs(server, naming);
  return !prefix || name.startsWith(`${prefix}_`);
}

/**
 * Which MCP server a tool came through, if any.
 *
 * Everything behind the adapter registers itself as one package, so a machine
 * with three servers attached had one group of forty tools called
 * `pi-mcp-adapter`. Nobody thinks of them that way: they think "the browser
 * one", "the Jira one". The adapter names a tool `<server>_<tool>` (mcpPrefix),
 * so the server is recoverable from the name given the list of configured servers.
 *
 * The longest match wins, or a server called `browser` would claim the tools
 * of one called `browser_staging`.
 *
 * What is returned is the name as configured.
 */
export function mcpServerOf(name: string, servers: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestLength = -1;
  for (const server of servers) {
    if (!mcpClaims(server, name)) continue;
    const length = mcpPrefix(server).length;
    if (length > bestLength) {
      best = server;
      bestLength = length;
    }
  }
  return best;
}


/** What to file a tool under: its MCP server where it has one, its package otherwise. */
export function toolSource(name: string, source: string, servers: Iterable<string>): string {
  return mcpServerOf(name, servers) ?? source;
}

/** What the web app calls the tools that say nothing about where they came from: pi's own among them. */
export const BUILT_IN_SET = "built in";

/**
 * The names of pi's own tools. By name rather than by set: with the sandbox on, the portal's inline
 * extension registers these again, and pi then files them under that extension's name, as it does
 * any extension that brings a tool of one of these names.
 */
export const PI_BUILT_IN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/**
 * The tool set a tool belongs to: the box the tool lists show it in, which is also what
 * can be made lazy.
 */
export function toolSetOf(tool: { name: string; source: string }, servers: Iterable<string>): string {
  return toolSource(tool.name, tool.source, servers).trim() || BUILT_IN_SET;
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
 * How a single tool is marked lazy in the list of marks, which holds tool sets as well. Brackets, as
 * no package, file or MCP server is called, so a set cannot be taken for a tool.
 */
export const lazyToolEntry = (name: string): string => `<tool>${name}`;

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
