import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type MutableRefObject, type RefObject } from "react";
import { local } from "./safe-storage";

/**
 * The extra animations: a layer of flourish on top of the motion the portal
 * always had (index.css and styles/*.css), switched off in one place.
 *
 * Whether it plays is decided once, by `installMotion`, and written on the page
 * as `data-motion="fancy"` on <html>. The style sheet (styles/motion.css) and
 * the code here both read that and nothing else, so they cannot disagree.
 * Two things turn it off: the switch in Settings → This browser, kept in this
 * browser like `panelDock`, and the system's own "reduce motion", which wins
 * whatever the switch says. Off, the page is exactly what it was before.
 *
 * What is made here is for things CSS cannot do alone: an element that is
 * already gone from the page when it is meant to leave (`useLeaveRef`, `keep`),
 * and rows that slide to where they now are (`useFlip`, `mark`). Both only
 * decorate: the real page changes at once, as it always did, and a picture
 * of what was there plays out above it and never takes a click.
 */

const KEY = "animations";
const REDUCED = "(prefers-reduced-motion: reduce)";

/** What was chosen on this page, for as long as it lasts: storage that cannot be written to still lets the switch work, and only forgets it at the next load. */
let kept: boolean | null = null;
/** The switch, from what was chosen here and what storage has: on until somebody turns it off, and storage that cannot be read reads as on. */
export const switchIs = (here: boolean | null, stored: string | null): boolean => here ?? stored !== "off";
/** Whether the switch is on. */
export const animationsChosen = (): boolean => switchIs(kept, local.get(KEY));
/** Whether the system asks for less motion. */
export const reducedMotion = (): boolean => typeof matchMedia === "function" && matchMedia(REDUCED).matches;
/** What plays: the switch, unless the system asks against it. */
export const plays = (chosen: boolean, reduced: boolean): boolean => chosen && !reduced;
/** Whether the extra animations play right now, as the page says. */
export const fancy = (): boolean => typeof document !== "undefined" && document.documentElement.dataset.motion === "fancy";

const listeners = new Set<() => void>();

function sync(): void {
  const root = document.documentElement;
  const was = root.dataset.motion;
  if (plays(animationsChosen(), reducedMotion())) root.dataset.motion = "fancy";
  else delete root.dataset.motion;
  if (root.dataset.motion !== was) finishRestarted();
  listeners.forEach((fn) => fn());
}

/**
 * Putting the attribute on or taking it off changes the animation of everything
 * on the page that has one for it, and a changed animation starts again: the
 * dialog the switch is in swung up once more. What has just been started that
 * way is taken to its end, so that the change shows and nothing plays. The
 * ones that go on for ever are left going.
 */
function finishRestarted(): void {
  for (const a of document.getAnimations()) if ("animationName" in a) finishQuietly(a);
}

/** An animation taken to its end, unless it goes on for ever. */
function finishQuietly(a: Animation): void {
  if (!Number.isFinite(a.effect?.getComputedTiming().iterations ?? Infinity)) return;
  try {
    a.finish();
  } catch {
    // Already at its end.
  }
}

/** Once, before the first draw: puts the state on the page and keeps it there. */
export function installMotion(): void {
  sync();
  matchMedia(REDUCED).addEventListener("change", sync);
  // Another tab turned them on or off.
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    kept = null;
    sync();
  });
}

function setAnimations(on: boolean): void {
  kept = on;
  local.set(KEY, on ? "on" : "off");
  sync();
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

/** The switch in Settings, and whether the system's own setting makes it moot. */
export function useAnimations() {
  const chosen = useSyncExternalStore(subscribe, animationsChosen);
  const reduced = useSyncExternalStore(subscribe, reducedMotion);
  return { chosen, reduced, set: setAnimations };
}

/* ── Pictures: what leaves is a copy of itself, laid over the page where it was ── */

/** How an element goes: each is a look in `LEAVES`. */
export type Leave = "dialog" | "menu" | "panel" | "row" | "message" | "page" | "gone";

const SPRING = "cubic-bezier(.34, 1.56, .64, 1)";
const OUT = "cubic-bezier(.22, 1, .36, 1)";
const IN = "cubic-bezier(.5, 0, .75, 0)";

const LEAVES: Record<Leave, (el: HTMLElement, delay: number) => Animation[]> = {
  // The dimming lets go and the dialog sinks, tilting back the way it came.
  dialog: (el) => {
    const card = el.firstElementChild as HTMLElement | null;
    return [
      el.animate([{ backgroundColor: getComputedStyle(el).backgroundColor, backdropFilter: getComputedStyle(el).backdropFilter }, { backgroundColor: "transparent", backdropFilter: "blur(0px)" }], { duration: 260, easing: "linear", fill: "both" }),
      ...(card ? [card.animate([{ transform: "none", opacity: 1 }, { transform: "perspective(1000px) translateY(26px) rotateX(8deg) scale(.9)", opacity: 0 }], { duration: 280, easing: IN, fill: "both" })] : []),
    ];
  },
  menu: (el) => [el.animate([{ transform: "none", opacity: 1 }, { transform: "translateY(8px) scale(.92)", opacity: 0 }], { duration: 190, easing: IN, fill: "both" })],
  // Back the way it came: out through the edge it was docked at.
  panel: (el) => {
    const dock = el.dataset.dock;
    const to = dock === "left" ? "translateX(-64px)" : dock === "bottom" ? "translateY(64px)" : dock === "float" ? "translateY(28px) scale(.9)" : "translateX(64px)";
    return [el.animate([{ transform: "none", opacity: 1 }, { transform: to, opacity: 0 }], { duration: 320, easing: IN, fill: "both" })];
  },
  // A deleted row flashes red, then comes apart: shrinks away to the side, out of focus.
  row: (el) => [
    el.animate(
      [
        { transform: "none", opacity: 1, filter: "blur(0px)", boxShadow: "inset 0 0 0 999px rgb(var(--danger) / 0)" },
        { offset: 0.22, transform: "scale(1.025)", opacity: 1, filter: "blur(0px)", boxShadow: "inset 0 0 0 999px rgb(var(--danger) / .2)" },
        { transform: "translateX(-36px) scale(.82) rotate(-2deg)", opacity: 0, filter: "blur(7px)", boxShadow: "inset 0 0 0 999px rgb(var(--danger) / .2)" },
      ],
      { duration: 460, easing: OUT, fill: "both" },
    ),
  ],
  // A message in the conversation: pushed off to the side it was said from, out of focus.
  message: (el, delay) => [el.animate([{ transform: "none", opacity: 1, filter: "blur(0px)" }, { transform: "translateX(48px) scale(.9) rotate(1.5deg)", opacity: 0, filter: "blur(8px)" }], { duration: 440, delay, easing: OUT, fill: "both" })],
  // The page that was there drifts up and away as the next one comes in.
  page: (el) => [el.animate([{ transform: "none", opacity: 1 }, { transform: "translateY(-30px) scale(.97)", opacity: 0 }], { duration: 340, easing: OUT, fill: "both" })],
  // A chat that no longer exists: it shrinks away where it stood.
  gone: (el) => [el.animate([{ transform: "none", opacity: 1 }, { transform: "translateY(14px) scale(.88)", opacity: 0 }], { duration: 520, easing: OUT, fill: "both" })],
};

/**
 * How high a picture is laid: just over what it came from, wherever that was
 * drawn — the phone's drawer is at 50, a dialog at 50 or 60, a list that opens
 * at 200, a floating window at 20 — and under whatever opens above that, which a
 * fixed number for each kind could not know. Where the source is not drawn in a
 * layer of its own (a page, the conversation, a row in the sidebar of a wide
 * window) it is under every layer there is: appended to the page last, it
 * is still over what is drawn in the flow, and under the windows and panels
 * that lie over the conversation, which stay open as it goes.
 *
 * A source that is the layer itself (a window, a dialog, a menu) goes with
 * its picture, so the picture lies at the layer's own height, and is put in
 * the page before the app: a layer of the same height that stays, or opens as
 * it goes (a second window; the setup assistant, opened from Settings) is
 * drawn over it. Appended after, it would have been in front of them.
 */
const UNDER_LAYERS = 0;
function layerOf(source: HTMLElement): { layer: number; own: boolean } {
  let z: number | null = null;
  let owner: HTMLElement | null = null;
  for (let el: HTMLElement | null = source; el; el = el.parentElement) {
    const at = Number.parseInt(getComputedStyle(el).zIndex, 10);
    // The outermost: what the rest is drawn inside of.
    if (Number.isFinite(at)) {
      z = at;
      owner = el;
    }
  }
  if (z === null) return { layer: UNDER_LAYERS, own: false };
  return owner === source ? { layer: z, own: true } : { layer: z + 1, own: false };
}

/** At most this many pictures are on the page at once; the oldest give way. */
const MAX_GHOSTS = 10;
/** The most a deletion plays out: its rows, from the message that was deleted, spread over what went. */
const MAX_BATCH = 6;
const ghosts = new Set<HTMLElement>();
/** Set while a page is being swapped for another, whose own picture covers everything in it. */
let swapping = false;
let swapTimer = 0;
export const swapPages = (on: boolean): void => {
  swapping = on;
  window.clearTimeout(swapTimer);
  // A swap that was begun and never drawn must not leave every picture after it silenced.
  if (on) swapTimer = window.setTimeout(() => (swapping = false), 400);
};

/** What a copy must not keep: ids and roles that would count twice, and what loads or takes focus. */
function scrub(copy: HTMLElement): void {
  copy.querySelectorAll("iframe, video, audio, script").forEach((n) => n.remove());
  for (const el of [copy, ...copy.querySelectorAll<HTMLElement>("[id], [role], [aria-modal], [data-popover-layer], [tabindex], [autofocus], [contenteditable], [title], [name]")]) {
    for (const attr of ["id", "role", "aria-modal", "data-popover-layer", "tabindex", "autofocus", "contenteditable", "title", "name"]) el.removeAttribute(attr);
  }
}

export interface Picture {
  frame: HTMLElement;
  el: HTMLElement;
  /** How high it is laid, and whether it goes with the layer it came from (see `layerOf`). */
  layer: number;
  own: boolean;
  /** Where the boxes in the copy that scroll were scrolled to: a copy starts at the top, and cannot be moved before it is on the page. */
  scrolled: [HTMLElement, number, number][];
}

/**
 * A copy of `source` as it looks now, held at the same place on the page, in
 * a frame that can be cut off at `clip`'s edge (a list that scrolls). Not on
 * the page yet: `out` puts it there. Null where there is nothing to show.
 */
export function picture(source: HTMLElement | null, clip?: HTMLElement | null): Picture | null {
  if (!source || !fancy() || !source.isConnected) return null;
  const rect = source.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  const el = source.cloneNode(true) as HTMLElement;
  // Read before the copy is scrubbed: the two are alike now, element for element.
  const scrolled: Picture["scrolled"] = [];
  const was = [source, ...source.querySelectorAll<HTMLElement>("*")], now = [el, ...el.querySelectorAll<HTMLElement>("*")];
  was.forEach((from, i) => from.scrollTop || from.scrollLeft ? scrolled.push([now[i], from.scrollTop, from.scrollLeft]) : undefined);
  scrub(el);
  const bounds = clip ? clip.getBoundingClientRect() : new DOMRect(0, 0, innerWidth, innerHeight);
  const frame = document.createElement("div");
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("data-ghost", "");
  frame.setAttribute("inert", "");
  Object.assign(frame.style, {
    position: "fixed", left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.width}px`, height: `${bounds.height}px`,
    overflow: clip ? "hidden" : "visible", pointerEvents: "none",
  });
  // Placed by its box alone: whatever moved the original (a translate, an
  // inset, a margin) is already in where it is.
  Object.assign(el.style, {
    position: "absolute", left: `${rect.left - bounds.left}px`, top: `${rect.top - bounds.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
    right: "auto", bottom: "auto", margin: "0", transform: "none", translate: "none", scale: "none", rotate: "none", maxWidth: "none", maxHeight: "none", minWidth: "0", minHeight: "0",
    animation: "none", transition: "none", pointerEvents: "none",
  });
  frame.append(el);
  return { frame, el, scrolled, ...layerOf(source) };
}

/** Puts a picture on the page and plays it out. */
export function out(shot: Picture | null, how: Leave, delay = 0): void {
  if (!shot || !fancy() || swapping) return;
  const { frame, el } = shot;
  frame.style.zIndex = String(shot.layer);
  for (const old of ghosts) if (ghosts.size >= MAX_GHOSTS) { old.remove(); ghosts.delete(old); }
  // Before the app when it goes with its layer: what stays at the same height is in front of it.
  const app = shot.own ? document.getElementById("root") : null;
  if (app?.parentElement === document.body) app.before(frame);
  else document.body.append(frame);
  ghosts.add(frame);
  // Where what scrolls was: the end of a conversation, not its start.
  for (const [box, top, left] of shot.scrolled) {
    box.scrollTop = top;
    box.scrollLeft = left;
  }
  const done = () => {
    frame.remove();
    ghosts.delete(frame);
  };
  const played = LEAVES[how](el, delay);
  // Not trusted to end: a page in the background may never get the frame it needs to say so.
  void Promise.allSettled(played.map((a) => a.finished)).then(done);
  window.setTimeout(done, 1200 + delay);
}

/** A picture of `el` taken now, to be played out once it is gone from the page. */
export function keep(el: HTMLElement | null, clip?: HTMLElement | null): (how: Leave) => void {
  const shot = picture(el, clip);
  return (how) => out(shot, how);
}

/**
 * A ref that sees its element go. It is the element that is given back to
 * React's `ref` as it leaves — still on the page, for that moment — so a picture
 * can be taken then, and played out where it was. One such ref holds one
 * element: where several places draw the same kind of thing (a panel's places),
 * each has a ref of its own, or the picture would be of whichever came last.
 * `into` is where the element would have gone otherwise; `how` may say "not
 * this time" with null.
 */
export function leaveRef<T extends HTMLElement>(how: () => Leave | null, into?: MutableRefObject<T | null> | ((el: T | null) => void)): (el: T | null) => void {
  let held: T | null = null;
  let since = 0;
  return (el) => {
    if (typeof into === "function") into(el);
    else if (into) into.current = el;
    if (el) {
      held = el;
      since = performance.now();
      return;
    }
    const gone = held;
    held = null;
    // Development React puts an element away and back at once to see that it
    // can: nobody saw it, so nothing leaves.
    if (!gone || performance.now() - since < 150) return;
    const kind = how();
    if (kind && !swapping) out(picture(gone), kind);
  };
}

/** `leaveRef` for the one element a component draws. Stable, so React does not call it with null again at every draw. */
export function useLeaveRef<T extends HTMLElement>(how: Leave | (() => Leave | null), into?: MutableRefObject<T | null>) {
  const latest = useRef(how);
  latest.current = how;
  return useMemo(() => leaveRef<T>(() => (typeof latest.current === "function" ? latest.current() : latest.current), into), [into]);
}

/* ── Moves ── */

/**
 * A panel carried from one place to another: it goes from where it was to
 * where it now is as one move, over the page, not out of one place and into
 * the other. Measured from `from`, which was taken before the change. What is
 * in `hold` has the entrance it has just been given taken to its end first, so
 * that it is measured where it will rest, and is not cut off at its edge while
 * the panel is on its way.
 */
export function glide(el: HTMLElement, from: DOMRect, hold: HTMLElement[] = []): void {
  if (!fancy() || typeof el.animate !== "function") return;
  for (const h of hold) {
    for (const a of h.getAnimations({ subtree: true })) if ("animationName" in a) finishQuietly(a);
    h.setAttribute("data-flown", "");
  }
  const to = el.getBoundingClientRect();
  const done = () => hold.forEach((h) => h.removeAttribute("data-flown"));
  if (to.width < 1 || to.height < 1 || from.width < 1 || from.height < 1) return done();
  const at = (transform: string) => ({ transformOrigin: "0 0", transform });
  el.animate([at(`translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`), at("none")], { duration: 620, easing: SPRING }).finished.then(done, done);
}

/** The chat that was picked lights up for a moment. */
export function pick(row: Element | null | undefined): void {
  if (!row || !fancy()) return;
  row.animate([{ boxShadow: "inset 0 0 0 999px rgb(var(--accent) / .26)" }, { boxShadow: "inset 0 0 0 999px rgb(var(--accent) / 0)" }], { duration: 800, easing: OUT });
}

/** Sent: the arrow goes up and out, a new one rises where it was, and a ring leaves the button. */
export function launch(button: Element | null): void {
  if (!button || !fancy()) return;
  button.querySelector("svg")?.animate(
    [
      { transform: "none", opacity: 1 },
      { offset: 0.35, transform: "translateY(-30px) scale(.7)", opacity: 0 },
      { offset: 0.36, transform: "translateY(26px) scale(.7)", opacity: 0 },
      { transform: "none", opacity: 1 },
    ],
    { duration: 560, easing: "cubic-bezier(.34, 1.4, .64, 1)" },
  );
  button.animate([{ boxShadow: "0 0 0 0 rgb(var(--fg) / .4)" }, { boxShadow: "0 0 0 16px rgb(var(--fg) / 0)" }], { duration: 560, easing: OUT });
}

/* ── Rows that slide to where they now are ── */

/** A row that slid or came in, to know how far it is from where it lies while it is on its way. */
const moving = new WeakMap<Element, Animation>();
/** How far a row on its way is drawn from where it lies, down the page. */
function lifted(el: Element): number {
  if (moving.get(el)?.playState !== "running") return 0;
  const [, y] = getComputedStyle(el).translate.split(" ");
  return Number.parseFloat(y ?? "") || 0;
}

/** Where each row is drawn on the page, less any slide it is on: by its `data-flip` (or `data-key`). */
function spotsOf(box: HTMLElement, attr: string): Map<string, number> {
  const spots = new Map<string, number>();
  box.querySelectorAll<HTMLElement>(`[${attr}]`).forEach((el) => spots.set(el.getAttribute(attr)!, el.getBoundingClientRect().top - lifted(el)));
  return spots;
}

const SLIDE = { duration: 420, easing: SPRING } as const;

/** Rows that were somewhere else slide from there, and new ones come in. */
function reflow(box: HTMLElement, attr: string, before: Map<string, number>, now: Map<string, number>, entering: boolean): Animation[] {
  const played: Animation[] = [];
  const first = before.size === 0;
  // Where a row has gone, the others wait for it to break apart before they close the gap.
  const wait = [...before.keys()].some((key) => !now.has(key)) ? 150 : 0;
  let order = 0;
  box.querySelectorAll<HTMLElement>(`[${attr}]`).forEach((el) => {
    const key = el.getAttribute(attr)!;
    const was = before.get(key);
    let a: Animation | undefined;
    if (was === undefined) {
      if (!entering) return;
      // The first rows to arrive come one after another; one that arrives later, on its own.
      a = el.animate(
        [
          { translate: "-28px 0", scale: ".9", opacity: 0, filter: "blur(5px)", backgroundColor: "rgb(var(--accent) / .22)" },
          { translate: "0 0", scale: "1", opacity: 1, filter: "blur(0px)", backgroundColor: "rgb(var(--accent) / 0)" },
        ],
        { duration: 560, delay: first ? Math.min(order++, 10) * 34 : 0, easing: SPRING, fill: "backwards" },
      );
    } else {
      // Moved in the page, a row starts its CSS animations again: those are taken to their end, so that only the slide is seen.
      for (const css of el.getAnimations()) if ("animationName" in css) finishQuietly(css);
      const dy = was - now.get(key)!;
      // Not rows that jumped a whole screen: those are another list, not a move.
      if (Math.abs(dy) < 2 || Math.abs(dy) > 700) return;
      a = el.animate([{ translate: `0 ${dy}px` }, { translate: "0 0" }], { ...SLIDE, delay: wait, fill: "backwards" });
    }
    moving.set(el, a);
    played.push(a);
  });
  return played;
}

/**
 * A list whose rows slide into their new places when the order changes
 * (`order` is any string that changes with it) and rise in when they are new.
 * Rows carry `data-flip`, their id; the box this returns is the one that
 * holds them, and scrolls if the list does.
 *
 * Looked at after every draw, so that what a row is compared with is where it
 * last was and not where it was when the order last changed, but only played
 * when the order has: a folder opened, a window resized, a search typed
 * (`quiet`) moves rows without that being news. A list that brings its
 * new rows in itself says `entering` is false.
 */
export function useFlip<T extends HTMLElement>(order: string, quiet = false, entering = true): RefObject<T> {
  const box = useRef<T>(null);
  /** Where the rows were, in the box's own content, so that scrolling it between two draws is not a move. */
  const last = useRef<{ order: string; quiet: boolean; spots: Map<string, number> } | null>(null);
  /** Where the box was last seen scrolled to: not yet where the browser put it when the list got shorter. */
  const seen = useRef(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const on = () => (seen.current = el.scrollTop);
    el.addEventListener("scroll", on, { passive: true });
    return () => el.removeEventListener("scroll", on);
  }, []);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    // Nothing is looked at while they are off: this is drawn with every change to the list.
    if (!fancy()) return void (last.current = null);
    const now = spotsOf(el, "data-flip");
    const before = last.current;
    const was = seen.current;
    last.current = { order, quiet, spots: new Map([...now].map(([key, y]) => [key, y + el.scrollTop])) };
    seen.current = el.scrollTop;
    // Not in the draw in which a search ends either: the rows it had hidden are back, not new.
    // Compared where they are drawn: a list scrolled to its end, made shorter, is pulled back by
    // the browser, and what is below what went has not moved on the page.
    if (before && before.order !== order && !quiet && !before.quiet) reflow(el, "data-flip", new Map([...before.spots].map(([key, y]) => [key, y - was])), now, entering);
  });
  return box;
}

/**
 * Where a list's rows are, and a picture of each that is on screen, taken
 * before something is done to them. `settle` then plays out those that are gone
 * and slides the others — for a message deleted, whose row goes when the
 * server says so, which may be a while after it was asked (it stops the chat's
 * agent first). The rows are kept where they are in the box that scrolls, and
 * the box is followed while the mark is open: scrolled, or made shorter, in
 * between, what is drawn moves, and where the rows were drawn moves with it.
 */
export interface Mark {
  box: HTMLElement;
  clip: HTMLElement | null;
  /** In the scrolling box's own content. */
  spots: Map<string, number>;
  shots: Map<string, Picture>;
  /** Where the box was scrolled to when the rows were marked, and where it was last seen. */
  scrolled: number;
  seen: number;
  /** Stops following the box. */
  stop: () => void;
}

export function mark(box: HTMLElement | null, clip: HTMLElement | null): Mark | null {
  if (!box || !fancy()) return null;
  const scrolled = clip?.scrollTop ?? 0;
  const spots = new Map([...spotsOf(box, "data-key")].map(([key, y]) => [key, y + scrolled]));
  const shots = new Map<string, Picture>();
  const view = (clip ?? box).getBoundingClientRect();
  for (const el of box.querySelectorAll<HTMLElement>(":scope > [data-key]")) {
    const r = el.getBoundingClientRect();
    if (r.bottom < view.top || r.top > view.bottom || shots.size >= 40) continue;
    const shot = picture(el, clip);
    if (shot) shots.set(el.getAttribute("data-key")!, shot);
  }
  const m: Mark = { box, clip, spots, shots, scrolled, seen: scrolled, stop: () => {} };
  if (clip) {
    const on = () => (m.seen = clip.scrollTop);
    clip.addEventListener("scroll", on, { passive: true });
    m.stop = () => clip.removeEventListener("scroll", on);
  }
  return m;
}

/** Whether the list has changed from what was marked, and so the mark is done with. */
export function settle(m: Mark, how: Leave = "message"): boolean {
  const now = spotsOf(m.box, "data-key");
  // What was drawn at the press has been moved by what was scrolled since.
  const moved = m.scrolled - m.seen;
  const gone = [...m.shots].filter(([key]) => !now.has(key));
  if (!gone.length) return false;
  // A turn can have more rows than there is room for pictures, and those first in are the ones that give way: the message that was deleted is what is
  // pictured first, and the rest of what went is spread from it to the last.
  const played = gone.length <= MAX_BATCH ? gone : Array.from({ length: MAX_BATCH }, (_, i) => gone[Math.round((i * (gone.length - 1)) / (MAX_BATCH - 1))]);
  played.forEach(([, shot], n) => {
    shot.el.style.top = `${Number.parseFloat(shot.el.style.top) + moved}px`;
    // One after another, the way they were said.
    out(shot, how, Math.min(n * 45, 400));
  });
  m.stop();
  const slid = reflow(m.box, "data-key", new Map([...m.spots].map(([key, y]) => [key, y - m.seen])), now, false);
  // Rows that start from below the end of the list would make it scroll further
  // than it does: a conversation that is followed at its end took that for being
  // left behind, and offered the way back to it for good. So what is below the
  // list's edge is cut off while they slide, and the scrolling box does not see it.
  if (slid.length) clipWhile(m.box, slid);
  return true;
}

/** Boxes that are cut off at their edge, with what they had before and how many moves they are cut off for. */
const clipped = new WeakMap<HTMLElement, { moves: number; overflow: string; margin: string }>();

/** `box` cut off at its edge until `moves` have finished: and a second set that comes while the first is still going is held by the same cut, which is let go of once, with what the box had before the first. */
function clipWhile(box: HTMLElement, moves: Animation[]): void {
  let c = clipped.get(box);
  if (!c) {
    c = { moves: 0, overflow: box.style.overflow, margin: box.style.overflowClipMargin };
    clipped.set(box, c);
    Object.assign(box.style, { overflow: "clip", overflowClipMargin: "8px" });
  }
  const cut = c;
  cut.moves++;
  void Promise.allSettled(moves.map((a) => a.finished)).then(() => {
    if (--cut.moves > 0) return;
    clipped.delete(box);
    Object.assign(box.style, { overflow: cut.overflow, overflowClipMargin: cut.margin });
  });
}
