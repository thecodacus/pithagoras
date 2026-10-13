import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { LuLocateFixed, LuMinus, LuPlus } from "react-icons/lu";
import { reducedMotion } from "../motion";
import { layout3dKept, layoutFlat, panned, pick, project, Shake, turnAround, zoomedAt, type Camera, type Projected, type SkyTheme } from "../memory-sky";
import { t, tp } from "../i18n";
import { LOOKS, rgbOf, type Gesture, type GraphNote, type Scene } from "./sky-looks";

export type { GraphNote } from "./sky-looks";

/** What a note says of itself when it is pointed at: in both views, the only place either writes anything. */
export function NoteCard({ note, colour }: { note: GraphNote; colour: string }) {
  return (
    <div className="w-max max-w-[16rem] rounded-lg border border-line bg-surface/95 px-3 py-2 text-left shadow-lg backdrop-blur">
      <p className="text-xs font-medium text-fg">{note.title || note.path}</p>
      <p className="mt-0.5 flex items-center gap-1.5 text-[10px] text-fg-muted">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: colour, boxShadow: `0 0 6px ${colour}` }} />
        {note.type && <span className="truncate">{note.type}</span>}
        <span className="shrink-0 text-fg-faint">{note.links === 0 ? t("orphan (unlinked)") : tp(note.links, "{n} link", "{n} links")}</span>
      </p>
      {note.description && <p className="mt-1 line-clamp-3 text-[11px] text-fg-subtle">{note.description}</p>}
    </div>
  );
}

const clampZoom = (z: number) => Math.max(0.35, Math.min(8, z));
/** How long a press is held still before it counts as held. */
const HOLD_MS = 1400;

/**
 * The graph on a canvas, in one of the looks of sky-looks.ts: each places the
 * notes, moves and answers a drag in its own way, and has a secret. The wheel
 * or a pinch zooms, and the buttons zoom and set the camera back, in all of
 * them. Nothing is written on it: a note says its name in a small card while it
 * is pointed at or reached with Tab, through buttons only a screen reader and
 * the keyboard see.
 *
 * Drawn in space (the 3D view), or `flat` (the 2D view): the same looks, the
 * same glow and links, seen straight on. Nothing turns then; a drag moves the
 * view, and the wheel zooms toward the pointer.
 *
 * The camera, the look's world and where every note is live in refs and are
 * drawn on every frame; React draws only the card and the buttons. The secret
 * playing, if one is, is named on the view as `data-easter-egg`.
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
  flat = false,
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
  /** Seen straight on, for the 2D view. The view is made again when this changes, from where the look rests. */
  flat?: boolean;
  label: string;
  onOpen: (path: string) => void;
  onSelect: (path: string | null) => void;
}) {
  const placed = useMemo(() => (flat ? layoutFlat : layout3dKept)(notes.map((n) => n.path), edges), [notes, edges, flat]);
  const index = useMemo(() => new Map(notes.map((n, i) => [n.path, i])), [notes]);
  const links = useMemo(
    () => edges.map((e) => [index.get(e.source), index.get(e.target)] as const).filter((l): l is readonly [number, number] => l[0] !== undefined && l[1] !== undefined && l[0] !== l[1]),
    [edges, index],
  );
  const near = useMemo(() => {
    const list: number[][] = notes.map(() => []);
    for (const [a, b] of links) {
      if (!list[a].includes(b)) list[a].push(b);
      if (!list[b].includes(a)) list[b].push(a);
    }
    return list;
  }, [notes, links]);
  const colours = useMemo(() => notes.map((n) => rgbOf(colourOf(n.type))), [notes, colourOf]);
  const types = useMemo(() => [...new Set(notes.map((n) => n.type).filter((x): x is string => !!x))].sort(), [notes]);
  const isShown = useMemo(() => notes.map((n) => shown.has(n.path)), [notes, shown]);
  const foundAt = useMemo(() => (found ? new Set([...found].map((p) => index.get(p)).filter((i): i is number => i !== undefined)) : null), [found, index]);
  // Bumped when what is placed changes, for the look to place it again.
  const version = useRef(0);
  const placedVersion = useMemo(() => ++version.current, [placed, isShown, links]);

  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const look = LOOKS[theme];
  /** Where a look's camera rests: in space, or straight on. */
  const restOf = (l: (typeof LOOKS)[SkyTheme]): Camera => ({ ...(flat ? l.flat : l.rest) });
  const rig = useRef({ cam: restOf(look), aim: null as Camera | null });
  const world = useRef<{ theme: SkyTheme; w: any }>({ theme, w: look.init() });
  if (world.current.theme !== theme) {
    // Another look is another world, seen from where it rests.
    world.current = { theme, w: look.init() };
    rig.current = { cam: restOf(look), aim: null };
  }
  const scene = useRef<Scene | null>(null);
  const dirty = useRef(true);
  const [hover, setHover] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const tip = hover ?? focused;

  const still = reducedMotion();
  // What the frame loop reads, as of the last render.
  const live = useRef({ isShown, foundAt, selected, theme, outline, tip, placedVersion });
  live.current = { isShown, foundAt, selected, theme, outline, tip, placedVersion };
  useEffect(() => {
    dirty.current = true;
  }, [isShown, foundAt, selected, theme, outline, tip, placed]);

  /** The camera to `to`: glided there, or at once for somebody who asked for less motion. */
  const go = (to: Camera) => {
    if (still) {
      rig.current.cam = { ...to };
      rig.current.aim = null;
      dirty.current = true;
    } else rig.current.aim = { ...to };
  };

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

  const grab = useRef<{ x: number; y: number; moved: boolean; id: number; held: boolean; around: number; aroundDone: boolean; shaken: boolean; trail: { x: number; y: number; at: number }[] } | null>(null);
  const pinch = useRef<number | null>(null);
  const shake = useRef(new Shake(1600));

  // The frame loop.
  useEffect(() => {
    const c = canvas.current;
    const g = c?.getContext("2d");
    if (!c || !g) return;
    let raf = 0;
    const started = performance.now();
    let last = started;
    let egg = "";
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      // The world's clock is the real one, so that a slow machine's frames are long ones and not slow time; a step is never more than a fifth of a second, so that a tab come back after a while does not fling anything.
      const dt = still ? 0 : Math.min(0.2, (now - last) / 1000);
      const time = still ? 0 : (now - started) / 1000;
      last = now;
      const { isShown, foundAt, selected, theme, outline, tip, placedVersion } = live.current;
      const lookNow = LOOKS[theme];
      const r = rig.current;
      if (r.aim) {
        const k = still ? 1 : 1 - Math.exp(-dt * 5);
        let done = true;
        for (const key of ["yaw", "pitch", "zoom", "tx", "ty", "tz"] as const) {
          r.cam[key] += (r.aim[key] - r.cam[key]) * k;
          if (Math.abs(r.aim[key] - r.cam[key]) > 1e-3) done = false;
        }
        if (done) {
          Object.assign(r.cam, r.aim);
          r.aim = null;
        }
      }
      if (still && !dirty.current) return;
      dirty.current = false;

      const dpr = c.width / Math.max(1, c.clientWidth);
      const w = c.width / dpr;
      const h = c.height / dpr;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.globalCompositeOperation = "source-over";
      g.globalAlpha = 1;
      g.shadowBlur = 0;
      const n = notes.length;
      const tipAt = tip === null ? null : (index.get(tip) ?? null);
      const chosen = selected === null ? null : (index.get(selected) ?? null);
      const focus = tipAt ?? (chosen !== null && isShown[chosen] ? chosen : null);
      const lit = focus === null ? null : new Set([focus, ...near[focus].filter((j) => isShown[j])]);
      const dim = new Float32Array(n);
      for (let i = 0; i < n; i++) dim[i] = lit ? (lit.has(i) ? 1 : 0.22) : foundAt ? (foundAt.has(i) ? 1 : 0.3) : 1;
      let view: Camera = r.cam;
      const s: Scene = {
        g,
        w,
        h,
        dt,
        time,
        still,
        version: placedVersion,
        notes,
        links,
        near,
        colours,
        types,
        shown: isShown,
        found: foundAt,
        selected: chosen,
        tip: tipAt,
        focus,
        lit,
        dim,
        base: placed,
        flat,
        rig: r,
        grabbing: !!grab.current?.moved || pinch.current !== null,
        outline: rgbOf(outline),
        pos: scene.current?.pos.length === n * 3 ? scene.current.pos : new Float64Array(n * 3),
        pts: scene.current?.pts ?? [],
        project: (x, y, z) => project({ x, y, z }, view, w, h),
      };
      const wd = world.current.w;
      lookNow.step(s, wd);
      view = lookNow.view?.(s, wd) ?? r.cam;
      const pts: Projected[] = new Array(n);
      for (let i = 0; i < n; i++) pts[i] = s.project(s.pos[i * 3], s.pos[i * 3 + 1], s.pos[i * 3 + 2]);
      s.pts = pts;
      scene.current = s;
      lookNow.draw(s, wd);
      g.globalCompositeOperation = "source-over";
      g.globalAlpha = 1;
      g.shadowBlur = 0;

      const playing = wd.egg?.name ?? "";
      if (playing !== egg && wrap.current) {
        egg = playing;
        if (egg) wrap.current.dataset.easterEgg = egg;
        else delete wrap.current.dataset.easterEgg;
      }
      // The card follows its note as the view moves.
      const el = card.current;
      if (el && tipAt !== null) {
        const p = pts[tipAt];
        const x = Math.max(4, Math.min(w - el.offsetWidth - 4, p.x - el.offsetWidth / 2));
        const above = p.y - el.offsetHeight - 14;
        const y = above < 4 ? Math.min(h - el.offsetHeight - 4, p.y + 14) : above;
        el.style.transform = `translate(${x}px, ${y}px)`;
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [placed, links, near, colours, types, notes, index, still, flat]);

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const holding = useRef(0);
  const at = (e: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const under = (x: number, y: number, touch: boolean) => {
    const s = scene.current;
    if (!s || !s.pts.length) return null;
    const z = Math.sqrt(rig.current.cam.zoom);
    const lookNow = LOOKS[live.current.theme];
    const i = pick(s.pts, x, y, (k) => Math.max(touch ? 16 : 9, lookNow.core(s, k, world.current.w) * s.pts[k].scale * z * 2.5), (k) => !live.current.isShown[k]);
    return i === null ? null : notes[i].path;
  };
  const tell = (g: Gesture) => {
    const s = scene.current;
    if (s) LOOKS[live.current.theme].gesture(s, world.current.w, g);
  };
  const down = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    clearTimeout(holding.current);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = Math.hypot(a.x - b.x, a.y - b.y);
      grab.current = null;
      return;
    }
    grab.current = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId, held: false, around: 0, aroundDone: false, shaken: false, trail: [{ x: e.clientX, y: e.clientY, at: performance.now() }] };
    shake.current.reset();
    rig.current.aim = null;
    const p = at(e);
    // Held still on the empty background: a gesture of its own, and not a click when it is let go.
    if (!under(p.x, p.y, e.pointerType === "touch"))
      holding.current = window.setTimeout(() => {
        const g = grab.current;
        if (!g || g.moved) return;
        g.held = true;
        tell({ kind: "hold", x: p.x, y: p.y });
      }, HOLD_MS);
  };
  const move = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current !== null && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (flat) {
        const r = canvas.current!.getBoundingClientRect();
        rig.current.cam = zoomedAt(rig.current.cam, d / pinch.current, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, r.width, r.height);
      } else rig.current.cam.zoom = clampZoom(rig.current.cam.zoom * (d / pinch.current));
      pinch.current = d;
      dirty.current = true;
      return;
    }
    const g = grab.current;
    const s = scene.current;
    if (g && g.id === e.pointerId) {
      const dx = e.clientX - g.x;
      const dy = e.clientY - g.y;
      if (!g.moved && Math.hypot(dx, dy) < 4) return;
      g.moved = true;
      clearTimeout(holding.current);
      const lookNow = LOOKS[live.current.theme];
      // Round the look's middle, if it has one: summed over the drag, a whole turn is a gesture.
      const centre = s && lookNow.centre?.(s, world.current.w);
      if (centre && canvas.current) {
        const r = canvas.current.getBoundingClientRect();
        g.around += turnAround({ x: g.x - r.left, y: g.y - r.top }, { x: e.clientX - r.left, y: e.clientY - r.top }, centre);
        if (Math.abs(g.around) >= Math.PI * 2 && !g.aroundDone) {
          g.aroundDone = true;
          tell({ kind: "around" });
        }
      }
      if (shake.current.add(e.clientX, performance.now()) >= 4 && !g.shaken) {
        g.shaken = true;
        tell({ kind: "shake" });
      }
      g.x = e.clientX;
      g.y = e.clientY;
      g.trail.push({ x: e.clientX, y: e.clientY, at: performance.now() });
      if (g.trail.length > 12) g.trail.shift();
      if (flat) {
        const r = canvas.current!.getBoundingClientRect();
        rig.current.cam = panned(rig.current.cam, dx, dy, r.width, r.height);
      } else if (s) lookNow.drag(s, world.current.w, dx, dy);
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
    clearTimeout(holding.current);
    const g = grab.current;
    grab.current = null;
    if (!g || g.id !== e.pointerId || g.held || e.type === "pointercancel") return;
    if (g.moved) {
      // The flat view stops where it is let go.
      if (flat) return;
      // How fast it was going when let go, over the last tenth of a second.
      const now = performance.now();
      const recent = g.trail.filter((p) => now - p.at < 100);
      const first = recent.length > 1 ? recent[0] : (g.trail[g.trail.length - 2] ?? g.trail[0]);
      const span = Math.max(16, now - first.at) / 1000;
      const s = scene.current;
      if (s) LOOKS[live.current.theme].release(s, world.current.w, (e.clientX - first.x) / span, (e.clientY - first.y) / span);
      return;
    }
    const p = at(e);
    const hit = under(p.x, p.y, e.pointerType === "touch");
    if (hit) onOpen(hit);
    else onSelect(null);
  };
  const double = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    const p = at(e);
    if (!under(p.x, p.y, false)) tell({ kind: "double", x: p.x, y: p.y });
  };
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      rig.current.aim = null;
      const factor = e.deltaY > 0 ? 1 / 1.12 : 1.12;
      if (flat) {
        const r = c.getBoundingClientRect();
        rig.current.cam = zoomedAt(rig.current.cam, factor, e.clientX - r.left, e.clientY - r.top, r.width, r.height);
      } else rig.current.cam.zoom = clampZoom(rig.current.cam.zoom * factor);
      dirty.current = true;
    };
    c.addEventListener("wheel", wheel, { passive: false });
    return () => {
      c.removeEventListener("wheel", wheel);
      clearTimeout(holding.current);
    };
  }, [flat]);
  const zoomBy = (f: number) => go({ ...(rig.current.aim ?? rig.current.cam), zoom: clampZoom((rig.current.aim ?? rig.current.cam).zoom * f) });

  const tipNote = tip === null ? undefined : notes[index.get(tip) ?? -1];
  return (
    <div ref={wrap} role="group" aria-label={label} data-look={theme} data-flat={flat || undefined} className={`memory-sky sky-${theme} relative min-h-0 flex-1 overflow-hidden`}>
      <canvas
        ref={canvas}
        aria-hidden="true"
        className={`absolute inset-0 h-full w-full touch-none select-none ${hover ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"}`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onPointerLeave={() => hover !== null && setHover(null)}
        onDoubleClick={double}
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
        <button
          type="button"
          onClick={() => {
            LOOKS[theme].reset?.(world.current.w);
            go(restOf(LOOKS[theme]));
          }}
          aria-label={t("Show all of it")}
          className="p-2 hover:bg-white/10 hover:text-white"
        >
          <LuLocateFixed className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
