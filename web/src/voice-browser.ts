import type { PortalEvent } from './api';
import { SHELL_TOOL, lazyCall } from './tool-activity';
import { toolArgsOf, toolNameOf } from './tool-payload';
/** A call as it is made of a tool: one through the `tools` tool, to a lazy tool, is a call of that tool. */
function calledTool(payload: any): { name: string; input: any } {
  const name = toolNameOf(payload), input = toolArgsOf(payload) ?? {};
  return lazyCall(name, input) ?? { name, input };
}

/** Match direct browser tools, a lazy browser tool called through `tools`, and the MCP adapter's wrapped browser calls. */
export function latestBrowserActivity(events: PortalEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type !== 'tool_execution_start') continue;
    const { name, input } = calledTool(event.payload);
    if (/(^|[_.])browser[_.]/i.test(name) || name === 'mcp' && ['server', 'connect', 'tool', 'describe'].some(k => typeof input[k] === 'string' && /browser/i.test(input[k]))) return event.seq;
  }
  return 0;
}

export function latestTerminalActivity(events: PortalEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'tool_execution_start' && SHELL_TOOL.test(calledTool(event.payload).name)) return event.seq;
  }
  return 0;
}
