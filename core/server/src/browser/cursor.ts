import type { BrowserContext, Locator, Page } from "playwright-core";
import { browserCursorOn } from "../db.js";

/**
 * The agent's cursor: an arrow drawn over the page, which the browser tools
 * glide to an element before they act on it, so whoever watches the browser
 * sees what the agent is about to do and where.
 *
 * It is the page's own drawing, not the system pointer: click-through
 * (pointer-events: none), in a closed shadow root, so the page's CSS cannot
 * reach it, and aria-hidden, so it is not in the accessibility tree the views
 * are built from or in the diffs after an action. It follows the system's light
 * or dark theme. It is left in screenshots on purpose: there it shows the agent
 * which element it last went for, which tells it when that was the wrong one.
 * Switched off on the Browser page, nothing moves and the actions do not wait for it.
 */

interface Cursor {
  move(x: number, y: number): Promise<void>;
  click(): Promise<void>;
  say(text: string, ms?: number): void;
  typing(on: boolean): void;
  place(x: number, y: number): void;
  off(): void;
  where(): { x: number; y: number } | null;
}

/**
 * Runs in the page, as its own source: everything it needs is inside it. It
 * defines window.__agentCursor once, and only in the top frame, whose cursor
 * points at elements in frames too (their boxes are measured from the top).
 */
function overlay() {
  const w = window as unknown as { __agentCursor?: Cursor };
  if (w.__agentCursor || window.top !== window) return;

  // The arrow: tip, lower wing, notch and upper wing, mirror images of each other about the line from
  // the tip through the notch, which leans 25 degrees from upright. Each corner is rounded by a circular
  // arc, the tip least: an arc stays round on the inside of the outline too, where a curve that only
  // bends towards the corner would come to a point at angles this sharp.
  const CORNERS = [[1.5, 1.5, 1.8], [2, 29.96, 2.4], [10.07, 19.88, 2.4], [22.98, 20.17, 2.4]];
  const unit = (a: number[], b: number[]) => {
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return [(b[0] - a[0]) / d, (b[1] - a[1]) / d];
  };
  const angleAt = (a: number[], b: number[]) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1])));
  const f = (n: number) => +n.toFixed(2);
  let ARROW = "";
  CORNERS.forEach((v, i) => {
    const prev = CORNERS[(i + CORNERS.length - 1) % CORNERS.length], next = CORNERS[(i + 1) % CORNERS.length], r = v[2];
    const a = unit(v, prev), b = unit(v, next);
    // The arc is tangent to both sides, meeting each this far from the corner.
    const t = r / Math.tan(angleAt(a, b) / 2);
    // It bends the way the outline turns there: one way at the corners that point out, the other at the notch.
    const sweep = -a[0] * b[1] + a[1] * b[0] > 0 ? 1 : 0;
    ARROW += `${i ? "L" : "M"}${f(v[0] + a[0] * t)} ${f(v[1] + a[1] * t)}A${r} ${r} 0 0 ${sweep} ${f(v[0] + b[0] * t)} ${f(v[1] + b[1] * t)}`;
  });
  ARROW += "Z";
  // Where it points: the rounded tip, back from its corner along the corner's bisector.
  const TIP = (() => {
    const v = CORNERS[0], r = v[2], a = unit(v, CORNERS[CORNERS.length - 1]), b = unit(v, CORNERS[1]);
    const m = Math.hypot(a[0] + b[0], a[1] + b[1]), back = r / Math.sin(angleAt(a, b) / 2) - r;
    return [f(v[0] + ((a[0] + b[0]) / m) * back), f(v[1] + ((a[1] + b[1]) / m) * back)];
  })();

  const css = `
    :host { all: initial;
      /* Light: see-through deep blue glass, a blue glow (a pale one is lost on white), and a blue hairline
         outside the white edge, which would otherwise be lost on a white page. */
      --fill: rgba(23, 37, 84, .58); --blur: 1.5px; --pill: rgba(15, 18, 30, .7); --soft: rgba(15, 18, 30, .22);
      --glow: rgba(59, 130, 246, .55); --core: rgba(37, 99, 235, .8); --hair: rgba(37, 99, 235, .55); }
    @media (prefers-color-scheme: dark) {
      /* Dark: see-through dark glass with a light blue glow. The white edge is the same in both. */
      :host { --fill: rgba(15, 18, 30, .5); --blur: 5px; --pill: rgba(15, 18, 30, .6); --soft: rgba(15, 18, 30, .2);
        --glow: rgba(125, 211, 252, .8); --core: rgba(186, 230, 253, 1); --hair: transparent; }
    }
    .halo { stroke: var(--glow); }
    /* The glow is strongest where it leaves the edge, then fades out through the wider halo. */
    .core { stroke: var(--core); }
    .hair { stroke: var(--hair); }
    .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; overflow: visible; }
    .c { position: absolute; left: 0; top: 0; width: 0; height: 0; will-change: transform; opacity: 0; transition: opacity .25s; }
    .c.on { opacity: 1; }
    /* The shadow and the glow are layers of their own around the glass, kept outside it: a filter on
       anything around the glass would cut it off from the page it blurs, and either one under it would
       show through it in place of the page. */
    .ptr { position: absolute; left: ${-TIP[0]}px; top: ${-TIP[1]}px; width: 26px; height: 32px; transform-origin: ${TIP[0]}px ${TIP[1]}px;
      transition: transform .18s cubic-bezier(.3,1.6,.5,1); }
    .ptr.go { transform: scale(1.05, .95) rotate(-4deg); }
    .ptr.land { animation: land .42s cubic-bezier(.3,1.5,.5,1); }
    @keyframes land { 0% { transform: scale(1.05, .95) rotate(-4deg); } 45% { transform: scale(.95, 1.05); } 100% { transform: none; } }
    .ptr.press { animation: press .34s cubic-bezier(.3,1.5,.5,1); }
    @keyframes press { 0% { transform: none; } 35% { transform: scale(.8); } 70% { transform: scale(1.08); } 100% { transform: none; } }
    .ptr > * { position: absolute; inset: 0; width: 26px; height: 32px; overflow: visible; }
    .glass { clip-path: path("${ARROW}"); background: var(--fill);
      backdrop-filter: blur(var(--blur)) saturate(150%); -webkit-backdrop-filter: blur(var(--blur)) saturate(150%); }
    .ripple { position: absolute; left: -5px; top: -5px; width: 10px; height: 10px; border-radius: 50%;
      border: 1.5px solid rgba(255,255,255,.85); background: var(--soft); box-shadow: 0 1px 4px rgba(2, 6, 23, .3);
      animation: ripple .65s cubic-bezier(.2,.7,.3,1) forwards; }
    @keyframes ripple { from { transform: scale(1); opacity: 1; } to { transform: scale(6.5); opacity: 0; } }
    /* The trail: small bubbles that drift after it, so a move reads as a glide rather than a jump. */
    .dot { position: absolute; left: -3px; top: -3px; width: 6px; height: 6px; border-radius: 50%;
      background: var(--soft); border: 1px solid rgba(255,255,255,.7); will-change: transform, opacity; }
    .label { position: absolute; left: 26px; top: 28px; white-space: nowrap; max-width: 280px; overflow: hidden; text-overflow: ellipsis;
      font: 600 12px/1 ui-rounded, "SF Pro Rounded", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; letter-spacing: .01em;
      color: #f1f5f9; padding: 7px 11px; border-radius: 999px; background: var(--pill);
      backdrop-filter: blur(8px) saturate(150%); -webkit-backdrop-filter: blur(8px) saturate(150%);
      border: 1px solid rgba(255,255,255,.35); box-shadow: 0 4px 12px rgba(2,6,23,.25);
      opacity: 0; transform: translateY(5px) scale(.96); transform-origin: 0 0; transition: opacity .22s, transform .3s cubic-bezier(.3,1.5,.5,1); }
    .label.on { opacity: 1; transform: none; }
    .caret { position: absolute; left: 30px; top: 2px; width: 2px; height: 16px; border-radius: 1px;
      background: var(--fill); box-shadow: 0 0 0 1px rgba(255,255,255,.7); opacity: 0; }
    .caret.on { animation: caret .9s steps(1) infinite; }
    @keyframes caret { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
  `;
  const mask = (id: string) =>
    `<mask id="${id}" maskUnits="userSpaceOnUse" x="-10" y="-10" width="48" height="50"><rect x="-10" y="-10" width="48" height="50" fill="#fff"/><path d="${ARROW}" fill="#000"/></mask>`;
  const blur = (id: string, by: number) => `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${by}"/></filter>`;
  const html = `<style>${css}</style><div class="layer">
    ${'<div class="dot"></div>'.repeat(4)}
    <div class="c"><div class="ptr">
      <svg viewBox="0 0 26 32"><defs>${blur("b", 2.2)}${mask("under")}</defs>
        <g mask="url(#under)"><path d="${ARROW}" transform="translate(.6 2)" fill="rgba(2, 6, 23, .35)" filter="url(#b)"/></g></svg>
      <div class="glass"></div>
      <svg viewBox="0 0 26 32"><defs>${blur("g", 1.8)}${blur("k", 0.7)}${mask("out")}</defs>
        <path class="halo" d="${ARROW}" fill="none" stroke-width="3" stroke-linejoin="round" filter="url(#g)" mask="url(#out)"/>
        <path class="core" d="${ARROW}" fill="none" stroke-width="2.6" stroke-linejoin="round" filter="url(#k)" mask="url(#out)"/>
        <path class="hair" d="${ARROW}" fill="none" stroke-width="2.6" stroke-linejoin="round" mask="url(#out)"/>
        <path d="${ARROW}" fill="none" stroke="rgba(255,255,255,.85)" stroke-width="1.5" stroke-linejoin="round"/></svg></div>
      <div class="caret"></div><div class="label"></div></div></div>`;

  let host: HTMLElement | undefined;
  let el: HTMLElement, ptr: HTMLElement, label: HTMLElement, caret: HTMLElement;
  let trail: { d: HTMLElement; x: number; y: number }[] = [];
  let at: { x: number; y: number } | null = null; // the tip, in viewport pixels; null until first placed
  let anim = 0, labelTimer = 0;
  // The glide in flight, settled when another one or a place takes over: its caller is still waiting on it.
  let settleGlide: (() => void) | null = null;
  // After a long pause with nothing done, it fades away; the next action brings it back where it was.
  const IDLE_MS = 120_000;
  let idleTimer = 0;
  function awake() {
    el.classList.add("on");
    clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      el.classList.remove("on");
      trail.forEach((t) => (t.d.style.opacity = "0"));
    }, IDLE_MS);
  }

  function mount(): boolean {
    if (host?.isConnected) return true;
    if (!document.documentElement) return false;
    if (!host) {
      host = document.createElement("agent-cursor");
      host.setAttribute("aria-hidden", "true");
      const root = host.attachShadow({ mode: "closed" });
      root.innerHTML = html;
      el = root.querySelector(".c")!;
      ptr = root.querySelector(".ptr")!;
      label = root.querySelector(".label")!;
      caret = root.querySelector(".caret")!;
      trail = [...root.querySelectorAll<HTMLElement>(".dot")].map((d) => ({ d, x: 0, y: 0 }));
    }
    // A page that rewrites <html>'s children takes it out: it goes back in on the next move.
    document.documentElement.append(host);
    return true;
  }

  const draw = (x: number, y: number) => {
    el.style.transform = `translate(${x}px, ${y}px)`;
  };

  // The trail follows the tip with a lag, fading out.
  function drawTrail(moving: boolean) {
    if (!at) return;
    let px = at.x, py = at.y;
    trail.forEach((t, i) => {
      const k = 0.38 - i * 0.05;
      t.x += (px - t.x) * k;
      t.y += (py - t.y) * k;
      const gap = Math.hypot(at!.x - t.x, at!.y - t.y);
      t.d.style.transform = `translate(${t.x}px, ${t.y}px) scale(${1 - i * 0.12})`;
      t.d.style.opacity = moving || gap > 1 ? String(Math.min(1, gap / 30) * (0.8 - i * 0.18)) : "0";
      px = t.x;
      py = t.y;
    });
  }

  function stopGlide() {
    cancelAnimationFrame(anim);
    const settle = settleGlide;
    settleGlide = null;
    settle?.();
  }

  function place(x: number, y: number) {
    if (!mount()) return;
    stopGlide();
    at = { x, y };
    trail.forEach((t) => {
      t.x = x;
      t.y = y;
      t.d.style.opacity = "0";
    });
    draw(x, y);
    awake();
  }

  const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  /** Glides to x, y along a slight arc, as a hand would, and resolves once it is there. */
  function move(x: number, y: number): Promise<void> {
    if (!mount()) return Promise.resolve();
    // The first time, from just above and to the left of the target, not from a corner of the screen.
    if (!at) place(Math.max(8, x - 140), Math.max(8, y - 90));
    stopGlide();
    awake();
    const from = { ...at! }, dist = Math.hypot(x - from.x, y - from.y);
    // A tab in the background gets no animation frames: there it is put in place at once.
    if (dist < 2 || document.hidden) {
      place(x, y);
      return Promise.resolve();
    }
    const ms = Math.min(650, Math.max(260, 180 + dist * 0.45));
    // The arc bends to one side of the straight line, by up to 60 px.
    const bend = Math.min(60, dist * 0.18), nx = -(y - from.y) / dist, ny = (x - from.x) / dist;
    const cx = (from.x + x) / 2 + nx * bend, cy = (from.y + y) / 2 + ny * bend;
    const start = performance.now();
    ptr.classList.remove("land", "press");
    ptr.classList.add("go");
    return new Promise((resolve) => {
      // Once only, whichever comes first: the landing, another glide or place taking over, or the
      // deadline below, in case animation frames stop coming mid-glide.
      let over = false;
      const done = () => {
        if (over) return;
        over = true;
        clearTimeout(deadline);
        if (settleGlide === done) settleGlide = null;
        resolve();
      };
      const deadline = setTimeout(() => {
        if (over) return;
        cancelAnimationFrame(anim);
        place(x, y);
        done();
      }, ms + 400);
      settleGlide = done;
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / ms), e = ease(t), u = 1 - e;
        at = { x: u * u * from.x + 2 * u * e * cx + e * e * x, y: u * u * from.y + 2 * u * e * cy + e * e * y };
        draw(at.x, at.y);
        drawTrail(true);
        if (t < 1) {
          anim = requestAnimationFrame(step);
          return;
        }
        // Lands with a little bounce while the trail catches up.
        ptr.classList.remove("go");
        void ptr.offsetWidth;
        ptr.classList.add("land");
        let settle = 0;
        const tail = () => {
          drawTrail(false);
          if (++settle < 14) anim = requestAnimationFrame(tail);
        };
        tail();
        done();
      };
      anim = requestAnimationFrame(step);
    });
  }

  /** A press where the tip is: the arrow squishes and a ring spreads out. */
  function click(): Promise<void> {
    if (!mount() || !at) return Promise.resolve();
    awake();
    ptr.classList.remove("go", "land", "press");
    void ptr.offsetWidth;
    ptr.classList.add("press");
    const ring = document.createElement("div");
    ring.className = "ripple";
    el.append(ring);
    setTimeout(() => ring.remove(), 700);
    return new Promise((done) => setTimeout(done, 160));
  }

  /** What the agent is doing, in a few words beside the arrow. */
  function say(text: string, ms = 1600) {
    if (!mount()) return;
    clearTimeout(labelTimer);
    label.textContent = text;
    label.classList.add("on");
    if (ms > 0) labelTimer = window.setTimeout(() => label.classList.remove("on"), ms);
  }

  function typing(on: boolean) {
    if (mount()) caret.classList.toggle("on", on);
  }

  /** Gone, as when the cursor is switched off: shown again by the next place or glide. */
  function off() {
    if (!mount()) return;
    stopGlide();
    el.classList.remove("on");
    label.classList.remove("on");
    caret.classList.remove("on");
    trail.forEach((t) => (t.d.style.opacity = "0"));
  }

  Object.defineProperty(window, "__agentCursor", {
    value: Object.freeze({ move, click, say, typing, place, off, where: () => (at ? { ...at } : null) }),
  });
}

/** The overlay as a script for a page to run. */
export const CURSOR_SCRIPT = `(${overlay.toString()})();`;

/** Where each tab's cursor last was: a new page in it starts there rather than nowhere. */
const last = new WeakMap<Page, { x: number; y: number }>();
const contexts = new WeakSet<BrowserContext>();
const watched = new WeakSet<Page>();

type Win = { __agentCursor?: Cursor };

/**
 * The cursor in this tab, put there if it is not yet: every page the context
 * opens from now on has it from its first script, and a page that loads keeps
 * the place the cursor had. Everything reaches the page through Playwright,
 * which a page's Content Security Policy does not stop; eval in the page would be.
 */
async function ready(page: Page): Promise<boolean> {
  const context = page.context();
  if (!contexts.has(context)) {
    contexts.add(context);
    await context.addInitScript({ content: CURSOR_SCRIPT }).catch(() => contexts.delete(context));
  }
  if (!watched.has(page)) {
    watched.add(page);
    page.on("load", () => {
      const at = last.get(page);
      if (at) void page.evaluate((p) => (window as unknown as Win).__agentCursor?.place(p.x, p.y), at).catch(() => {});
    });
  }
  // A page that was open before the context was given the script.
  const has = () => page.evaluate(() => !!(window as unknown as Win).__agentCursor).catch(() => false);
  if (await has()) return true;
  await page.evaluate(CURSOR_SCRIPT).catch(() => {});
  return has();
}

/**
 * What an element is called, for the label: its accessible name as near as the
 * page says it, kept short. A field's text is never part of it (`text` false):
 * in an editable area that is what is being typed.
 */
async function nameOf(locator: Locator, text = true): Promise<string> {
  const name = await locator
    .evaluate((node: Element, withText: boolean) => {
      const e = node as HTMLElement & { labels?: NodeListOf<HTMLLabelElement>; placeholder?: string };
      return (e.getAttribute("aria-label") || e.labels?.[0]?.textContent || e.placeholder || (withText ? e.innerText : "") || e.getAttribute("title") || "").trim();
    }, text)
    .catch(() => "");
  const one = name.replace(/\s+/g, " ");
  return one.length > 40 ? `${one.slice(0, 39)}…` : one;
}

/** Takes a cursor already on screen away, for when the cursor has been switched off: the switch says off, so nothing is left showing. */
async function gone(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as Win).__agentCursor?.off()).catch(() => {});
}

/** Glides to x, y with a word on what is about to happen, from where the tab's cursor last was if the page is new. */
async function glide(page: Page, x: number, y: number, text: string): Promise<void> {
  await page
    .evaluate((a) => {
      const c = (window as unknown as Win).__agentCursor;
      if (!c) return;
      if (!c.where() && a.from) c.place(a.from.x, a.from.y);
      c.say(a.text);
      return c.move(a.x, a.y);
    }, { x, y, text, from: last.get(page) })
    .catch(() => {});
  last.set(page, { x, y });
}

/**
 * Glides the cursor to an element and says what is about to happen to it,
 * resolving once it is there. The element is scrolled into view first, as the
 * action would; its box is measured from the top of the page, frames and all.
 */
export async function pointAt(page: Page, locator: Locator, verb: string, detail?: string): Promise<void> {
  if (!browserCursorOn()) return gone(page);
  if (!(await ready(page))) return;
  await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  const box = await locator.boundingBox().catch(() => null);
  if (!box) return;
  const name = detail ?? (await nameOf(locator, verb !== "Type"));
  await glide(page, box.x + box.width / 2, box.y + box.height / 2, name ? `${verb} · ${name}` : verb);
}

/** Glides to a point in the viewport, as for a scroll at the middle of the page. */
export async function pointTo(page: Page, x: number, y: number, text: string): Promise<void> {
  if (!browserCursorOn()) return gone(page);
  if (!(await ready(page))) return;
  await glide(page, x, y, text);
}

/** A press where the cursor is: a click, or a key. */
export async function press(page: Page, text?: string): Promise<void> {
  if (!browserCursorOn()) return gone(page);
  await page
    .evaluate((t) => {
      const c = (window as unknown as Win).__agentCursor;
      if (!c?.where()) return;
      if (t) c.say(t);
      return c.click();
    }, text)
    .catch(() => {});
}

/** The caret beside the cursor while text goes in. */
export async function typing(page: Page, on: boolean): Promise<void> {
  if (!browserCursorOn()) return;
  await page.evaluate((v) => (window as unknown as Win).__agentCursor?.typing(v), on).catch(() => {});
}
