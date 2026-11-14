import { lazySetLabels, resolvedLazy, sizedTools, toolMarks } from "./db.js";
import { headLazy, type LazyHead } from "./tool-lazy.js";
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
  const lazy = new Set([...Object.entries(marks).filter(([, mark]) => mark === "lazy").map(([entry]) => entry), ...resolvedLazy().lazy].filter((entry) => !kept.has(entry)));
  const head = { lazy: [...lazy].sort(), direct: [...direct].sort() };
  // The tools that are lazy in it and may be: judged as the marks do (lazyAllowed), so that a mark on a set whose tools cannot be lazy names none.
  const names = tools.filter((tool) => tool.allowed && headLazy(head, tool) && !off.has(tool.name)).map((tool) => tool.name);
  if (!names.length) return { v: 1, lazy: [], direct: head.direct, hint: "", outside: false, voice: [] };
  return { v: 1, ...head, hint: lazyHintOf(lazySetLabels(names)), outside: false, voice: [] };
}
