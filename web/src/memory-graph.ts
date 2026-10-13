/**
 * What the memory's graph is drawn with besides its layout (memory-sky.ts):
 * how many rounds a layout is run for, and the colour of each type of note.
 *
 * The layout is a force layout, quadratic in the number of notes, so the
 * rounds it gets fall as they grow (`roundsFor`): a memory of a few hundred
 * notes runs through all of them in a moment, and one of thousands is not left
 * to freeze the page for the sake of a layout nobody could read anyway.
 */

/** Pairs looked at in all, over every round: what the main thread can do in a fraction of a second. */
const PAIR_BUDGET = 25_000_000;

/**
 * How many rounds a layout of `n` notes is run for: all 300 up to a few hundred
 * notes, fewer after that so that the pairs looked at stay within the budget,
 * and never fewer than 20, which is enough to pull a start near rest together.
 */
export const roundsFor = (n: number): number => Math.max(20, Math.min(300, Math.floor(PAIR_BUDGET / Math.max(1, (n * (n - 1)) / 2))));

const COLOURS = ["#0ea5e9", "#8b5cf6", "#10b981", "#f59e0b", "#ec4899", "#f97316", "#6366f1", "#84cc16", "#d946ef", "#14b8a6"];
const NONE = "#94a3b8";

/**
 * A colour per type of note: in the order of the memory's types, so the first
 * ten never share one, and by the type's name past them.
 */
export function colours(types: Iterable<string | undefined>): (type: string | undefined) => string {
  const known = [...new Set([...types].filter((t): t is string => !!t))].sort();
  const at = new Map(known.map((t, i) => [t, i]));
  return (type) => {
    if (!type) return NONE;
    const i = at.get(type);
    if (i !== undefined && i < COLOURS.length) return COLOURS[i];
    let h = 0;
    for (const c of type) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return COLOURS[h % COLOURS.length];
  };
}
