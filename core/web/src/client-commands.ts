import type { PiCommand } from "./api";

/**
 * The commands the portal runs itself, by opening a piece of UI — the ones the
 * server lists with `where: "client"` (see pi/builtins.ts), which is what is
 * asked once the list has been fetched. Known here as well, for before then:
 * listing commands starts pi for the chat, which /new has no need of. A test
 * keeps the two in step.
 */
export const CLIENT_COMMANDS: ReadonlySet<string> = new Set(["model", "settings", "new", "clear", "name"]);

/** Whether `/name` is opened here rather than sent: as the server says, once it has. */
export function isClientCommand(name: string, listed: readonly PiCommand[]): boolean {
  const known = listed.find((c) => c.name === name && c.source === "builtin");
  return known ? known.where === "client" : CLIENT_COMMANDS.has(name);
}

/**
 * Whether `/name` is a command at all, rather than a message that starts with a
 * slash — as the server decides it, against the same list. Pictures sent with
 * one would go nowhere: no chat line shows them, and the server lets them go.
 */
export function isCommand(name: string, listed: readonly PiCommand[]): boolean {
  return CLIENT_COMMANDS.has(name) || listed.some((c) => c.name === name);
}
