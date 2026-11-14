/**
 * Which tools are lazy: not in the list the model is offered, found and called through `tool_search` instead.
 *
 * Kept apart from the database and from pi, as tool-policy.ts is, so that the rule can be read in one place and tested
 * without either. A tool is in a set (the box the tools lists show it in); a set, or a single tool, has a mark:
 *
 * - `lazy`: always behind `tool_search`.
 * - `direct`: always in the model's list.
 * - none, which is `auto`: the threshold decides.
 *
 * The threshold is a budget for the model's list: how many tokens its declarations cost, and how many tools there are.
 * Groups are taken out of the list, the largest first, until both are within the limits. The result is stored and
 * kept: a group that went lazy stays lazy until the list would fit within 80 % of the limits without it, so that it does
 * not flip when another group grows or shrinks a little.
 */

/** What a mark says. Without one, the threshold decides. */
export type Mark = "lazy" | "direct";

/** The marks, by what they are on: a set's name, or a single tool as `<tool>name` (lazyToolEntry in tool-policy.ts). */
export type Marks = Record<string, Mark>;

/** How many tokens of declarations and how many tools the model's list may hold before groups go lazy; 0 turns that part off. */
export interface Limits {
  tokens: number;
  tools: number;
}

/** About 20 functions is the usual advice for how many a model picks from reliably, and 3,000 tokens is where a list starts to cost. */
export const DEFAULT_LIMITS: Limits = { tokens: 3000, tools: 20 };

/** A group that went lazy is kept lazy until the list would fit within this share of the limits without it. */
const RELEASE_AT = 0.8;

/** A tool as the threshold sees it. */
export interface SizedTool {
  name: string;
  /** The set it is in. */
  set: string;
  /** What its declaration costs the model's list, in tokens. */
  tokens: number;
  /** Whether a mark may make it lazy (lazyAllowed in db.ts): pi's own tools, an MCP server's and code mode cannot. */
  allowed: boolean;
  /** Whether the threshold may: the portal's own small tools that the agent needs at once are never taken out by size. */
  auto: boolean;
  /** Whether it is in the model's list with the default switches: a tool that is off by default costs the list nothing. */
  counted: boolean;
}

/** `<tool>name`: how a single tool is told from a set in the marks. Brackets, as no package, file or MCP server is called. */
export const toolEntry = (name: string): string => `<tool>${name}`;

/** What the threshold decided, and whether it could not make the list fit. */
export interface Resolution {
  /** The sets it made lazy. */
  lazy: string[];
  /** The list is over a limit even with every group it may take out taken out: nothing is made lazy by size then, and the page says so. */
  over: boolean;
}

/** The mark that applies to a tool: its own, else its set's. */
export const markOf = (tool: Pick<SizedTool, "name" | "set">, marks: Marks): Mark | undefined => marks[toolEntry(tool.name)] ?? marks[tool.set];

/** Whether a tool is lazy, given the marks and the sets the threshold made lazy. */
export function isLazy(tool: SizedTool, marks: Marks, resolved: readonly string[]): boolean {
  if (!tool.allowed) return false;
  const mark = markOf(tool, marks);
  if (mark) return mark === "lazy";
  return tool.auto && resolved.includes(tool.set);
}

/**
 * The sets that go lazy by size. The tools that are in the model's list count; those made lazy by a mark do not, and
 * those marked direct are never taken out. `before` is what was resolved last time.
 */
export function resolveThreshold(tools: readonly SizedTool[], marks: Marks, limits: Limits, before: readonly string[] = []): Resolution {
  const listed = tools.filter((tool) => tool.counted && !(tool.allowed && markOf(tool, marks) === "lazy"));
  let tokens = listed.reduce((sum, tool) => sum + tool.tokens, 0);
  let count = listed.length;

  // The sets the threshold may take out, whole, with what they cost: those whose tools it may take out and that no mark is on.
  const sets = new Map<string, { tokens: number; count: number; blocked: boolean }>();
  for (const tool of tools) {
    if (!tool.allowed) continue;
    const one = sets.get(tool.set) ?? { tokens: 0, count: 0, blocked: false };
    // A tool of the set that a mark settles, or that the threshold may not touch, is no part of what a set's size is.
    if (!tool.auto) one.blocked = true;
    else if (!markOf(tool, marks) && tool.counted) {
      one.tokens += tool.tokens;
      one.count += 1;
    }
    sets.set(tool.set, one);
  }
  const candidates = [...sets.entries()]
    .filter(([name, one]) => !one.blocked && !marks[name] && one.count > 0)
    .map(([name, one]) => ({ name, ...one }));

  const within = (t: number, n: number, share: number) =>
    (!limits.tokens || t <= limits.tokens * share) && (!limits.tools || n <= limits.tools * share);

  const lazy = new Map<string, { name: string; tokens: number; count: number }>();
  for (const name of before) {
    const one = candidates.find((c) => c.name === name);
    if (one) {
      lazy.set(name, one);
      tokens -= one.tokens;
      count -= one.count;
    }
  }
  // A group that went lazy comes back only when the list fits well within the limits with it: the smallest first.
  for (const one of [...lazy.values()].sort((a, b) => a.tokens - b.tokens || a.name.localeCompare(b.name))) {
    if (within(tokens + one.tokens, count + one.count, RELEASE_AT)) {
      lazy.delete(one.name);
      tokens += one.tokens;
      count += one.count;
    }
  }
  // Then the largest group that is left, until both numbers are within the limits.
  while (!within(tokens, count, 1)) {
    const next = candidates
      .filter((c) => !lazy.has(c.name))
      .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name))[0];
    if (!next) break;
    lazy.set(next.name, next);
    tokens -= next.tokens;
    count -= next.count;
  }
  // With every group it may take out taken out, the list is still over: that is not for the threshold to fix, and a model that
  // has to search for tools it could have had in its list is no gain. Nothing is made lazy by size, and the page says so.
  if (!within(tokens, count, 1)) return { lazy: [], over: true };
  return { lazy: [...lazy.keys()].sort(), over: false };
}

/** The tokens a tool's declaration costs, where it was not measured: its text and an average schema, at four characters to a token. */
export const guessTokens = (name: string, description?: string): number => Math.ceil((name.length + (description?.length ?? 0) + 160) / 4);

/** Reads a stored list of marks: the entries that are an entry and say lazy or direct. */
export function parseMarks(raw: unknown): Marks {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const marks: Marks = {};
  for (const [key, mark] of Object.entries(value as Record<string, unknown>)) {
    if (key.trim() && (mark === "lazy" || mark === "direct")) marks[key] = mark;
  }
  return marks;
}

/** What a chat's pi is told about its lazy tools, and keeps for as long as the chat lasts: see session-manager's `lazyHeadFor`. */
export interface LazyHead {
  /** Which version of this shape a stored one is. */
  v: 1;
  /** The sets (and single tools, as `<tool>name`) that are lazy in this chat. Which tools those are is read from what is registered. */
  lazy: string[];
  /** The sets and single tools that are in the model's list in this chat whatever else says: the chat's marks of that, and what its mode and agent keep there. */
  direct: string[];
  /** The one line that tells the model which groups there are behind `tool_search`. */
  hint: string;
  /** Whether a lazy tool declares outside content, when the head was made: the line that outside content is data is said for it. */
  outside: boolean;
  /** What the lazy tools ask to be told in a spoken turn. */
  voice: string[];
}

/** A stored head, or nothing where there is none or it is not one this version wrote. */
export function parseHead(raw: unknown): LazyHead | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    const head = JSON.parse(raw);
    const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
    if (head?.v !== 1 || !strings(head.lazy) || !strings(head.direct) || typeof head.hint !== "string" || typeof head.outside !== "boolean" || !strings(head.voice)) return undefined;
    return { v: 1, lazy: head.lazy, direct: head.direct, hint: head.hint, outside: head.outside, voice: head.voice };
  } catch {
    return undefined;
  }
}

/** A head of a chat with nothing lazy. */
export const NO_LAZY: LazyHead = { v: 1, lazy: [], direct: [], hint: "", outside: false, voice: [] };

/**
 * Whether a tool is lazy in a chat with this head: its own entry decides first, then its set's. A tool a head does not
 * name is in the model's list, whatever the marks say now: the marks reach the chats that start afterwards.
 */
export function headLazy(head: Pick<LazyHead, "lazy" | "direct">, tool: Pick<SizedTool, "name" | "set">): boolean {
  const own = toolEntry(tool.name);
  if (head.direct.includes(own)) return false;
  if (head.lazy.includes(own)) return true;
  if (head.direct.includes(tool.set)) return false;
  return head.lazy.includes(tool.set);
}
