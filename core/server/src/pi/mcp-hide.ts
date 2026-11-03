/**
 * What the MCP adapter's own `mcp` tool tells the model of tools that are switched off in the conversation.
 *
 * A switch refuses the calls (switchedOffVia in guard.ts), but the adapter answers a list, a search, a connection
 * and a status from its cache, and writes the tool's description from it as well, and none of those know the
 * conversation's switches. A tool that is off is to be gone, not visible and refused: its name, its description and
 * its parameters are not for the model to learn. So what the adapter says is taken in here and less what is off:
 * the call of a server whose tools are all off is refused, a result is read again without the off tools, and the
 * description the model is declared the tool with is written again (see SdkPiClient.keepSwitchedOffFromMcpTool).
 *
 * The adapter's words are text, so this reads them as pi-mcp-adapter 2.18.0 writes them (proxy-modes.ts,
 * direct-tools.ts), with the structured `details` of a result to tell what is a tool's name. What it does not
 * recognise in a list or a search it answers with what the details say is on, and a status it writes again from
 * the details: a package's hook that runs before the guard's may have worded the text otherwise. A server's tools
 * are told by their names in the naming the adapter gives them (mcpServerAs), or by the adapter having registered
 * them, as the guard judges a call (switchedOffVia).
 */
import type { McpView } from "../db.js";
import { mcpServerAs, mcpServerOf } from "../tool-policy.js";

type View = Pick<McpView, "catalogue" | "servers" | "direct"> &
  Partial<Pick<McpView, "naming">> & {
    /** Whether the adapter registered a tool of this name in the session (fromAdapter in guard.ts): a server's, whatever it is named. */
    registered?: (name: string) => boolean;
  };

/** A tool's name as the guard compares it: the adapter takes hyphens for underscores, and a dot is written as one. */
const same = (name: string) => name.replace(/[-.]/g, "_");

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The configured server a tool's name is of, each server in the naming the adapter gives its tools (`toolPrefix`). */
const serverOf = (name: string, view: View) => mcpServerAs(name, view.servers, (server) => view.naming?.(server) ?? "server");

/** Whether a name is a server's tool that is switched off here: a configured server's in its naming, or one the adapter registered. */
function offTest(off: ReadonlySet<string>, view: View): (name: string) => boolean {
  const offSame = new Set([...off].map(same));
  return (name) => offSame.has(same(name)) && (serverOf(name, view) !== undefined || view.registered?.(name) === true);
}

interface ServerTools {
  /** Its tools the adapter's cache lists and the configuration allows. */
  total: number;
  off: number;
  /** Of those, the ones the adapter registers one by one, and so counts apart from the ones behind `mcp`. */
  direct: number;
  offDirect: number;
  /** Only some of its tools are known here, so that it cannot be told to have none on. */
  partial?: boolean;
}

function statsOf(off: ReadonlySet<string>, view: View): Map<string, ServerTools> {
  const isOff = offTest(off, view);
  const out = new Map<string, ServerTools>();
  const entry = (server: string) => {
    const one = out.get(server) ?? { total: 0, off: 0, direct: 0, offDirect: 0 };
    out.set(server, one);
    return one;
  };
  const listed = new Set<string>();
  for (const tool of view.catalogue) {
    const server = mcpServerOf(tool.name, view.servers);
    if (server === undefined) continue;
    listed.add(same(tool.name));
    const one = entry(server);
    const direct = view.direct(tool) === true;
    one.total++;
    if (direct) one.direct++;
    if (isOff(tool.name)) {
      one.off++;
      if (direct) one.offDirect++;
    }
  }
  // The catalogue has the servers in the default naming only. A tool the adapter registered of another is one of its
  // direct tools (what it reaches through `mcp` is not switched one by one), so those count as well; but what else
  // such a server has is not known, so it is never one with nothing on.
  for (const name of off) {
    if (listed.has(same(name)) || view.registered?.(name) !== true) continue;
    const server = serverOf(name, view);
    if (server === undefined) continue;
    const one = entry(server);
    one.total++;
    one.direct++;
    one.off++;
    one.offDirect++;
    one.partial = true;
  }
  return out;
}

/** A server none of whose known tools is on: there is nothing of it for the model to be told. */
const allOff = (one: ServerTools | undefined): boolean => one !== undefined && !one.partial && one.total > 0 && one.off >= one.total;

/**
 * The server a call of the `mcp` tool asks to list, search, connect, read the instructions of or call a tool of, if
 * all of its tools are switched off here. The mode is the adapter's: an action, a call, then connect, describe,
 * instructions, search, list. A call goes to the server it names, or else to the one its tool's name starts like,
 * which the adapter connects (and signs in to) to look for a name it does not know (executeCall); no call of a
 * server with nothing on can come to anything, so nothing that is on is lost by refusing it.
 */
export function switchedOffServer(input: Record<string, unknown>, off: ReadonlySet<string>, view: View): string | undefined {
  if (!off.size) return undefined;
  if (["ui-messages", "auth-start", "auth-complete"].includes(String(input.action))) return undefined;
  let asked: string | undefined;
  if (input.tool) {
    const tool = text(input.tool);
    asked = text(input.server) ?? (tool === undefined ? undefined : (serverOf(tool.replace(/-/g, "_"), view) ?? serverOf(same(tool), view)));
  } else {
    asked = text(input.connect) ?? (text(input.describe) ? undefined : (text(input.instructions) ?? text(input.server)));
  }
  if (asked === undefined || !view.servers.includes(asked)) return undefined;
  return allOff(statsOf(off, view).get(asked)) ? asked : undefined;
}

/**
 * Less the tools that are off from the lists a failed call ends with: what the server has ("Server "x" has: a, b"), what
 * is available on it, and the suggestions ("Did you mean: a, b").
 */
function withoutSuggestions(value: string, isOff: (name: string) => boolean): string {
  const kept = (list: string) => {
    const all = list.split(", ");
    return { all, kept: all.filter((name) => !isOff(name)) };
  };
  return value
    .replace(/ Server ("[^"]*") has: (.*?)(?= Did you mean: |$)/gm, (whole, server: string, list: string) => {
      const { all, kept: left } = kept(list);
      return left.length === all.length ? whole : left.length ? ` Server ${server} has: ${left.join(", ")}` : ' Use mcp({ search: "..." }) to search.';
    })
    .replace(/Available tools on ("[^"]*"): (.*?)(?= Did you mean: |$)/gm, (whole, server: string, list: string) => {
      const { all, kept: left } = kept(list);
      return left.length === all.length ? whole : left.length ? `Available tools on ${server}: ${left.join(", ")}` : `Server ${server} has no tools.`;
    })
    .replace(/ Did you mean: ([^\n]*)/g, (whole, list: string) => {
      const { all, kept: left } = kept(list);
      return left.length === all.length ? whole : left.length ? ` Did you mean: ${left.join(", ")}` : "";
    });
}

const plural = (n: number) => (n === 1 ? "" : "s");

/**
 * A list of tools as the adapter writes it, less the ones that are off. Each tool's part starts at its own line,
 * looked for in the order the details name the tools, so that a line of a tool's description that reads like a tool
 * of the list is not taken for one unless it is the next one's and `header` takes it; what follows the last of them
 * (`ends`: the server's instructions, a search's footer) is kept as it is, and no tool is looked for in it. Undefined
 * where not every tool's line was found: the text is not the adapter's, or not as it writes it.
 */
function regroup(
  value: string,
  names: string[],
  isOff: (name: string) => boolean,
  header: (lines: string[], at: number, name: string) => boolean,
  ends: (line: string) => boolean,
): string[] | undefined {
  const lines = value.split("\n");
  const before: string[] = [];
  const blocks: { name: string; lines: string[] }[] = [];
  let at = 0;
  for (; at < lines.length; at++) {
    const next = names[blocks.length];
    if (next !== undefined && header(lines, at, next)) {
      blocks.push({ name: next, lines: [lines[at]] });
      continue;
    }
    if (blocks.length === names.length && ends(lines[at])) break;
    (blocks.at(-1)?.lines ?? before).push(lines[at]);
  }
  if (blocks.length < names.length) return undefined;
  const blank = (part: string[]) => {
    let n = 0;
    while (n < part.length && part[part.length - 1 - n] === "") n++;
    return n;
  };
  // The blank lines a part ends with are what parts it from the next, and the last one's from what follows.
  const gap = blank(blocks.at(-1)?.lines ?? []);
  const kept = blocks.filter((block) => !isOff(block.name));
  const out = [...before];
  kept.forEach((block, i) => {
    const n = blank(block.lines);
    out.push(...block.lines.slice(0, block.lines.length - n), ...Array<string>(i === kept.length - 1 ? gap : n).fill(""));
  });
  out.push(...lines.slice(at));
  return out;
}

/** A server's list (also what a connection answers with) less the tools that are off. */
function listWithout(value: string, details: Record<string, any>, isOff: (name: string) => boolean): { text: string; details: Record<string, any> } | undefined {
  const tools: string[] = Array.isArray(details.tools) ? details.tools.filter((t: unknown): t is string => typeof t === "string") : [];
  const gone = tools.filter(isOff);
  if (!gone.length) return undefined;
  const left = tools.filter((name) => !isOff(name));
  const server = String(details.server ?? "");
  const shown = { ...details, tools: left, count: left.length };
  if (!left.length) return { text: `Server "${server}" is switched off in this conversation: none of its tools is available here.`, details: shown };
  const lines = regroup(
    value,
    tools,
    isOff,
    (all, at, name) => all[at] === `- ${name}` || all[at].startsWith(`- ${name} - `),
    (line) => line === "Server instructions:",
  );
  // Not as the adapter writes it: what the details say is on, and nothing of what the text said of it.
  if (!lines) return { text: `${server} (${left.length} tool${plural(left.length)}):\n\n${left.map((name) => `- ${name}`).join("\n")}`, details: shown };
  return { text: lines.join("\n").replace(/^(.*?) \(\d+ tools?/, `$1 (${left.length} tools`), details: shown };
}

/**
 * A search's matches less the tools that are off, with their descriptions and parameters. A search that has more
 * than one page counts the matches of every page, and those that are off on the others are not known here: such a
 * search, where anything is off, says how many it shows rather than how many there are (`paged`).
 */
function searchWithout(
  value: string,
  details: Record<string, any>,
  isOff: (name: string) => boolean,
  paged: boolean,
): { text: string; details: Record<string, any> } | undefined {
  const matches: { tool: string }[] = Array.isArray(details.matches) ? details.matches.filter((m: any) => typeof m?.tool === "string") : [];
  const gone = matches.filter((m) => isOff(m.tool));
  if (!gone.length && !paged) return undefined;
  const left = matches.filter((m) => !isOff(m.tool));
  const query = String(details.query ?? "");
  const total = Math.max(0, Number(details.count ?? matches.length) - gone.length);
  const shown: Record<string, any> = { ...details, matches: left, count: total };
  if (paged) delete shown.count;
  if (!left.length) {
    if (!paged) return { text: `No tools matching "${query}"`, details: shown };
    return {
      text: details.hasMore === true ? `No tools matching "${query}" on this page — offset: ${details.nextOffset} for more` : `No more tools matching "${query}"`,
      details: shown,
    };
  }
  const names = matches.map((m) => m.tool);
  const lines = regroup(
    value,
    names,
    isOff,
    (all, at, name) => {
      const line = all[at];
      // `- name - description`, without schemas; otherwise the name alone on a line after a blank one, its description indented below.
      if ([`- ${name}`, `- ${name} (requires approval)`].some((head) => line === head || line.startsWith(`${head} - `))) return true;
      return (line === name || line === `${name} (requires approval)`) && (at === 0 || all[at - 1] === "") && /^ {2}/.test(all[at + 1] ?? "");
    },
    (line) => /^\d+ of \d+ — offset: /.test(line),
  );
  const heading = paged ? "Tools matching " : `Found ${total} tool${plural(total)} matching `;
  if (!lines) return { text: `${heading}"${query}":\n\n${left.map((m) => `- ${m.tool}`).join("\n")}`, details: shown };
  const body = lines
    .join("\n")
    .replace(/^Found \d+ tools? matching /, heading)
    .replace(/^(\d+) of (\d+) — offset: /m, (_, items: string, all: string) =>
      paged ? `${left.length} shown — offset: ` : `${Number(items) - gone.length} of ${Math.max(0, Number(all) - gone.length)} — offset: `,
    );
  return { text: body, details: shown };
}

type StatusServer = { name: string; status: string; toolCount: number; failedAgo?: number | null; disabled?: boolean; switchedOff?: boolean };

/** One server's line of the status, as the adapter writes it (executeStatus). */
function statusLine(one: StatusServer): string {
  if (one.switchedOff) return `⊘ ${one.name} (switched off)`;
  if (one.disabled) return `⊘ ${one.name} (disabled)`;
  if (one.status === "connected") return `✓ ${one.name} (${one.toolCount} tools)`;
  if (one.status === "needs-auth") return `⚠ ${one.name} (needs auth)`;
  if (one.status === "cached") return `○ ${one.name} (${one.toolCount} tools, cached)`;
  if (one.status === "failed") return `✗ ${one.name} (failed ${one.failedAgo ?? 0}s ago)`;
  return `○ ${one.name} (not connected)`;
}

/**
 * The status less what is off: a server's tool count, and a server with all of its tools off reported as such,
 * whatever state it is in. Written again from the details, which hold all that the text says, so that it holds
 * however a hook before this one worded the text.
 */
function statusWithout(details: Record<string, any>, off: ReadonlySet<string>, view: View): { text: string; details: Record<string, any> } | undefined {
  const servers: StatusServer[] = Array.isArray(details.servers) ? details.servers.filter((one: any) => typeof one?.name === "string") : [];
  const stats = statsOf(off, view);
  const shown = servers.map((one): StatusServer => {
    const tools = stats.get(one.name);
    if (one.disabled || !tools?.off) return one;
    const count = typeof one.toolCount === "number" ? one.toolCount : 0;
    if (allOff(tools)) return { ...one, toolCount: 0, switchedOff: true };
    const gone = Math.min(tools.off, count);
    return gone ? { ...one, toolCount: count - gone } : one;
  });
  if (shown.every((one, i) => one === servers[i])) return undefined;
  const on = shown.filter((one) => !one.disabled && !one.switchedOff);
  const totalTools = on.reduce((n, one) => n + (Number(one.toolCount) || 0), 0);
  const connectedCount = on.filter((one) => one.status === "connected").length;
  const disabledCount = shown.length - on.length;
  let body = `MCP: ${connectedCount}/${on.length} servers, ${totalTools} tools${disabledCount ? ` (${disabledCount} disabled)` : ""}\n\n`;
  body += shown.map(statusLine).join("\n");
  if (shown.length) body += `\n\nmcp({ server: "name" }) to list tools, mcp({ search: "..." }) to search`;
  return { text: body.trim(), details: { ...details, servers: shown, totalTools, connectedCount, disabledCount } };
}

/**
 * The result of an `mcp` call less the tools that are switched off here, or undefined where nothing of it is: the
 * result as the tool_result hook is given it (`content`, `details`), and the call's input. What it makes of it is by
 * the adapter's own `details.mode`, so a result that is not one of a list, a search, a connection or a status is left
 * alone, except that the adapter's own failures (`details.error`: a tool not found) are cleared of the names that are
 * off they list. A server's own answer to a call is its words, and not rewritten.
 */
export function withoutSwitchedOff(
  result: { content?: unknown; details?: unknown },
  off: ReadonlySet<string>,
  view: View,
  input: Record<string, unknown> = {},
): { content: unknown[]; details?: unknown } | undefined {
  if (!off.size || !Array.isArray(result.content)) return undefined;
  const isOff = offTest(off, view);
  const details: Record<string, any> = result.details && typeof result.details === "object" ? (result.details as Record<string, any>) : {};
  const parts = result.content as { type?: string; text?: string }[];
  const failed = typeof details.error === "string";
  if (details.mode === "status" && !failed) {
    const status = statusWithout(details, off, view);
    if (!status) return undefined;
    const others = parts.filter((part) => part?.type !== "text");
    return { content: [{ type: "text", text: status.text }, ...others], ...(result.details === undefined ? {} : { details: status.details }) };
  }
  const paged = details.mode === "search" && (details.hasMore === true || Number(input.offset) > 0) && [...off].some(isOff);
  let changedDetails: Record<string, any> = details;
  let changed = false;
  const content = parts.map((part) => {
    if (part?.type !== "text" || typeof part.text !== "string") return part;
    let now = part.text;
    const rewritten =
      failed ? undefined
      : details.mode === "list" ? listWithout(now, details, isOff)
      : details.mode === "search" ? searchWithout(now, details, isOff, paged)
      : undefined;
    if (rewritten) {
      now = rewritten.text;
      changedDetails = rewritten.details;
    }
    if (failed) now = withoutSuggestions(now, isOff);
    if (now === part.text && !rewritten) return part;
    changed = true;
    return { ...part, text: now };
  });
  if (failed && Array.isArray(details.suggestions) && details.suggestions.some((name: unknown) => typeof name === "string" && isOff(name))) {
    changedDetails = { ...changedDetails, suggestions: details.suggestions.filter((name: unknown) => !(typeof name === "string" && isOff(name))) };
    changed = true;
  }
  return changed ? { content, ...(result.details === undefined ? {} : { details: changedDetails }) } : undefined;
}

/** `name (n)` entries of one of the description's lists. */
const entriesOf = (list: string): { name: string; n: number }[] =>
  [...list.matchAll(/(.+?) \((\d+)(?: tools)?\)(?:, |$)/g)].map((m) => ({ name: m[1], n: Number(m[2]) }));

/**
 * The description of the `mcp` tool less the tools that are off: the servers it names and how many tools they have
 * (the adapter counts what its cache lists and its configuration allows, off or on), the tools it says are direct,
 * and the instructions of a server none of whose tools is on. The description as it was where nothing is off.
 */
export function describedWithoutSwitchedOff(description: string, off: ReadonlySet<string>, view: View): string {
  if (!off.size) return description;
  const stats = statsOf(off, view);
  if (![...stats.values()].some((one) => one.off)) return description;
  const out: string[] = [];
  const lines = description.split("\n");
  // A list the adapter writes between blank lines, dropped with the blank line before it.
  const drop = () => {
    if (out.at(-1) === "") out.pop();
  };
  let instructions = false;
  for (const line of lines) {
    const direct = /^(Direct tools available \(call as normal tools\): )(.*)$/.exec(line);
    const proxied = /^(Servers: )(.*)$/.exec(line);
    if (direct || proxied) {
      const kept = entriesOf((direct ?? proxied)![2])
        .map(({ name, n }) => {
          const one = stats.get(name);
          return { name, n: Math.max(0, n - (direct ? (one?.offDirect ?? 0) : (one?.off ?? 0) - (one?.offDirect ?? 0))) };
        })
        .filter(({ n }) => n > 0);
      instructions = false;
      if (!kept.length) {
        drop();
        continue;
      }
      out.push((direct ?? proxied)![1] + kept.map(({ name, n }) => (direct ? `${name} (${n})` : `${name} (${n} tools)`)).join(", "));
      continue;
    }
    if (line.startsWith("Server instructions (truncated")) {
      instructions = true;
      out.push(line);
      continue;
    }
    if (instructions) {
      const server = /^ {2}(.+?): /.exec(line)?.[1];
      if (server !== undefined && allOff(stats.get(server))) continue;
      if (server === undefined) {
        // The first line past the list: if nothing is left of it, the heading goes with it.
        instructions = false;
        if (out.at(-1)?.startsWith("Server instructions (truncated")) {
          out.pop();
          drop();
        }
      }
    }
    out.push(line);
  }
  const shown = out.join("\n");
  // A description worded otherwise than the adapter's would keep what is off: then it has none of the servers' lists.
  const still = [...stats].some(
    ([server, one]) => allOff(one) && new RegExp(`(?:^|: |, )${escaped(server)} \\(\\d|^ {2}${escaped(server)}: `, "m").test(shown),
  );
  return still ? describedBare(description) : shown;
}

/**
 * The description of the `mcp` tool with nothing in it of any server: what it is, and how it is used. For a description
 * that could not be read without what is off; the status and the lists, which are, name the servers that are on.
 */
export function describedBare(description: string): string {
  const first = description.split("\n")[0] ?? "";
  const usage = description.indexOf("\nUsage:\n");
  return usage < 0 ? first : `${first}\n${description.slice(usage)}`;
}
