/**
 * The memory's graph in 3D: where its notes go in space, how a camera that
 * turns around them sees them, and which note is under the pointer. Kept apart
 * from the drawing (components/MemorySky.tsx) so the geometry can be tested
 * without a browser.
 *
 * The layout is the flat one's (memory-graph.ts) with a third axis: the same
 * pushes and pulls, started on a sphere, so the same memory lands the same way
 * each time. Then it is centred and scaled to a radius of about one, which is
 * what the camera and the themes are made for.
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
export function normalised(points: Point3[]): Point3[] {
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

/** `layout3d`, remembered by the notes and links it was run for, as `layoutKept` is. */
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
  for (const side of [-1, 1]) lines.push(Array.from({ length: 12 }, (_, i) => [side * (0.09 - i * 0.002), 0.3 + i * 0.05, 0.38 + i * 0.012] as Vec));
  return lines;
}

/** How the 3D view looks; what it shows and how it turns is the same in each. */
export const SKY_THEMES = ["stellar", "deepsea", "brain", "synthwave"] as const;
export type SkyTheme = (typeof SKY_THEMES)[number];
export const skyThemeFrom = (stored: string | null): SkyTheme => (SKY_THEMES as readonly string[]).includes(stored ?? "") ? (stored as SkyTheme) : "stellar";

/** The brain's outline as it comes: a soft pink with a little neon in it. */
export const BRAIN_COLOUR = "#ff5fc8";
/** A colour kept in storage, if it is one: `#` and six hex digits, as a colour input gives. */
export const colourFrom = (stored: string | null): string => (stored && /^#[0-9a-f]{6}$/i.test(stored) ? stored.toLowerCase() : BRAIN_COLOUR);
