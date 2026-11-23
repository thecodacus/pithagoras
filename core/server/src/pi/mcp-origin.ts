/**
 * Where a tool of pi's native MCP support comes from, told by what pi records of it and never by the look of its name.
 *
 * pi registers a server's tools as `mcp__<server>__<tool>` with a namespace, `mcp__<server>` (the server's name with its
 * hyphens as underscores), on the tool's definition. That namespace is what attributes the tool: a name only looks like
 * one, and any extension can register a tool called `mcp_page` or `mcp__x__y`. The three resource tools are shared by every
 * server and name theirs in an argument.
 *
 * The portal runs pi's own MCP support (see sdk-client.ts), so every server's tool carries such a namespace.
 *
 * Pure, in a module of its own: the guard and the tests read it, and none of them may wait on the database.
 */

/** pi's tools for the resources of the servers, which reach every server that has some: the server is an argument. */
export const MCP_RESOURCE_TOOLS: readonly string[] = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];

/** Whether this is the name of one of pi's resource tools. */
export const isResourceTool = (name: string): boolean => MCP_RESOURCE_TOOLS.includes(name);

/** The set the lists file pi's three tools for the servers' resources under, which belong to no one server. */
export const MCP_RESOURCES = "MCP resources";

/** The namespace pi gives a server's tools: `mcp__<server>`, hyphens as underscores (mcpNamespace in pi's core/mcp-servers). */
export const mcpNamespace = (server: string): string => `mcp__${server.replace(/-/g, "_")}`;

/**
 * The namespace of a tool that pi's MCP support registered, from the definition's own: undefined for any other tool. A
 * namespace is a group any extension may name, so only one in pi's `mcp__` form counts.
 */
export function mcpNamespaceOf(definition: unknown): string | undefined {
  const name = (definition as { namespace?: { name?: unknown } } | undefined)?.namespace?.name;
  return typeof name === "string" && name.startsWith("mcp__") ? name : undefined;
}

/**
 * The configured servers a namespace can be. One in the normal case; more than one where two names differ only by a hyphen
 * and an underscore, which pi refuses to connect together, and none where the server is not in the portal's file (one
 * that only a project's own configuration brought, or an extension registered): then it is nobody's the person has said
 * is theirs.
 */
export function serversOfNamespace(namespace: string, configured: Iterable<string>): string[] {
  return [...configured].filter((server) => mcpNamespace(server) === namespace);
}

/**
 * The configured server a resource tool's `server` argument names. pi takes the name as configured, with the blanks around
 * it trimmed, and nothing else; undefined where it names none, and where there is none (a listing of every server's).
 */
export function serverOfArgument(argument: unknown, configured: Iterable<string>): string | undefined {
  if (typeof argument !== "string") return undefined;
  const name = argument.trim();
  return name ? [...configured].find((server) => server === name) : undefined;
}

/**
 * The namespaces of the servers a chat has switched off: every tool of the server that the chat has registered is off. A
 * server stays connected whatever a chat has off of its tools (so a switch can be undone), and pi's resource tools reach
 * every connected server by an argument, so the guard holds them to this. A server with no tool registered cannot be told
 * as off. A tool pi registered as `hidden` (the file hides it, or the server dropped it) is not one a chat can switch, so it
 * does not count: a server with every tool that can be switched off is off.
 */
export function serversSwitchedOff(tools: Iterable<{ name: string; definition: unknown }>, off: ReadonlySet<string>): Set<string> {
  const seen = new Map<string, boolean>();
  for (const tool of tools) {
    if ((tool.definition as { exposure?: unknown } | undefined)?.exposure === "hidden") continue;
    const namespace = mcpNamespaceOf(tool.definition);
    if (namespace !== undefined) seen.set(namespace, (seen.get(namespace) ?? true) && off.has(tool.name));
  }
  return new Set([...seen].filter(([, allOff]) => allOff).map(([namespace]) => namespace));
}

/** A name as `approve` compares it: every character but letters, digits and `_` is `_`, as pi writes a tool's name, so `delete-repo` and `delete_repo` are one. */
const plain = (name: string): string => name.replace(/[^A-Za-z0-9_*]/g, "_");

/**
 * The names a call of an MCP tool goes by for a server's `approve` patterns: the tool's own name as the server gave it (pi labels
 * the definition `<server>/<tool>`), and the name pi registered it under with `mcp__<server>__` taken off (which is the same
 * name, sanitised, and the only one left where pi has cut a long name short with a hash). Empty for a tool pi's MCP support did not register.
 */
export function approveNames(toolName: string, definition: unknown): string[] {
  const namespace = mcpNamespaceOf(definition);
  if (namespace === undefined) return [];
  const names: string[] = [];
  const label = (definition as { label?: unknown }).label;
  if (typeof label === "string" && label.includes("/")) names.push(label.slice(label.indexOf("/") + 1));
  if (toolName.startsWith(`${namespace}__`)) names.push(toolName.slice(namespace.length + 2));
  return [...new Set(names.map(plain))];
}

/** Whether any of the patterns (`*` for any characters, as a name `plain`ed) matches any of the names. */
export function needsApproval(patterns: readonly string[], names: readonly string[]): boolean {
  return patterns.some((pattern) => {
    // Only letters, digits, `_` and `*` are left of a pattern, so nothing in it is special to a regular expression but the `*`.
    const matcher = new RegExp(`^${plain(pattern.trim()).replaceAll("*", ".*")}$`);
    return names.some((name) => matcher.test(name));
  });
}

/** The patterns an `approve` option may hold: texts that name at least one character, trimmed, without doubles; or the reason it is not. */
export function approvePatterns(value: unknown, server = "<server>"): string[] | string {
  if (!Array.isArray(value)) return "approve takes a list of patterns of the server's own tool names, `*` for any characters (`delete_*`)";
  const patterns: string[] = [];
  for (const one of value) {
    if (typeof one !== "string" || !one.trim()) return "approve takes a list of patterns of the server's own tool names, `*` for any characters (`delete_*`): each one a text that is not blank";
    // A pattern is matched against the tool's own name only: pi's full name or the label form would never match, and the server would run ungated.
    if (one.trim().startsWith("mcp__") || one.includes("/")) {
      return `approve takes the server's own tool names (\`send_*\`, \`delete_mail\`), not pi's name (\`mcp__${server}__send_mail\`) or \`${server}/send_mail\`: "${one.trim()}" would never match, and the server's calls would run unconfirmed`;
    }
    patterns.push(one.trim());
  }
  return [...new Set(patterns)];
}
