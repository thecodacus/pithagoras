import type { PortalEvent, ToolCallView } from "@pithagoras/extension-api";
import { t } from "./portal";

/**
 * Which of the agent's calls drive a browser, and what voice mode's card of
 * one says: its own browser tools and a Playwright MCP's alike, called
 * directly, through the gateway to the tools kept out of the model's list, or
 * through the MCP adapter's `mcp` tool.
 */

/** The tool that reaches the tools kept out of the model's list, and calls them. */
const GATEWAY_TOOL = "tools";

const plain = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown) => (typeof v === "string" ? v : "");

/** What a gateway call calls: the tool, and what it gives it (an object, or the JSON text of one). Nothing for a search or a describe. */
function calledThrough(args: unknown): { name: string; input: Record<string, any> } | undefined {
  if (!plain(args) || args.action !== "call" || typeof args.name !== "string") return undefined;
  const name = args.name.trim();
  if (!name) return undefined;
  let given: unknown = args.args;
  if (typeof given === "string") {
    try {
      given = JSON.parse(given);
    } catch {
      given = undefined;
    }
  }
  return { name, input: plain(given) ? given : {} };
}

/**
 * The call as the agent made it, from a tool event's payload: pi has spelled
 * the name `toolName` and `name`, and the arguments `input`, `args` and
 * `parameters`. A call through the gateway is a call of the tool it calls.
 */
function called(payload: any): { name: string; input: Record<string, any> } {
  const name = String(payload?.toolName ?? payload?.name ?? "");
  const args = payload?.input ?? payload?.args ?? payload?.parameters;
  return (name === GATEWAY_TOOL ? calledThrough(args) : undefined) ?? { name, input: plain(args) ? args : {} };
}

/** A browser tool, by its name: `browser_navigate`, `browser.click`, `playwright_browser_type`. */
const BROWSER_TOOL = /(?:^|[_.])browser[_.](.*)$/i;
/** What of an `mcp` call names the server or the tool it is for. */
const WRAPPED = ["server", "connect", "tool", "describe"];

/** Whether a call drives a browser: a browser tool, or an `mcp` call whose server or tool is one. */
export function isBrowserCall(name: string, input: Record<string, unknown>): boolean {
  return BROWSER_TOOL.test(name) || (name === "mcp" && WRAPPED.some((key) => /browser/i.test(text(input[key]))));
}

/** The latest call that drove a browser in a chat, by its place among the chat's events: it grows with each new one. */
export function latestBrowserCall(events: readonly PortalEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type !== "tool_execution_start") continue;
    const { name, input } = called(event.payload);
    if (isBrowserCall(name, input)) return event.seq;
  }
  return 0;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

/** What the card of a browser call says in voice mode: by what it does, the part of its name after `browser_`, or the tool an `mcp` call names. */
export function describeBrowserCall(call: ToolCallView): { label: string; detail: string } {
  const { input } = call;
  const action = BROWSER_TOOL.exec(call.name)?.[1] ?? text(input.tool);
  const url = text(input.url);
  if (/navigate|open|goto/.test(action)) return { label: t("Opening a page"), detail: url ? hostOf(url) : "" };
  if (/screenshot/.test(action)) return { label: t("Taking a screenshot"), detail: "" };
  if (/scroll|wheel/.test(action)) return { label: t("Scrolling the page"), detail: "" };
  if (/find/.test(action)) return { label: t("Searching the page"), detail: text(input.query) };
  if (/get_text/.test(action)) return { label: t("Reading the page"), detail: "" };
  if (/click|hover|drag/.test(action)) return { label: t("Clicking in the browser"), detail: text(input.element) };
  if (/type|fill|press|select|key/.test(action)) return { label: t("Typing in the browser"), detail: text(input.element) };
  if (/snapshot|evaluate|console|network/.test(action)) return { label: t("Reading the page"), detail: "" };
  if (/tab|close|back|forward|resize|wait/.test(action)) return { label: t("Using the browser"), detail: "" };
  return { label: t("Using the browser"), detail: url ? hostOf(url) : "" };
}
