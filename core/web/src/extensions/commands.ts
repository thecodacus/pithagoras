/**
 * Things one part of the portal can ask another to do, by name: an extension
 * says what it can be asked ("my-files.reveal"), and anything in the page, of
 * another extension's or the portal's own, asks it. Neither imports the other.
 */
import { useSyncExternalStore } from "react";
import { byRank, onRanked } from "./rank";

type Command = (...args: any[]) => unknown;

/** Who answers to a name: the portal's own first, then the extensions in the order of the list of extensions. */
type Answer = { owner: string | undefined; run: Command };
const commands = new Map<string, Answer[]>();
const watchers = new Set<() => void>();
const changed = () => {
  for (const watcher of [...watchers]) watcher();
};
const inOrder = (list: Answer[]) => list.map((answer, at) => ({ answer, at })).sort((a, b) => byRank(a.answer.owner, b.answer.owner) || a.at - b.at).map(({ answer }) => answer);
const answering = (name: string): Command | undefined => commands.get(name)?.[0]?.run;

// Which one answers is the one first in the list, not the one whose module came first.
onRanked(() => {
  for (const [name, list] of [...commands]) commands.set(name, inOrder(list));
  changed();
});

/**
 * Say what `name` does, for `owner` (an extension; none for the portal). Returns what takes it back. Throws if
 * `owner` has said it already. Another's that says it too is not refused, for which of two extensions loads
 * first is not for anyone to rely on: the first of them in the list of extensions answers, and the other
 * does when that one is taken out.
 */
export function registerCommand(name: string, run: Command, owner?: string): () => void {
  if (typeof name !== "string" || !name || typeof run !== "function") throw new Error("A command needs a name and something to do");
  const list = commands.get(name) ?? [];
  if (list.some((answer) => answer.owner === owner)) throw new Error(`There is already a command called "${name}"`);
  const answer = { owner, run };
  commands.set(name, inOrder([...list, answer]));
  changed();
  return () => {
    const now = commands.get(name);
    if (!now?.includes(answer)) return;
    const rest = now.filter((a) => a !== answer);
    if (rest.length) commands.set(name, rest);
    else commands.delete(name);
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
  const run = answering(name);
  if (!run) throw new Error(`There is no command called "${name}"`);
  return run(...args);
}
