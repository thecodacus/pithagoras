/**
 * Things one part of the portal can ask another to do, by name: an extension
 * says what it can be asked ("my-files.reveal"), and anything in the page, of
 * another extension's or the portal's own, asks it. Neither imports the other.
 */
type Command = (...args: any[]) => unknown;

const commands = new Map<string, Command>();

/** Say what `name` does. Returns what takes it back. Throws if something already answers to the name. */
export function registerCommand(name: string, run: Command): () => void {
  if (typeof name !== "string" || !name || typeof run !== "function") throw new Error("A command needs a name and something to do");
  if (commands.has(name)) throw new Error(`There is already a command called "${name}"`);
  commands.set(name, run);
  return () => {
    if (commands.get(name) === run) commands.delete(name);
  };
}

export const hasCommand = (name: string): boolean => commands.has(name);

/** Ask for `name` to be done, with what it does returned. Throws if nothing answers to the name. */
export function runCommand(name: string, ...args: unknown[]): unknown {
  const run = commands.get(name);
  if (!run) throw new Error(`There is no command called "${name}"`);
  return run(...args);
}
