/**
 * How pi's events are read for a terminal, the same way the portal's own
 * conversation reads them: which calls are commands, what they were given,
 * and their output as plain text.
 */

/** The tools that run a command in a shell. */
export const SHELL_TOOL = /^(bash|shell|terminal|exec_command)$/i;

/** The tool that reaches the tools kept out of the model's list, and calls them. */
const GATEWAY_TOOL = "tools";

const plain = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

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
 * The call as the agent made it, from a tool event's payload. pi has spelled the
 * name `toolName` and `name`, and the arguments `input`, `args` and `parameters`.
 * A call through the gateway is a call of the tool it calls, and one through the
 * MCP adapter's `mcp` tool a call of the tool inside.
 */
export function unwrap(payload: any): { name: string; input: Record<string, any> } {
  const name = String(payload?.toolName ?? payload?.name ?? "tool");
  const args = payload?.input ?? payload?.args ?? payload?.parameters;
  const lazy = name === GATEWAY_TOOL ? calledThrough(args) : undefined;
  if (lazy) return lazy;
  const input = plain(args) ? args : {};
  if (name === "mcp" && typeof input.tool === "string" && input.tool) return { name: input.tool, input: plain(input.args) ? input.args : {} };
  return { name, input };
}

/** Text without the colour and cursor codes a terminal would act on. */
export const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

/** A tool result's text: the result itself when it is text, its text parts joined otherwise. */
export function toolOutputText(result: any): string | undefined {
  if (typeof result === "string") return result;
  const content = result?.content;
  if (!Array.isArray(content)) return undefined;
  return content.filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text).join("\n");
}

/** Seconds as "42s" or "3m 07s". */
export const formatElapsed = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`);

/**
 * Keystrokes for a shell, sent in the order they were typed.
 *
 * Each key as a request of its own can overtake another on the way: typed
 * quickly, `echo hello` reached the shell as `ecohh lelo`. Here one request is
 * out at a time; what is typed meanwhile is joined and goes next, so a burst
 * costs a request or two instead of one per key.
 *
 * `failed` hears of each request that did not arrive; later keys are still tried.
 */
export function orderedInput(send: (data: string) => Promise<unknown>, failed: () => void): (data: string) => void {
  let out = false;
  let queued = "";
  const drain = async () => {
    out = true;
    while (queued) {
      const data = queued;
      queued = "";
      try {
        await send(data);
      } catch {
        failed();
      }
    }
    out = false;
  };
  return (data) => {
    queued += data;
    if (!out) void drain();
  };
}
