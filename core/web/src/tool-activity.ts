import { insideFolder } from "./file-activity";
import { t, tp } from "./i18n";
import { toolArgsOf, toolNameOf } from "./tool-payload";
import { GATEWAY_TOOL, calledThrough } from "../../server/src/pi/tools-gateway-names";

/**
 * What a tool call is, in words, for the cards that fly out of the orb in voice mode.
 *
 * "Using grep" says nothing to somebody who is not reading code; "Searching for
 * ‘retry’ — 12 matches" does. So a call is described from its arguments when it
 * starts, and given its outcome when it ends: how many lines an edit changed,
 * how many files a search found, the first line of what went wrong. And each
 * card knows where the thing it is about can be seen, so that tapping it
 * opens that: the picture, or a window an extension brought for it (a
 * command, in the terminal's).
 *
 * Tolerant like the transcript: pi's payloads vary by tool and version, and
 * anything unrecognised is described by its name rather than not at all.
 */

export type ToolTarget = "pictures";

export interface ToolCall {
  label: string;
  detail: string;
  /** Where tapping the card goes. */
  target?: ToolTarget;
}

const text = (v: unknown) => (typeof v === "string" ? v : "");
const flat = (s: string, n = 90) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
};
const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
const hostOf = (url: string) => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

/**
 * A tool that runs a shell command, whichever extension it comes from: these
 * show their command and output as a terminal would.
 */
export const SHELL_TOOL = /^(bash|shell|terminal|exec_command)$/i;

/**
 * A call through the `tools` tool, which reaches the tools kept out of the model's list, as a call of
 * the tool it calls: its name and its own arguments. Nothing for a search or a describe, or for any
 * other tool.
 */
export function lazyCall(name: string, args: unknown): { name: string; input: Record<string, any> } | undefined {
  const called = name === GATEWAY_TOOL ? calledThrough(args) : undefined;
  return called && { name: called.name, input: called.args };
}

/**
 * The call as the agent made it. The MCP adapter puts every server's tools
 * behind one `mcp` tool, so a web search and a database query would both read
 * "mcp": the tool it was asked to call, and what it was asked to call it with,
 * are what say what happened. A lazy tool is called through `tools` in the
 * same way, and is the tool it calls (see lazyCall).
 */
export function unwrapCall(name: string, args: unknown): { name: string; input: Record<string, any> } {
  const lazy = lazyCall(name, args);
  if (lazy) return lazy;
  const input = args && typeof args === "object" ? (args as Record<string, any>) : {};
  if (name === "mcp" && typeof input.tool === "string" && input.tool) {
    return { name: input.tool, input: input.args && typeof input.args === "object" ? input.args : {} };
  }
  return { name, input };
}

/** A payload's call, unwrapped: see unwrapCall. */
export const unwrap = (p: any) => unwrapCall(toolNameOf(p, "tool"), toolArgsOf(p));

/** The name to show for a call. */
export const toolName = (name: string, args: unknown): string => unwrapCall(name, args).name;

/**
 * A call as it starts. `folder` is the chat's: a file in it is named by its
 * path there. A file's card has no target of the portal's: the window it opens
 * is an extension's that says it is for files (Files').
 */
export function describeCall(payload: any, folder: string): ToolCall {
  const { name, input } = unwrap(payload);
  const path = text(input.path ?? input.file_path);
  const inside = path ? insideFolder(folder, path) : undefined;
  const file = (label: (file: string) => string): ToolCall => ({
    label: label(path ? base(path) : t("a file")),
    detail: inside && inside !== base(path) ? inside : "",
  });

  if (SHELL_TOOL.test(name)) {
    // No target of the portal's: the window it opens is an extension's that says it is for commands.
    return { label: t("Running a command"), detail: flat(text(input.description) || text(input.command) || text(input.cmd)) };
  }
  if (name === "read") {
    const call = file((f) => t("Reading {file}", { file: f }));
    const from = Number(input.offset), count = Number(input.limit);
    if (Number.isInteger(from) && from > 0) call.detail = [call.detail, count > 0 ? t("lines {from}–{to}", { from, to: from + count - 1 }) : t("from line {from}", { from })].filter(Boolean).join(" · ");
    return call;
  }
  if (name === "write") return file((f) => t("Writing {file}", { file: f }));
  if (name === "edit") return file((f) => t("Editing {file}", { file: f }));
  if (name === "grep") return { label: t("Searching for “{pattern}”", { pattern: flat(text(input.pattern), 40) }), detail: flat([text(input.path), text(input.glob)].filter(Boolean).join(" · ")) };
  if (name === "find") return { label: t("Looking for “{pattern}”", { pattern: flat(text(input.pattern), 40) }), detail: flat(text(input.path)) };
  if (name === "ls") return { label: t("Listing {folder}", { folder: path ? base(path) : t("the folder") }), detail: "" };
  if (name === "ask_question") return { label: t("Asking you a question"), detail: flat(text(input.title) || text((input.questions as { question?: unknown }[] | undefined)?.[0]?.question)) };
  if (/web_?search|search_web/.test(name)) return { label: t("Searching the web"), detail: flat(text(input.query)) };
  if (/fetch|scrape|read_url|web_read/.test(name) && text(input.url)) return { label: t("Opening a page"), detail: hostOf(text(input.url)) };
  if (/search/.test(name)) return { label: t("Searching"), detail: flat(text(input.query) || text(input.pattern)) };
  const detail = [input.description, input.query, input.url, input.path, input.command].find((v) => typeof v === "string") as string | undefined;
  return { label: t("Using {tool}", { tool: name.replace(/[_.]+/g, " ") }), detail: flat(detail ?? "") };
}

/** What a tool said back, as text. */
function resultText(payload: any): string {
  const content = payload?.result?.content;
  if (Array.isArray(content)) return content.filter((c: any) => c?.type === "text").map((c: any) => text(c.text)).join("\n");
  return text(payload?.result) || text(payload?.error);
}

const lines = (s: string) => s.split("\n").filter((l) => l.trim() && !/^\[.*\]$/.test(l.trim()));

/**
 * What came of a call, in a few words, or nothing when there is nothing worth
 * adding to the tick. `start` is the call's own start payload, for what the
 * end does not repeat (a write's content).
 */
export function describeOutcome(start: any, end: any): string {
  const { name, input } = unwrap(start ?? end);
  const said = resultText(end);
  if (end?.isError) return flat(said.split("\n").find((l) => l.trim()) ?? "", 110);
  if (name === "edit") {
    const diff = text(end?.result?.details?.diff);
    if (!diff) return "";
    const added = diff.split("\n").filter((l) => /^\+\s*\d/.test(l)).length;
    const removed = diff.split("\n").filter((l) => /^-\s*\d/.test(l)).length;
    return `+${added} −${removed}`;
  }
  if (name === "write") {
    const content = text(input.content);
    return content ? tp(content.split("\n").length - (content.endsWith("\n") ? 1 : 0), "{n} line", "{n} lines") : "";
  }
  if (name === "grep") {
    if (/^no matches/i.test(said.trim())) return t("No matches");
    const n = lines(said).length;
    return n ? `${tp(n, "{n} match", "{n} matches")}${end?.result?.details?.matchLimitReached ? "+" : ""}` : "";
  }
  if (name === "find") {
    if (/^no files/i.test(said.trim())) return t("Nothing found");
    const n = lines(said).length;
    return n ? `${tp(n, "{n} file", "{n} files")}${end?.result?.details?.resultLimitReached ? "+" : ""}` : "";
  }
  if (name === "ls") {
    const n = lines(said).length;
    return n ? tp(n, "{n} entry", "{n} entries") : "";
  }
  return "";
}

/** "12 s", "2 min 5 s": how long something has been going. */
export function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
}
