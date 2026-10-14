import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { api } from "../api";
import { DEFAULT_ORB, ORB_PERSONALITIES, hexToRgb, itemColor, type OrbHat, type OrbPattern, type OrbProp, type OrbState, type OrbStyle } from "../../../server/src/orb-style";

type Ctx = CanvasRenderingContext2D;

export interface VoiceLevels { input: number; output: number }

/** Sent with the new style when it is saved, so an open voice stage changes with it. */
export const ORB_STYLE_EVENT = "orb-style-changed";

/**
 * The avatar of the agent a chat talks to: the default until the server
 * answers, then whatever is saved. Asked again when an avatar is saved, since
 * it can be this one.
 */
export function useOrbStyle(session: string): OrbStyle {
  const [style, setStyle] = useState<OrbStyle>(DEFAULT_ORB);
  useEffect(() => {
    let live = true;
    const load = () => api.chatOrb(session).then((s) => { if (live) setStyle(s); }).catch(() => {});
    void load();
    window.addEventListener(ORB_STYLE_EVENT, load);
    return () => { live = false; window.removeEventListener(ORB_STYLE_EVENT, load); };
  }, [session]);
  return style;
}

type Rgb = [number, number, number];
const css = (c: Rgb, a = 1) => `rgba(${c.map(Math.round).join(",")},${a})`;
/** "r,g,b", for building an rgba() with its own alpha. */
const channels = (c: Rgb) => c.map(Math.round).join(",");
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** Toward white for k > 0, toward black for k < 0. */
const shade = (c: Rgb, k: number): Rgb => mix(c, k > 0 ? [255, 255, 255] : [0, 0, 0], Math.abs(k));
/** The portal's accent, for the small lights on what the orb wears. */
const ACCENT: Rgb = [34, 211, 238];

/**
 * A colour softened the way the UI softens its own: the hue kept, the
 * saturation held well below full and the lightness kept in a middle range,
 * so props stay colourful without shouting.
 */
function tame(c: Rgb): Rgb {
  const [r, g, b] = c.map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0, s = 0;
  let l = (max + min) / 2;
  if (d) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6;
  }
  s = Math.min(s, 0.62) * 0.78;
  l = Math.min(0.72, Math.max(0.22, l));
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const ch = (t: number) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [ch(h + 1 / 3) * 255, ch(h) * 255, ch(h - 1 / 3) * 255];
}

/**
 * A prop's material: its colour softened (see tame), lit from above.
 */
function material(ctx: Ctx, color: string, top: number, bottom: number): CanvasGradient {
  const base = tame(hexToRgb(color));
  const g = ctx.createLinearGradient(0, top, 0, bottom);
  g.addColorStop(0, css(shade(base, 0.28))); g.addColorStop(0.5, css(base)); g.addColorStop(1, css(shade(base, -0.45)));
  return g;
}

/** A small ball lit from the upper left. */
function ball(ctx: Ctx, x: number, y: number, radius: number, color: Rgb) {
  const g = ctx.createRadialGradient(x - radius * 0.35, y - radius * 0.4, radius * 0.1, x, y, radius);
  g.addColorStop(0, css(shade(color, 0.3))); g.addColorStop(0.55, css(color)); g.addColorStop(1, css(shade(color, -0.5)));
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
}

/** A rounded surface lit from the left, darker toward its right edge: cylinders and cones. */
function sideLit(ctx: Ctx, base: Rgb, left: number, right: number): CanvasGradient {
  const g = ctx.createLinearGradient(left, 0, right, 0);
  g.addColorStop(0, css(shade(base, 0.25))); g.addColorStop(0.45, css(base)); g.addColorStop(1, css(shade(base, -0.5)));
  return g;
}

/** A colour a step lighter (k > 0) or darker, for a second part of the same object. */
function mixHex(hex: string, k: number): string {
  const c = shade(hexToRgb(hex), k).map((v) => Math.round(v).toString(16).padStart(2, "0"));
  return `#${c.join("")}`;
}

/** A small five-pointed star. */
function star(ctx: Ctx, x: number, y: number, size: number, color: Rgb) {
  ctx.save(); ctx.translate(x, y); ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 5, d = i % 2 ? size * 0.45 : size;
    ctx.lineTo(Math.cos(a) * d, Math.sin(a) * d);
  }
  ctx.closePath(); ctx.fillStyle = css(color); ctx.shadowColor = css(color, 0.6); ctx.shadowBlur = 6; ctx.fill();
  ctx.restore();
}

interface Grain { dark: CanvasPattern; light: CanvasPattern }

/**
 * A matte grain for what the orb wears: specks and short fibres, one pattern
 * that darkens and one that lightens, so a surface reads as felt or matte
 * plastic rather than polished. Made once per orb, so it does not shimmer.
 */
function grain(ctx: Ctx): Grain {
  const make = (tone: string, specks: number, fibres: number, alpha: number) => {
    const tile = document.createElement("canvas");
    tile.width = tile.height = 192;
    const g = tile.getContext("2d")!;
    for (let i = 0; i < specks; i++) {
      g.fillStyle = `rgba(${tone},${Math.random() * alpha})`;
      const size = 1.2 + Math.random() * 1.8;
      g.fillRect(Math.random() * 192, Math.random() * 192, size, size);
    }
    g.lineCap = "round";
    for (let i = 0; i < fibres; i++) {
      const x = Math.random() * 192, y = Math.random() * 192, a = Math.random() * Math.PI, len = 4 + Math.random() * 9;
      g.strokeStyle = `rgba(${tone},${Math.random() * alpha * 0.6})`; g.lineWidth = 0.8;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); g.stroke();
    }
    return ctx.createPattern(tile, "repeat")!;
  };
  return { dark: make("0,0,0", 3200, 220, 0.55), light: make("255,255,255", 1800, 120, 0.4) };
}

/**
 * The plush orb's pile, drawn once and shared by every orb on the page: a very
 * fine, short, even nap, as on a minky toy, in light only so it never reads as
 * specks. Combed gently down and outward; softened by one blur over the whole.
 * Scaled with the orb each frame, so its only cost after the first is one image.
 */
let pileCache: HTMLCanvasElement | undefined;
function minkySprite(): HTMLCanvasElement {
  if (pileCache) return pileCache;
  const size = 640, c = size / 2, R = size / 2;
  const raw = document.createElement("canvas");
  raw.width = raw.height = size;
  const g = raw.getContext("2d")!;
  // Barely there: where the nap lies a little differently.
  for (let i = 0; i < 120; i++) {
    const d = Math.sqrt(Math.random()), a = Math.random() * Math.PI * 2, x = c + Math.cos(a) * d * R, y = c + Math.sin(a) * d * R, rad = 24 + Math.random() * 36;
    const patch = g.createRadialGradient(x, y, 0, x, y, rad);
    patch.addColorStop(0, "rgba(255,255,255,0.035)"); patch.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = patch; g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  const strands = [new Path2D(), new Path2D(), new Path2D()];
  for (let i = 0; i < 36000; i++) {
    const d = Math.sqrt(Math.random()), a = Math.random() * Math.PI * 2;
    const u = Math.cos(a) * d, v = Math.sin(a) * d;
    let dx = u * 0.5 + (Math.random() - 0.5) * 0.6, dy = v * 0.5 + 0.6 + (Math.random() - 0.5) * 0.6;
    const n = Math.hypot(dx, dy) || 1; dx /= n; dy /= n;
    const len = 2 + Math.random() * 2.5, x = c + u * R, y = c + v * R;
    const path = strands[i % 3];
    path.moveTo(x, y); path.lineTo(x + dx * len, y + dy * len);
  }
  g.lineCap = "round"; g.lineWidth = 1;
  strands.forEach((path, i) => { g.strokeStyle = `rgba(255,255,255,${0.07 + i * 0.04})`; g.stroke(path); });
  const soft = document.createElement("canvas");
  soft.width = soft.height = size;
  const sg = soft.getContext("2d")!;
  sg.filter = "blur(0.9px)"; sg.drawImage(raw, 0, 0);
  return (pileCache = soft);
}

/** A point of light for the starry pattern: where in the sphere (a unit disc), its size, its twinkle, and which layer it is in. */
interface Sparkle { x: number; y: number; size: number; phase: number; back: boolean }

/**
 * What moves inside the sphere, one of its two layers: the back one dimmer and
 * moving less as the face turns, the front one more, so the inside reads as a
 * volume rather than a surface. Patterns that wrap the sphere (bands, spots,
 * globe) are on its surface, and a solid ball hides its far side: they have
 * only the half that faces you.
 */
function drawPattern(ctx: Ctx, kind: OrbPattern, back: boolean, r: number, t: number, level: number, color: Rgb, turn: Turn, sparkles: readonly Sparkle[]) {
  if (kind === "none" || (back && (kind === "bands" || kind === "spots" || kind === "globe"))) return;
  const depth = back ? 0.55 : 1;
  const rgb = channels(color);
  const lighter = channels(shade(color, 0.5)), darker = channels(shade(color, -0.45));
  ctx.save();
  ctx.translate(Math.sin(turn.yaw) * r * (back ? 0.06 : 0.28), Math.sin(turn.pitch) * r * (back ? 0.04 : 0.18));
  // Latitude circles seen from a little above: the far half is the upper arc, the near half the lower.
  const latitude = (y: number, width: number, style: string) => {
    const half = Math.sqrt(Math.max(0, r * r - y * y)) * 1.04;
    ctx.beginPath(); ctx.ellipse(0, y, half, half * 0.16, 0, back ? Math.PI : 0, back ? Math.PI * 2 : Math.PI);
    ctx.lineWidth = width; ctx.strokeStyle = style; ctx.stroke();
  };
  switch (kind) {
    case "ribbons":
      // Translucent ribbons bend across the sphere rather than flat sine bars.
      for (let band = back ? 0 : 1; band < 15; band += 2) {
        const y = -r + band * r * 0.15;
        const bend = Math.sin(t + band * 0.27) * 35 + level * 22;
        ctx.beginPath(); ctx.moveTo(-r * 1.3, y);
        ctx.bezierCurveTo(-r * 0.45, y - 60 + bend, r * 0.35, y + 65 + bend, r * 1.3, y - 20);
        ctx.bezierCurveTo(r * 0.3, y + 85 + bend, -r * 0.4, y - 40 + bend, -r * 1.3, y + 9);
        const ribbon = ctx.createLinearGradient(-r, -r, r, r);
        ribbon.addColorStop(0, `rgba(231,255,255,${(0.04 + band * 0.003) * depth})`);
        ribbon.addColorStop(0.45, `rgba(${rgb},${(0.24 + level * 0.12) * depth})`);
        ribbon.addColorStop(1, "rgba(192,190,255,0.03)");
        ctx.fillStyle = ribbon; ctx.fill();
      }
      break;
    case "bands":
      // A gas giant's belts, drifting and thickening with the voice.
      for (let i = -4; i <= 4; i++) {
        const y = i * r * 0.21 + Math.sin(t * 0.6 + i) * r * 0.03 * (1 + level);
        latitude(y, r * (0.07 + level * 0.03), `rgba(${i % 2 ? lighter : darker},${0.3 * depth})`);
      }
      break;
    case "spots": {
      // Spots on a ball that rolls round as it looks about.
      const spin = t * 0.35 + turn.yaw * 0.6;
      for (const [row, lat] of [-0.95, -0.48, 0, 0.48, 0.95].entries()) {
        for (let k = 0; k < 7; k++) {
          const lon = spin + k * Math.PI * 2 / 7 + (row % 2) * 0.45;
          const X = Math.cos(lat) * Math.sin(lon), Y = Math.sin(lat), Z = Math.cos(lat) * Math.cos(lon);
          if ((Z < 0) !== back) continue;
          const size = r * 0.09 * (1 + level * 0.3);
          ctx.beginPath();
          ctx.ellipse(X * r, Y * r, size * Math.sqrt(Math.max(0.05, 1 - X * X)), size * Math.sqrt(Math.max(0.05, 1 - Y * Y)), 0, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${lighter},${(back ? 0.18 : 0.42) * (0.5 + 0.5 * Math.abs(Z))})`; ctx.fill();
        }
      }
      break;
    }
    case "swirl":
      // Three arms winding out from the middle; the back ones turn the other way.
      ctx.lineCap = "round";
      for (let arm = 0; arm < 3; arm++) {
        ctx.beginPath();
        for (let i = 0; i <= 40; i++) {
          const f = i / 40, a = arm * Math.PI * 2 / 3 + f * 3.4 + t * 0.5 * (back ? -0.6 : 1);
          const x = Math.cos(a) * f * r * 1.05, y = Math.sin(a) * f * r * 0.95;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.lineWidth = r * (0.06 + level * 0.04) * (back ? 0.7 : 1);
        ctx.strokeStyle = `rgba(${lighter},${0.28 * depth})`; ctx.stroke();
      }
      break;
    case "stars":
      // Points of light twinkling inside: small and faint at the back, larger in front.
      for (const sp of sparkles) {
        if (sp.back !== back) continue;
        const tw = 0.5 + 0.5 * Math.sin(t * 4 + sp.phase);
        const size = r * (back ? 0.014 : 0.026) * (0.6 + sp.size) * (0.7 + 0.6 * tw) * (1 + level * 0.5);
        const x = sp.x * r * 0.95, y = sp.y * r * 0.95;
        ctx.fillStyle = `rgba(${lighter},${(0.35 + 0.55 * tw) * depth})`;
        ctx.shadowColor = `rgba(${lighter},0.8)`; ctx.shadowBlur = size * 2;
        ctx.beginPath();
        for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4, d = i % 2 ? size * 0.3 : size; ctx.lineTo(x + Math.cos(a) * d, y + Math.sin(a) * d); }
        ctx.closePath(); ctx.fill();
      }
      ctx.shadowBlur = 0;
      break;
    case "globe": {
      // A wireframe of latitude and longitude, turning as it looks about.
      const spin = t * 0.25 + turn.yaw * 0.6;
      for (let i = -2; i <= 2; i++) latitude(i * r * 0.38, r * 0.012, `rgba(${lighter},${0.45 * depth})`);
      for (let k = 0; k < 6; k++) {
        const lon = spin + k * Math.PI / 6;
        if ((Math.cos(lon) < 0) !== back) continue;
        ctx.beginPath(); ctx.ellipse(0, 0, r * Math.abs(Math.sin(lon)), r, 0, 0, Math.PI * 2);
        ctx.lineWidth = r * 0.012; ctx.strokeStyle = `rgba(${lighter},${0.45 * depth})`; ctx.stroke();
      }
      break;
    }
  }
  ctx.restore();
}

/** Lifts a prop off the orb with a soft shadow below it. */
function lift(ctx: Ctx, r: number) { ctx.shadowColor = "rgba(0,0,0,0.45)"; ctx.shadowBlur = r * 0.08; ctx.shadowOffsetY = r * 0.03; }
function unlift(ctx: Ctx) { ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0; }

/** How far the face is into listening (`wide`) and into speaking (`talk`), each 0 to 1, eased from one state to the next. */
interface Mood { wide: number; talk: number }

/** Where the eyes sit and how big they are: widened and raised when listening, stretched by the voice when speaking. */
function faceOf(r: number, mood: Mood, level: number) {
  return {
    ex: r * 0.36,
    ey: -r * 0.06 - mood.wide * r * 0.04 - mood.talk * level * r * 0.06,
    es: r * 0.22 * (1 + 0.18 * mood.wide),
    stretch: 1 + mood.talk * level * 0.32 + mood.wide * 0.08,
  };
}

/** Which way the face is turned, in radians: yaw to the side, pitch up or down. */
interface Turn { yaw: number; pitch: number }

/**
 * Where one eye lands on the sphere once the face turns: its centre, and how
 * much it narrows as it moves round toward the edge.
 */
function eyePlace(r: number, ex: number, ey: number, side: number, turn: Turn) {
  const rest = Math.asin(Math.min(0.95, ex / r));
  const a = side * rest + turn.yaw;
  return { x: Math.sin(a) * r, y: ey + Math.sin(turn.pitch) * r * 0.6, fx: Math.max(0.3, Math.cos(a) / Math.cos(rest)) };
}

/** A soft shadow under a shape, so it sits in the orb's surface rather than on it. */
function recess(ctx: Ctx, path: () => void, size: number) {
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.3)"; ctx.shadowColor = "rgba(0,0,0,0.55)"; ctx.shadowBlur = size * 0.35; ctx.shadowOffsetY = size * 0.12;
  path(); ctx.fill();
  ctx.restore();
}

/** Light catching the top of a domed shape. */
function dome(ctx: Ctx, path: () => void, size: number) {
  ctx.save();
  path(); ctx.clip();
  const g = ctx.createRadialGradient(-size * 0.35, -size * 0.5, 0, -size * 0.35, -size * 0.5, size * 0.95);
  g.addColorStop(0, "rgba(255,255,255,0.34)"); g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g; ctx.fillRect(-size * 2, -size * 2, size * 4, size * 4);
  ctx.restore();
}

/**
 * Eyes on the face of the orb, in the orb's own units: centred on it, `r` its
 * radius. `open` is 0 shut to 1 open (blinks, muted); `gx`/`gy` are where they
 * look, -1 to 1, and `turn` is how far the face has turned to look there.
 * Cartoon proportions on purpose: big, and moving with the voice.
 */
function drawEyes(ctx: Ctx, look: OrbStyle, r: number, mood: Mood, level: number, open: number, gx: number, gy: number, turn: Turn) {
  const { ex, ey, es, stretch } = faceOf(r, mood, level);
  const color = look.eyeColor;
  // The pupils and glints are white; dark eyes get a faint light rim to stand
  // off the orb instead of a glow of their own colour.
  const [cr, cg, cb] = hexToRgb(color);
  const dark = cr * 0.299 + cg * 0.587 + cb * 0.114 < 110;
  const rim = dark ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.2)";
  const pupil = "#ffffff";
  // The head has turned part of the way; the eyes look the rest.
  const lx = gx * 0.6, ly = gy * 0.6;
  ctx.save();
  ctx.lineCap = "round";
  if (look.eyes === "visor") {
    ctx.translate(Math.sin(turn.yaw) * r * 0.75, ey + Math.sin(turn.pitch) * r * 0.6);
    ctx.scale(Math.cos(turn.yaw), 1);
    const band = () => { ctx.beginPath(); ctx.roundRect(-r * 0.62, -es * 0.7, r * 1.24, es * 1.4, es * 0.7); };
    recess(ctx, band, es);
    ctx.fillStyle = color; band(); ctx.fill();
    ctx.strokeStyle = rim; ctx.lineWidth = es * 0.06; band(); ctx.stroke();
    ctx.shadowColor = pupil; ctx.shadowBlur = 14; ctx.fillStyle = pupil;
    for (const side of [-1, 1]) {
      const h = Math.max(1, es * 0.42 * open * stretch);
      ctx.beginPath(); ctx.roundRect(side * ex - es * 0.55 + lx * es * 0.4, -h / 2, es * 1.1, h, h / 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    dome(ctx, band, es);
    ctx.restore();
    return;
  }
  for (const side of [-1, 1]) {
    const place = eyePlace(r, ex, ey, side, turn);
    ctx.save();
    ctx.translate(place.x, place.y); ctx.scale(place.fx, 1);
    ctx.fillStyle = color; ctx.strokeStyle = color;
    const line = (draw: () => void, width: number) => {
      ctx.save(); ctx.lineWidth = width;
      ctx.shadowColor = "rgba(0,0,0,0.5)"; ctx.shadowBlur = es * 0.25; ctx.shadowOffsetY = es * 0.1;
      draw(); ctx.stroke(); ctx.restore();
    };
    if (look.eyes === "happy") {
      line(() => { ctx.beginPath(); ctx.arc(0, es * 0.45, es * 0.72 * stretch, Math.PI * 1.13, Math.PI * 1.87); }, es * 0.36);
    } else if (open < 0.15) {
      // Shut: a thick soft curve where the eye was.
      line(() => { ctx.beginPath(); ctx.arc(0, -es * 0.3, es * 0.7, Math.PI * 0.2, Math.PI * 0.8); }, es * 0.26);
    } else if (look.eyes === "dots") {
      const x = lx * es * 0.4, y = ly * es * 0.4;
      const eye = () => { ctx.beginPath(); ctx.ellipse(x, y, es * 0.58, es * 0.78 * open * stretch, 0, 0, Math.PI * 2); };
      recess(ctx, eye, es); eye(); ctx.fill();
      ctx.strokeStyle = rim; ctx.lineWidth = es * 0.06; eye(); ctx.stroke();
      dome(ctx, eye, es * 0.8);
      ctx.fillStyle = pupil;
      ctx.beginPath(); ctx.ellipse(x - es * 0.17, y - es * 0.26 * open, es * 0.2, es * 0.2 * open, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x + es * 0.18, y + es * 0.22 * open, es * 0.07, 0, Math.PI * 2); ctx.fill();
    } else if (look.eyes === "round") {
      const eye = () => { ctx.beginPath(); ctx.ellipse(0, 0, es * 0.92, es * 1.12 * open * stretch, 0, 0, Math.PI * 2); };
      recess(ctx, eye, es); eye(); ctx.fill();
      ctx.save(); eye(); ctx.clip();
      ctx.fillStyle = pupil;
      ctx.beginPath(); ctx.arc(lx * es * 0.38, ly * es * 0.38 - es * 0.08, es * 0.44, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(-lx * es * 0.1 + es * 0.42, es * 0.5, es * 0.12, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.strokeStyle = rim; ctx.lineWidth = es * 0.06; eye(); ctx.stroke();
      dome(ctx, eye, es);
    } else if (look.eyes === "sleepy") {
      const x = lx * es * 0.25;
      const lid = () => { ctx.beginPath(); ctx.ellipse(x, es * 0.25, es * 0.7, es * 0.42 * open * stretch, 0, 0, Math.PI); ctx.closePath(); };
      recess(ctx, lid, es); lid(); ctx.fill();
      dome(ctx, lid, es * 0.7);
      line(() => { ctx.beginPath(); ctx.moveTo(-es * 0.85, es * 0.16); ctx.quadraticCurveTo(0, es * 0.02, es * 0.85, es * 0.16); }, es * 0.22);
      ctx.fillStyle = pupil;
      ctx.beginPath(); ctx.arc(x - es * 0.15, es * 0.36, es * 0.12 * open, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  ctx.restore();
}

/**
 * Something the orb wears, in the same units as the eyes, drawn as a lit
 * object in the UI's own colours: neutral surfaces, with the accent only in
 * small lights.
 */
function drawWorn(ctx: Ctx, kind: OrbHat | OrbProp, color: string, r: number, t: number, level: number, mood: Mood, turn: Turn, texture: Grain) {
  const base = tame(hexToRgb(color));
  ctx.save();
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  // What sits on top rides round with the turn a little, less than the face
  // does; what is on the face places itself with the eyes.
  if (!["headphones", "glasses", "mustache", "monocle"].includes(kind)) ctx.translate(Math.sin(turn.yaw) * r * 0.3, Math.sin(turn.pitch) * r * 0.12);
  switch (kind) {
    case "headphones": {
      const shift = Math.sin(turn.yaw) * r * 0.08;
      lift(ctx, r);
      ctx.strokeStyle = material(ctx, color, -r * 1.2, -r * 0.4); ctx.lineWidth = r * 0.11;
      ctx.beginPath(); ctx.arc(shift, 0, r * 1.1, Math.PI * 1.12, Math.PI * 1.88); ctx.stroke();
      unlift(ctx);
      for (const side of [-1, 1]) {
        // The cup the face turns away from comes forward and grows; the other goes round behind.
        const near = Math.min(1.3, Math.max(0.45, 1 - side * Math.sin(turn.yaw) * 1.1));
        const w = r * 0.24 * near, h = r * 0.54 * (0.85 + near * 0.15);
        const x = side * r * 1.06 * Math.cos(turn.yaw * 0.5) + shift - w / 2, y = -h / 2;
        lift(ctx, r);
        ctx.fillStyle = material(ctx, color, y, y + h);
        ctx.beginPath(); ctx.roundRect(x, y, w, h, r * 0.1); ctx.fill();
        unlift(ctx);
        ctx.fillStyle = css(shade(base, -0.65));
        ctx.beginPath(); ctx.roundRect(x + (side < 0 ? w * 0.55 : 0), y + h * 0.12, w * 0.45, h * 0.76, r * 0.05); ctx.fill();
        ctx.fillStyle = css(ACCENT, 0.5 + level * 0.5); ctx.shadowColor = css(ACCENT, 0.8); ctx.shadowBlur = 6;
        ctx.beginPath(); ctx.arc(x + w * (side < 0 ? 0.28 : 0.72), y + h * 0.82, r * 0.02, 0, Math.PI * 2); ctx.fill();
        unlift(ctx);
      }
      break;
    }
    case "antenna": {
      const sway = Math.sin(t * 1.7) * r * 0.06;
      lift(ctx, r);
      ctx.strokeStyle = material(ctx, color, -r * 1.45, -r * 0.95); ctx.lineWidth = r * 0.04;
      ctx.beginPath(); ctx.moveTo(0, -r * 0.96); ctx.quadraticCurveTo(sway * 0.4, -r * 1.2, sway, -r * 1.42); ctx.stroke();
      ctx.fillStyle = material(ctx, color, -r * 1.02, -r * 0.92);
      ctx.beginPath(); ctx.ellipse(0, -r * 0.97, r * 0.09, r * 0.04, 0, 0, Math.PI * 2); ctx.fill();
      unlift(ctx);
      ball(ctx, sway, -r * 1.45, r * 0.085, base);
      ctx.fillStyle = css(ACCENT, 0.35 + level * 0.6); ctx.shadowColor = css(ACCENT, 0.9); ctx.shadowBlur = 8 + level * 16;
      ctx.beginPath(); ctx.arc(sway, -r * 1.45, r * 0.035, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case "crown": {
      const y = -r * 0.84;
      const tips: [number, number][] = [[-r * 0.44, y - r * 0.34], [0, y - r * 0.44], [r * 0.44, y - r * 0.34]];
      lift(ctx, r);
      ctx.fillStyle = material(ctx, color, y - r * 0.44, y + r * 0.04);
      ctx.beginPath(); ctx.moveTo(-r * 0.44, y); ctx.lineTo(...tips[0]); ctx.lineTo(-r * 0.22, y - r * 0.15); ctx.lineTo(...tips[1]);
      ctx.lineTo(r * 0.22, y - r * 0.15); ctx.lineTo(...tips[2]); ctx.lineTo(r * 0.44, y); ctx.closePath(); ctx.fill();
      unlift(ctx);
      ctx.strokeStyle = "rgba(0,0,0,0.25)"; ctx.lineWidth = r * 0.015; ctx.stroke();
      ctx.fillStyle = css(shade(base, -0.35));
      ctx.beginPath(); ctx.roundRect(-r * 0.46, y - r * 0.05, r * 0.92, r * 0.09, r * 0.03); ctx.fill();
      for (const [x, ty] of tips) ball(ctx, x, ty, r * 0.045, tame(ACCENT));
      break;
    }
    case "halo": {
      const bob = Math.sin(t * 1.4) * r * 0.04;
      const y = -r * 1.22 + bob;
      ctx.shadowColor = css(shade(base, 0.4), 0.6); ctx.shadowBlur = 16;
      ctx.strokeStyle = css(shade(base, -0.4)); ctx.lineWidth = r * 0.075;
      ctx.beginPath(); ctx.ellipse(0, y + r * 0.012, r * 0.55, r * 0.13, 0, 0, Math.PI * 2); ctx.stroke();
      unlift(ctx);
      ctx.strokeStyle = css(shade(base, 0.35)); ctx.lineWidth = r * 0.04;
      ctx.beginPath(); ctx.ellipse(0, y - r * 0.008, r * 0.55, r * 0.13, 0, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
      break;
    }
    case "party": {
      ctx.translate(r * 0.3, -r * 0.86); ctx.rotate(0.35 + Math.sin(t * 1.5) * 0.04);
      lift(ctx, r);
      const cone = ctx.createLinearGradient(-r * 0.3, 0, r * 0.3, 0);
      cone.addColorStop(0, css(shade(base, 0.25))); cone.addColorStop(0.45, css(base)); cone.addColorStop(1, css(shade(base, -0.6)));
      ctx.fillStyle = cone;
      ctx.beginPath(); ctx.moveTo(-r * 0.3, 0); ctx.lineTo(0, -r * 0.74); ctx.lineTo(r * 0.3, 0); ctx.closePath(); ctx.fill();
      unlift(ctx);
      ctx.save(); ctx.clip();
      ctx.strokeStyle = css(tame(ACCENT), 0.55); ctx.lineWidth = r * 0.05;
      for (let i = 1; i <= 3; i++) { ctx.beginPath(); ctx.moveTo(-r * 0.35, -r * 0.18 * i); ctx.lineTo(r * 0.35, -r * 0.18 * i - r * 0.09); ctx.stroke(); }
      ctx.restore();
      ctx.fillStyle = css(shade(base, -0.4));
      ctx.beginPath(); ctx.ellipse(0, 0, r * 0.3, r * 0.05, 0, 0, Math.PI); ctx.fill();
      ball(ctx, 0, -r * 0.77, r * 0.08, shade(base, 0.3));
      break;
    }
    case "glasses": {
      const { ex, ey, es } = faceOf(r, mood, level);
      const h = es * 2;
      const lenses = [-1, 1].map((side) => { const p = eyePlace(r, ex, ey, side, turn); return { ...p, w: es * 2.4 * p.fx }; });
      const [left, right] = lenses;
      lift(ctx, r);
      ctx.strokeStyle = material(ctx, color, left.y - h / 2, left.y + h / 2); ctx.lineWidth = r * 0.045;
      for (const l of lenses) { ctx.beginPath(); ctx.roundRect(l.x - l.w / 2, l.y - h / 2, l.w, h, r * 0.09 * l.fx); ctx.stroke(); }
      ctx.beginPath(); ctx.moveTo(left.x + left.w / 2, left.y - h * 0.12); ctx.quadraticCurveTo((left.x + right.x) / 2, left.y - h * 0.35, right.x - right.w / 2, right.y - h * 0.12); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(left.x - left.w / 2, left.y - h * 0.2); ctx.lineTo(-r * 0.95 * Math.cos(turn.yaw) + Math.sin(turn.yaw) * r * 0.2, left.y - h * 0.32);
      ctx.moveTo(right.x + right.w / 2, right.y - h * 0.2); ctx.lineTo(r * 0.95 * Math.cos(turn.yaw) + Math.sin(turn.yaw) * r * 0.2, right.y - h * 0.32);
      ctx.stroke();
      unlift(ctx);
      for (const l of lenses) {
        const lens = ctx.createLinearGradient(l.x - l.w / 2, l.y - h / 2, l.x + l.w / 2, l.y + h / 2);
        lens.addColorStop(0, "rgba(255,255,255,0.1)"); lens.addColorStop(1, "rgba(255,255,255,0.06)");
        ctx.fillStyle = lens; ctx.beginPath(); ctx.roundRect(l.x - l.w / 2, l.y - h / 2, l.w, h, r * 0.09 * l.fx); ctx.fill();
      }
      break;
    }
    case "bow": {
      ctx.translate(r * 0.55, -r * 0.8); ctx.rotate(0.5);
      lift(ctx, r);
      for (const side of [-1, 1]) {
        const lobe = ctx.createRadialGradient(side * r * 0.14, -r * 0.08, r * 0.02, side * r * 0.18, 0, r * 0.3);
        lobe.addColorStop(0, css(shade(base, 0.28))); lobe.addColorStop(0.5, css(base)); lobe.addColorStop(1, css(shade(base, -0.55)));
        ctx.fillStyle = lobe;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(side * r * 0.28, -r * 0.3, side * r * 0.37, 0); ctx.quadraticCurveTo(side * r * 0.28, r * 0.3, 0, 0); ctx.fill();
      }
      unlift(ctx);
      ball(ctx, 0, 0, r * 0.085, shade(base, -0.1));
      break;
    }
    case "tophat": {
      ctx.rotate(-0.1);
      const brim = -r * 0.9, w = r * 0.68, top = -r * 1.58;
      const cylinder = () => { ctx.beginPath(); ctx.moveTo(-w / 2, brim); ctx.lineTo(-w * 0.47, top); ctx.lineTo(w * 0.47, top); ctx.lineTo(w / 2, brim); ctx.ellipse(0, brim, w / 2, r * 0.07, 0, 0, Math.PI); ctx.closePath(); };
      lift(ctx, r);
      ctx.fillStyle = material(ctx, color, brim - r * 0.12, brim + r * 0.12);
      ctx.beginPath(); ctx.ellipse(0, brim, r * 0.64, r * 0.13, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = sideLit(ctx, base, -w / 2, w / 2); cylinder(); ctx.fill();
      unlift(ctx);
      ctx.save(); cylinder(); ctx.clip();
      ctx.fillStyle = css(tame(ACCENT), 0.85); ctx.fillRect(-w, brim - r * 0.22, w * 2, r * 0.12);
      ctx.restore();
      ctx.fillStyle = css(shade(base, 0.2)); ctx.beginPath(); ctx.ellipse(0, top, w * 0.47, r * 0.07, 0, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case "beanie": {
      const cuff = -r * 0.7;
      lift(ctx, r);
      ctx.fillStyle = material(ctx, color, -r * 1.3, cuff);
      ctx.beginPath(); ctx.ellipse(0, cuff + r * 0.06, r * 0.92, r * 0.6, 0, Math.PI, Math.PI * 2); ctx.closePath(); ctx.fill();
      unlift(ctx);
      ctx.strokeStyle = "rgba(0,0,0,0.14)"; ctx.lineWidth = r * 0.025;
      for (let i = -3; i <= 3; i++) { ctx.beginPath(); ctx.moveTo(i * r * 0.22, cuff); ctx.quadraticCurveTo(i * r * 0.12, -r * 1.0, i * r * 0.04, -r * 1.24); ctx.stroke(); }
      lift(ctx, r);
      ctx.fillStyle = material(ctx, mixHex(color, -0.15), cuff - r * 0.06, cuff + r * 0.2);
      ctx.beginPath(); ctx.roundRect(-r * 0.97, cuff - r * 0.06, r * 1.94, r * 0.25, r * 0.11); ctx.fill();
      unlift(ctx);
      ctx.strokeStyle = "rgba(0,0,0,0.16)"; ctx.lineWidth = r * 0.018;
      for (let x = -r * 0.88; x <= r * 0.88; x += r * 0.09) { ctx.beginPath(); ctx.moveTo(x, cuff - r * 0.02); ctx.lineTo(x, cuff + r * 0.15); ctx.stroke(); }
      ball(ctx, 0, -r * 1.3, r * 0.15, shade(base, 0.15));
      break;
    }
    case "cap": {
      const rim = -r * 0.66;
      lift(ctx, r);
      ctx.fillStyle = material(ctx, color, -r * 1.2, rim);
      ctx.beginPath(); ctx.ellipse(0, rim, r * 0.86, r * 0.52, 0, Math.PI, Math.PI * 2); ctx.closePath(); ctx.fill();
      unlift(ctx);
      ctx.strokeStyle = "rgba(0,0,0,0.18)"; ctx.lineWidth = r * 0.02;
      for (const x of [-0.42, 0, 0.42]) { ctx.beginPath(); ctx.moveTo(x * r * 1.6, rim); ctx.quadraticCurveTo(x * r * 0.9, -r * 1.0, 0, -r * 1.18); ctx.stroke(); }
      lift(ctx, r);
      ctx.fillStyle = material(ctx, mixHex(color, -0.2), rim - r * 0.1, rim + r * 0.1);
      ctx.beginPath(); ctx.ellipse(r * 0.62, rim + r * 0.02, r * 0.55, r * 0.11, -0.06, 0, Math.PI * 2); ctx.fill();
      unlift(ctx);
      ball(ctx, 0, -r * 1.18, r * 0.06, shade(base, -0.1));
      break;
    }
    case "wizard": {
      ctx.translate(0, -r * 0.86); ctx.rotate(-0.12 + Math.sin(t * 1.2) * 0.03);
      lift(ctx, r);
      ctx.fillStyle = material(ctx, color, -r * 0.12, r * 0.12);
      ctx.beginPath(); ctx.ellipse(0, 0, r * 0.78, r * 0.14, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = sideLit(ctx, base, -r * 0.42, r * 0.42);
      ctx.beginPath(); ctx.moveTo(-r * 0.42, -r * 0.02);
      ctx.quadraticCurveTo(-r * 0.12, -r * 0.6, r * 0.32, -r * 1.02);
      ctx.quadraticCurveTo(r * 0.18, -r * 0.55, r * 0.42, -r * 0.02);
      ctx.ellipse(0, -r * 0.02, r * 0.42, r * 0.08, 0, 0, Math.PI); ctx.closePath(); ctx.fill();
      unlift(ctx);
      for (const [x, y, size] of [[-r * 0.12, -r * 0.25, r * 0.07], [r * 0.12, -r * 0.5, r * 0.05], [r * 0.2, -r * 0.18, r * 0.04]]) star(ctx, x, y, size, tame(ACCENT));
      break;
    }
    case "cowboy": {
      const y = -r * 0.86;
      lift(ctx, r);
      ctx.fillStyle = sideLit(ctx, base, -r * 0.42, r * 0.42);
      ctx.beginPath(); ctx.moveTo(-r * 0.44, y); ctx.lineTo(-r * 0.38, y - r * 0.46);
      ctx.quadraticCurveTo(-r * 0.15, y - r * 0.56, 0, y - r * 0.42); ctx.quadraticCurveTo(r * 0.15, y - r * 0.56, r * 0.38, y - r * 0.46);
      ctx.lineTo(r * 0.44, y); ctx.closePath(); ctx.fill();
      unlift(ctx);
      ctx.fillStyle = css(tame(ACCENT), 0.8); ctx.fillRect(-r * 0.43, y - r * 0.12, r * 0.86, r * 0.08);
      lift(ctx, r);
      ctx.fillStyle = material(ctx, color, y - r * 0.18, y + r * 0.12);
      ctx.beginPath(); ctx.moveTo(-r * 1.02, y - r * 0.14);
      ctx.quadraticCurveTo(-r * 0.8, y + r * 0.08, 0, y + r * 0.1); ctx.quadraticCurveTo(r * 0.8, y + r * 0.08, r * 1.02, y - r * 0.14);
      ctx.quadraticCurveTo(r * 0.75, y - r * 0.02, 0, y - r * 0.04); ctx.quadraticCurveTo(-r * 0.75, y - r * 0.02, -r * 1.02, y - r * 0.14);
      ctx.closePath(); ctx.fill();
      unlift(ctx);
      break;
    }
    case "catears": {
      for (const side of [-1, 1]) {
        const a = side * 0.62;
        ctx.save(); ctx.translate(Math.sin(a) * r * 0.9, -Math.cos(a) * r * 0.9); ctx.rotate(a + Math.sin(t * 2 + side) * 0.04);
        lift(ctx, r);
        ctx.fillStyle = material(ctx, color, -r * 0.4, 0);
        ctx.beginPath(); ctx.moveTo(-r * 0.22, r * 0.04); ctx.quadraticCurveTo(-r * 0.1, -r * 0.3, 0, -r * 0.42); ctx.quadraticCurveTo(r * 0.1, -r * 0.3, r * 0.22, r * 0.04); ctx.closePath(); ctx.fill();
        unlift(ctx);
        ctx.fillStyle = css(tame([236, 160, 180]));
        ctx.beginPath(); ctx.moveTo(-r * 0.11, 0); ctx.quadraticCurveTo(-r * 0.05, -r * 0.18, 0, -r * 0.27); ctx.quadraticCurveTo(r * 0.05, -r * 0.18, r * 0.11, 0); ctx.closePath(); ctx.fill();
        ctx.restore();
      }
      break;
    }
    case "sprout": {
      const sway = Math.sin(t * 1.6) * r * 0.05;
      lift(ctx, r);
      ctx.strokeStyle = material(ctx, color, -r * 1.35, -r * 0.95); ctx.lineWidth = r * 0.035;
      ctx.beginPath(); ctx.moveTo(0, -r * 0.96); ctx.quadraticCurveTo(sway * 0.3, -r * 1.18, sway, -r * 1.36); ctx.stroke();
      for (const side of [-1, 1]) {
        ctx.save(); ctx.translate(sway, -r * 1.36); ctx.rotate(side * 0.8);
        ctx.fillStyle = material(ctx, color, -r * 0.4, 0);
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(-r * 0.18, -r * 0.22, 0, -r * 0.42); ctx.quadraticCurveTo(r * 0.18, -r * 0.22, 0, 0); ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.22)"; ctx.lineWidth = r * 0.012;
        ctx.beginPath(); ctx.moveTo(0, -r * 0.03); ctx.lineTo(0, -r * 0.36); ctx.stroke();
        ctx.restore();
      }
      unlift(ctx);
      break;
    }
    case "flower": {
      ctx.translate(r * 0.64, -r * 0.74); ctx.rotate(t * 0.2);
      lift(ctx, r);
      for (let i = 0; i < 5; i++) {
        const a = i / 5 * Math.PI * 2;
        const x = Math.cos(a) * r * 0.15, y = Math.sin(a) * r * 0.15;
        const petal = ctx.createRadialGradient(x - r * 0.04, y - r * 0.04, r * 0.01, x, y, r * 0.15);
        petal.addColorStop(0, css(shade(base, 0.3))); petal.addColorStop(1, css(shade(base, -0.3)));
        ctx.fillStyle = petal; ctx.beginPath(); ctx.ellipse(x, y, r * 0.14, r * 0.1, a, 0, Math.PI * 2); ctx.fill();
      }
      unlift(ctx);
      ball(ctx, 0, 0, r * 0.09, tame([251, 191, 36]));
      break;
    }
    case "mustache": {
      const { ey, es } = faceOf(r, mood, level);
      ctx.translate(Math.sin(turn.yaw) * r, ey + es * 1.55 + Math.sin(turn.pitch) * r * 0.6);
      ctx.scale(Math.cos(turn.yaw), 1);
      const wiggle = mood.talk * level * 0.15;
      lift(ctx, r);
      ctx.fillStyle = material(ctx, color, -r * 0.08, r * 0.1);
      for (const s of [-1, 1]) {
        ctx.save(); ctx.rotate(s * wiggle);
        ctx.beginPath(); ctx.moveTo(0, -r * 0.02);
        ctx.bezierCurveTo(s * r * 0.12, -r * 0.1, s * r * 0.28, -r * 0.05, s * r * 0.34, r * 0.03);
        ctx.bezierCurveTo(s * r * 0.38, r * 0.08, s * r * 0.44, r * 0.0, s * r * 0.41, -r * 0.05);
        ctx.bezierCurveTo(s * r * 0.44, r * 0.07, s * r * 0.33, r * 0.11, s * r * 0.22, r * 0.07);
        ctx.bezierCurveTo(s * r * 0.12, r * 0.04, s * r * 0.04, r * 0.06, 0, r * 0.04);
        ctx.closePath(); ctx.fill();
        ctx.restore();
      }
      unlift(ctx);
      break;
    }
    case "monocle": {
      const { ex, ey, es } = faceOf(r, mood, level);
      const p = eyePlace(r, ex, ey, 1, turn);
      const radius = es * 1.15;
      lift(ctx, r);
      ctx.strokeStyle = material(ctx, mixHex(color, -0.3), p.y - radius, p.y + radius); ctx.lineWidth = r * 0.06;
      ctx.beginPath(); ctx.ellipse(p.x, p.y, radius * p.fx, radius, 0, 0, Math.PI * 2); ctx.stroke();
      unlift(ctx);
      const lens = ctx.createLinearGradient(p.x - radius, p.y - radius, p.x + radius, p.y + radius);
      lens.addColorStop(0, "rgba(255,255,255,0.1)"); lens.addColorStop(1, "rgba(255,255,255,0.06)");
      ctx.fillStyle = lens; ctx.beginPath(); ctx.ellipse(p.x, p.y, radius * p.fx, radius, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = css(shade(base, 0.2), 0.8); ctx.lineWidth = r * 0.012; ctx.setLineDash([r * 0.03, r * 0.02]);
      ctx.beginPath(); ctx.moveTo(p.x + radius * 0.6 * p.fx, p.y + radius * 0.8); ctx.quadraticCurveTo(p.x + r * 0.2, p.y + r * 0.7, r * 0.82, r * 0.5); ctx.stroke();
      ctx.setLineDash([]);
      break;
    }
  }
  // The grain goes on here, in the item's own space: it moves, turns and
  // grows with it (the orb's radius swells with the voice), rather than
  // staying put on the screen while the item moves under it.
  unlift(ctx);
  const k = (r / 132) * 0.5;
  for (const [pattern, alpha] of [[texture.dark, 0.6], [texture.light, 0.45]] as const) {
    pattern.setTransform(new DOMMatrix([k, 0, 0, k, 0, 0]));
    ctx.globalCompositeOperation = "source-atop"; ctx.globalAlpha = alpha;
    ctx.fillStyle = pattern; ctx.fillRect(-r * 4, -r * 4, r * 8, r * 8);
  }
  ctx.restore();
  // Then shadow from the orb's light, over the grain as well, in the orb's own space
  // rather than the item's, so every part of what it wears is lit from the same side.
  ctx.save();
  ctx.globalCompositeOperation = "source-atop";
  const away = ctx.createRadialGradient(-r * 0.35, -r * 0.6, r * 0.3, -r * 0.35, -r * 0.6, r * 2.1);
  away.addColorStop(0, "rgba(4,6,14,0)"); away.addColorStop(0.5, "rgba(4,6,14,0.06)"); away.addColorStop(1, "rgba(4,6,14,0.45)");
  ctx.fillStyle = away; ctx.fillRect(-r * 2.5, -r * 2.5, r * 5, r * 5);
  ctx.restore();
}

/**
 * The shape follows real RMS audio levels; the slow drift only gives idle depth.
 *
 * The style is read on every frame rather than restarting the animation, so a
 * change in the avatar customizer's preview shows at once. With the balanced
 * personality and the default multipliers this draws the orb as it always was.
 */
export function VoiceOrb({ mode, levels, look }: { mode: OrbState; levels: MutableRefObject<VoiceLevels>; look: OrbStyle }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const current = useRef(mode); current.current = mode;
  const style = useRef(look); style.current = look;
  useEffect(() => {
    const element = canvas.current!;
    const ctx = element.getContext("2d");
    if (!ctx) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    // The orb is laid out on a square of this many units, however many pixels it is drawn in: those follow the size
    // it is shown at (`fit`). A fixed 1200 by 1200 was six full renders per frame for six thumbnails.
    const size = 600;
    // What the orb wears is drawn on a layer of its own, so its grain lands on it alone.
    const layer = document.createElement("canvas");
    const worn = layer.getContext("2d")!;
    // Only an orb that wears something needs it.
    let texture: Grain | undefined;
    // Pixels across, to a unit, and whether it is shown as small as a thumbnail; set once it has a size.
    let pixels = 0, scale = 0, small = false;
    // The box it is shown in has changed since the canvas was sized.
    let stale = true;
    const fit = () => {
      const shown = element.clientWidth;
      if (!shown) return;
      small = shown < 160;
      const px = Math.min(size * 2, Math.max(96, Math.round(shown * Math.min(devicePixelRatio || 1, 2))));
      if (px === pixels) return;
      // Sized, a canvas is cleared and forgets its transform.
      element.width = element.height = layer.width = layer.height = pixels = px;
      scale = px / size;
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
    };
    const sparkles: Sparkle[] = Array.from({ length: 46 }, () => {
      const d = Math.sqrt(Math.random()), a = Math.random() * Math.PI * 2;
      return { x: Math.cos(a) * d, y: Math.sin(a) * d, size: Math.random(), phase: Math.random() * Math.PI * 2, back: Math.random() < 0.55 };
    });
    let frame = 0, level = 0, last = -1e9, visible = true;
    let color: number[] = hexToRgb(style.current.colors[current.current]);
    // Blinks come at uneven intervals, as they do; the personality sets how often.
    let nextBlink = performance.now() + 2500, blinkAt = -1e9;
    // Each state is eased into rather than switched to: eyes close slowly on mute and open again, the face widens into listening.
    let lid = 1, wide = 0, talk = 0, roam = 0.9, up = 0;
    const draw = (timestamp: number) => {
      const mode = current.current;
      const look = style.current;
      const motion = ORB_PERSONALITIES[look.personality];
      const value = (mode === "input" ? levels.current.input : mode === "output" ? levels.current.output : 0) * look.reactivity;
      level += (value - level) * (value > level ? motion.attack : motion.release);
      const target = hexToRgb(look.colors[mode]);
      color = color.map((v, i) => v + (target[i] - v) * 0.06);
      const rgb = color.map(Math.round).join(",");
      const t = reduced ? 0 : timestamp * 0.00055 * look.speed * motion.drift;
      const swell = 1 + motion.bounce * Math.sin(t * 3);
      const r = (132 + level * (reduced ? 5 : 28)) * swell;
      // Where the face looks: about while idle, up toward you while listening.
      const ease = reduced ? 1 : 0.1;
      lid += ((mode === "muted" ? 0 : 1) - lid) * ease;
      wide += ((mode === "input" ? 1 : 0) - wide) * ease;
      talk += ((mode === "output" ? 1 : 0) - talk) * ease;
      roam += ((mode === "idle" ? 0.9 : 0.35) - roam) * ease * 0.5;
      up += ((mode === "input" ? 1 : 0) - up) * ease;
      const mood: Mood = { wide, talk };
      const gx = reduced ? 0 : Math.sin(t * 0.9) * roam;
      const gy = reduced ? 0 : Math.cos(t * 0.6) * 0.4 * (1 - up) - 0.45 * up;
      const turn = { yaw: gx * 0.32, pitch: gy * 0.18 };
      ctx.clearRect(0, 0, size, size);
      ctx.save(); ctx.translate(size / 2, size / 2);
      const halo = ctx.createRadialGradient(0, 0, r * 0.65, 0, 0, r * 1.7);
      halo.addColorStop(0, `rgba(${rgb},${Math.min(1, (0.3 + level * 0.18) * look.glow)})`); halo.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = halo; ctx.fillRect(-size / 2, -size / 2, size, size);
      // A soft shadow below, so the orb floats above its stage rather than being painted on it.
      ctx.save(); ctx.translate(0, r * 1.3); ctx.scale(1, 0.16);
      const floor = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.8);
      floor.addColorStop(0, "rgba(0,0,0,0.5)"); floor.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = floor; ctx.beginPath(); ctx.arc(0, 0, r * 0.8, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      for (let ring = 0; ring < motion.rings; ring++) {
        ctx.beginPath();
        ctx.ellipse(0, 0, r + 20 + ring * 16 + level * 7, r + 18 + ring * 16, Math.sin(t) * motion.wobble, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${rgb},${Math.max(0.04, 0.2 + level * 0.15 - ring * 0.05)})`; ctx.lineWidth = 1.2; ctx.stroke();
      }
      const [first, second] = motion.lobes;
      // How far the edge is from the middle at an angle: the outline the sphere is filled, clipped and feathered by.
      const edge = (a: number) => r + (Math.sin(a * first + t * 1.3) * (3 + level * 7) + Math.sin(a * second - t * 2) * level * 10) * motion.wave;
      const outline = new Path2D();
      for (let i = 0; i <= 160; i++) {
        const a = i / 160 * Math.PI * 2, e = edge(a);
        const x = Math.cos(a) * e, y = Math.sin(a) * e;
        if (i === 0) outline.moveTo(x, y); else outline.lineTo(x, y);
      }
      outline.closePath();
      const sphere = ctx.createRadialGradient(-r * 0.32, -r * 0.45, 1, r * 0.12, r * 0.1, r * 1.32);
      sphere.addColorStop(0, `rgba(${rgb},0.98)`); sphere.addColorStop(0.32, `rgba(${rgb},0.95)`);
      sphere.addColorStop(0.7, `rgb(${color.map(v => Math.round(v * 0.62)).join(",")})`); sphere.addColorStop(1, `rgb(${color.map(v => Math.round(v * 0.34)).join(",")})`);
      ctx.shadowColor = `rgba(${rgb},0.65)`; ctx.shadowBlur = 22 * look.glow;
      ctx.fillStyle = sphere; ctx.fill(outline); ctx.shadowBlur = 0;
      const plush = look.finish === "plush";
      if (!plush) {
        // Lit from the upper left, as the gradient is: brightest where the light meets the edge.
        const rim = ctx.createLinearGradient(-r, -r, r, r);
        rim.addColorStop(0, "rgba(255,255,255,0.7)"); rim.addColorStop(0.45, `rgba(${rgb},0.75)`); rim.addColorStop(1, `rgba(${rgb},0.3)`);
        ctx.strokeStyle = rim; ctx.lineWidth = 1.8; ctx.stroke(outline);
      }
      ctx.save(); ctx.clip(outline);
      const tint = color as Rgb;
      drawPattern(ctx, look.pattern, true, r, t, level, tint, turn, sparkles);
      // A glowing core between the layers, drifting against the turn, as something deep inside would.
      const cx = -r * 0.08 - Math.sin(turn.yaw) * r * 0.18, cy = -r * 0.1 - Math.sin(turn.pitch) * r * 0.18;
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 0.62);
      core.addColorStop(0, `rgba(${color.map((v) => Math.round(v + (255 - v) * 0.55)).join(",")},${0.3 + level * 0.25})`); core.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = core; ctx.fillRect(-r, -r, 2 * r, 2 * r);
      drawPattern(ctx, look.pattern, false, r, t, level, tint, turn, sparkles);
      // Felt goes on before the shading, so the shadow side darkens it as it does the surface under it.
      if (plush) {
        // The pile over the whole body, scaled with the orb and riding a little with the turn.
        const R = r * 1.04;
        ctx.drawImage(minkySprite(), -R + Math.sin(turn.yaw) * r * 0.06, -R + Math.sin(turn.pitch) * r * 0.06, R * 2, R * 2);
      }
      // The side away from the light falls into shadow, and the underside darkens most.
      const turned = ctx.createRadialGradient(-r * 0.35, -r * 0.45, r * 0.4, -r * 0.35, -r * 0.45, r * 1.9);
      turned.addColorStop(0, "rgba(4,6,14,0)"); turned.addColorStop(0.55, "rgba(4,6,14,0.08)"); turned.addColorStop(1, "rgba(4,6,14,0.55)");
      ctx.fillStyle = turned; ctx.fillRect(-r * 1.2, -r * 1.2, r * 2.4, r * 2.4);
      const under = ctx.createLinearGradient(0, r * 0.25, 0, r);
      under.addColorStop(0, "rgba(0,0,0,0)"); under.addColorStop(1, "rgba(0,0,0,0.22)");
      ctx.fillStyle = under; ctx.fillRect(-r * 1.2, r * 0.25, r * 2.4, r);
      if (plush) {
        // Velvet catches light at its edges rather than in a spot: a soft brightening inside the rim, most where the light falls.
        const sheen = ctx.createRadialGradient(r * 0.12, r * 0.15, r * 0.55, -r * 0.05, -r * 0.05, r * 1.05);
        sheen.addColorStop(0, "rgba(255,255,255,0)"); sheen.addColorStop(0.7, "rgba(255,255,255,0.03)"); sheen.addColorStop(1, "rgba(255,255,255,0.1)");
        ctx.fillStyle = sheen; ctx.fillRect(-r * 1.2, -r * 1.2, r * 2.4, r * 2.4);
      } else {
        // The highlight is light falling on the surface, so it goes on last.
        const shine = ctx.createRadialGradient(-r * 0.33, -r * 0.55, 0, -r * 0.33, -r * 0.55, r * 0.85);
        shine.addColorStop(0, "rgba(238,255,255,0.45)"); shine.addColorStop(0.35, "rgba(233,253,255,0.08)"); shine.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = shine; ctx.fillRect(-r, -r, 2 * r, 2 * r);
      }
      ctx.restore();
      if (plush) {
        // A soft edge, as a minky toy's silhouette is: the orb's own colour feathering outward in a few wide, faint passes, and no lines.
        const soft = color.map((v) => Math.round(v * 0.85)).join(",");
        for (const [width, alpha] of [[r * 0.03, 0.22], [r * 0.06, 0.1], [r * 0.1, 0.04]] as const) {
          ctx.lineWidth = width; ctx.strokeStyle = `rgba(${soft},${alpha})`; ctx.stroke(outline);
        }
      }
      if (look.eyes !== "none") {
        if (!reduced && timestamp > nextBlink) { blinkAt = timestamp; nextBlink = timestamp + (2200 + Math.random() * 3200) / motion.blink; }
        const blinking = timestamp - blinkAt < 160;
        const open = lid * (blinking ? Math.abs(Math.cos((timestamp - blinkAt) / 160 * Math.PI)) : 1);
        drawEyes(ctx, look, r, mood, level, open, gx, gy, turn);
      }
      const wear = (kind: OrbHat | OrbProp, tint: string) => {
        worn.setTransform(1, 0, 0, 1, 0, 0); worn.clearRect(0, 0, layer.width, layer.height);
        worn.setTransform(scale, 0, 0, scale, 0, 0); worn.translate(size / 2, size / 2);
        drawWorn(worn, kind, tint, r, t, level, mood, turn, (texture ??= grain(worn)));
        ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(layer, 0, 0); ctx.restore();
      };
      if (look.prop !== "none") wear(look.prop, itemColor(look.prop, look.propColor));
      if (look.hat !== "none") wear(look.hat, itemColor(look.hat, look.hatColor));
      ctx.restore();
    };
    const render = (timestamp: number) => {
      // Reduced motion, and an orb the size of a thumbnail, are drawn at about 15 frames a second: nobody sees more of it.
      if (!((reduced || small) && timestamp - last < 66)) {
        last = timestamp;
        // Sized here, right before it is drawn, and not as the observer reports it: that comes after the frame's
        // animation callbacks and before it is painted, so a canvas cleared by it showed empty at every step of the
        // orb gliding to its place beside a window, and the orb flickered.
        if (stale) { stale = false; fit(); }
        if (scale) draw(timestamp);
      }
      frame = visible ? requestAnimationFrame(render) : 0;
    };
    const resized = new ResizeObserver(() => { stale = true; });
    resized.observe(element);
    // Out of view (scrolled away, behind another page) there is nothing to draw for.
    const seen = new IntersectionObserver((entries) => {
      visible = entries[entries.length - 1].isIntersecting;
      if (visible && !frame) frame = requestAnimationFrame(render);
    });
    seen.observe(element);
    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame);
      resized.disconnect();
      seen.disconnect();
    };
  }, [levels]);
  return <canvas ref={canvas} aria-hidden="true" className="voice-orb" data-mode={mode} />;
}
