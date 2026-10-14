import type { PortalEvent } from "@pithagoras/extension-api";
import { SHELL_TOOL, toolOutputText, unwrap } from "./text";

/** What the agent ran in a chat, read from the chat's events. */

export type Run = { id: string; command: string; output: string; running: boolean; error: boolean; interrupted?: boolean };

/**
 * The commands in `events`, oldest first, the last `limit` of them. `ended`:
 * the chat stopped (an error, or by hand), so a command with no end will get
 * none.
 *
 * One pass, whatever the length: this runs again with every token streamed.
 */
export function terminalRuns(events: readonly PortalEvent[], limit = 6, maxOutput = 20000, ended = false) {
  const runs: (Run & { result?: unknown })[] = [];
  const byId = new Map<string, Run & { result?: unknown }>();
  const open = new Set<Run>();
  // What the chat does with a call whose end never came: it was cut off.
  const settle = () => {
    for (const run of open) {
      run.running = false;
      run.interrupted = true;
    }
    open.clear();
  };
  for (const event of events) {
    const p = event.payload ?? {};
    switch (event.type) {
      case "tool_execution_start": {
        const { name, input } = unwrap(p);
        if (!SHELL_TOOL.test(name)) break;
        const run = { id: p.toolCallId ?? String(event.seq), command: input.command ?? input.cmd ?? name, output: "", running: true, error: false };
        runs.push(run);
        byId.set(run.id, run);
        open.add(run);
        break;
      }
      case "tool_execution_update":
      case "tool_execution_end": {
        let run = p.toolCallId ? byId.get(p.toolCallId) : undefined;
        if (!p.toolCallId && SHELL_TOOL.test(unwrap(p).name)) run = [...open].at(-1);
        if (!run) break;
        // Only the newest output is shown: read once, at the end.
        const result = p.partialResult ?? p.result;
        if (result !== undefined) run.result = result;
        if (event.type === "tool_execution_end") {
          run.running = false;
          run.error = !!p.isError;
          delete run.interrupted;
          open.delete(run);
        }
        break;
      }
      case "portal_status":
        if (typeof p.status === "string" && p.status !== "running") settle();
        break;
      case "agent_end":
      case "agent_start":
        settle();
        break;
    }
  }
  if (ended) settle();
  return runs.slice(-limit).map(({ result, ...run }) => {
    const text = result === undefined ? undefined : toolOutputText(result);
    return typeof text === "string" ? { ...run, output: text.slice(-maxOutput) } : run;
  });
}

/** The latest command the agent started in a chat, by its place among the chat's events: it grows with each new one. */
export function latestCommand(events: readonly PortalEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === "tool_execution_start" && SHELL_TOOL.test(unwrap(event.payload).name)) return event.seq;
  }
  return 0;
}
