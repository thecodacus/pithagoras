/**
 * Where the notes of the agent's memory go in its graph: a small force
 * layout, run to rest before anything is drawn.
 *
 * Notes push each other apart, a link pulls its two ends together, and
 * everything is drawn towards the middle so unlinked notes do not drift off.
 * Started on a circle rather than at random, so the same memory is laid out
 * the same way each time. Quadratic in the number of notes, so the rounds it
 * gets fall as they grow (`roundsFor`): a memory of a few hundred notes runs
 * through all of them in a moment, and one of thousands is not left to freeze
 * the page for the sake of a layout nobody could read anyway.
 */
export interface Placed {
  path: string;
  x: number;
  y: number;
}

const REPEL = 6000;
const GRAVITY = 0.012;
/** Pairs looked at in all, over every round: what the main thread can do in a fraction of a second. */
const PAIR_BUDGET = 25_000_000;

/**
 * How many rounds a layout of `n` notes is run for: all 300 up to a few hundred
 * notes, fewer after that so that the pairs looked at stay within the budget,
 * and never fewer than 20, which is enough to pull a start near rest together.
 */
export const roundsFor = (n: number): number => Math.max(20, Math.min(300, Math.floor(PAIR_BUDGET / Math.max(1, (n * (n - 1)) / 2))));

export function layout(paths: string[], edges: { source: string; target: string }[], rounds = roundsFor(paths.length)): Placed[] {
  const n = paths.length;
  const at = new Map(paths.map((p, i) => [p, i]));
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  // Where the pull to the middle and the push apart balance, for a start close to rest when there are too few rounds to walk in from far away; a few hundred notes keep the start they always had.
  const radius = n <= 400 ? 40 + 12 * n : 40 + 1.5 * Math.cbrt((n * REPEL) / GRAVITY);
  for (let i = 0; i < n; i++) {
    x[i] = radius * Math.cos((2 * Math.PI * i) / Math.max(1, n));
    y[i] = radius * Math.sin((2 * Math.PI * i) / Math.max(1, n));
  }
  const links = edges
    .map((e) => [at.get(e.source), at.get(e.target)] as const)
    .filter((l): l is readonly [number, number] => l[0] !== undefined && l[1] !== undefined && l[0] !== l[1]);

  const LENGTH = 90;
  const SPRING = 0.06;
  for (let round = 0; round < rounds; round++) {
    // Cooling: big moves first, then settling.
    const heat = 1 - round / rounds;
    const dx = new Float64Array(n);
    const dy = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ex = x[i] - x[j];
        let ey = y[i] - y[j];
        let d2 = ex * ex + ey * ey;
        // Two in the same place are nudged apart, the same way each time.
        if (d2 < 0.01) {
          ex = ((i - j) % 7) + 0.5;
          ey = ((j * 3 - i) % 5) + 0.5;
          d2 = ex * ex + ey * ey;
        }
        const d = Math.sqrt(d2);
        const f = REPEL / d2;
        dx[i] += (ex / d) * f;
        dy[i] += (ey / d) * f;
        dx[j] -= (ex / d) * f;
        dy[j] -= (ey / d) * f;
      }
    }
    for (const [a, b] of links) {
      const ex = x[b] - x[a];
      const ey = y[b] - y[a];
      const d = Math.sqrt(ex * ex + ey * ey) || 1;
      const f = (d - LENGTH) * SPRING;
      dx[a] += (ex / d) * f;
      dy[a] += (ey / d) * f;
      dx[b] -= (ex / d) * f;
      dy[b] -= (ey / d) * f;
    }
    for (let i = 0; i < n; i++) {
      dx[i] -= x[i] * GRAVITY;
      dy[i] -= y[i] * GRAVITY;
      // No step longer than the heat allows: the layout settles instead of shaking.
      const step = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]);
      const most = 30 * heat + 0.5;
      const scale = step > most ? most / step : 1;
      x[i] += dx[i] * scale;
      y[i] += dy[i] * scale;
    }
  }
  return paths.map((path, i) => ({ path, x: x[i], y: y[i] }));
}

/** The layouts last asked for: opening the graph again for the same memory is not laid out again. */
const kept: { key: string; placed: Placed[] }[] = [];

/** `layout`, remembered by the notes and links it was run for. */
export function layoutKept(paths: string[], edges: { source: string; target: string }[]): Placed[] {
  const key = `${paths.join("\n")}\u0000${edges.map((e) => `${e.source}\u0001${e.target}`).join("\n")}`;
  const at = kept.findIndex((k) => k.key === key);
  if (at >= 0) return kept[at].placed;
  const placed = layout(paths, edges);
  kept.unshift({ key, placed });
  kept.length = Math.min(kept.length, 2);
  return placed;
}

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

/** How the graph is drawn: flat (straight on) or in space. */
export type GraphMode = "2d" | "3d";
export const graphModeFrom = (stored: string | null): GraphMode => (stored === "3d" ? "3d" : "2d");
