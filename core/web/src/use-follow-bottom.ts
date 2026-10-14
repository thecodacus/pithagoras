import { useCallback, useEffect, useRef, useState } from "react";

/** How far from the end still counts as being at the end, in px. */
const NEAR_END = 48;
/** At the end, not near it: where a box whose content shrank is put back. */
const AT_END = 2;
/** How long, in ms, a press on something that opens holds it where it was (see below). */
export const HOLD = 1000;

const distance = (el: { scrollHeight: number; scrollTop: number; clientHeight: number }) => el.scrollHeight - el.scrollTop - el.clientHeight;

/** True when a scrolling box is at, or within a hair of, its end. */
function atEnd(el: { scrollHeight: number; scrollTop: number; clientHeight: number }): boolean {
  return distance(el) <= NEAR_END;
}

/**
 * Keep a growing box scrolled to its end — until the person scrolls away.
 *
 * Following is decided by where they go, not by what arrives: at the end, new
 * content keeps them there; scrolled up to read something, it leaves them
 * alone. Jumping to the end on every update is what made scrolling back during
 * a run impossible, since each new line undid the scroll. Scrolling back down
 * to the end picks following up again.
 *
 * Scrolling up is what stops it, however little. It was being further than a
 * threshold from the end, which snagged both ways while the agent wrote: a
 * short scroll up, within the threshold, was undone by the next word; and the
 * box's own jump to the end, heard a frame later, was measured against what
 * had arrived since — more than the threshold, and following stopped on its
 * own.
 *
 * It holds the end whenever the content grows, not only when something is
 * added: a block of code that highlights, a picture that loads, the thinking
 * that grows into its lines. Those left the end behind until the next word,
 * then jumped to it.
 *
 * But not over something the person just opened. A tool call or the thinking
 * expanded at the end grows the content as much as new words do, and keeping
 * the end in view took what they clicked up and out of sight. For a moment
 * after a press on something that opens and closes (`aria-expanded`), once
 * the press has opened or closed it, it stays where it was, and whether the
 * box still follows is where that leaves it. Only then: a press on Copy in
 * the reply being written, which grows with every word, is not an opening.
 *
 * While it follows, the browser does not hold the content in view itself
 * (`overflow-anchor`): the oldest message dropped from the top of a long
 * conversation as a new one arrives moved the box up by as much, which read as
 * the person scrolling back, and following stopped on its own. Reading back, it
 * does, so what settles above does not move what is read.
 *
 * The jump is instant. A smooth one fires scroll events on its way that read as
 * the person leaving the end, and it ends up fighting them.
 *
 * `paused` holds it where it is while the caller shows something of its own —
 * the terminal, a command it was asked to show.
 *
 * `nested`, for a box inside another that follows — the reasoning, opened in
 * the chat: it leaves the browser's anchoring alone. Turned off there, it took
 * the box and all in it out of what the chat's own anchoring holds in view
 * while reading back; and its content only ever grows at the end.
 *
 * The box is given as `ref={attach}`: what watches it for growth goes with the
 * element, so a box drawn later, or drawn again as another element, is
 * watched too. `ref` is there to read it.
 */
export function useFollowBottom<T extends HTMLElement>({ paused, nested = false }: { paused?: () => boolean; nested?: boolean } = {}) {
  const ref = useRef<T | null>(null);
  const [node, setNode] = useState<T | null>(null);
  const following = useRef(true);
  // Where the box was last seen, to tell up from down.
  const top = useRef(0);
  // Whether to offer a way back to the end, for drawing. Kept apart from
  // `following`, which is read on every update and must not wait for a render.
  const [away, setAway] = useState(false);
  const anchor = useCallback(
    (el: HTMLElement) => {
      if (!nested) el.style.overflowAnchor = following.current ? "none" : "";
    },
    [nested],
  );
  /** Following or not, and the browser's own anchoring off while it does (see above). */
  const follows = useCallback(
    (yes: boolean) => {
      if (following.current === yes) return;
      following.current = yes;
      if (ref.current) anchor(ref.current);
    },
    [anchor],
  );
  const attach = useCallback(
    (el: T | null) => {
      ref.current = el;
      if (el) {
        // Another element starts from where it is, not where the last one was.
        top.current = el.scrollTop;
        anchor(el);
      }
      setNode(el);
    },
    [anchor],
  );
  // Not drawn at all — the chat, while voice mode shows instead.
  const hidden = useRef(false);
  // A button pressed in the box, for a moment: what it opens does not move it.
  const held = useRef<{ el: Element; item: Element; expanded: string | null; top: number; height: number; until: number } | null>(null);
  const isPaused = useRef(paused);
  isPaused.current = paused;

  const toEnd = useCallback((el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
    top.current = el.scrollTop;
  }, []);

  /**
   * Where the box has been taken since it was last seen. Its scroll event says
   * so, but only with the next frame: a touch or a drag of the scrollbar has
   * moved it before then, and a word arriving in between was put at the end
   * over it — so what grows asks first, too.
   */
  const heard = useCallback((el: HTMLElement) => {
    // A box that is not drawn measures nothing, which reads as being at its
    // end: whoever had scrolled back to read was taken to the end on coming
    // back. Drawn again, it is where it was last seen — put back there, should
    // the browser have let go of it.
    if (!el.clientHeight) {
      hidden.current = true;
      return;
    }
    if (hidden.current) {
      hidden.current = false;
      if (!following.current && Math.abs(el.scrollTop - top.current) > 0.5) el.scrollTop = top.current;
      top.current = el.scrollTop;
      return;
    }
    const left = distance(el);
    // At the very end — or put there because what was below it went away.
    if (left <= AT_END) follows(true);
    // Up, and not to the end: the person, reading back.
    else if (el.scrollTop < top.current - 0.5) follows(false);
    // Back down to near the end picks it up again.
    else if (el.scrollTop > top.current + 0.5 && left <= NEAR_END) follows(true);
    top.current = el.scrollTop;
  }, [follows]);

  /** Wire to the box's onScroll. */
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    heard(el);
    setAway(!following.current && !atEnd(el));
  }, [heard]);

  /**
   * Whether it follows, counting where the box has been taken and not yet
   * heard: for what is decided while the next update is drawn — whether the
   * chat's oldest message leaves the top as a new one comes, which, read back
   * but not yet heard, moved what was being read. It only looks; what it saw
   * is taken in by `follow`, once the update is on screen.
   */
  const isFollowing = useCallback(() => {
    const el = ref.current;
    if (!el || !following.current || hidden.current || !el.clientHeight) return following.current;
    return !(el.scrollTop < top.current - 0.5 && distance(el) > AT_END);
  }, []);

  /**
   * Wire to the box's onWheel: a turn of the wheel upwards is the person
   * leaving the end before the box has moved, so the next word does not undo it.
   * Not a turn that something inside takes — a long thinking or a block of
   * code scrolled back on its own — nor a sideways swipe or a pinch.
   */
  const onWheel = useCallback((e: { deltaY: number; deltaX: number; ctrlKey: boolean; target: EventTarget | null }) => {
    const box = ref.current;
    if (!box || e.ctrlKey || e.deltaY >= 0 || Math.abs(e.deltaX) > Math.abs(e.deltaY) || box.scrollTop <= 0) return;
    for (let el = e.target instanceof Element ? e.target : null; el && el !== box; el = el.parentElement) {
      if (el.scrollTop > 0 && el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY)) return;
    }
    follows(false);
  }, [follows]);

  /**
   * Wire to the box's onPointerDown and onKeyDown: a press on something that
   * opens — a tool call's header, the thinking's — keeps it where it is while
   * what it opens grows (see above). Anything else is not held: a click to
   * select or copy lets it go on following.
   */
  const hold = useCallback((e: { target: EventTarget | null }) => {
    const box = ref.current, target = e.target instanceof Element ? e.target.closest("[aria-expanded]") : null;
    if (!box || !target || !box.contains(target)) return;
    // The entry it is in, whose size says whether it opened: a child of the
    // list the box holds — the one element in it, as the chat's — or, where
    // the entries are the box's own children, of the box.
    const list = box.childElementCount === 1 ? box.firstElementChild! : box;
    let item: Element = target;
    while (item.parentElement && item.parentElement !== list && item.parentElement !== box) item = item.parentElement;
    held.current = { el: target, item, expanded: target.getAttribute("aria-expanded"), top: target.getBoundingClientRect().top, height: item.getBoundingClientRect().height, until: performance.now() + HOLD };
  }, []);

  /** Whatever a held button opened or closed: it stays put, and following is where that leaves it. True when it did. */
  const keepHeld = useCallback((el: HTMLElement) => {
    const h = held.current;
    if (!h) return false;
    if (performance.now() > h.until || !h.el.isConnected) {
      held.current = null;
      return false;
    }
    // Not opened or closed (yet): whatever else grew is followed as ever.
    if (h.el.getAttribute("aria-expanded") === h.expanded) return false;
    const height = h.item.getBoundingClientRect().height;
    if (height === h.height) return false;
    h.height = height;
    const drift = h.el.getBoundingClientRect().top - h.top;
    if (Math.abs(drift) >= 1) el.scrollTop += drift;
    top.current = el.scrollTop;
    follows(distance(el) <= AT_END);
    setAway(!following.current && !atEnd(el));
    return true;
  }, [follows]);

  /** Call after content changed; `force` to go to the end whatever they were doing. */
  const follow = useCallback((force = false) => {
    const el = ref.current;
    if (!el) return;
    if (force) {
      follows(true);
      held.current = null;
    } else if (keepHeld(el)) return;
    else heard(el);
    if (following.current) toEnd(el);
    // Said here as well as on scroll: a conversation too short to scroll fires
    // no scroll event, and the way back to the end offered in the last one,
    // scrolled up, stayed on screen in this one for good.
    setAway(!following.current && !atEnd(el));
  }, [toEnd, keepHeld, heard]);

  // Whatever grows — the box's content, or the box itself shrinking as the
  // composer or the keyboard takes room — keeps the end in view while following.
  useEffect(() => {
    const el = node;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (isPaused.current?.() || keepHeld(el)) return;
      heard(el);
      if (following.current) toEnd(el);
      else setAway(!atEnd(el));
    });
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    // A box whose content is a list of its own children — the terminal's runs —
    // grows by the ones added; the ones taken away are let go.
    const added = new MutationObserver((changes) => {
      for (const change of changes) {
        for (const node of change.addedNodes) if (node instanceof Element) observer.observe(node);
        for (const node of change.removedNodes) if (node instanceof Element) observer.unobserve(node);
      }
    });
    added.observe(el, { childList: true });
    return () => {
      observer.disconnect();
      added.disconnect();
    };
  }, [node, toEnd, keepHeld, heard]);

  /**
   * Following again if it is near the end, whichever way it got there: after
   * the caller has moved the box itself — the terminal, up a little to show a
   * command at its top, which read as the person scrolling up.
   */
  const settle = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    top.current = el.scrollTop;
    follows(atEnd(el));
    if (following.current) toEnd(el);
    setAway(!following.current && !atEnd(el));
  }, [toEnd, follows]);

  // Not `following` itself: read as it is, it misses a move not yet heard.
  return { ref, attach, onScroll, onWheel, hold, follow, settle, isFollowing, away };
}
