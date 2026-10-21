/**
 * The memory's graph in 3D: where its notes go in space, how a camera that
 * turns around them sees them, and which note is under the pointer. Kept apart
 * from the drawing (MemorySky.tsx) so the geometry can be tested
 * without a browser.
 *
 * The layout is a force layout in three directions: notes push each other
 * apart, a link pulls its two ends together, and everything is drawn towards
 * the middle. It is started on a sphere, so the same memory lands the same way
 * each time, and run for as many rounds as the number of notes affords
 * (`roundsFor`, memory-graph.ts). Then it is centred and scaled to a radius of
 * about one, which is what the camera and the themes are made for.
 */
import { roundsFor } from "./memory-graph";

export interface Point3 {
  path: string;
  x: number;
  y: number;
  z: number;
}

const REPEL = 6000;
const GRAVITY = 0.012;
const LENGTH = 90;
const SPRING = 0.06;

export function layout3d(paths: string[], edges: { source: string; target: string }[], rounds = roundsFor(paths.length)): Point3[] {
  const n = paths.length;
  const at = new Map(paths.map((p, i) => [p, i]));
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  // On a sphere, evenly (a Fibonacci spiral), where the pull in and the push apart about balance.
  const radius = 40 + Math.cbrt((n * REPEL) / GRAVITY);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const h = n === 1 ? 0 : 1 - (2 * i) / (n - 1);
    const ring = Math.sqrt(Math.max(0, 1 - h * h));
    x[i] = radius * ring * Math.cos(golden * i);
    y[i] = radius * h;
    z[i] = radius * ring * Math.sin(golden * i);
  }
  const links = edges
    .map((e) => [at.get(e.source), at.get(e.target)] as const)
    .filter((l): l is readonly [number, number] => l[0] !== undefined && l[1] !== undefined && l[0] !== l[1]);
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  const dz = new Float64Array(n);
  for (let round = 0; round < rounds; round++) {
    const heat = 1 - round / rounds;
    dx.fill(0);
    dy.fill(0);
    dz.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ex = x[i] - x[j];
        let ey = y[i] - y[j];
        let ez = z[i] - z[j];
        let d2 = ex * ex + ey * ey + ez * ez;
        if (d2 < 0.01) {
          ex = ((i - j) % 7) + 0.5;
          ey = ((j * 3 - i) % 5) + 0.5;
          ez = ((i + j) % 3) + 0.5;
          d2 = ex * ex + ey * ey + ez * ez;
        }
        const d = Math.sqrt(d2);
        const f = REPEL / d2 / d;
        dx[i] += ex * f;
        dy[i] += ey * f;
        dz[i] += ez * f;
        dx[j] -= ex * f;
        dy[j] -= ey * f;
        dz[j] -= ez * f;
      }
    }
    for (const [a, b] of links) {
      const ex = x[b] - x[a];
      const ey = y[b] - y[a];
      const ez = z[b] - z[a];
      const d = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1;
      const f = ((d - LENGTH) * SPRING) / d;
      dx[a] += ex * f;
      dy[a] += ey * f;
      dz[a] += ez * f;
      dx[b] -= ex * f;
      dy[b] -= ey * f;
      dz[b] -= ez * f;
    }
    for (let i = 0; i < n; i++) {
      dx[i] -= x[i] * GRAVITY;
      dy[i] -= y[i] * GRAVITY;
      dz[i] -= z[i] * GRAVITY;
      const step = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i] + dz[i] * dz[i]);
      const most = 30 * heat + 0.5;
      const scale = step > most ? most / step : 1;
      x[i] += dx[i] * scale;
      y[i] += dy[i] * scale;
      z[i] += dz[i] * scale;
    }
  }
  return normalised(paths.map((path, i) => ({ path, x: x[i], y: y[i], z: z[i] })));
}

/** Centred on the middle, and scaled so that nearly all of it is within one of it: a few far-flung notes do not shrink the rest. */
function normalised(points: Point3[]): Point3[] {
  if (!points.length) return [];
  const n = points.length;
  const cx = points.reduce((s, p) => s + p.x, 0) / n;
  const cy = points.reduce((s, p) => s + p.y, 0) / n;
  const cz = points.reduce((s, p) => s + p.z, 0) / n;
  const far = points.map((p) => Math.hypot(p.x - cx, p.y - cy, p.z - cz)).sort((a, b) => a - b);
  const reach = far[Math.min(n - 1, Math.floor(n * 0.95))] || 1;
  return points.map((p) => ({ path: p.path, x: (p.x - cx) / reach, y: (p.y - cy) / reach, z: (p.z - cz) / reach }));
}

const kept: { key: string; placed: Point3[] }[] = [];

/** `layout3d`, remembered by the notes and links it was run for: opening the graph again for the same memory is not laid out again. */
export function layout3dKept(paths: string[], edges: { source: string; target: string }[]): Point3[] {
  const key = `${paths.join("\n")}\u0000${edges.map((e) => `${e.source}\u0001${e.target}`).join("\n")}`;
  const at = kept.findIndex((k) => k.key === key);
  if (at >= 0) return kept[at].placed;
  const placed = layout3d(paths, edges);
  kept.unshift({ key, placed });
  kept.length = Math.min(kept.length, 2);
  return placed;
}

/** Where the camera looks from: turned by `yaw` and `pitch` around the point it looks at, `zoom` times as close. */
export interface Camera {
  yaw: number;
  pitch: number;
  zoom: number;
  /** The point it turns around. */
  tx: number;
  ty: number;
  tz: number;
}

export const RESTING: Camera = { yaw: 0.55, pitch: -0.32, zoom: 1, tx: 0, ty: 0, tz: 0 };

/** How far the camera is, in the units of the layout: near enough for depth to show, far enough that nothing passes behind it. */
const DISTANCE = 3.2;

export interface Projected {
  x: number;
  y: number;
  /** Further away the larger; 0 is the point the camera turns around. */
  depth: number;
  /** How much larger than at the middle's depth something is drawn here. */
  scale: number;
}

/** Where a point in space is on a screen `width` by `height`, seen by `cam`. */
export function project(p: { x: number; y: number; z: number }, cam: Camera, width: number, height: number): Projected {
  const x = p.x - cam.tx;
  const y = p.y - cam.ty;
  const z = p.z - cam.tz;
  const cy = Math.cos(cam.yaw);
  const sy = Math.sin(cam.yaw);
  const x1 = x * cy + z * sy;
  const z1 = -x * sy + z * cy;
  const cp = Math.cos(cam.pitch);
  const sp = Math.sin(cam.pitch);
  const y2 = y * cp - z1 * sp;
  const z2 = y * sp + z1 * cp;
  // Never at or behind the camera: a point that close is drawn as if just in front of it.
  const scale = DISTANCE / Math.max(0.2, DISTANCE + z2);
  const unit = Math.min(width, height) * 0.4 * cam.zoom;
  return { x: width / 2 + x1 * unit * scale, y: height / 2 + y2 * unit * scale, depth: z2, scale };
}

/**
 * The point under (`x`, `y`): the closest one whose reach (`reach(i)`, in
 * pixels) takes it in, and of two as close the one nearer the camera.
 */
export function pick(points: Projected[], x: number, y: number, reach: (i: number) => number, skip?: (i: number) => boolean): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    if (skip?.(i)) continue;
    const d = Math.hypot(points[i].x - x, points[i].y - y);
    if (d > reach(i)) continue;
    if (d < bestD - 0.5 || (Math.abs(d - bestD) <= 0.5 && best !== null && points[i].depth < points[best].depth)) {
      best = i;
      bestD = d;
    }
  }
  return best;
}

/** Numbers that look random and are the same each time for the same seed (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Vec = [number, number, number];

/** Where a note sits inside the brain: the layout's ball pressed into its shape, so that every neuron is within the outline. */
export const intoBrain = (p: { x: number; y: number; z: number }): Vec => {
  // Past the edge of the ball the few far notes are drawn in, rather than out through the skull.
  const r = Math.hypot(p.x, p.y, p.z);
  const k = r > 1 ? 1 / r : 1;
  return [p.x * k * 0.62, p.y * k * 0.42 - 0.08, p.z * k * 0.72];
};

/** A point on the surface of one half of the brain: an egg, flatter below, with the folds of its gyri. */
function cortex(side: -1 | 1, around: number, along: number): Vec {
  // `along` from the front (-1) to the back (1), `around` the ring at that place.
  const ring = Math.sqrt(Math.max(0, 1 - along * along));
  const fold = 1 + 0.05 * Math.sin(around * 9 + along * 7) * Math.sin(along * 11 + side);
  const sx = 0.48 * ring * fold;
  const syUp = 0.62 * ring * fold;
  const syDown = 0.4 * ring * fold;
  const c = Math.cos(around);
  const s = Math.sin(around);
  // The inner side of each half is flat, where the two halves meet.
  const x = side * (0.06 + sx * (side * c > 0 ? 1 : 0.35) * Math.abs(c));
  const y = s < 0 ? syUp * s - 0.05 : syDown * s - 0.05;
  return [x, y, along * 0.92];
}

/**
 * The outline of a brain as a few lines in space: rings around its two halves
 * and the folds along them, the cerebellum and the stem. Most of each line is
 * left out on purpose, so that it reads as a sketch of a brain rather than a
 * shell that hides what is inside.
 */
export function brainOutline(): Vec[][] {
  const random = seeded(97);
  const lines: Vec[][] = [];
  /** A line, broken where the sketch leaves it out: runs of points kept, the rest dropped. */
  const sketch = (points: Vec[], keep = 0.42) => {
    let run: Vec[] = [];
    for (let i = 0; i < points.length; i++) {
      if (i % 6 === 0 && run.length > 1 && random() > keep) {
        lines.push(run);
        run = [];
        i += 3 + Math.floor(random() * 6);
        continue;
      }
      run.push(points[i]);
    }
    if (run.length > 1) lines.push(run);
  };
  for (const side of [-1, 1] as const) {
    // Rings across each half, from front to back.
    for (const along of [-0.8, -0.5, -0.15, 0.2, 0.5, 0.78]) sketch(Array.from({ length: 73 }, (_, i) => cortex(side, (i / 72) * Math.PI * 2, along)));
    // Lines from front to back, over the top and down the side: the long folds.
    for (const around of [-1.95, -1.5, -1.05, -0.45, 0.6]) sketch(Array.from({ length: 61 }, (_, i) => cortex(side, around + 0.12 * Math.sin(i / 4), -0.97 + (i / 60) * 1.94)), 0.5);
  }
  // The cerebellum, low at the back, and the stem below it.
  for (const t of [-0.6, 0, 0.6]) {
    sketch(
      Array.from({ length: 49 }, (_, i) => {
        const a = (i / 48) * Math.PI * 2;
        const ring = Math.sqrt(1 - t * t);
        return [Math.cos(a) * 0.42 * ring, 0.36 + t * 0.12 + Math.sin(a) * 0.04, 0.62 + Math.sin(a) * 0.2 * ring] as Vec;
      }),
      0.55,
    );
  }
  for (const side of [-1, 1]) lines.push(Array.from({ length: 8 }, (_, i) => [side * (0.09 - i * 0.002), 0.3 + i * 0.04, 0.38 + i * 0.012] as Vec));
  return lines;
}

/**
 * The looks of the 3D view. Each is a world of its own — where the notes go,
 * how it moves and answers a drag, what a chosen note does to it, and a
 * secret — over the same notes, filters and search.
 */
export const SKY_THEMES = ["stellar", "galaxy", "brain", "fireflies", "helix"] as const;
export type SkyTheme = (typeof SKY_THEMES)[number];
export const skyThemeFrom = (stored: string | null): SkyTheme =>
  // The galaxy was a solar system once: a browser that chose that keeps its place.
  stored === "solar" ? "galaxy" : (SKY_THEMES as readonly string[]).includes(stored ?? "") ? (stored as SkyTheme) : "stellar";

/**
 * How many links away from `centre` each note is, over the notes shown: 0 for
 * the centre, -1 for one that is not shown, and one past the farthest ring for
 * those no link leads to (the galaxy's halo).
 */
export function ringsFrom(centre: number, near: number[][], shown: boolean[]): Int32Array {
  const n = shown.length;
  const ring = new Int32Array(n).fill(-2);
  for (let i = 0; i < n; i++) if (!shown[i]) ring[i] = -1;
  if (centre < 0 || centre >= n || !shown[centre]) {
    for (let i = 0; i < n; i++) if (shown[i]) ring[i] = 1;
    return ring;
  }
  ring[centre] = 0;
  let wave = [centre];
  let depth = 0;
  while (wave.length) {
    depth++;
    const next: number[] = [];
    for (const i of wave) for (const j of near[i] ?? []) if (ring[j] === -2) (ring[j] = depth), next.push(j);
    wave = next;
  }
  const far = Math.max(1, ...Array.from(ring));
  for (let i = 0; i < n; i++) if (ring[i] === -2) ring[i] = far + 1;
  return ring;
}

/** Where a note is in the galaxy, before it turns: in polar terms in the plane of its disc. */
export interface GalaxyStar {
  radius: number;
  angle: number;
  /** Above or below the disc. */
  height: number;
  /** Radians a second: the galaxy turns round its core, the inner stars faster. */
  speed: number;
  /** Out in the halo, round the disc, rather than on an arm: notes no link reaches. */
  halo: boolean;
}

/** How fast the disc turns round its core, in radians a second. */
export const GALAXY_TURN = 0.07;

/** How tightly the arms wind: radians of turn for each unit out from the core. */
export const WINDING = 4.2;

/**
 * Where each note goes in a spiral galaxy round the note at ring 0, its core:
 * out along an arm as far as it is links away (rings beyond `levels` sharing
 * the outermost reach, so that a long chain does not run off into space), on
 * the arm of its type (`arm`, out of `arms`), close to the others of its ring
 * and arm so that they make a cluster, and the disc thinner further out. The
 * ring `belt`, which no link reaches, is scattered through the halo.
 */
export function galaxyStars(ring: Int32Array, belt: number, arm: number[], arms: number, levels = 7): GalaxyStar[] {
  const most = Math.max(1, ...Array.from(ring).filter((r) => r !== belt));
  const steps = Math.min(most, levels);
  return Array.from(ring, (r, i) => {
    const random = seeded(i * 7919 + 13);
    if (r <= 0) return { radius: 0, angle: 0, height: 0, speed: 0, halo: false };
    if (r === belt) {
      const radius = 1.05 + random() * 0.3;
      return { radius, angle: random() * Math.PI * 2, height: (random() - 0.5) * 1.1, speed: 0.03, halo: true };
    }
    const level = Math.ceil((r * steps) / most);
    const radius = 0.16 + (0.82 * (level - 1)) / Math.max(1, steps - 1) + (random() - 0.5) * 0.06;
    const angle = (2 * Math.PI * (arm[i] % arms)) / arms + radius * WINDING + (random() - 0.5) * 0.35;
    // The whole disc turns as one, so that the arms keep their shape however long it is watched.
    return { radius, angle, height: (random() - 0.5) * 0.08 * (1.1 - radius), speed: GALAXY_TURN, halo: false };
  });
}

/** The order the notes go along the double helix: through their links from the most linked one, so that linked notes sit near each other. */
export function helixOrder(near: number[][], shown: boolean[], links: number[]): number[] {
  const order: number[] = [];
  const done = new Set<number>();
  const starts = shown.map((on, i) => (on ? i : -1)).filter((i) => i >= 0).sort((a, b) => links[b] - links[a] || a - b);
  for (const start of starts) {
    if (done.has(start)) continue;
    const stack = [start];
    while (stack.length) {
      const i = stack.pop()!;
      if (done.has(i)) continue;
      done.add(i);
      order.push(i);
      for (const j of [...(near[i] ?? [])].sort((a, b) => links[a] - links[b] || b - a)) if (shown[j] && !done.has(j)) stack.push(j);
    }
  }
  return order;
}

/** Where along the helix, and on which strand, the `k`th note goes: two strands, each turn `twist` round, `step` apart. */
export function helixAt(k: number, count: number, step: number, twist: number, spin: number, radius: number): Vec {
  const m = Math.floor(k / 2);
  const angle = m * twist + (k % 2) * Math.PI + spin;
  return [radius * Math.cos(angle), (m - (Math.ceil(count / 2) - 1) / 2) * step, radius * Math.sin(angle)];
}

/** The parts of the brain the types of notes live in: the lobes of each half, the cerebellum, the stem, in an order where every few apart are far apart. */
export const LOBES: Vec[] = [
  [-0.22, -0.3, -0.48],
  [0.26, -0.36, 0.14],
  [0, 0.34, 0.6],
  [0.36, 0.06, -0.14],
  [-0.2, -0.12, 0.6],
  [0.22, -0.3, -0.48],
  [-0.26, -0.36, 0.14],
  [-0.36, 0.06, -0.14],
  [0.2, -0.12, 0.6],
];
/** The lobe of a note's type: the memory's types spread over the lobes, and notes without one in the middle. */
export const lobeOf = (type: string | undefined, types: string[]): Vec => {
  if (!type) return [0, -0.05, 0];
  const i = Math.max(0, types.indexOf(type));
  return LOBES[types.length <= LOBES.length ? Math.floor((i * LOBES.length) / Math.max(1, types.length)) : i % LOBES.length];
};

/** A point of a heart, `t` from 0 to 1 round it, about one across. */
export function heart(t: number): [number, number] {
  const a = t * Math.PI * 2;
  return [(16 * Math.sin(a) ** 3) / 17, -(13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a)) / 17];
}

/** The angle from `a` to `b` seen from `c`, between -π and π: summed over a drag, how far it went round `c`. */
export function turnAround(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }): number {
  let d = Math.atan2(b.y - c.y, b.x - c.x) - Math.atan2(a.y - c.y, a.x - c.x);
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Counts how often a drag changed direction left and right within the last `window` milliseconds: a shake. */
export class Shake {
  private turns: number[] = [];
  private last: { x: number; dir: number } | null = null;
  constructor(private window = 1200, private least = 12) {}
  add(x: number, at: number): number {
    if (!this.last) this.last = { x, dir: 0 };
    const dx = x - this.last.x;
    if (Math.abs(dx) >= this.least) {
      const dir = Math.sign(dx);
      if (this.last.dir && dir !== this.last.dir) this.turns.push(at);
      this.last = { x, dir };
    }
    this.turns = this.turns.filter((t) => at - t <= this.window);
    return this.turns.length;
  }
  reset() {
    this.turns = [];
    this.last = null;
  }
}

/** The brain's outline as it comes: a soft pink with a little neon in it. */
export const BRAIN_COLOUR = "#ff5fc8";
/** A colour kept in storage, if it is one: `#` and six hex digits, as a colour input gives. */
export const colourFrom = (stored: string | null): string => (stored && /^#[0-9a-f]{6}$/i.test(stored) ? stored.toLowerCase() : BRAIN_COLOUR);
