import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { ZOOM_STEP, clampView, fitted, isFitted, toggled, zoomAt, type Size, type View } from "./image-viewer";

/** A press that moved less than this far, and let go within the time, was a tap. */
const TAP_DISTANCE = 8;
const TAP_TIME = 500;
/** Two taps this close in time and place are a double tap. */
const DOUBLE_TIME = 350;
const DOUBLE_DISTANCE = 30;
/** A swipe to the next picture: this far, mostly sideways, and quick. */
const SWIPE_DISTANCE = 50;
const SWIPE_TIME = 700;

interface Press {
  /** Where the picture lay when the press began, and where in the stage the press was. */
  view: View | null;
  start: { x: number; y: number };
  time: number;
  /** What was under it: only a tap on the picture can be half of a double tap. */
  target: EventTarget | null;
  type: string;
  /** The stage holds the pointer, so that a drag goes on outside it. */
  captured?: boolean;
  /** How far it has moved: infinite once a second finger has come, which makes it no tap. */
  moved: number;
  pinch?: { distance: number; middle: { x: number; y: number }; view: View };
}

const between = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const apart = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Looking at a picture closely: the wheel and a pinch zoom in on the spot they
 * are over, a drag moves a zoomed picture, a double tap goes between the whole
 * picture and its own size, and a quick swipe on a whole picture asks for
 * the next. The numbers are image-viewer.ts's; this is the pointer and the page.
 *
 * `id` names the picture: another one starts again, fitted. `view` is null until
 * the picture and the stage are both measured. `onTap` is a click beside the
 * picture, where nothing is, which the viewer takes to mean "done". It is
 * the click and not the end of the press that says so: closed from the press,
 * the click that follows it lands on whatever was under the viewer.
 */
export function usePanZoom({
  id,
  image,
  stage,
  element,
  onSwipe,
  onTap,
}: {
  id: string;
  image: Size | null;
  stage: Size | null;
  element: RefObject<HTMLElement>;
  onSwipe: (by: 1 | -1) => void;
  onTap: () => void;
}) {
  // Null is fitted: nothing was done to it, so it follows the stage when that changes size.
  const [own, setOwn] = useState<{ id: string; view: View | null }>({ id, view: null });
  const custom = own.id === id ? own.view : null;
  const view = image && stage ? (custom ? clampView(custom, image, stage) : fitted(image, stage)) : null;
  // What a drag that goes on over several draws has to go by, and the newest of it.
  const live = useRef({ id, view, image, stage, onSwipe, onTap });
  live.current = { id, view, image, stage, onSwipe, onTap };

  const put = useCallback((next: View) => {
    const { id, image, stage } = live.current;
    if (!image || !stage) return;
    const clean = clampView(next, image, stage);
    live.current.view = clean;
    setOwn({ id, view: isFitted(clean, image, stage) ? null : clean });
  }, []);

  const local = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const box = element.current?.getBoundingClientRect();
      return { x: e.clientX - (box?.left ?? 0), y: e.clientY - (box?.top ?? 0) };
    },
    [element],
  );
  const middle = useCallback(() => ({ x: (live.current.stage?.w ?? 0) / 2, y: (live.current.stage?.h ?? 0) / 2 }), []);

  const zoomBy = useCallback(
    (factor: number) => {
      const { view, image, stage } = live.current;
      if (view && image && stage) put(zoomAt(view, view.k * factor, middle(), image, stage));
    },
    [put, middle],
  );
  const toggle = useCallback(
    (at?: { x: number; y: number }) => {
      const { view, image, stage } = live.current;
      if (view && image && stage) put(toggled(view, at ?? middle(), image, stage));
    },
    [put, middle],
  );
  const fit = useCallback(() => {
    const { image, stage } = live.current;
    if (image && stage) put(fitted(image, stage));
  }, [put]);

  // Not React's onWheel: that one is passive, and cannot keep the page from zooming itself.
  useEffect(() => {
    const target = element.current;
    if (!target) return;
    const onWheel = (e: WheelEvent) => {
      const { view, image, stage } = live.current;
      if (!view || !image || !stage) return;
      e.preventDefault();
      const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1);
      // A pinch on a trackpad arrives as a wheel with Ctrl held, in smaller steps.
      put(zoomAt(view, view.k * Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.002)), local(e), image, stage));
    };
    target.addEventListener("wheel", onWheel, { passive: false });
    return () => target.removeEventListener("wheel", onWheel);
  }, [element, local, put]);

  const presses = useRef(new Map<number, { x: number; y: number }>());
  const press = useRef<Press | null>(null);
  const lastTap = useRef<{ time: number; x: number; y: number } | null>(null);
  /** Whether the press that just ended was a drag: the click after it is not a tap. */
  const dragged = useRef(false);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const at = local(e);
    presses.current.set(e.pointerId, at);
    const { view } = live.current;
    if (presses.current.size === 1) {
      dragged.current = false;
      press.current = { view, start: at, time: e.timeStamp, target: e.target, type: e.pointerType, moved: 0 };
    } else if (press.current && view) {
      const [a, b] = [...presses.current.values()];
      press.current.pinch = { distance: Math.max(1, apart(a, b)), middle: between(a, b), view };
      press.current.moved = Infinity;
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const current = press.current;
    if (!current || !presses.current.has(e.pointerId)) return;
    const at = local(e);
    presses.current.set(e.pointerId, at);
    const { image, stage } = live.current;
    if (current.pinch && presses.current.size >= 2) {
      if (!image || !stage) return;
      const [a, b] = [...presses.current.values()];
      const mid = between(a, b);
      const zoomed = zoomAt(current.pinch.view, current.pinch.view.k * (apart(a, b) / current.pinch.distance), current.pinch.middle, image, stage);
      put({ ...zoomed, x: zoomed.x + mid.x - current.pinch.middle.x, y: zoomed.y + mid.y - current.pinch.middle.y });
    } else if (presses.current.size === 1) {
      const [dx, dy] = [at.x - current.start.x, at.y - current.start.y];
      current.moved = Math.max(current.moved, Math.hypot(dx, dy));
      // A finger is held by what it touched; a mouse or a pen is held from here, once it is a drag and no longer a click.
      if (!current.captured && current.type !== "touch" && current.moved >= TAP_DISTANCE) {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        current.captured = true;
      }
      // Only a picture that is bigger than the stage has anywhere to go.
      if (image && stage && current.view && !isFitted(current.view, image, stage)) put({ ...current.view, x: current.view.x + dx, y: current.view.y + dy });
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    if (!presses.current.delete(e.pointerId)) return;
    const current = press.current;
    if (presses.current.size > 0) {
      // One finger of a pinch is up: the other goes on moving the picture, from where it is now.
      const [rest] = [...presses.current.values()];
      if (current) press.current = { ...current, view: live.current.view, start: rest, pinch: undefined, moved: Infinity };
      return;
    }
    press.current = null;
    if (!current || e.type === "pointercancel") return;
    dragged.current = current.moved >= TAP_DISTANCE;
    const at = local(e);
    const elapsed = e.timeStamp - current.time;
    if (current.moved < TAP_DISTANCE && elapsed < TAP_TIME) {
      const onPicture = current.target instanceof Element && current.target.closest("[data-picture]");
      const before = lastTap.current;
      if (!onPicture) lastTap.current = null;
      else if (before && e.timeStamp - before.time < DOUBLE_TIME && apart(at, before) < DOUBLE_DISTANCE) {
        lastTap.current = null;
        toggle(at);
      } else lastTap.current = { time: e.timeStamp, ...at };
      return;
    }
    const [dx, dy] = [at.x - current.start.x, at.y - current.start.y];
    const { image, stage } = live.current;
    // A picture that has not loaded (yet) is as good as whole: there is nothing in it to move, and the swipe is the way on.
    const whole = !current.view || !image || !stage || isFitted(current.view, image, stage);
    if (current.type !== "mouse" && whole && elapsed < SWIPE_TIME && Math.abs(dx) > SWIPE_DISTANCE && Math.abs(dx) > 1.5 * Math.abs(dy)) {
      live.current.onSwipe(dx < 0 ? 1 : -1);
    }
  };

  const onClick = (e: ReactMouseEvent<HTMLElement>) => {
    if (dragged.current || (e.target instanceof Element && e.target.closest("[data-picture]"))) return;
    live.current.onTap();
  };

  return {
    view,
    zoomed: view && image && stage ? !isFitted(view, image, stage) : false,
    zoomIn: () => zoomBy(ZOOM_STEP),
    zoomOut: () => zoomBy(1 / ZOOM_STEP),
    toggle: () => toggle(),
    fit,
    bind: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onClick },
  };
}
