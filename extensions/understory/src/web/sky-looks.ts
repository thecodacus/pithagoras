/**
 * The looks of the memory's 3D view (MemorySky.tsx draws them). Each one is
 * a world of its own over the same notes, links, filters and search:
 *
 * - where the notes go and how their links are drawn (`step` writes where each
 *   note is on every frame, `draw` paints it),
 * - how the world moves by itself, how it answers a drag (`drag`, `release`),
 *   and what choosing a note does to it,
 * - and a secret, set off by a gesture (`gesture`) and shown in `egg`.
 *
 * Nothing here writes text: the names of notes are the card's, in React.
 * Somebody who asks for less motion gets each world standing still (`still`):
 * no drift, no time, and no secrets, which are all motion.
 */
import { brainOutline, galaxyStars, GALAXY_TURN, heart, helixAt, helixOrder, intoBrain, lobeOf, ringsFrom, seeded, WINDING, type Camera, type GalaxyStar, type Point3, type Projected, type SkyTheme } from "./memory-sky";

/** A note as the graph has it. */
export interface GraphNote {
  path: string;
  title?: string;
  type?: string;
  description?: string;
  links: number;
}

export type Rgb = [number, number, number];
export const rgbOf = (hex: string): Rgb => {
  const n = parseInt(hex.replace("#", "").padEnd(6, "0").slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
export const rgba = ([r, g, b]: Rgb, a: number) => `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
/** Part of the way to white, or to another colour. */
const mix = ([r, g, b]: Rgb, [r2, g2, b2]: Rgb, k: number): Rgb => [r + (r2 - r) * k, g + (g2 - g) * k, b + (b2 - b) * k];
const WHITE: Rgb = [255, 255, 255];
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const ease = (k: number) => 1 - (1 - clamp(k, 0, 1)) ** 3;

/** The camera and where it is gliding to: shared by the view and its look. */
export interface Rig {
  cam: Camera;
  aim: Camera | null;
}

/** What a look is given on each frame. */
export interface Scene {
  g: CanvasRenderingContext2D;
  w: number;
  h: number;
  /** Seconds since the last frame, and since the view opened: both 0 while motion is kept down. */
  dt: number;
  time: number;
  still: boolean;
  /** Bumped whenever the notes or what is shown change, for a look to place them again. */
  version: number;
  notes: GraphNote[];
  links: (readonly [number, number])[];
  near: number[][];
  colours: Rgb[];
  types: string[];
  shown: boolean[];
  found: Set<number> | null;
  selected: number | null;
  /** The note pointed at or reached with Tab. */
  tip: number | null;
  /** The note in focus (`tip`, else the chosen one), and it with those it links with. */
  focus: number | null;
  lit: Set<number> | null;
  /** The notes of the query path being traced: lit with the links between them, as the note in focus is with its own. */
  trail: Set<number> | null;
  /** How strongly each note is drawn: dimmed outside what is in focus, on the path traced, or what the search found. */
  dim: Float32Array;
  /** The layout, about a unit across. */
  base: Point3[];
  rig: Rig;
  grabbing: boolean;
  outline: Rgb;
  /** Where each note is now, three numbers a note: written by `step`. */
  pos: Float64Array;
  /** Where each note is on the screen: filled in between `step` and `draw`. */
  pts: Projected[];
  project: (x: number, y: number, z: number) => Projected;
}

export type Gesture = { kind: "double"; x: number; y: number } | { kind: "hold"; x: number; y: number } | { kind: "around" } | { kind: "shake" };

/** A secret playing: its name (on the view, for whoever looks for it), and when it began. */
export interface Egg {
  name: string;
  at: number;
  until: number;
}

export interface Look<W extends { egg: Egg | null } = { egg: Egg | null }> {
  /** Where the camera rests, and goes back to with "Show all of it". */
  rest: Camera;
  init(): W;
  step(s: Scene, w: W): void;
  draw(s: Scene, w: W): void;
  /** The camera the frame is drawn with: the rig's, or the rig's with the look's own sway. */
  view?(s: Scene, w: W): Camera;
  drag(s: Scene, w: W, dx: number, dy: number): void;
  /** The drag let go, moving at `vx`, `vy` pixels a second. */
  release(s: Scene, w: W, vx: number, vy: number): void;
  /** The point on the screen a drag can go round. */
  centre?(s: Scene, w: W): { x: number; y: number } | null;
  gesture(s: Scene, w: W, g: Gesture): void;
  /** "Show all of it": what the look puts back, beside the camera. */
  reset?(w: W): void;
  /** How big note `i`'s point is, in pixels, at the middle's depth: for the drawing and for what a pointer reaches. */
  core(s: Scene, i: number, w: W): number;
}

const clampPitch = (p: number) => clamp(p, -1.45, 1.45);

// Stamps of soft light, made once for each colour.
const stamps = new Map<string, HTMLCanvasElement>();
function glow(colour: Rgb, core: Rgb = WHITE, falloff = 0.38): HTMLCanvasElement {
  const key = `${colour.map(Math.round).join()}|${core.join()}|${falloff}`;
  let c = stamps.get(key);
  if (c) return c;
  c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, rgba(core, 1));
  grad.addColorStop(0.12, rgba(mix(colour, WHITE, 0.5), 0.9));
  grad.addColorStop(falloff, rgba(colour, 0.22));
  grad.addColorStop(1, rgba(colour, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  stamps.set(key, c);
  return c;
}
function stamp(g: CanvasRenderingContext2D, img: HTMLCanvasElement, x: number, y: number, size: number, alpha: number) {
  if (alpha <= 0.01 || size < 0.5) return;
  g.globalAlpha = clamp(alpha, 0, 1);
  g.drawImage(img, x - size / 2, y - size / 2, size, size);
  g.globalAlpha = 1;
}
function ring(g: CanvasRenderingContext2D, x: number, y: number, r: number, colour: Rgb, alpha: number, width = 1.2) {
  g.strokeStyle = rgba(colour, alpha);
  g.lineWidth = width;
  g.beginPath();
  g.arc(x, y, Math.max(1, r), 0, Math.PI * 2);
  g.stroke();
}
/** The far ones first, so that the near ones are drawn over them. */
const backToFront = (s: Scene) => {
  const order: number[] = [];
  for (let i = 0; i < s.notes.length; i++) if (s.shown[i]) order.push(i);
  return order.sort((a, b) => s.pts[b].depth - s.pts[a].depth);
};
/** The ring round the chosen note, and fainter ones round what the search found and the path traced: the same in every look. */
function marks<W extends { egg: Egg | null }>(s: Scene, look: Look<W>, w: W, colour: Rgb = WHITE) {
  const z = Math.sqrt(s.rig.cam.zoom);
  const at = (i: number, gap: number, alpha: number) => s.shown[i] && ring(s.g, s.pts[i].x, s.pts[i].y, look.core(s, i, w) * s.pts[i].scale * z * 2.4 + gap, colour, alpha);
  if (s.found) for (const i of s.found) at(i, 3, 0.45);
  if (s.trail) for (const i of s.trail) at(i, 3, 0.45);
  if (s.selected !== null) at(s.selected, 6, s.still ? 0.85 : 0.6 + 0.3 * Math.sin(s.time * 2.4));
}
/** The note a link is lit in the colour of: the note in focus when the link touches it, the end of a link between two notes of the path traced, or null for a link that is not lit. */
const litBy = (s: Scene, a: number, b: number): number | null => (s.focus !== null && (a === s.focus || b === s.focus) ? s.focus : s.trail?.has(a) && s.trail.has(b) ? a : null);
/** Draws `points` (screen points) as one line, the segments between `from` and `to`. */
function polyline(g: CanvasRenderingContext2D, points: Projected[]) {
  g.beginPath();
  points.forEach((p, k) => (k ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
  g.stroke();
}
const put = (s: Scene, i: number, x: number, y: number, z: number) => {
  s.pos[i * 3] = x;
  s.pos[i * 3 + 1] = y;
  s.pos[i * 3 + 2] = z;
};
const at3 = (s: Scene, i: number): [number, number, number] => [s.pos[i * 3], s.pos[i * 3 + 1], s.pos[i * 3 + 2]];

/** Dust and far stars, fixed for each look so the same view is the same picture. */
const specks = (seed: number, n: number) => {
  const random = seeded(seed);
  return Array.from({ length: n }, () => ({ x: random(), y: random(), size: random(), phase: random() * Math.PI * 2, speed: random() }));
};
const FAR_STARS = specks(11, 260);
const DUST = specks(23, 80);

/** Turning as a drag does in most looks: across turns it round, up and down tips it. */
const turn = (s: Scene, dx: number, dy: number, rate = 0.006) => {
  s.rig.cam.yaw += dx * rate;
  s.rig.cam.pitch = clampPitch(s.rig.cam.pitch - dy * rate);
};

// ---------------------------------------------------------------------------
// Constellation: the notes as stars where their links pull them, the sky
// turning slowly round a leaning pole. A drag flings it and it coasts; choosing
// a star flies the camera to it. Secret: a double-click on the empty sky sets
// off a meteor shower from there.

interface Meteor {
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
}
interface StellarWorld {
  egg: Egg | null;
  spin: { yaw: number; pitch: number };
  chosen: number | null;
  meteors: Meteor[];
}

const stellar: Look<StellarWorld> = {
  rest: { yaw: 0.55, pitch: -0.32, zoom: 1, tx: 0, ty: 0, tz: 0 },
  init: () => ({ egg: null, spin: { yaw: 0, pitch: 0 }, chosen: null, meteors: [] }),
  core: (s, i) => 1.7 + Math.min(s.notes[i].links, 12) * 0.3,
  step(s, w) {
    for (let i = 0; i < s.notes.length; i++) put(s, i, s.base[i].x, s.base[i].y, s.base[i].z);
    const cam = s.rig.cam;
    if (!s.still) {
      if (!s.grabbing && s.tip === null) cam.yaw += s.dt * 0.05;
      cam.yaw += w.spin.yaw * s.dt;
      cam.pitch = clampPitch(cam.pitch + w.spin.pitch * s.dt);
      w.spin.yaw *= Math.exp(-s.dt * 2.5);
      w.spin.pitch *= Math.exp(-s.dt * 2.5);
    }
    if (s.selected !== w.chosen) {
      w.chosen = s.selected;
      if (s.selected !== null && s.shown[s.selected]) {
        const [x, y, z] = at3(s, s.selected);
        s.rig.aim = { ...(s.rig.aim ?? cam), tx: x, ty: y, tz: z, zoom: Math.max(cam.zoom, 1.5) };
      }
    }
    if (w.egg && s.time > w.egg.until) w.egg = null;
  },
  draw(s, w) {
    const { g, w: W, h: H } = s;
    const sky = g.createRadialGradient(W * 0.5, H * 0.45, 0, W * 0.5, H * 0.5, Math.max(W, H) * 0.75);
    sky.addColorStop(0, "#141a3a");
    sky.addColorStop(0.55, "#090c1f");
    sky.addColorStop(1, "#03040b");
    g.fillStyle = sky;
    g.fillRect(0, 0, W, H);
    const band = g.createLinearGradient(0, H * 0.2, W, H * 0.8);
    band.addColorStop(0, "rgba(90,70,160,0)");
    band.addColorStop(0.5, "rgba(110,90,190,0.10)");
    band.addColorStop(1, "rgba(60,120,200,0)");
    g.fillStyle = band;
    g.fillRect(0, 0, W, H);
    const cam = s.rig.cam;
    for (const st of FAR_STARS) {
      const x = (((st.x * W - cam.yaw * 40) % W) + W) % W;
      const y = (((st.y * H + cam.pitch * 40) % H) + H) % H;
      g.fillStyle = `rgba(220,230,255,${(0.12 + st.size * 0.4) * (0.7 + 0.3 * Math.sin(s.time * 1.5 + st.phase))})`;
      const size = st.size > 0.85 ? 1.6 : 1;
      g.fillRect(x, y, size, size);
    }
    // The constellations' lines.
    g.lineCap = "round";
    for (const [a, b] of s.links) {
      if (!s.shown[a] || !s.shown[b]) continue;
      const pa = s.pts[a];
      const pb = s.pts[b];
      const by = litBy(s, a, b);
      const hot = by !== null;
      g.lineWidth = hot ? 1.4 : 0.7;
      g.strokeStyle = hot ? rgba(mix(s.colours[by!], WHITE, 0.25), 0.9) : rgba([175, 200, 255], 0.26 * clamp(1 - (pa.depth + pb.depth) / 4, 0.15, 1) * Math.min(s.dim[a], s.dim[b]));
      g.beginPath();
      g.moveTo(pa.x, pa.y);
      g.lineTo(pb.x, pb.y);
      g.stroke();
    }
    g.globalCompositeOperation = "lighter";
    const z = Math.sqrt(cam.zoom);
    for (const i of backToFront(s)) {
      const p = s.pts[i];
      const base = stellar.core(s, i, w) * p.scale * z;
      const twinkle = s.still ? 1 : 0.82 + 0.18 * Math.sin(s.time * (1.3 + (i % 5) * 0.37) + i * 2.1);
      const alpha = s.dim[i] * twinkle * clamp(1.2 - p.depth / 3, 0.35, 1);
      stamp(g, glow(s.colours[i]), p.x, p.y, base * 7.5, alpha);
      // The brightest stars have the spikes a lens gives them.
      if (s.notes[i].links >= 3) {
        g.strokeStyle = rgba(mix(s.colours[i], WHITE, 0.6), 0.35 * alpha);
        g.lineWidth = 0.7;
        const r = base * 4.5;
        g.beginPath();
        g.moveTo(p.x - r, p.y);
        g.lineTo(p.x + r, p.y);
        g.moveTo(p.x, p.y - r);
        g.lineTo(p.x, p.y + r);
        g.stroke();
      }
    }
    // The shower: streaks with tails, each living a second.
    for (const m of w.meteors) {
      const age = s.time - m.born;
      if (age < 0 || age > 1.1) continue;
      const x = m.x + m.vx * age;
      const y = m.y + m.vy * age;
      const tail = g.createLinearGradient(x, y, x - m.vx * 0.18, y - m.vy * 0.18);
      tail.addColorStop(0, `rgba(255,255,255,${(0.95 * (1 - age / 1.1)).toFixed(3)})`);
      tail.addColorStop(1, "rgba(180,200,255,0)");
      g.strokeStyle = tail;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x - m.vx * 0.18, y - m.vy * 0.18);
      g.stroke();
    }
    g.globalCompositeOperation = "source-over";
    w.meteors = w.meteors.filter((m) => s.time - m.born < 1.2);
    marks(s, stellar, w);
  },
  drag: (s, _w, dx, dy) => turn(s, dx, dy),
  release(_s, w, vx, vy) {
    w.spin = { yaw: vx * 0.006 * 0.35, pitch: -vy * 0.006 * 0.35 };
  },
  gesture(s, w, g) {
    if (g.kind !== "double" || s.still) return;
    const random = seeded(Math.floor(s.time * 1000) + 1);
    for (let k = 0; k < 16; k++) {
      const angle = Math.PI * 0.7 + (random() - 0.5) * 0.5;
      const speed = 380 + random() * 320;
      w.meteors.push({ x: g.x + (random() - 0.3) * 260, y: g.y - 40 - random() * 160, vx: -Math.cos(angle) * speed, vy: Math.sin(angle) * speed, born: s.time + k * 0.12 });
    }
    w.egg = { name: "meteor-shower", at: s.time, until: s.time + 3.2 };
  },
};

// ---------------------------------------------------------------------------
// Galaxy: a spiral galaxy seen at a slant, its core the chosen note (the most
// linked one until a note is chosen). Every other note is a star out along an
// arm as far as it is links away, on the arm of its type, close to the others
// of its ring so that they make clusters; what no link reaches is scattered
// through the halo. The disc turns slowly round the core, its arms glowing
// with dust and stars and crossed by dark lanes. Choosing another note makes
// it the core, and the whole galaxy swirls round to it. A drag tips the disc,
// which settles back to its slant. Secret: drag once right round the core, and
// it goes supernova: a flash, and a shock that runs out through the disc.

interface GalaxyWorld {
  egg: Egg | null;
  key: string;
  centre: number;
  /** The ring of the notes no link reaches, or -1. */
  belt: number;
  ring: Int32Array;
  stars: GalaxyStar[];
  from: Float64Array | null;
  movedAt: number;
  spin: number;
}

/** The glow of the arms and the dust lanes along them: fixed, and turning with the disc. */
const ARM_GLOW = (() => {
  const random = seeded(71);
  return Array.from({ length: 900 }, (_, k) => {
    const u = 0.06 + random() ** 0.8 * 1.02;
    const spread = (random() + random() + random() - 1.5) * 0.45;
    return { u, a: (k % 2) * Math.PI + u * WINDING + spread, y: (random() - 0.5) * 0.05, size: random(), warm: u < 0.32 || random() < 0.15 };
  });
})();
const LANES = (() => {
  const random = seeded(83);
  return Array.from({ length: 260 }, (_, k) => {
    const u = 0.14 + random() * 0.8;
    // On the inner side of each arm, where the dust gathers.
    return { u, a: (k % 2) * Math.PI + u * WINDING - 0.32 + (random() - 0.5) * 0.12, size: random() };
  });
})();
const lane = (() => {
  let c: HTMLCanvasElement | null = null;
  return () => {
    if (c) return c;
    c = document.createElement("canvas");
    c.width = c.height = 32;
    const g = c.getContext("2d")!;
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, "rgba(14,8,6,0.55)");
    grad.addColorStop(1, "rgba(14,8,6,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
    return c;
  };
})();

const galaxy: Look<GalaxyWorld> = {
  rest: { yaw: 0.3, pitch: -0.62, zoom: 1, tx: 0, ty: 0, tz: 0 },
  init: () => ({ egg: null, key: "", centre: -1, belt: -1, ring: new Int32Array(0), stars: [], from: null, movedAt: 0, spin: 0 }),
  core: (s, i, w) => (i === w.centre ? 4.5 : 1.6 + Math.min(s.notes[i].links, 12) * 0.28),
  step(s, w) {
    let centre = s.selected !== null && s.shown[s.selected] ? s.selected : -1;
    if (centre < 0) {
      for (let i = 0; i < s.notes.length; i++) if (s.shown[i] && (centre < 0 || s.notes[i].links > s.notes[centre].links)) centre = i;
    }
    const key = `${centre}|${s.version}`;
    if (key !== w.key) {
      // A new core: every star swirls from where it is to its place round it.
      w.from = w.key ? s.pos.slice() : null;
      w.key = key;
      w.centre = centre;
      w.ring = ringsFrom(centre, s.near, s.shown);
      // Every note a link reaches has a neighbour one ring nearer; those of the outermost ring without one are the halo.
      const most = Math.max(0, ...Array.from(w.ring));
      w.belt = most > 1 && Array.from(w.ring).some((r, i) => r === most && !(s.near[i] ?? []).some((j) => w.ring[j] === most - 1)) ? most : -1;
      const arms = s.types.length >= 3 ? 3 : 2;
      w.stars = galaxyStars(w.ring, w.belt, s.notes.map((n, i) => (n.type ? s.types.indexOf(n.type) : i)), arms);
      w.movedAt = s.time;
    }
    const k = s.still || !w.from ? 1 : ease((s.time - w.movedAt) / 1.8);
    const nova = w.egg ? (s.time - w.egg.at) / (w.egg.until - w.egg.at) : -1;
    for (let i = 0; i < s.notes.length; i++) {
      const st = w.stars[i];
      // The shock pushes each star out a little as it passes.
      const push = nova >= 0 ? 1 + 0.12 * Math.exp(-(((st.radius - nova * 1.5) / 0.12) ** 2)) : 1;
      const a = st.angle + st.speed * s.time;
      const x = st.radius * push * Math.cos(a);
      const z = st.radius * push * Math.sin(a);
      const y = st.height;
      if (w.from && k < 1) put(s, i, w.from[i * 3] + (x - w.from[i * 3]) * k, w.from[i * 3 + 1] + (y - w.from[i * 3 + 1]) * k, w.from[i * 3 + 2] + (z - w.from[i * 3 + 2]) * k);
      else put(s, i, x, y, z);
    }
    const cam = s.rig.cam;
    if (!s.still && !s.grabbing && !s.rig.aim) {
      // The slant the galaxy is seen at draws the view back to it, like a spring.
      cam.pitch += (galaxy.rest.pitch - cam.pitch) * (1 - Math.exp(-s.dt * 1.2));
      cam.yaw += w.spin * s.dt;
      w.spin *= Math.exp(-s.dt * 1.8);
    }
    if (w.egg && s.time > w.egg.until) w.egg = null;
  },
  draw(s, w) {
    const { g, w: W, h: H } = s;
    g.fillStyle = "#020208";
    g.fillRect(0, 0, W, H);
    for (const st of FAR_STARS) {
      g.fillStyle = `rgba(220,225,255,${(0.06 + st.size * 0.22).toFixed(3)})`;
      g.fillRect(st.x * W, st.y * H, 1, 1);
    }
    const z = Math.sqrt(s.rig.cam.zoom);
    const spun = GALAXY_TURN * s.time;
    const nova = w.egg ? clamp((s.time - w.egg.at) / (w.egg.until - w.egg.at), 0, 1) : -1;
    const core = s.project(0, 0, 0);
    // The disc's light: a soft ellipse, as flat as the slant makes it.
    const flat = Math.max(0.22, Math.abs(Math.sin(s.rig.cam.pitch)));
    const reach = Math.min(W, H) * 0.4 * s.rig.cam.zoom * core.scale;
    g.save();
    g.translate(core.x, core.y);
    g.scale(1, flat);
    const disc = g.createRadialGradient(0, 0, 0, 0, 0, reach * 1.1);
    disc.addColorStop(0, "rgba(255,230,190,0.32)");
    disc.addColorStop(0.25, "rgba(200,180,220,0.12)");
    disc.addColorStop(1, "rgba(90,110,200,0)");
    g.fillStyle = disc;
    g.beginPath();
    g.arc(0, 0, reach * 1.1, 0, Math.PI * 2);
    g.fill();
    g.restore();
    // The arms: dust and far stars along them, warm near the core and blue out in the arms.
    g.globalCompositeOperation = "lighter";
    for (const d of ARM_GLOW) {
      const p = s.project(d.u * Math.cos(d.a + spun), d.y, d.u * Math.sin(d.a + spun));
      g.fillStyle = d.warm ? `rgba(255,214,160,${(0.18 + d.size * 0.3).toFixed(3)})` : `rgba(150,180,255,${(0.14 + d.size * 0.28).toFixed(3)})`;
      const size = (0.8 + d.size * 1.6) * p.scale;
      g.fillRect(p.x - size / 2, p.y - size / 2, size, size);
    }
    g.globalCompositeOperation = "source-over";
    // The dust lanes, dark along the inner edge of each arm.
    const dark = lane();
    for (const d of LANES) {
      const p = s.project(d.u * Math.cos(d.a + spun), 0, d.u * Math.sin(d.a + spun));
      const size = (8 + d.size * 12) * p.scale * z;
      g.drawImage(dark, p.x - size / 2, p.y - size / 2, size, size * flat * 1.4);
    }
    for (const [a, b] of s.links) {
      if (!s.shown[a] || !s.shown[b]) continue;
      const by = litBy(s, a, b);
      const hot = by !== null;
      g.strokeStyle = hot ? rgba(mix(s.colours[by!], WHITE, 0.3), 0.85) : rgba([190, 205, 255], 0.09 * Math.min(s.dim[a], s.dim[b]));
      g.lineWidth = hot ? 1.2 : 0.6;
      g.beginPath();
      g.moveTo(s.pts[a].x, s.pts[a].y);
      g.lineTo(s.pts[b].x, s.pts[b].y);
      g.stroke();
    }
    g.globalCompositeOperation = "lighter";
    // The core, and the flash when it goes.
    const flash = nova >= 0 ? (1 - nova) ** 2 : 0;
    stamp(g, glow([255, 214, 150], [255, 250, 235], 0.4), core.x, core.y, (70 + flash * 260) * z, 0.9);
    for (const i of backToFront(s)) {
      const p = s.pts[i];
      const r = galaxy.core(s, i, w) * p.scale * z;
      const twinkle = s.still ? 1 : 0.85 + 0.15 * Math.sin(s.time * (1.1 + (i % 7) * 0.3) + i);
      const colour = i === w.centre ? mix(s.colours[i], [255, 235, 200], 0.6) : s.colours[i];
      stamp(g, glow(colour), p.x, p.y, r * 7, s.dim[i] * twinkle * clamp(1.2 - p.depth / 3, 0.35, 1));
    }
    // The shock, a ring running out through the disc.
    if (nova >= 0) {
      const radius = nova * 1.5;
      g.strokeStyle = `rgba(190,215,255,${(0.75 * (1 - nova)).toFixed(3)})`;
      g.lineWidth = 2 + 3 * (1 - nova);
      polyline(g, Array.from({ length: 97 }, (_, k) => s.project(radius * Math.cos((k / 96) * Math.PI * 2), 0, radius * Math.sin((k / 96) * Math.PI * 2))));
    }
    g.globalCompositeOperation = "source-over";
    marks(s, galaxy, w);
  },
  drag: (s, _w, dx, dy) => turn(s, dx, dy, 0.005),
  release(_s, w, vx) {
    w.spin = vx * 0.005 * 0.3;
  },
  centre: (s, w) => (w.centre >= 0 && s.pts[w.centre] ? { x: s.pts[w.centre].x, y: s.pts[w.centre].y } : null),
  gesture(s, w, g) {
    if (g.kind === "around" && !s.still && w.centre >= 0) w.egg = { name: "supernova", at: s.time, until: s.time + 3.2 };
  },
};

// ---------------------------------------------------------------------------
// Brain: neurons in the lobes their types belong to, axons curving between
// them, inside the faint outline of a brain. It sways from side to side like a
// specimen turned in the hand and breathes a little; a drag turns it heavily,
// with no coasting. Neurons fire now and then, a spark running down an axon;
// the chosen one keeps firing into those it links with. Secret: press and hold
// on an empty spot, and a thought starts at the nearest neuron and spreads
// through the links, the whole outline flaring.

interface Pulse {
  a: number;
  b: number;
  born: number;
}
interface BrainWorld {
  egg: Egg | null;
  key: string;
  home: Float64Array;
  pulses: Pulse[];
  next: number;
  fired: number;
  flash: Float64Array;
}
const BRAIN = brainOutline();

const brain: Look<BrainWorld> = {
  rest: { yaw: 0.55, pitch: -0.3, zoom: 1.05, tx: 0, ty: 0, tz: 0 },
  init: () => ({ egg: null, key: "", home: new Float64Array(0), pulses: [], next: 0, fired: 0, flash: new Float64Array(0) }),
  core: (s, i) => 1 + Math.min(s.notes[i].links, 12) * 0.13,
  view: (s, w) => ({ ...s.rig.cam, yaw: s.rig.cam.yaw + (s.still ? 0 : 0.55 * Math.sin(s.time * 0.13)) }),
  step(s, w) {
    const key = `${s.version}`;
    if (key !== w.key) {
      w.key = key;
      w.home = new Float64Array(s.notes.length * 3);
      w.flash = new Float64Array(s.notes.length).fill(-9);
      s.notes.forEach((n, i) => {
        const lobe = lobeOf(n.type, s.types);
        const b = s.base[i];
        // Spread wider the fewer the lobes in use.
        const spread = 0.16 + 0.3 / Math.max(1, Math.min(s.types.length, 9));
        const p = intoBrain({ x: (lobe[0] + b.x * spread) / 0.62, y: (lobe[1] + 0.08 + b.y * spread) / 0.42, z: (lobe[2] + b.z * spread) / 0.72 });
        w.home.set(p, i * 3);
      });
    }
    const breath = s.still ? 1 : 1 + 0.012 * Math.sin(s.time * 0.9);
    for (let i = 0; i < s.notes.length; i++) put(s, i, w.home[i * 3] * breath, w.home[i * 3 + 1] * breath, w.home[i * 3 + 2] * breath);
    if (!s.still) {
      const live = s.links.filter(([a, b]) => s.shown[a] && s.shown[b]);
      if (s.time > w.next && live.length) {
        const [a, b] = live[Math.floor(Math.random() * live.length)];
        w.pulses.push(Math.random() < 0.5 ? { a, b, born: s.time } : { a: b, b: a, born: s.time });
        w.next = s.time + 0.3 + Math.random() * 0.6;
      }
      if (s.selected !== null && s.shown[s.selected] && s.time > w.fired) {
        for (const j of s.near[s.selected] ?? []) if (s.shown[j]) w.pulses.push({ a: s.selected, b: j, born: s.time });
        w.flash[s.selected] = s.time;
        w.fired = s.time + 1.1;
      }
      for (const p of w.pulses) if (s.time - p.born >= 0.8 && w.flash[p.b] < p.born) w.flash[p.b] = s.time;
      w.pulses = w.pulses.filter((p) => s.time - p.born < 0.8);
    }
    if (w.egg && s.time > w.egg.until) w.egg = null;
  },
  draw(s, w) {
    const { g, w: W, h: H } = s;
    const dark = g.createRadialGradient(W * 0.5, H * 0.5, 0, W * 0.5, H * 0.5, Math.max(W, H) * 0.7);
    dark.addColorStop(0, "#1a0d1f");
    dark.addColorStop(1, "#060308");
    g.fillStyle = dark;
    g.fillRect(0, 0, W, H);
    const flare = w.egg ? Math.sin(clamp((s.time - w.egg.at) / (w.egg.until - w.egg.at), 0, 1) * Math.PI) : 0;
    // The outline: between a twentieth and a quarter as strong, the far side the fainter, flaring with a thought.
    g.lineWidth = 1;
    g.shadowColor = rgba(s.outline, 0.9);
    g.shadowBlur = 6 + flare * 10;
    const breath = s.still ? 1 : 1 + 0.012 * Math.sin(s.time * 0.9);
    for (const line of BRAIN) {
      const projected = line.map((q) => s.project(q[0] * breath, q[1] * breath, q[2] * breath));
      const depth = projected.reduce((a, q) => a + q.depth, 0) / projected.length;
      g.strokeStyle = rgba(s.outline, (0.05 + 0.2 * clamp(0.5 - depth / 2, 0, 1)) * (1 + flare * 2.5));
      polyline(g, projected);
    }
    g.shadowBlur = 0;
    // The axons, curving out from the middle of the brain.
    const axon = mix(s.outline, WHITE, 0.3);
    const bend = (a: number, b: number) => {
      const pa = at3(s, a);
      const pb = at3(s, b);
      return s.project((pa[0] + pb[0]) * 0.62, (pa[1] + pb[1]) * 0.62, (pa[2] + pb[2]) * 0.62);
    };
    for (const [a, b] of s.links) {
      if (!s.shown[a] || !s.shown[b]) continue;
      const by = litBy(s, a, b);
      const hot = by !== null;
      const c = bend(a, b);
      g.strokeStyle = hot ? rgba(mix(s.colours[by!], WHITE, 0.3), 0.85) : rgba(axon, 0.17 * Math.min(s.dim[a], s.dim[b]));
      g.lineWidth = hot ? 1.2 : 0.6;
      g.beginPath();
      g.moveTo(s.pts[a].x, s.pts[a].y);
      g.quadraticCurveTo(c.x, c.y, s.pts[b].x, s.pts[b].y);
      g.stroke();
    }
    g.globalCompositeOperation = "lighter";
    // The sparks running down the axons.
    for (const p of w.pulses) {
      const k = (s.time - p.born) / 0.8;
      if (k < 0 || k > 1 || !s.shown[p.a] || !s.shown[p.b]) continue;
      const a = s.pts[p.a];
      const b = s.pts[p.b];
      const c = bend(p.a, p.b);
      const x = (1 - k) ** 2 * a.x + 2 * (1 - k) * k * c.x + k * k * b.x;
      const y = (1 - k) ** 2 * a.y + 2 * (1 - k) * k * c.y + k * k * b.y;
      stamp(g, glow(mix(s.outline, WHITE, 0.5)), x, y, 10, 0.9);
    }
    const z = Math.sqrt(s.rig.cam.zoom);
    for (const i of backToFront(s)) {
      const p = s.pts[i];
      const firing = s.still ? 0 : clamp(1 - (s.time - w.flash[i]) / 0.5, 0, 1);
      const r = brain.core(s, i, w) * p.scale * z * (1 + firing * 1.5);
      stamp(g, glow(mix(s.colours[i], WHITE, 0.25), [255, 245, 252], 0.35), p.x, p.y, r * 8, s.dim[i] * clamp(1.2 - p.depth / 3, 0.35, 1) + firing * 0.5);
    }
    g.globalCompositeOperation = "source-over";
    marks(s, brain, w, mix(s.outline, WHITE, 0.6));
  },
  drag: (s, _w, dx, dy) => {
    s.rig.cam.yaw += dx * 0.0035;
    s.rig.cam.pitch = clamp(s.rig.cam.pitch - dy * 0.0035, -0.9, 0.6);
  },
  release() {
    // Heavy: it stops where it is let go.
  },
  gesture(s, w, g) {
    if (g.kind !== "hold" || s.still) return;
    // The neuron nearest the press starts it, and it runs on through the links, a step at a time.
    let start = -1;
    let best = Infinity;
    for (let i = 0; i < s.notes.length; i++) {
      if (!s.shown[i]) continue;
      const d = Math.hypot(s.pts[i].x - g.x, s.pts[i].y - g.y);
      if (d < best) (best = d), (start = i);
    }
    if (start < 0) return;
    const depth = new Map([[start, 0]]);
    let wave = [start];
    let step = 0;
    while (wave.length && step < 12) {
      const next: number[] = [];
      for (const i of wave)
        for (const j of s.near[i] ?? [])
          if (s.shown[j] && !depth.has(j)) {
            depth.set(j, step + 1);
            next.push(j);
            w.pulses.push({ a: i, b: j, born: s.time + step * 0.28 });
          }
      wave = next;
      step++;
    }
    w.flash[start] = s.time;
    w.egg = { name: "thought", at: s.time, until: s.time + step * 0.28 + 1.6 };
  },
};

// ---------------------------------------------------------------------------
// Fireflies: each note a firefly wandering near where its links put it, each
// blinking to its own rhythm, over a meadow at dusk. A drag turns the view and
// blows a breeze through them; choosing a note calls the swarm to it, those it
// links with circling close and the rest gathering round. Secret: shake the
// view (drag quickly back and forth), and they all blink as one and fly into
// a heart.

interface FireflyWorld {
  egg: Egg | null;
  key: string;
  chosen: number | null;
  now: Float64Array;
  wind: [number, number, number];
  bob: number;
}
const MEADOW = specks(53, 48);

const fireflies: Look<FireflyWorld> = {
  rest: { yaw: 0.3, pitch: -0.12, zoom: 1, tx: 0, ty: 0, tz: 0 },
  init: () => ({ egg: null, key: "", chosen: null, now: new Float64Array(0), wind: [0, 0, 0], bob: 0 }),
  core: (s, i) => 1.5 + Math.min(s.notes[i].links, 12) * 0.2,
  view: (s) => ({ ...s.rig.cam, pitch: s.rig.cam.pitch + (s.still ? 0 : 0.05 * Math.sin(s.time * 0.31)) }),
  step(s, w) {
    const n = s.notes.length;
    const first = w.key !== `${s.version}`;
    if (first) {
      w.key = `${s.version}`;
      if (w.now.length !== n * 3) w.now = new Float64Array(n * 3).map((_, k) => [s.base[Math.floor(k / 3)].x, s.base[Math.floor(k / 3)].y, s.base[Math.floor(k / 3)].z][k % 3]);
    }
    const sel = s.selected !== null && s.shown[s.selected] ? s.selected : null;
    const cam = s.rig.cam;
    // The camera goes where the swarm gathers.
    if (s.selected !== w.chosen) {
      w.chosen = s.selected;
      if (sel !== null) s.rig.aim = { ...(s.rig.aim ?? cam), tx: s.base[sel].x, ty: s.base[sel].y, tz: s.base[sel].z, zoom: Math.max(cam.zoom, 1.4) };
    }
    // The heart faces the camera: across the screen and up it.
    const right: [number, number, number] = [Math.cos(cam.yaw), 0, Math.sin(cam.yaw)];
    const shown = s.notes.map((_, i) => i).filter((i) => s.shown[i]);
    let cx = 0, cy = 0, cz = 0;
    for (const i of shown) (cx += s.base[i].x), (cy += s.base[i].y), (cz += s.base[i].z);
    cx /= shown.length || 1;
    cy /= shown.length || 1;
    cz /= shown.length || 1;
    const linked = sel === null ? null : new Set(s.near[sel] ?? []);
    const heartUp = w.egg ? clamp((s.time - w.egg.at) / 0.8, 0, 1) * clamp((w.egg.until - s.time) / 0.8, 0, 1) : 0;
    const pull = 1 - Math.exp(-s.dt * (heartUp > 0 ? 3 : 1.3));
    shown.forEach((i, k) => {
      const b = s.base[i];
      let t: [number, number, number] = [b.x, b.y, b.z];
      if (sel !== null) {
        const c = s.base[sel];
        if (i === sel) t = [c.x, c.y, c.z];
        else if (linked!.has(i)) {
          // Round the chosen one, close.
          const a = (k * 2.4 + s.time * 0.8) % (Math.PI * 2);
          const lean = ((i * 13) % 7) / 7 - 0.5;
          t = [c.x + Math.cos(a) * 0.17, c.y + lean * 0.2, c.z + Math.sin(a) * 0.17];
        } else t = [c.x + (b.x - cx) * 0.45, c.y + (b.y - cy) * 0.45, c.z + (b.z - cz) * 0.45];
      }
      if (heartUp > 0) {
        const [hx, hy] = heart(k / shown.length);
        const h: [number, number, number] = [right[0] * hx * 0.8, hy * 0.8, right[2] * hx * 0.8];
        t = [t[0] + (h[0] - t[0]) * heartUp, t[1] + (h[1] - t[1]) * heartUp, t[2] + (h[2] - t[2]) * heartUp];
      }
      // Wandering, and blown by the breeze, each a little differently.
      const ph = i * 1.7;
      const wander = heartUp > 0 ? 0.01 : 0.05;
      const blow = 0.6 + ((i * 7) % 5) / 6;
      t = [t[0] + wander * Math.sin(s.time * 0.7 + ph) + w.wind[0] * blow, t[1] + wander * Math.sin(s.time * 0.9 + ph * 1.3) + w.wind[1] * blow, t[2] + wander * Math.sin(s.time * 0.6 + ph * 0.7) + w.wind[2] * blow];
      for (let d = 0; d < 3; d++) w.now[i * 3 + d] = s.still || first ? t[d] : w.now[i * 3 + d] + (t[d] - w.now[i * 3 + d]) * pull;
      put(s, i, w.now[i * 3], w.now[i * 3 + 1], w.now[i * 3 + 2]);
    });
    if (!s.still) {
      w.wind = w.wind.map((v) => v * Math.exp(-s.dt * 1.4)) as [number, number, number];
      if (!s.grabbing && s.tip === null) cam.yaw += s.dt * 0.025;
    }
    if (w.egg && s.time > w.egg.until) w.egg = null;
  },
  draw(s, w) {
    const { g, w: W, h: H } = s;
    const dusk = g.createLinearGradient(0, 0, 0, H);
    dusk.addColorStop(0, "#070f24");
    dusk.addColorStop(0.6, "#0b1b22");
    dusk.addColorStop(1, "#081108");
    g.fillStyle = dusk;
    g.fillRect(0, 0, W, H);
    const moon = g.createRadialGradient(W * 0.82, H * 0.16, 0, W * 0.82, H * 0.16, Math.min(W, H) * 0.25);
    moon.addColorStop(0, "rgba(230,240,255,0.55)");
    moon.addColorStop(0.08, "rgba(210,225,255,0.25)");
    moon.addColorStop(1, "rgba(120,150,220,0)");
    g.fillStyle = moon;
    g.fillRect(0, 0, W, H);
    // The tree line and the grass, sliding a little as the view turns.
    const slide = s.rig.cam.yaw * 30;
    g.fillStyle = "#040a06";
    g.beginPath();
    g.moveTo(0, H);
    for (let x = -60; x <= W + 60; x += 6) {
      // A hedge and the round tops of trees behind it.
      const u = (x + slide) / 40;
      const top = 0.86 - 0.05 * Math.max(0, Math.sin(u * 0.9)) ** 0.6 - 0.035 * Math.max(0, Math.sin(u * 2.3 + 1)) ** 0.5 - 0.01 * Math.sin(u * 7);
      g.lineTo(x, H * top);
    }
    g.lineTo(W, H);
    g.fill();
    g.strokeStyle = "rgba(20,40,20,0.9)";
    g.lineWidth = 1.2;
    for (const blade of MEADOW) {
      const x = (((blade.x * W - slide * 1.6) % W) + W) % W;
      const sway = s.still ? 0 : Math.sin(s.time * 1.2 + blade.phase) * 3;
      g.beginPath();
      g.moveTo(x, H);
      g.quadraticCurveTo(x + sway * 0.5, H - 10 - blade.size * 14, x + sway, H - 18 - blade.size * 26);
      g.stroke();
    }
    for (const [a, b] of s.links) {
      if (!s.shown[a] || !s.shown[b]) continue;
      const by = litBy(s, a, b);
      const hot = by !== null;
      g.strokeStyle = hot ? rgba([255, 240, 160], 0.7) : rgba([200, 230, 160], 0.07 * Math.min(s.dim[a], s.dim[b]));
      g.lineWidth = hot ? 1 : 0.5;
      g.beginPath();
      g.moveTo(s.pts[a].x, s.pts[a].y);
      g.lineTo(s.pts[b].x, s.pts[b].y);
      g.stroke();
    }
    g.globalCompositeOperation = "lighter";
    const z = Math.sqrt(s.rig.cam.zoom);
    const sync = !!w.egg;
    for (const i of backToFront(s)) {
      const p = s.pts[i];
      // A blink: a quick light and a long dark, each to its own rhythm, or all at once.
      const u = sync ? s.time * 1.1 : s.time * (0.35 + ((i * 7) % 11) / 30) + ((i * 0.618) % 1);
      const blink = s.still ? 0.8 : 0.18 + 0.82 * Math.max(0, Math.sin(u * Math.PI * 2)) ** 4;
      const warm = mix([255, 228, 110], s.colours[i], 0.3);
      const r = fireflies.core(s, i, w) * p.scale * z;
      // Those out of focus dim less here: a swarm at night is mostly dark already.
      stamp(g, glow(warm, [255, 255, 220], 0.3), p.x, p.y, r * 9 * (0.7 + blink * 0.5), Math.max(s.dim[i], 0.5) * blink * clamp(1.2 - p.depth / 3, 0.4, 1));
    }
    g.globalCompositeOperation = "source-over";
    marks(s, fireflies, w, [255, 240, 170]);
  },
  drag(s, w, dx, dy) {
    turn(s, dx, dy, 0.005);
    // The breeze goes the way the pointer does.
    const cam = s.rig.cam;
    w.wind[0] = clamp(w.wind[0] + Math.cos(cam.yaw) * dx * 0.0016, -0.4, 0.4);
    w.wind[2] = clamp(w.wind[2] + Math.sin(cam.yaw) * dx * 0.0016, -0.4, 0.4);
    w.wind[1] = clamp(w.wind[1] + dy * 0.0016, -0.4, 0.4);
  },
  release() {
    // The swarm drifts on with the breeze; the view itself stops.
  },
  gesture(s, w, g) {
    if (g.kind === "shake" && !s.still) w.egg = { name: "heart", at: s.time, until: s.time + 6 };
  },
  reset(w) {
    w.wind = [0, 0, 0];
  },
};

// ---------------------------------------------------------------------------
// Double helix: the notes as beads on two strands, in the order their links
// lead through them, so that linked notes sit close; the links are the rungs
// and chords across. It spins about its axis by itself. A drag across spins
// it and lets it coast, a drag up and down runs along it; choosing a note
// brings it to the front and the middle, and the helix loosens round it.
// Secret: flick it fast enough to spin it round a couple of times a second,
// and it unzips and copies itself before it zips up again.

interface HelixWorld {
  egg: Egg | null;
  key: string;
  order: number[];
  slot: Int32Array;
  spin: number;
  speed: number;
  scroll: number;
  chosen: number | null;
  aimSpin: number | null;
  aimScroll: number | null;
}
const TWIST = 0.55;
const SPEED = 0.45;
const helixShape = (count: number) => {
  const step = clamp(2.2 / Math.max(1, Math.ceil(count / 2)), 0.05, 0.16);
  return { step, length: step * Math.ceil(count / 2) };
};

const helix: Look<HelixWorld> = {
  rest: { yaw: 0, pitch: -0.12, zoom: 1, tx: 0, ty: 0, tz: 0 },
  init: () => ({ egg: null, key: "", order: [], slot: new Int32Array(0), spin: 0, speed: SPEED, scroll: 0, chosen: null, aimSpin: null, aimScroll: null }),
  core: (s, i) => 2 + Math.min(s.notes[i].links, 12) * 0.25,
  step(s, w) {
    if (w.key !== `${s.version}`) {
      w.key = `${s.version}`;
      w.order = helixOrder(s.near, s.shown, s.notes.map((n) => n.links));
      w.slot = new Int32Array(s.notes.length).fill(-1);
      w.order.forEach((i, k) => (w.slot[i] = k));
    }
    const count = w.order.length;
    const { step, length } = helixShape(count);
    if (s.selected !== w.chosen) {
      w.chosen = s.selected;
      const k = s.selected === null ? -1 : w.slot[s.selected];
      if (k >= 0) {
        const m = Math.floor(k / 2);
        w.aimScroll = helixAt(k, count, step, TWIST, 0, 1)[1];
        // To the front: the side nearest the camera is -z.
        const want = -Math.PI / 2 - m * TWIST - (k % 2) * Math.PI;
        w.aimSpin = w.spin + ((((want - w.spin) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        w.speed = 0;
      }
    }
    if (!s.still) {
      const k = 1 - Math.exp(-s.dt * 3);
      if (w.aimSpin !== null) {
        w.spin += (w.aimSpin - w.spin) * k;
        if (Math.abs(w.aimSpin - w.spin) < 1e-3) w.aimSpin = null;
      } else if (!s.grabbing) {
        // It coasts back to its own pace, unless it is held at the chosen note.
        const pace = s.selected !== null && s.shown[s.selected] ? 0 : SPEED;
        w.speed += (pace - w.speed) * (1 - Math.exp(-s.dt * 0.7));
        w.spin += w.speed * s.dt;
        if (Math.abs(w.speed) > 9 && !w.egg) w.egg = { name: "replication", at: s.time, until: s.time + 4.5 };
      }
      if (w.aimScroll !== null) {
        w.scroll += (w.aimScroll - w.scroll) * k;
        if (Math.abs(w.aimScroll - w.scroll) < 1e-4) w.aimScroll = null;
      }
    } else {
      if (w.aimSpin !== null) (w.spin = w.aimSpin), (w.aimSpin = null);
      if (w.aimScroll !== null) (w.scroll = w.aimScroll), (w.aimScroll = null);
    }
    w.scroll = clamp(w.scroll, -length / 2, length / 2);
    const open = w.egg ? Math.sin(clamp((s.time - w.egg.at) / (w.egg.until - w.egg.at), 0, 1) * Math.PI) : 0;
    const chosenM = s.selected !== null && w.slot[s.selected] >= 0 ? Math.floor(w.slot[s.selected] / 2) : null;
    for (let i = 0; i < s.notes.length; i++) {
      const k = w.slot[i];
      if (k < 0) {
        put(s, i, 0, 0, 0);
        continue;
      }
      const m = Math.floor(k / 2);
      const loose = chosenM === null ? 1 : 1 + 0.7 * Math.exp(-(((m - chosenM) / 2.2) ** 2));
      const [x, y, z] = helixAt(k, count, step, TWIST, w.spin, 0.36 * loose);
      put(s, i, x + (k % 2 ? 1 : -1) * open * 0.32, y - w.scroll, z);
    }
    if (w.egg && s.time > w.egg.until) w.egg = null;
  },
  draw(s, w) {
    const { g, w: W, h: H } = s;
    const lab = g.createRadialGradient(W * 0.5, H * 0.4, 0, W * 0.5, H * 0.5, Math.max(W, H) * 0.7);
    lab.addColorStop(0, "#0e2a33");
    lab.addColorStop(1, "#02080b");
    g.fillStyle = lab;
    g.fillRect(0, 0, W, H);
    for (const d of DUST) {
      const y = (((d.y * H - s.time * (4 + d.speed * 8) - w.scroll * 120) % H) + H) % H;
      g.fillStyle = `rgba(140,220,230,${(0.05 + d.size * 0.12).toFixed(3)})`;
      g.beginPath();
      g.arc(d.x * W, y, 0.6 + d.size * 1.4, 0, Math.PI * 2);
      g.fill();
    }
    const count = w.order.length;
    const { step } = helixShape(count);
    const open = w.egg ? Math.sin(clamp((s.time - w.egg.at) / (w.egg.until - w.egg.at), 0, 1) * Math.PI) : 0;
    const chosenM = s.selected !== null && w.slot[s.selected] >= 0 ? Math.floor(w.slot[s.selected] / 2) : null;
    // The two backbones, drawn finer than the beads on them; with the copy beside each while it replicates.
    const strand = (side: 0 | 1, shift: number, alpha: number) => {
      const colour: Rgb = side ? [255, 110, 200] : [90, 220, 255];
      const rungs = Math.ceil(count / 2);
      let prev: Projected | null = null;
      for (let u = -0.5; u <= rungs - 0.5; u += 0.2) {
        const loose = chosenM === null ? 1 : 1 + 0.7 * Math.exp(-(((u - chosenM) / 2.2) ** 2));
        const angle = u * TWIST + side * Math.PI + w.spin;
        const p = s.project(0.36 * loose * Math.cos(angle) + (side ? 1 : -1) * open * 0.32 + shift, (u - (rungs - 1) / 2) * step - w.scroll, 0.36 * loose * Math.sin(angle));
        if (prev) {
          g.strokeStyle = rgba(colour, alpha * clamp(0.9 - (p.depth + prev.depth) / 2, 0.15, 0.9));
          g.lineWidth = 2.6 * p.scale;
          g.beginPath();
          g.moveTo(prev.x, prev.y);
          g.lineTo(p.x, p.y);
          g.stroke();
        }
        prev = p;
      }
    };
    g.lineCap = "round";
    strand(0, 0, 0.8);
    strand(1, 0, 0.8);
    if (open > 0.05) {
      strand(1, -0.2, 0.35 * open);
      strand(0, 0.2, 0.35 * open);
    }
    for (const [a, b] of s.links) {
      if (!s.shown[a] || !s.shown[b]) continue;
      const by = litBy(s, a, b);
      const hot = by !== null;
      g.strokeStyle = hot ? rgba(mix(s.colours[by!], WHITE, 0.3), 0.9) : rgba([230, 240, 255], 0.22 * Math.min(s.dim[a], s.dim[b]) * clamp(0.9 - (s.pts[a].depth + s.pts[b].depth) / 2, 0.2, 1));
      g.lineWidth = hot ? 1.6 : 0.9;
      g.beginPath();
      g.moveTo(s.pts[a].x, s.pts[a].y);
      g.lineTo(s.pts[b].x, s.pts[b].y);
      g.stroke();
    }
    g.globalCompositeOperation = "lighter";
    const z = Math.sqrt(s.rig.cam.zoom);
    for (const i of backToFront(s)) {
      const p = s.pts[i];
      stamp(g, glow(s.colours[i], WHITE, 0.45), p.x, p.y, helix.core(s, i, w) * p.scale * z * 6, s.dim[i] * clamp(1 - p.depth / 2, 0.3, 1));
    }
    g.globalCompositeOperation = "source-over";
    marks(s, helix, w);
  },
  drag(s, w, dx, dy) {
    w.aimSpin = null;
    w.aimScroll = null;
    w.spin += dx * 0.01;
    w.speed = 0;
    w.scroll += dy * 0.004 / s.rig.cam.zoom;
  },
  release(s, w, vx) {
    w.speed = vx * 0.01;
    if (Math.abs(w.speed) > 9 && !s.still) w.egg = { name: "replication", at: s.time, until: s.time + 4.5 };
  },
  gesture() {
    // Its secret is set off by how fast it spins, in `release`.
  },
  reset(w) {
    w.scroll = 0;
    w.aimScroll = null;
    w.aimSpin = null;
  },
};

export const LOOKS: Record<SkyTheme, Look<any>> = { stellar, galaxy, brain, fireflies, helix };
