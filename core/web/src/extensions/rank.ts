/**
 * Where each installed extension stands among the others, by the order the server lists them in.
 *
 * The modules are loaded at the same time, so the order they come into the page in is the order of
 * their network, and differs from one load to the next. Whatever has to choose between two
 * extensions (whose entry is drawn first, whose key a shortcut has, whose command answers to a name)
 * chooses by this, which does not.
 */

let ranks = new Map<string, number>();
const listeners = new Set<() => void>();

/** The portal's own, which no extension is, come before any extension; an extension not listed (yet) comes after the listed. */
const rankOf = (extension: string | undefined): number => (extension === undefined ? -1 : ranks.get(extension) ?? Infinity);

/** For `sort`: `extension` before `other` by the list, equal when neither is listed. */
export const byRank = (extension: string | undefined, other: string | undefined): number => {
  const a = rankOf(extension), b = rankOf(other);
  return a < b ? -1 : a > b ? 1 : 0;
};

/** Ask to be told when the list changes, to put what is held in order again. */
export const onRanked = (listener: () => void): void => void listeners.add(listener);

/** Say which extensions there are, first to last. */
export function rankExtensions(names: readonly string[]): void {
  ranks = new Map(names.map((name, at) => [name, at]));
  for (const listener of [...listeners]) listener();
}
