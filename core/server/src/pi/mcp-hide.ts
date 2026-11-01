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
 * recognise it leaves as it is: an adapter that words things otherwise says more than it should, never less.
 * Only the tools the portal tells a server's by (mcpServerOf), as the guard judges a call.
 */
import type { McpView } from "../db.js";
import { mcpServerOf } from "../tool-policy.js";

type View = Pick<McpView, "catalogue" | "servers" | "direct">;

/** A tool's name as the guard compares it: the adapter takes hyphens for underscores, and a dot is written as one. */
const same = (name: string) => name.replace(/[-.]/g, "_");

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a name is a tool of a configured server that is switched off here. */
function offTest(off: ReadonlySet<string>, view: Pick<McpView, "servers">): (name: string) => boolean {
  const offSame = new Set([...off].map(same));
  return (name) => offSame.has(same(name)) && mcpServerOf(name, view.servers) !== undefined;
}

interface ServerTools {
  /** Its tools the adapter's cache lists and the configuration allows. */
  total: number;
  off: number;
  /** Of those, the ones the adapter registers one by one, and so counts apart from the ones behind `mcp`. */
  direct: number;
  offDirect: number;
}

function statsOf(off: ReadonlySet<string>, view: View): Map<string, ServerTools> {
  const isOff = offTest(off, view);
  const out = new Map<string, ServerTools>();
  for (const tool of view.catalogue) {
    const server = mcpServerOf(tool.name, view.servers);
    if (server === undefined) continue;
    const one = out.get(server) ?? { total: 0, off: 0, direct: 0, offDirect: 0 };
    const direct = view.direct(tool) === true;
    one.total++;
    if (direct) one.direct++;
    if (isOff(tool.name)) {
      one.off++;
      if (direct) one.offDirect++;
    }
    out.set(server, one);
  }
  return out;
}

/** A server none of whose known tools is on: there is nothing of it for the model to be told. */
const allOff = (one: ServerTools | undefined): boolean => one !== undefined && one.total > 0 && one.off >= one.total;

/**
 * The server a call of the `mcp` tool asks to list, search, connect or read the instructions of, if all of its tools
 * are switched off here. The mode is the adapter's: a call, then connect, describe, instructions, search, list.
 */
export function switchedOffServer(input: Record<string, unknown>, off: ReadonlySet<string>, view: View): string | undefined {
  if (!off.size || input.tool) return undefined;
  if (["ui-messages", "auth-start", "auth-complete"].includes(String(input.action))) return undefined;
  const asked = text(input.connect) ?? (text(input.describe) ? undefined : (text(input.instructions) ?? text(input.server)));
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

/** A server's list (also what a connection answers with) less the tools that are off. */
function listWithout(value: string, details: Record<string, any>, isOff: (name: string) => boolean): { text: string; details: Record<string, any> } | undefined {
  const tools: string[] = Array.isArray(details.tools) ? details.tools.filter((t: unknown): t is string => typeof t === "string") : [];
  const gone = tools.filter(isOff);
  if (!gone.length) return undefined;
  const left = tools.filter((name) => !isOff(name));
  const named = new Set(tools);
  const server = String(details.server ?? "");
  const shown = { ...details, tools: left, count: left.length };
  if (!left.length) return { text: `Server "${server}" is switched off in this conversation: none of its tools is available here.`, details: shown };
  const out: string[] = [];
  let skipping = false;
  for (const line of value.split("\n")) {
    const name = /^- (\S+)(?: - |$)/.exec(line)?.[1];
    if (name !== undefined && named.has(name)) {
      skipping = isOff(name);
      if (skipping) continue;
    } else if (skipping) {
      // The server's own instructions follow the tools, after a blank line the skipped tool's description may have had too.
      if (line !== "Server instructions:") continue;
      skipping = false;
      // As the adapter writes it: the tools end in a line break, and the instructions follow after a blank line.
      if (out.at(-1) !== "") out.push("", "");
    }
    out.push(line);
  }
  const body = out.join("\n").replace(/^(.*?) \(\d+ tools?/, `$1 (${left.length} tools`);
  return { text: body, details: shown };
}

/** A search's matches less the tools that are off, with their descriptions and parameters. */
function searchWithout(value: string, details: Record<string, any>, isOff: (name: string) => boolean): { text: string; details: Record<string, any> } | undefined {
  const matches: { tool: string }[] = Array.isArray(details.matches) ? details.matches.filter((m: any) => typeof m?.tool === "string") : [];
  const gone = matches.filter((m) => isOff(m.tool));
  if (!gone.length) return undefined;
  const named = new Set(matches.map((m) => m.tool));
  const total = Math.max(0, Number(details.count ?? matches.length) - gone.length);
  const shown = { ...details, matches: matches.filter((m) => !isOff(m.tool)), count: total };
  if (total === 0) return { text: `No tools matching "${String(details.query ?? "")}"`, details: shown };
  const out: string[] = [];
  let skipping = false;
  for (const line of value.split("\n")) {
    const name = /^- (\S+)(?: - | \(requires approval\)|$)/.exec(line)?.[1] ?? /^(\S+)(?: \(requires approval\))?$/.exec(line)?.[1];
    if (name !== undefined && named.has(name)) {
      skipping = isOff(name);
      if (skipping) continue;
    } else if (/^\d+ of \d+ — offset: /.test(line)) {
      skipping = false;
      if (out.at(-1) !== "") out.push("");
      out.push(line.replace(/^(\d+) of (\d+)/, (_, items: string, all: string) => `${Number(items) - gone.length} of ${Math.max(0, Number(all) - gone.length)}`));
      continue;
    } else if (skipping) {
      continue;
    }
    out.push(line);
  }
  const body = out.join("\n").replace(/^Found \d+ tools?/, `Found ${total} tool${plural(total)}`);
  return { text: body, details: shown };
}

/** The status less what is off: a server's tool count, and a server with all of its tools off reported as such. */
function statusWithout(value: string, details: Record<string, any>, off: ReadonlySet<string>, view: View): { text: string; details: Record<string, any> } | undefined {
  const servers: { name: string; status: string; toolCount: number; disabled?: boolean }[] = Array.isArray(details.servers) ? details.servers : [];
  const stats = statsOf(off, view);
  let removed = 0;
  let switchedOff = 0;
  let connected = 0;
  let body = value;
  const shown = servers.map((one) => {
    const tools = stats.get(one.name);
    if (one.disabled || !tools?.off || typeof one.toolCount !== "number") return one;
    const gone = Math.min(tools.off, one.toolCount);
    const whole = gone >= one.toolCount;
    removed += gone;
    if (whole) {
      switchedOff++;
      if (one.status === "connected") connected++;
    }
    const line = new RegExp(`^(\\S+) ${escaped(one.name)} \\((\\d+) tools?(, cached)?\\)$`, "m");
    body = body.replace(line, (_, mark: string, _n: string, cached?: string) =>
      whole ? `⊘ ${one.name} (switched off)` : `${mark} ${one.name} (${one.toolCount - gone} tools${cached ?? ""})`,
    );
    return { ...one, toolCount: one.toolCount - gone, ...(whole ? { switchedOff: true } : {}) };
  });
  if (!removed) return undefined;
  body = body.replace(/^MCP: (\d+)\/(\d+) servers, (\d+) tools(?: \((\d+) disabled\))?/, (_, up: string, all: string, tools: string, disabled?: string) => {
    const now = Number(disabled ?? 0) + switchedOff;
    return `MCP: ${Number(up) - connected}/${Number(all) - switchedOff} servers, ${Math.max(0, Number(tools) - removed)} tools${now ? ` (${now} disabled)` : ""}`;
  });
  return {
    text: body,
    details: {
      ...details,
      servers: shown,
      totalTools: Math.max(0, Number(details.totalTools ?? 0) - removed),
      connectedCount: Math.max(0, Number(details.connectedCount ?? 0) - connected),
      disabledCount: Number(details.disabledCount ?? 0) + switchedOff,
    },
  };
}

/**
 * The result of an `mcp` call less the tools that are switched off here, or undefined where nothing of it is: the
 * result as the tool_result hook is given it (`content`, `details`). What it makes of it is by the adapter's own
 * `details.mode`, so a result that is not one of a list, a search, a connection or a status is left alone, except
 * that the suggestions any of them may end with are cleared of a name that is off.
 */
export function withoutSwitchedOff(
  result: { content?: unknown; details?: unknown },
  off: ReadonlySet<string>,
  view: View,
): { content: unknown[]; details?: unknown } | undefined {
  if (!off.size || !Array.isArray(result.content)) return undefined;
  const isOff = offTest(off, view);
  const details: Record<string, any> = result.details && typeof result.details === "object" ? (result.details as Record<string, any>) : {};
  const parts = result.content as { type?: string; text?: string }[];
  let changedDetails: Record<string, any> = details;
  let changed = false;
  const content = parts.map((part) => {
    if (part?.type !== "text" || typeof part.text !== "string") return part;
    let now = part.text;
    const rewritten =
      details.mode === "list" ? listWithout(now, details, isOff)
      : details.mode === "search" ? searchWithout(now, details, isOff)
      : details.mode === "status" ? statusWithout(now, details, off, view)
      : undefined;
    if (rewritten) {
      now = rewritten.text;
      changedDetails = rewritten.details;
    }
    now = withoutSuggestions(now, isOff);
    if (now === part.text) return part;
    changed = true;
    return { ...part, text: now };
  });
  if (Array.isArray(details.suggestions) && details.suggestions.some((name: unknown) => typeof name === "string" && isOff(name))) {
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
  return out.join("\n");
}
