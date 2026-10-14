/**
 * What a tool was called with, in a line: the command, the file, the search
 * — or else its short parameters labelled, "Queries: …, …", rather than the
 * JSON the model wrote. For a channel, and for the chat's header too, which
 * imports it (web/src/tool-args.ts): nothing here but plain JavaScript, so
 * the page's bundle can take it as it is.
 */

import { GATEWAY_TOOL, calledThrough } from "./pi/tools-gateway-names.js";

/** Parameters that are what a call acted on: said bare, without a label. */
const PRIMARY = ["command", "file_path", "path", "pattern", "query", "url"] as const;

const isScalar = (v: unknown) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/** "queries" → "Queries", "file_path" → "File path", "numResults" → "Num results". */
export function argLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : key;
}

const flat = (s: string) => s.replace(/\s+/g, " ").trim();

function inline(v: unknown): string | undefined {
  if (typeof v === "string") return flat(v) || undefined;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    if (!v.length) return undefined;
    if (v.every(isScalar)) return v.map((x) => flat(String(x))).filter(Boolean).join(", ") || undefined;
    return `${v.length} ${v.length === 1 ? "item" : "items"}`;
  }
  return undefined;
}

/** A call's arguments in one line, cut to `max` characters. */
export function argsSummary(input: unknown, max = 160): string | undefined {
  if (input === undefined || input === null) return undefined;
  const cut = (s: string) => (s.length > max ? s.slice(0, max - 1) + "…" : s);
  if (typeof input !== "object") return cut(flat(String(input))) || undefined;
  if (Array.isArray(input)) {
    const said = inline(input);
    return said && cut(said);
  }
  const args = input as Record<string, unknown>;
  for (const key of PRIMARY) {
    const v = args[key];
    if (typeof v === "string" && flat(v)) return cut(flat(v));
  }
  const parts = Object.entries(args).flatMap(([key, v]) => {
    const said = inline(v);
    return said === undefined ? [] : [`${argLabel(key)}: ${said}`];
  });
  return parts.length ? cut(parts.join(" · ")) : undefined;
}

/**
 * A tool call as a channel says it: its name and what it was given. Through
 * the MCP adapter, or the `tools` tool that reaches the lazy ones, the tool
 * inside and what that was given.
 */
export function describeToolCall(payload: any): { name: string; detail?: string } {
  const name = String(payload?.toolName ?? payload?.name ?? "tool");
  const input = payload?.input ?? payload?.args ?? payload?.parameters;
  if (name === "mcp" && input && typeof input === "object" && typeof input.tool === "string" && input.tool) {
    return { name: input.tool, detail: argsSummary(input.args && typeof input.args === "object" ? input.args : undefined, 80) };
  }
  const lazy = name === GATEWAY_TOOL ? calledThrough(input) : undefined;
  if (lazy) return { name: lazy.name, detail: argsSummary(lazy.args, 80) };
  return { name, detail: argsSummary(input, 80) };
}
