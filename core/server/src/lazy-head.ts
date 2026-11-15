import { knownTools, lazySetLabels, mcpView, resolvedLazy, sizedTools, toolGroupNames, toolMarks } from "./db.js";
import { headLazy, ruleTag, type LazyHead } from "./tool-lazy.js";
import { TOOL_SEARCH } from "./pi/tool-search-names.js";

/** How many groups the hint names, and how many of a group's tools: it is in the system prompt of every request of the chat. */
const HINT_GROUPS = 8;
const HINT_TOOLS = 3;

/**
 * The one line that tells the model which lazy tools exist, by the names of their sets and a few of their tools each:
 * the tools are not in its list, and a model that does not know of them says it cannot do what they do. Said to
 * the chat once, with the rest of what it starts with, and the same words for as long as it lasts.
 */
export function lazyHintOf(groups: readonly { label: string; tools: readonly string[] }[]): string {
  if (!groups.length) return "";
  const shown = groups.slice(0, HINT_GROUPS).map((group) => {
    // A server nothing is known of yet has no tools to name: its name is what there is.
    if (!group.tools.length) return group.label;
    const names = group.tools.slice(0, HINT_TOOLS).join(", ");
    const more = group.tools.length > HINT_TOOLS ? ` and ${group.tools.length - HINT_TOOLS} more` : "";
    return `${group.label} (${names}${more})`;
  });
  const rest = groups.length > HINT_GROUPS ? ` and ${groups.length - HINT_GROUPS} more groups` : "";
  return `These tools are not in your list: ${shown.join("; ")}${rest}. Search them with the ${TOOL_SEARCH} tool before you say you cannot do something.`;
}

/**
 * What a chat is told about its lazy tools when it starts, from the marks, the threshold's resolution and what the
 * chat's mode and agent keep in the list (`pinned`: sets, and single tools as `<tool>name`). The chat keeps it (LazyHead).
 * `off` are the tools it starts with switched off: where every lazy tool is, there is nothing to reach and nothing is lazy.
 */
export function buildLazyHead(pinned: readonly string[] = [], off: ReadonlySet<string> = new Set()): LazyHead {
  const marks = toolMarks();
  const tools = sizedTools();
  const kept = new Set(pinned);
  const direct = new Set([...Object.entries(marks).filter(([, mark]) => mark === "direct").map(([entry]) => entry), ...kept]);
  // An MCP server nothing is known of (it has never connected: no tool of it is remembered) counts as lazy, with an unknown
  // size: connecting it for every chat to find out is what lazy is there to avoid. A search starts it and finds its tools.
  const view = mcpView();
  const seen = new Set(knownTools().flatMap((tool) => (tool.server ? [tool.server] : [])));
  const unseen = view.servers.filter((server) => !view.off.has(server) && !seen.has(server) && !view.catalogue.some((tool) => tool.server === server) && !direct.has(server));
  const lazy = new Set([...Object.entries(marks).filter(([, mark]) => mark === "lazy").map(([entry]) => entry), ...resolvedLazy().lazy, ...unseen].filter((entry) => !kept.has(entry)));
  const head = { lazy: [...lazy].sort(), direct: [...direct].sort() };
  // The tools that are lazy in it and may be: judged as the marks do (lazyAllowed), so that a mark on a set whose tools cannot be lazy names none.
  const inHead = tools.filter((tool) => tool.allowed && headLazy(head, tool));
  const names = inHead.filter((tool) => !off.has(tool.name)).map((tool) => tool.name);
  const unseenLazy = unseen.filter((server) => head.lazy.includes(server));
  if (!names.length && !unseenLazy.length) return { v: 1, lazy: [], direct: head.direct, hint: "", outside: false, voice: [], tag: ruleTag() };
  // What the lazy tools say of themselves that stays in the head (decision 13): the line that outside content is data, and
  // their lines for a spoken turn. From what they said when a chat last registered them, so that it is said from the first
  // request and a lazy tool that registers late adds nothing to the prompt. One no chat has registered yet adds its own
  // when it does (see keepHead in pi/sdk-client.ts): the one change of the head left, and only for a tool new to the portal.
  const said = new Map(knownTools().map((tool) => [tool.name, tool]));
  // Every tool that is lazy in the head, switched off now or not: one that is off at the start and switched on later says
  // its line then, and the head must not change under the chat for a tool the model is not even shown.
  const lazyTools = inHead.map((tool) => said.get(tool.name));
  const voice = [...new Set(lazyTools.flatMap((tool) => tool?.voice ?? []))];
  const given = toolGroupNames();
  const groups = [...lazySetLabels(names), ...unseenLazy.map((server) => ({ label: given[server] ?? server, tools: [] as string[] }))].sort((a, b) => a.label.localeCompare(b.label));
  return { v: 1, ...head, hint: lazyHintOf(groups), outside: lazyTools.some((tool) => tool?.outside === true), voice, tag: ruleTag() };
}
