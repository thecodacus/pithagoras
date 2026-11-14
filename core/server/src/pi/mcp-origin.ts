/**
 * Where a tool of pi's native MCP support comes from, told by what pi records of it and never by the look of its name.
 *
 * pi registers a server's tools as `mcp__<server>__<tool>` with a namespace, `mcp__<server>` (the server's name with its
 * hyphens as underscores), on the tool's definition. That namespace is what attributes the tool: a name only looks like
 * one, and any extension can register a tool called `mcp_page` or `mcp__x__y`. The three resource tools are shared by every
 * server and name theirs in an argument.
 *
 * Pure, in a module of its own: the guard and the tests read it, and none of them may wait on the database.
 */

/** pi's tools for the resources of the servers, which reach every server that has some: the server is an argument. */
export const MCP_RESOURCE_TOOLS: readonly string[] = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];

/** Whether this is the name of one of pi's resource tools. */
export const isResourceTool = (name: string): boolean => MCP_RESOURCE_TOOLS.includes(name);

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
 * and an underscore, which pi refuses to connect together, and none where the server is not in the portal's file (one a
 * project's own configuration brought, or an extension registered): then it is nobody's the person has said is theirs.
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
