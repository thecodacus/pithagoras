import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { LuLocateFixed, LuMinus, LuPlus } from "react-icons/lu";
import { reducedMotion } from "../motion";
import { neighbours } from "../memory-graph";
import { brainOutline, intoBrain, layout3dKept, pick, project, RESTING, seeded, type Camera, type Projected, type SkyTheme } from "../memory-sky";
import { t, tp } from "../i18n";

/** A note as the graph has it. */
export interface GraphNote {
  path: string;
  title?: string;
  type?: string;
  description?: string;
  links: number;
}

/** What a note says of itself when it is pointed at: in both views, the only place the 3D one writes anything. */
export function NoteCard({ note, colour, hint }: { note: GraphNote; colour: string; hint?: string }) {
  return (
    <div className="w-max max-w-[16rem] rounded-lg border border-line bg-surface/95 px-3 py-2 text-left shadow-lg backdrop-blur">
      <p className="text-xs font-medium text-fg">{note.title || note.path}</p>
      <p className="mt-0.5 flex items-center gap-1.5 text-[10px] text-fg-muted">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: colour, boxShadow: `0 0 6px ${colour}` }} />
        {note.type && <span className="truncate">{note.type}</span>}
        <span className="shrink-0 text-fg-faint">{note.links === 0 ? t("orphan (unlinked)") : tp(note.links, "{n} link", "{n} links")}</span>
      </p>
      {note.description && <p className="mt-1 line-clamp-3 text-[11px] text-fg-subtle">{note.description}</p>}
      {hint && <p className="mt-1 text-[10px] text-fg-faint">{hint}</p>}
    </div>
  );
}

type Rgb = [number, number, number];
const rgbOf = (hex: string): Rgb => {
  const n = parseInt(hex.replace("#", "").padEnd(6, "0").slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgba = ([r, g, b]: Rgb, a: number) => `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
/** Part of the way to white: a type's colour as light rather than paint. */
const lighter = ([r, g, b]: Rgb, k: number): Rgb => [r + (255 - r) * k, g + (255 - g) * k, b + (255 - b) * k];

/** A soft round glow of a colour, drawn once and then stamped at every star of it. */
function glow(colour: Rgb, core: Rgb, falloff: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, rgba(core, 1));
  grad.addColorStop(0.12, rgba(lighter(colour, 0.5), 0.9));
  grad.addColorStop(falloff, rgba(colour, 0.22));
  grad.addColorStop(1, rgba(colour, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return c;
}

/** The dust and the far stars behind the graph: fixed for each theme, so the same view is the same picture. */
const specks = (seed: number, n: number) => {
  const random = seeded(seed);
  return Array.from({ length: n }, () => ({ x: random(), y: random(), size: random(), phase: random() * Math.PI * 2 }));
};
const FAR_STARS = specks(11, 260);
const SNOW = specks(23, 90);

const BRAIN = brainOutline();

/** How big a note's point of light is at the middle's depth, in pixels, from how linked it is: the brain's neurons are smaller. */
const coreOf = (links: number, theme: SkyTheme) => (theme === "brain" ? 0.9 + Math.min(links, 12) * 0.12 : 1.7 + Math.min(links, 12) * 0.3);

/**
 * The graph in space, on a canvas: the notes as points of light, their links
 * as thin lines, turning slowly. Drag turns it, the wheel or a pinch zooms,
 * and the buttons zoom and set it back. Nothing is written on it: a note says
 * its name in a small card while it is pointed at or reached with Tab, through
 * buttons only a screen reader and the keyboard see.
 *
 * The camera and what it looks at live in refs and are drawn on every frame;
 * React draws only the card and the buttons.
 */
export function MemorySky({
  notes,
  edges,
  shown,
  colourOf,
  found,
  selected,
  theme,
  outline,
  label,
  onOpen,
  onSelect,
}: {
  /** Every note of the graph, also those filtered out: the layout stays put whatever is shown. */
  notes: GraphNote[];
  edges: { source: string; target: string }[];
  shown: Set<string>;
  colourOf: (type: string | undefined) => string;
  found: Set<string> | null;
  selected: string | null;
  theme: SkyTheme;
  /** The brain's outline colour. */
  outline: string;
  label: string;
  onOpen: (path: string) => void;
  onSelect: (path: string | null) => void;
}) {
  const placed = useMemo(() => layout3dKept(notes.map((n) => n.path), edges), [notes, edges]);
  const index = useMemo(() => new Map(notes.map((n, i) => [n.path, i])), [notes]);
  const near = useMemo(() => neighbours(edges), [edges]);
  const links = useMemo(
    () => edges.map((e) => [index.get(e.source), index.get(e.target)] as const).filter((l): l is readonly [number, number] => l[0] !== undefined && l[1] !== undefined && l[0] !== l[1]),
    [edges, index],
  );
  const colours = useMemo(() => notes.map((n) => rgbOf(colourOf(n.type))), [notes, colourOf]);

  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const cam = useRef<Camera>({ ...RESTING });
  const aim = useRef<Camera | null>(null);
  const spin = useRef({ yaw: 0, pitch: 0 });
  const seen = useRef<Projected[]>([]);
  const dirty = useRef(true);
  // The note pointed at, and the one reached with Tab: either one is lit and has the card.
  const [hover, setHover] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const tip = hover ?? focused;

  // What the frame loop reads, as of the last render.
  const live = useRef({ shown, found, selected, theme, outline, tip });
  live.current = { shown, found, selected, theme, outline, tip };
  useEffect(() => {
    dirty.current = true;
  }, [shown, found, selected, theme, outline, tip, placed]);

  const still = reducedMotion();
  /** The camera to `to`: glided there, or at once for somebody who asked for less motion. */
  const go = (to: Camera) => {
    spin.current = { yaw: 0, pitch: 0 };
    if (still) {
      cam.current = { ...to };
      aim.current = null;
      dirty.current = true;
    } else aim.current = { ...to };
  };
  // The chosen note is brought to the middle, a little closer.
  useEffect(() => {
    const at = selected === null ? undefined : index.get(selected);
    if (at === undefined || !shown.has(selected!)) return;
    const p = where(at);
    go({ ...cam.current, tx: p[0], ty: p[1], tz: p[2], zoom: Math.max(cam.current.zoom, 1.5) });
  }, [selected, placed, theme]);

  /** Where note `i` is in this theme's space. */
  const where = (i: number): [number, number, number] => {
    const p = placed[i];
    return live.current.theme === "brain" ? intoBrain(p) : [p.x, p.y, p.z];
  };

  // Sized to its box, in the screen's own pixels.
  useLayoutEffect(() => {
    const el = wrap.current;
    const c = canvas.current;
    if (!el || !c) return;
    const fit = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      c.width = Math.max(1, Math.round(el.clientWidth * dpr));
      c.height = Math.max(1, Math.round(el.clientHeight * dpr));
      dirty.current = true;
    };
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  // The frame loop.
  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const sprites = new Map<string, HTMLCanvasElement>();
    const sprite = (key: string, make: () => HTMLCanvasElement) => sprites.get(key) ?? (sprites.set(key, make()), sprites.get(key)!);
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const { shown, found, selected, theme, outline, tip } = live.current;
      const camera = cam.current;
      if (!still) {
        // A slow drift, held while a note is pointed at so it stays where the pointer is; a flick goes on a while and slows.
        if (!grab.current && tip === null) camera.yaw += dt * 0.06;
        camera.yaw += spin.current.yaw * dt;
        camera.pitch = clampPitch(camera.pitch + spin.current.pitch * dt);
        spin.current.yaw *= Math.exp(-dt * 3);
        spin.current.pitch *= Math.exp(-dt * 3);
        const to = aim.current;
        if (to) {
          const k = 1 - Math.exp(-dt * 5);
          let done = true;
          for (const key of ["yaw", "pitch", "zoom", "tx", "ty", "tz"] as const) {
            camera[key] += (to[key] - camera[key]) * k;
            if (Math.abs(to[key] - camera[key]) > 1e-3) done = false;
          }
          if (done) {
            Object.assign(camera, to);
            aim.current = null;
          }
        }
      } else if (!dirty.current) return;
      dirty.current = false;

      const dpr = c.width / Math.max(1, c.clientWidth);
      const w = c.width / dpr;
      const h = c.height / dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
      const time = still ? 0 : now / 1000;
      backdrop(ctx, theme, w, h, camera, time);

      const n = placed.length;
      const pts: Projected[] = new Array(n);
      const bob = theme === "deepsea" && !still;
      for (let i = 0; i < n; i++) {
        const p = where(i);
        if (bob) p[1] += Math.sin(time * 0.7 + i * 1.7) * 0.025;
        pts[i] = project({ x: p[0], y: p[1], z: p[2] }, camera, w, h);
      }
      seen.current = pts;
      const focusAt = tip !== null ? index.get(tip) : selected !== null ? index.get(selected) : undefined;
      const lit = focusAt === undefined ? null : new Set([focusAt, ...[...(near.get(notes[focusAt].path) ?? [])].map((p) => index.get(p)!).filter((i) => i !== undefined)]);
      const isShown = (i: number) => shown.has(notes[i].path);
      const dimOf = (i: number) => (lit ? (lit.has(i) ? 1 : 0.22) : found ? (found.has(notes[i].path) ? 1 : 0.3) : 1);
      const zoomed = Math.sqrt(camera.zoom);

      if (theme === "brain") {
        const glowOf = rgbOf(outline);
        ctx.lineWidth = 1;
        ctx.shadowColor = rgba(glowOf, 0.9);
        ctx.shadowBlur = 6;
        for (const line of BRAIN) {
          const projected = line.map((q) => project({ x: q[0], y: q[1], z: q[2] }, camera, w, h));
          // Between a twentieth and a quarter as strong, the far side the fainter.
          const depth = projected.reduce((s, q) => s + q.depth, 0) / projected.length;
          ctx.strokeStyle = rgba(glowOf, 0.05 + 0.2 * Math.max(0, Math.min(1, 0.5 - depth / 2)));
          ctx.beginPath();
          projected.forEach((q, k) => (k ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
          ctx.stroke();
        }
        ctx.shadowBlur = 0;
      }
      // The links: thin, the far ones fainter, those of the note in focus in its colour.
      const linkColour: Rgb = theme === "brain" ? lighter(rgbOf(outline), 0.3) : theme === "deepsea" ? [120, 230, 255] : theme === "synthwave" ? [45, 226, 230] : [175, 200, 255];
      ctx.lineCap = "round";
      for (const [a, b] of links) {
        if (!isShown(a) || !isShown(b)) continue;
        const pa = pts[a];
        const pb = pts[b];
        const near = Math.max(0.15, Math.min(1, 1 - (pa.depth + pb.depth) / 4));
        const hot = lit !== null && lit.has(a) && lit.has(b) && (a === focusAt || b === focusAt);
        ctx.lineWidth = hot ? 1.4 : theme === "synthwave" ? 1 : 0.7;
        ctx.strokeStyle = hot ? rgba(lighter(colours[focusAt!], 0.25), 0.9) : rgba(linkColour, (theme === "stellar" ? 0.26 : 0.32) * near * Math.min(dimOf(a), dimOf(b)));
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
      }

      // The notes, the far ones first so the near ones are drawn over them.
      const order = Array.from({ length: n }, (_, i) => i).filter(isShown).sort((a, b) => pts[b].depth - pts[a].depth);
      ctx.globalCompositeOperation = "lighter";
      for (const i of order) {
        const p = pts[i];
        const base = coreOf(notes[i].links, theme) * p.scale * zoomed;
        const twinkle = still ? 1 : 0.82 + 0.18 * Math.sin(time * (1.3 + (i % 5) * 0.37) + i * 2.1);
        const alpha = dimOf(i) * twinkle * Math.max(0.35, Math.min(1, 1.2 - p.depth / 3));
        const colour = colours[i];
        const key = `${theme}${colour.join()}`;
        const img =
          theme === "deepsea"
            ? sprite(key, () => glow(lighter(colour, 0.35), [230, 255, 255], 0.5))
            : theme === "synthwave"
              ? sprite(key, () => glow(colour, [255, 255, 255], 0.3))
              : theme === "brain"
                ? sprite(key, () => glow(lighter(colour, 0.25), [255, 245, 252], 0.35))
                : sprite(key, () => glow(colour, [255, 255, 255], 0.38));
        const size = base * (theme === "deepsea" ? 9 : theme === "brain" ? 8 : 7.5);
        ctx.globalAlpha = alpha;
        ctx.drawImage(img, p.x - size / 2, p.y - size / 2, size, size);
        if (theme === "deepsea") {
          // A jelly's bell: a faint ring that swells and settles.
          ctx.strokeStyle = rgba(lighter(colour, 0.5), 0.35 * alpha);
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          ctx.arc(p.x, p.y, base * (2.4 + (still ? 0 : 0.35 * Math.sin(time * 1.6 + i))), 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;

      // A ring for the note chosen, and fainter ones for what the search found.
      const ring = (i: number, strength: number, gap: number) => {
        const p = pts[i];
        const r = coreOf(notes[i].links, theme) * p.scale * zoomed * 2.4 + gap;
        ctx.strokeStyle = rgba([255, 255, 255], strength);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.stroke();
      };
      if (found) for (const path of found) {
        const i = index.get(path);
        if (i !== undefined && isShown(i)) ring(i, 0.45, 3);
      }
      const chosen = selected === null ? undefined : index.get(selected);
      if (chosen !== undefined && isShown(chosen)) ring(chosen, still ? 0.85 : 0.6 + 0.3 * Math.sin(time * 2.4), 6);

      // The card follows its note as the view turns.
      const tipAt = tip === null ? undefined : index.get(tip);
      const el = card.current;
      if (el && tipAt !== undefined) {
        const p = pts[tipAt];
        const x = Math.max(4, Math.min(w - el.offsetWidth - 4, p.x - el.offsetWidth / 2));
        const above = p.y - el.offsetHeight - 14;
        const y = above < 4 ? Math.min(h - el.offsetHeight - 4, p.y + 14) : above;
        el.style.transform = `translate(${x}px, ${y}px)`;
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [placed, links, colours, notes, index, near, still]);

  // Turning, zooming and choosing with the pointer.
  const grab = useRef<{ x: number; y: number; moved: boolean; id: number } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<number | null>(null);
  const at = (e: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const under = (x: number, y: number, touch: boolean) => {
    const z = Math.sqrt(cam.current.zoom);
    const i = pick(seen.current, x, y, (k) => Math.max(touch ? 16 : 9, coreOf(notes[k].links, live.current.theme) * seen.current[k].scale * z * 2.5), (k) => !live.current.shown.has(notes[k].path));
    return i === null ? null : notes[i].path;
  };
  const down = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = Math.hypot(a.x - b.x, a.y - b.y);
      grab.current = null;
      return;
    }
    grab.current = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId };
    spin.current = { yaw: 0, pitch: 0 };
    aim.current = null;
  };
  const move = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current !== null && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      cam.current.zoom = clampZoom(cam.current.zoom * (d / pinch.current));
      pinch.current = d;
      dirty.current = true;
      return;
    }
    const g = grab.current;
    if (g && g.id === e.pointerId) {
      const dx = e.clientX - g.x;
      const dy = e.clientY - g.y;
      if (!g.moved && Math.hypot(dx, dy) < 4) return;
      g.moved = true;
      g.x = e.clientX;
      g.y = e.clientY;
      cam.current.yaw += dx * 0.006;
      cam.current.pitch = clampPitch(cam.current.pitch - dy * 0.006);
      if (!still) spin.current = { yaw: dx * 0.35, pitch: -dy * 0.35 };
      dirty.current = true;
      if (hover !== null) setHover(null);
      return;
    }
    const p = at(e);
    const over = under(p.x, p.y, e.pointerType === "touch");
    if (over !== hover) setHover(over);
  };
  const up = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const g = grab.current;
    grab.current = null;
    if (!g || g.id !== e.pointerId || g.moved || e.type === "pointercancel") return;
    const p = at(e);
    const hit = under(p.x, p.y, e.pointerType === "touch");
    if (hit) onOpen(hit);
    else onSelect(null);
  };
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      aim.current = null;
      cam.current.zoom = clampZoom(cam.current.zoom * (e.deltaY > 0 ? 1 / 1.12 : 1.12));
      dirty.current = true;
    };
    c.addEventListener("wheel", wheel, { passive: false });
    return () => c.removeEventListener("wheel", wheel);
  }, []);
  const zoomBy = (f: number) => go({ ...(aim.current ?? cam.current), zoom: clampZoom((aim.current ?? cam.current).zoom * f) });

  const tipNote = tip === null ? undefined : notes[index.get(tip) ?? -1];
  return (
    <div ref={wrap} role="group" aria-label={label} data-theme-3d={theme} className={`memory-sky sky-${theme} relative min-h-0 flex-1 overflow-hidden`}>
      <canvas
        ref={canvas}
        aria-hidden="true"
        className={`absolute inset-0 h-full w-full touch-none select-none ${hover ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"}`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onPointerLeave={() => hover !== null && setHover(null)}
      />
      <ul className="sr-only">
        {notes.map((n) =>
          shown.has(n.path) ? (
            <li key={n.path}>
              <button
                type="button"
                aria-current={selected === n.path ? "true" : undefined}
                aria-description={found?.has(n.path) ? t("Matches the search") : undefined}
                onFocus={() => setFocused(n.path)}
                onBlur={() => setFocused((f) => (f === n.path ? null : f))}
                onClick={() => onOpen(n.path)}
              >
                {n.title || n.path}
              </button>
            </li>
          ) : null,
        )}
      </ul>
      {tipNote && (
        <div ref={card} aria-hidden="true" className="pointer-events-none absolute left-0 top-0 z-10" style={{ transform: "translate(-9999px, 0)" }}>
          <NoteCard note={tipNote} colour={colourOf(tipNote.type)} />
        </div>
      )}
      <div className="absolute bottom-3 right-3 flex flex-col overflow-hidden rounded-lg border border-white/15 bg-black/40 text-white/75 backdrop-blur">
        <button type="button" onClick={() => zoomBy(1.3)} aria-label={t("Zoom in")} className="p-2 hover:bg-white/10 hover:text-white">
          <LuPlus className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={() => zoomBy(1 / 1.3)} aria-label={t("Zoom out")} className="border-y border-white/15 p-2 hover:bg-white/10 hover:text-white">
          <LuMinus className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={() => go({ ...RESTING })} aria-label={t("Show all of it")} className="p-2 hover:bg-white/10 hover:text-white">
          <LuLocateFixed className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

const clampPitch = (p: number) => Math.max(-1.45, Math.min(1.45, p));
const clampZoom = (z: number) => Math.max(0.35, Math.min(8, z));

/** What is behind the graph in each theme. */
function backdrop(ctx: CanvasRenderingContext2D, theme: SkyTheme, w: number, h: number, cam: Camera, time: number) {
  if (theme === "stellar") {
    const sky = ctx.createRadialGradient(w * 0.5, h * 0.45, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.75);
    sky.addColorStop(0, "#141a3a");
    sky.addColorStop(0.55, "#090c1f");
    sky.addColorStop(1, "#03040b");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);
    // A faint band of the galaxy across it.
    const band = ctx.createLinearGradient(0, h * 0.2, w, h * 0.8);
    band.addColorStop(0, "rgba(90,70,160,0)");
    band.addColorStop(0.5, "rgba(110,90,190,0.10)");
    band.addColorStop(1, "rgba(60,120,200,0)");
    ctx.fillStyle = band;
    ctx.fillRect(0, 0, w, h);
    // Far stars, which move a little as the view turns, as far things do.
    for (const s of FAR_STARS) {
      const x = (((s.x * w - cam.yaw * 40) % w) + w) % w;
      const y = (((s.y * h + cam.pitch * 40) % h) + h) % h;
      ctx.fillStyle = `rgba(220,230,255,${(0.12 + s.size * 0.4) * (0.7 + 0.3 * Math.sin(time * 1.5 + s.phase))})`;
      ctx.fillRect(x, y, s.size > 0.85 ? 1.6 : 1, s.size > 0.85 ? 1.6 : 1);
    }
  } else if (theme === "deepsea") {
    const sea = ctx.createLinearGradient(0, 0, 0, h);
    sea.addColorStop(0, "#0b3a4f");
    sea.addColorStop(0.45, "#06222f");
    sea.addColorStop(1, "#020a10");
    ctx.fillStyle = sea;
    ctx.fillRect(0, 0, w, h);
    // Light from the surface, in slow swaying shafts.
    ctx.globalCompositeOperation = "lighter";
    for (let k = 0; k < 4; k++) {
      const x = w * (0.18 + k * 0.22) + Math.sin(time * 0.25 + k * 1.9) * w * 0.04;
      const shaft = ctx.createLinearGradient(0, 0, 0, h * 0.85);
      shaft.addColorStop(0, "rgba(120,220,255,0.07)");
      shaft.addColorStop(1, "rgba(120,220,255,0)");
      ctx.fillStyle = shaft;
      ctx.beginPath();
      ctx.moveTo(x - w * 0.03, 0);
      ctx.lineTo(x + w * 0.03, 0);
      ctx.lineTo(x + w * 0.12, h * 0.85);
      ctx.lineTo(x - w * 0.02, h * 0.85);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
    // Marine snow, sinking slowly.
    for (const s of SNOW) {
      const x = (((s.x * w + Math.sin(time * 0.3 + s.phase) * 8 - cam.yaw * 25) % w) + w) % w;
      const y = (((s.y * h + time * (6 + s.size * 10)) % h) + h) % h;
      ctx.fillStyle = `rgba(200,240,255,${0.08 + s.size * 0.18})`;
      ctx.beginPath();
      ctx.arc(x, y, 0.6 + s.size * 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (theme === "brain") {
    const dark = ctx.createRadialGradient(w * 0.5, h * 0.5, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.7);
    dark.addColorStop(0, "#1a0d1f");
    dark.addColorStop(1, "#060308");
    ctx.fillStyle = dark;
    ctx.fillRect(0, 0, w, h);
  } else {
    const dusk = ctx.createLinearGradient(0, 0, 0, h);
    dusk.addColorStop(0, "#0b0221");
    dusk.addColorStop(0.55, "#2a0a45");
    dusk.addColorStop(0.75, "#4a0f4f");
    dusk.addColorStop(1, "#0b0221");
    ctx.fillStyle = dusk;
    ctx.fillRect(0, 0, w, h);
    // The sun on the horizon, cut by the bands it always has.
    const r = Math.min(w, h) * 0.24;
    const cx = w / 2;
    const cy = h * 0.6;
    const sun = ctx.createLinearGradient(0, cy - r, 0, cy + r * 0.2);
    sun.addColorStop(0, "#ffd36e");
    sun.addColorStop(1, "#ff3d81");
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.PI, 0);
    ctx.closePath();
    ctx.clip();
    ctx.fillStyle = sun;
    ctx.globalAlpha = 0.55;
    ctx.fillRect(cx - r, cy - r, r * 2, r);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#3a0c4c";
    for (let k = 0; k < 5; k++) ctx.fillRect(cx - r, cy - r * 0.42 + k * r * 0.1, r * 2, 1.5 + k * 1.3);
    ctx.restore();
    // The floor: a grid running to the horizon, sliding towards the viewer and aside as the view turns.
    const floor = ctx.createLinearGradient(0, cy, 0, h);
    floor.addColorStop(0, "#1c0633");
    floor.addColorStop(1, "#07011a");
    ctx.fillStyle = floor;
    ctx.fillRect(0, cy, w, h - cy);
    ctx.lineWidth = 1;
    const rows = 12;
    const phase = (time * 0.35) % 1;
    for (let k = 0; k < rows; k++) {
      const p = (k + phase) / rows;
      const y = cy + (h - cy) * p * p;
      ctx.strokeStyle = `rgba(255,47,214,${(0.15 + 0.55 * p).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    const spacing = w * 0.12;
    const slide = ((((cam.yaw * w * 0.15) % spacing) + spacing) % spacing) - spacing / 2;
    for (let k = -14; k <= 14; k++) {
      const x = cx + k * spacing + slide;
      ctx.strokeStyle = "rgba(255,47,214,0.45)";
      ctx.beginPath();
      ctx.moveTo(cx + (x - cx) * 0.04, cy);
      ctx.lineTo(cx + (x - cx) * 1.6, h);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(255,120,230,0.9)";
    ctx.shadowColor = "#ff2fd6";
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(0, cy);
    ctx.lineTo(w, cy);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
}
