import type { PortalTool } from "./api";
import { formatNumber, msg, t, tp } from "./i18n";

/**
 * Tools as somebody thinks about them: by what they came from.
 *
 * pi has a flat registry, and a person does not — "turn off the web search
 * one" means four tools that arrived together. Grouping by source is what
 * makes a switch per extension possible without this knowing what any
 * extension is.
 */
export interface ToolGroup {
  source: string;
  tools: PortalTool[];
  /** Every tool in it is on. */
  allOn: boolean;
  /** None of them are. */
  allOff: boolean;
}

/** What the portal registers itself, which is not an extension anyone installed. */
const BUILT_IN = msg("built in");

/**
 * The group of pi's code mode, which the portal gives every chat it starts and leaves off unless switched on.
 * Brackets, as no package, file or MCP server is called: a group an extension's tool of the same name could be
 * filed in by accident.
 */
const CODEMODE = "<portal:codemode>";

/** Why a chat's switch of the code tool cannot turn it off (PortalTool.byMode), and what the server's refusal is said as. */
export const CODEMODE_HELD = msg("This chat's mode works through the code tool, so it stays on: start a chat in Standard mode to work without it.");

/** The portal's code mode, not an extension's tool of that name. */
const isCodemode = (tool: Pick<PortalTool, "name" | "inline">): boolean => Boolean(tool.inline) && tool.name === "codemode";

/** What to file a tool under: what registered it. Code mode is a group of its own, called what it is rather than what registered it. */
export const sourceOf = (tool: Pick<PortalTool, "name" | "source" | "inline">): string =>
  isCodemode(tool) ? CODEMODE : tool.source?.trim() || BUILT_IN;

/** Where a group goes in the list: what is installed first, what the portal brings after it, what is built in last. */
const shippedRank = (source: string): number => (source === BUILT_IN ? 2 : source === CODEMODE ? 1 : 0);

export function groupTools(tools: PortalTool[]): ToolGroup[] {
  const groups = new Map<string, PortalTool[]>();
  for (const tool of tools) {
    const source = sourceOf(tool);
    const list = groups.get(source);
    if (list) list.push(tool);
    else groups.set(source, [tool]);
  }
  return [...groups.entries()]
    .map(([source, list]) => ({
      source,
      tools: [...list].sort((a, b) => a.name.localeCompare(b.name)),
      allOn: list.every((t) => t.enabled),
      allOff: list.every((t) => !t.enabled),
    }))
    // What the portal ships is last: somebody opening this came for the thing
    // they installed, not for the tools that were always there.
    .sort((a, b) => shippedRank(a.source) - shippedRank(b.source) || a.source.localeCompare(b.source));
}

/**
 * The list of names to store after a switch is flipped.
 *
 * Off is what gets written down, so this returns the exceptions: everything
 * currently off, with `names` added or removed. A tool the session has never
 * heard of stays in the list — it may belong to an extension that is merely
 * not loaded right now, and dropping it would silently turn it back on.
 */
export function nextOff(off: string[], names: string[], enabled: boolean): string[] {
  const next = new Set(off);
  for (const name of names) {
    if (enabled) next.delete(name);
    else next.add(name);
  }
  return [...next].sort();
}

/**
 * What a group says about itself while it is shut.
 *
 * A closed group has to answer the only question worth asking from the
 * outside — is anything in here switched off — or closing them would hide the
 * thing the list exists to show.
 */
export function groupSummary(group: ToolGroup): string {
  const total = group.tools.length;
  if (group.allOff) return tp(total, "{n} off", "{n} off");
  const off = group.tools.filter((tool) => !tool.enabled).length;
  return off ? tp(total, "{off} of {n} off", "{off} of {n} off", { off: formatNumber(off) }) : tp(total, "{n} on", "{n} on");
}

/** Opening one group, or shutting it. */
export function toggleOpen(open: string[], source: string): string[] {
  return open.includes(source) ? open.filter((s) => s !== source) : [...open, source];
}

/** Where a group of tools comes from, as it is: a package's spec, or what the portal brings itself, in words. */
export const sourceName = (source: string): string =>
  source === BUILT_IN ? t(BUILT_IN) : source === CODEMODE ? t("Code mode") : source;

/**
 * What a tool's row says about it when pointed at. Code mode's own description is the model's: how to write a
 * script, at length. A person deciding whether to switch it on is told what it does instead.
 */
export const toolTitle = (tool: PortalTool): string | undefined =>
  isCodemode(tool)
    ? t("Lets the model write a script that calls the other tools, and gives it only what the script returns.")
    : tool.description;

/**
 * What a group is called on the page.
 *
 * A given name wins. Failing that the npm scope is dropped, because
 * `@juicesharp/rpiv-ask-user-question` is an address and a heading has to fit
 * in a column: the part after the slash is the part anybody says out loud. The
 * address is still there, under the package in the extensions list and in the
 * heading's tooltip.
 */
export function displayName(source: string, names: Record<string, string> = {}): string {
  const given = names[source]?.trim();
  if (given) return given;
  if (source === BUILT_IN || source === CODEMODE) return sourceName(source);
  return source.replace(/^@[^/]+\//, "") || source;
}
