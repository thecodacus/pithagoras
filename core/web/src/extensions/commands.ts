/**
 * Things one part of the portal can ask another to do, by name: an extension
 * says what it can be asked ("my-files.reveal"), and anything in the page, of
 * another extension's or the portal's own, asks it. Neither imports the other.
 */
import { useSyncExternalStore } from "react";

type Command = (...args: any[]) => unknown;

const commands = new Map<string, Command>();
const watchers = new Set<() => void>();
const changed = () => {
  for (const watcher of [...watchers]) watcher();
};

/** Say what `name` does. Returns what takes it back. Throws if something already answers to the name. */
export function registerCommand(name: string, run: Command): () => void {
  if (typeof name !== "string" || !name || typeof run !== "function") throw new Error("A command needs a name and something to do");
  if (commands.has(name)) throw new Error(`There is already a command called "${name}"`);
  commands.set(name, run);
  changed();
  return () => {
    if (commands.get(name) !== run) return;
    commands.delete(name);
    changed();
  };
}

export const hasCommand = (name: string): boolean => commands.has(name);

/** Whether something answers to `name`, drawn again when that changes: for what the portal offers only while it does. */
export function useHasCommand(name: string): boolean {
  return useSyncExternalStore(
    (watcher) => {
      watchers.add(watcher);
      return () => void watchers.delete(watcher);
    },
    () => commands.has(name),
  );
}

/** Ask for `name` to be done, with what it does returned. Throws if nothing answers to the name. */
export function runCommand(name: string, ...args: unknown[]): unknown {
  const run = commands.get(name);
  if (!run) throw new Error(`There is no command called "${name}"`);
  return run(...args);
}
