/**
 * pi's code mode: one tool, `codemode`, that runs a JavaScript script calling
 * the other tools, and hands the model only what the script puts out.
 *
 * pi's CLI loads it as a built-in extension; an SDK session has to be given it.
 * Every session the portal starts in its own process is given it, active, and
 * the tool switches decide whether a chat has it — off unless a chat, its
 * project or agent, or Settings → Tools says otherwise (see seedCodemodeOff in
 * db.ts). So it is a switch in the chat's tools list like any other, stored
 * with the chat like any other.
 *
 * What a script calls goes through pi's tool pipeline one call at a time, with
 * the guard's hooks: see guard.ts for how a result read inside a script still
 * marks what the model is given.
 */

export const CODEMODE_TOOL = "codemode";

/** The name the portal's inline extension for it has, and so the source its tool is listed under. */
export const CODEMODE_SOURCE = "codemode";

/** What createAgentSession is told about tools, so that pi activates code mode next to its default tools rather than in place of them. */
export const CODEMODE_TOOLS = [`+${CODEMODE_TOOL}`];

/**
 * The extension, or undefined where this pi has none.
 *
 * Scripts get no `models`: with it they could run the session's image models
 * directly, past the tools that make pictures and the switches and settings
 * that hold those. A script reaches a model only through a tool. Replaceable,
 * as pi's own built-in one is: an installed extension with a `codemode` tool of
 * its own is loaded in its place rather than beside it with a conflict.
 *
 * `"only"` is for a chat whose mode works through the code tool (chat-modes.ts):
 * the direct tools' declarations are hidden from the model, and a script calls
 * them. Without it pi's setting decides, `on` by default, as for the switch.
 */
export function codemodeExtension(pi: any, mode?: "only"): { name: string; factory: (pi: any) => void; replaceable: true } | undefined {
  if (typeof pi?.createCodemodeExtension !== "function") return undefined;
  return { name: CODEMODE_SOURCE, factory: pi.createCodemodeExtension({ models: false, ...(mode ? { mode } : {}) }), replaceable: true };
}
