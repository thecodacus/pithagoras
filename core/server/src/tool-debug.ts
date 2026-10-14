import { debugLog, debugOn } from "./logs.js";
import { GATEWAY_TOOL, calledThrough } from "./pi/tools-gateway-names.js";

/**
 * The debug lines for tool calls: which tool, how it ended, and how long it took.
 *
 * Only the name and the outcome are written. What the call was given and what it
 * returned can hold anything (a command, a file, a password the agent was shown),
 * so neither is ever part of a line; the chat's own event log has them for
 * whoever may read them.
 */

/** Calls still running, by chat and then by call id: the tool and when it began, for the line its end prints. */
const running = new Map<string, Map<string, { tool: string; at: number; subagent?: string; via?: string }>>();

const nameOf = (tool: unknown) => (typeof tool === "string" && tool ? tool : "unknown");

/**
 * A call began. `subagent` names the subagent it runs in, when it is not the chat's own. A call through the
 * gateway to the lazy tools (`args` are the call's) is filed under the tool it calls, with `via=tools`: all pi
 * says of it is `tools`, which would make every lazy tool's line the same.
 */
export function toolCallStarted(sessionId: string, call: string, tool: unknown, subagent?: string, args?: unknown): void {
  if (!debugOn()) return;
  const through = tool === GATEWAY_TOOL ? calledThrough(args)?.name : undefined;
  const name = nameOf(through ?? tool);
  const via = through ? GATEWAY_TOOL : undefined;
  let calls = running.get(sessionId);
  if (!calls) running.set(sessionId, (calls = new Map()));
  calls.set(call, { tool: name, at: Date.now(), subagent, via });
  debugLog("tool", "start", { tool: name, via, session: sessionId, subagent });
}

/** A call ended, with an error or without. */
export function toolCallEnded(sessionId: string, call: string, tool: unknown, failed: boolean, subagent?: string): void {
  if (!debugOn()) return;
  const calls = running.get(sessionId);
  const began = calls?.get(call);
  calls?.delete(call);
  if (calls && !calls.size) running.delete(sessionId);
  debugLog("tool", "end", {
    tool: began?.tool ?? nameOf(tool),
    via: began?.via,
    outcome: failed ? "error" : "ok",
    // Without a start there is no duration: a call that began before this process did, or before debug was on.
    ms: began ? Date.now() - began.at : undefined,
    session: sessionId,
    subagent,
  });
}

/**
 * Calls that will not end because what ran them is gone: a subagent that stopped (`only` is its call-id prefix), or
 * the chat's pi (without one). The line says so, with how long they had run.
 */
export function toolCallsCutOff(sessionId: string, only?: string): void {
  const calls = running.get(sessionId);
  if (!calls) return;
  for (const [call, began] of [...calls]) {
    if (only !== undefined && !call.startsWith(only)) continue;
    calls.delete(call);
    debugLog("tool", "end", { tool: began.tool, via: began.via, outcome: "cut-off", ms: Date.now() - began.at, session: sessionId, subagent: began.subagent });
  }
  if (!calls.size) running.delete(sessionId);
}
