/**
 * What a tool event of pi's carries, read one way. The name has been spelled
 * `toolName` and `name`, and the arguments `input`, `args` and `parameters`:
 * each reader asking for them in its own words is how a rename reaches all
 * but one.
 */

/** The tool's name; `fallback` for an event that carries none. */
export const toolNameOf = (payload: any, fallback = ""): string => String(payload?.toolName ?? payload?.name ?? fallback);

/** What the tool was called with, as the agent wrote it. */
export const toolArgsOf = (payload: any): any => payload?.input ?? payload?.args ?? payload?.parameters;
