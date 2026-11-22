import { ASK_QUESTION_TOOL } from "./pi/ask-question.js";
import { lazyMarks, shownTools, toolGroupNames } from "./db.js";
import { defaultsFor, exceptionsFor, heldOffUnshown, onByDefault, toolEnabled } from "./tool-policy.js";

/**
 * What the routes of the tool layers under a chat share — a project's, an agent's, a routine's, a mode's: reading a
 * layer's list, storing what it says, and the answer they all give where tools cannot be switched.
 */

/** Whether a request's list of tools to switch off is one: a list of names. */
export const isToolList = (value: unknown): value is string[] => Array.isArray(value) && value.every((name) => typeof name === "string");

/**
 * A tool's lazy mark as a page shows it, where the chats it is shown for work through the code tool alone (`scripted`):
 * there no tool is lazy (see lazyMember in pi/sdk-client.ts), as nothing is offered one by one and a script reaches every
 * tool that is on.
 */
export const scriptedMark = <T extends object>(mark: T, scripted?: boolean): T | Record<string, never> => (scripted ? {} : mark);

/**
 * A layer's tools as its page shows them: what the portal has seen registered
 * where the layer's chats and runs work (`folder`; everywhere for a layer that
 * has no folder, a mode's), on or off by `below` — every layer under this one —
 * bent by what this one says. `defaultOn` is what the layers under it say, which
 * is what this one disagrees with. Shaped like a project's and a chat's, so the
 * page draws them all the same way. `scripted`: the layer's chats work through
 * the code tool alone (see scriptedMark).
 */
export function layerTools(folder: string | undefined, below: string[], exceptions: { off: string[]; on: string[] }, unwatched = false, scripted = false) {
  const lazy = lazyMarks();
  return {
    // A routine's runs have nobody to ask (see asksQuestions), so its page does not offer the tool.
    tools: shownTools(folder).filter((tool) => !(unwatched && tool.name === ASK_QUESTION_TOOL && tool.inline)).map((tool) => ({
      ...tool,
      enabled: toolEnabled(tool.name, below, exceptions),
      defaultOn: onByDefault(tool.name, below),
      ...scriptedMark(lazy(tool), scripted),
    })),
    live: false,
    names: toolGroupNames(),
    off: layerOff(folder, below, exceptions),
  };
}

/**
 * What a layer's page holds as off: the tools it lists, with each one that is off named, so that a leftover gateway entry
 * in the lists below (see MCP_GATEWAY) is not the only thing that says an MCP tool is off, and switching one on does not
 * switch the others on with it.
 */
export function layerOff(folder: string | undefined, below: string[], exceptions: { off: string[]; on: string[] }): string[] {
  return defaultsFor(below, exceptions, shownTools(folder).map((tool) => tool.name));
}

/** The exceptions to store for a layer, given what it wants off: as for a project. */
export function layerExceptions(folder: string | undefined, below: string[], held: { off: string[]; on: string[] }, off: string[]) {
  const shown = shownTools(folder).map((t) => t.name);
  const answered = [...shown, ...held.off, ...held.on];
  return exceptionsFor(heldOffUnshown(off, shown, held), below, answered, held);
}

/**
 * A container session reaches pi over RPC, which has no tool registry to ask
 * and nothing to tell. Said plainly rather than answered with an empty list
 * and a switch that does nothing.
 */
const TOOLS_UNSUPPORTED =
  "Tools cannot be switched with EXECUTOR=container: pi runs inside the container and the portal never sees what it registered";
/** With a `code`, so that the page tells this answer from any other failure of the same request by it, not by the sentence. */
export const toolsUnsupported = { error: TOOLS_UNSUPPORTED, code: "tools-unsupported" };
