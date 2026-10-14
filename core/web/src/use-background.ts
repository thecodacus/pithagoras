import { useEffect, useMemo, useRef, useState } from "react";
import { api, type BackgroundState, type PortalEvent } from "./api";
import { stripAnsi } from "./transcript";
import { piRunning } from "./drafts";
import { pollWhileVisible } from "./poll";
import { reconcile } from "./reconcile";

const EMPTY: BackgroundState = { supported: false, jobs: [], statuses: [], widgets: [] };

/** Where a page was in its events when it asked: the newest live and stored seqs it held. */
export type Mark = { live: number; stored: number };
/** Before any event: every one is after it. */
const NOWHERE: Mark = { live: 0, stored: 0 };

export function markOf(events: PortalEvent[]): Mark {
  const mark = { live: 0, stored: 0 };
  for (const e of events) {
    if (e.seq < 0) mark.live = Math.min(mark.live, e.seq);
    else mark.stored = Math.max(mark.stored, e.seq);
  }
  return mark;
}

/**
 * What extensions say about themselves, as the portal last answered and then
 * as their events have said since: a status arrives as an event, and asking
 * the portal again for each — with a walk of /proc for the jobs — was a
 * request a moment, for text the page already had. Read back from the end of
 * the events to where the page was when it asked: new ones are appended.
 */
export function withLiveUi(state: BackgroundState, events: PortalEvent[], since: Mark): BackgroundState {
  let from = events.length;
  while (from > 0) {
    const e = events[from - 1];
    if (e.seq < 0 ? e.seq >= since.live : e.seq <= since.stored) break;
    from--;
  }
  const said = events.slice(from).filter((e) => e.type === "extension_ui_request" && (e.payload?.method === "setStatus" || e.payload?.method === "setWidget"));
  if (!said.length) return state;
  const statuses = new Map(state.statuses.map((s) => [s.key, s.text]));
  const widgets = new Map(state.widgets.map((w) => [w.key, w.lines]));
  const plain = (t: unknown) => stripAnsi(String(t ?? "")).trim();
  for (const { payload: p } of said) {
    if (p.method === "setStatus" && typeof p.statusKey === "string") {
      const text = plain(p.statusText);
      if (text) statuses.set(p.statusKey, text);
      else statuses.delete(p.statusKey);
    }
    if (p.method === "setWidget" && typeof p.widgetKey === "string") {
      const lines = Array.isArray(p.widgetContent) ? p.widgetContent.map(plain) : [];
      if (lines.some(Boolean)) widgets.set(p.widgetKey, lines);
      else widgets.delete(p.widgetKey);
    }
  }
  return {
    ...state,
    statuses: [...statuses].map(([key, text]) => ({ key, text })),
    widgets: [...widgets].map(([key, lines]) => ({ key, lines })),
  };
}

/**
 * Jobs the agent left running, and what extensions say about themselves,
 * asked for every few seconds while the page is looked at — more often while
 * something is running — and once at once when a job was stopped. What
 * extensions say after that comes with the events.
 */
export function useBackground(sessionId: string, busy: boolean, events: PortalEvent[]): [BackgroundState, () => void] {
  // Kept with the chat it is of. Cleared in an effect, another chat's state
  // lasted a render into the next, long enough for its status lines to make
  // this one list its commands, which starts its pi.
  const [held, setHeld] = useState<{ sessionId: string; state: BackgroundState; since: Mark }>({ sessionId, state: EMPTY, since: NOWHERE });
  const state = held.sessionId === sessionId ? held.state : EMPTY;
  const current = useRef(sessionId);
  current.current = sessionId;
  const latest = useRef(events);
  latest.current = events;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    const load = () => {
      if (document.hidden) return;
      // Where the events were as it asked: anything after may not be in the answer.
      const since = markOf(latest.current);
      api.background(sessionId).then(
        (s) => {
          if (!live || current.current !== sessionId) return;
          const state = normalize(s);
          piRunning(sessionId, state.piRunning === true);
          // The same object when nothing changed: asked every few seconds, an answer that says
          // what the last did is no reason to draw the chat again.
          setHeld((prev) => {
            const mine = prev.sessionId === sessionId;
            const kept = mine ? reconcile(prev.state, state) : state;
            return mine && kept === prev.state && prev.since.live === since.live && prev.since.stored === since.stored ? prev : { sessionId, state: kept, since };
          });
        },
        () => undefined,
      );
    };
    load();
    const running = state.jobs.some((j) => j.state === "running");
    const stop = pollWhileVisible(load, busy || running ? 2000 : 6000);
    return () => {
      live = false;
      stop();
    };
  }, [sessionId, busy, tick, state.jobs.some((j) => j.state === "running")]);
  // Where this chat's events were when its answer was asked for. Another
  // chat's would take this one's statuses for ones its answer already had.
  const since = held.sessionId === sessionId ? held.since : NOWHERE;
  const shown = useMemo(() => withLiveUi(state, events, since), [state, since, events]);
  return [shown, () => setTick((n) => n + 1)];
}

/**
 * Only what the chat can draw. A server from before this endpoint, or a proxy
 * answering in its place, sends something else, and a missing list here was a
 * TypeError that took the whole page down with it.
 */
function normalize(s: Partial<BackgroundState> | null | undefined): BackgroundState {
  const list = <T,>(v: T[] | undefined): T[] => (Array.isArray(v) ? v : []);
  return { supported: s?.supported === true, jobs: list(s?.jobs), statuses: list(s?.statuses), widgets: list(s?.widgets), piRunning: s?.piRunning === true };
}
