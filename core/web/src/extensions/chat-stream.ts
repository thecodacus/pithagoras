import { useCallback, useSyncExternalStore } from "react";
import { api, ApiError, type PortalEvent, type SessionStatus } from "../api";
import { appendLiveEvents, resetLiveEvents } from "../live-events";
import { reconnectDelay } from "../poll";

/**
 * `chats.useEvents`: a chat's events by its id, streamed as the chat on screen streams its own, for an extension that
 * draws a chat beside the one on screen (a child chat's run in a panel, with `ui.Transcript`). Of a long conversation
 * its latest part, as a page load replays it; nothing older is fetched.
 *
 * One stream for each chat however many parts ask, open while one of them is drawn: the last to go closes it, and
 * what it held goes with it.
 */
export interface ChatEvents {
  events: readonly PortalEvent[];
  /** How the chat stands, as its events last said: "idle" until one says otherwise. */
  status: SessionStatus;
  /** Its replay has not all come yet. */
  loading: boolean;
  /** The portal has no such chat: deleted, say, or never made. Nothing more is asked. */
  missing: boolean;
}

const EMPTY: ChatEvents = { events: [], status: "idle", loading: false, missing: false };

interface Stream {
  state: ChatEvents;
  watchers: Set<() => void>;
  close(): void;
}

const streams = new Map<string, Stream>();

function open(chatId: string): Stream {
  const stream: Stream = { state: { ...EMPTY, loading: true }, watchers: new Set(), close: () => {} };
  const set = (next: Partial<ChatEvents>) => {
    stream.state = { ...stream.state, ...next };
    for (const watcher of [...stream.watchers]) watcher();
  };
  let closed = false;
  let seq = 0;
  // How often the chat's events came back under seqs a reader had read past: the portal says it as a stream opens
  // (`reloads`), and a count other than the last one heard is a reload that was missed while the stream was down.
  let reloads: number | undefined;
  let failed = 0;
  let es: EventSource | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  // What comes once the replay is in is applied a little at a time, not a token at a time: each is a draw of the panel.
  let pending: PortalEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drain = () => {
    clearTimeout(timer);
    timer = undefined;
    const batch = pending;
    pending = [];
    if (batch.length) set({ events: appendLiveEvents(stream.state.events as PortalEvent[], batch), status: statusOf(batch) ?? stream.state.status });
  };
  const connect = () => {
    if (closed) return;
    // Read from the start (a reload of the chat): what comes replaces what is held once it has all come.
    const fresh = seq === 0;
    let replay: PortalEvent[] | null = [];
    const source = new EventSource(`/api/sessions/${encodeURIComponent(chatId)}/events?since=${seq}`);
    es = source;
    source.onopen = () => (failed = 0);
    source.addEventListener("reloads", (m) => {
      const now = (JSON.parse((m as MessageEvent).data) as { reloads: number }).reloads;
      const missed = reloads !== undefined && now !== reloads && !fresh;
      reloads = now;
      if (!missed) return;
      source.close();
      seq = 0;
      connect();
    });
    source.addEventListener("live-reset", () => {
      drain();
      set({ events: resetLiveEvents(stream.state.events as PortalEvent[]) });
    });
    source.addEventListener("caught-up", () => {
      const batch = replay ?? [];
      replay = null;
      const events = fresh ? appendLiveEvents([], batch) : appendLiveEvents(stream.state.events as PortalEvent[], batch);
      set({ events, status: statusOf(batch) ?? stream.state.status, loading: false });
    });
    source.onmessage = (m) => {
      const ev: PortalEvent = JSON.parse(m.data);
      // A message taken out of the conversation: what it covered goes (see the chat's own stream in App.tsx).
      if (ev.type === "portal_removed") {
        drain();
        const { from, to, also = [], kept = [], reloads: now } = ev.payload as { from: number; to: number | null; also?: number[]; kept?: number[]; reloads?: number };
        // Heard, so not missed: the count it brings is not a reason to read again.
        if (now !== undefined) reloads = now;
        const covered = (at: number) => also.includes(at) || (at >= from && (to == null || at < to) && !kept.includes(at));
        if (replay) replay = replay.filter((e) => !covered(e.seq));
        else set({ events: stream.state.events.filter((e) => !covered(e.seq)) });
        return;
      }
      // Its events came back under seqs this stream has read past: read again from the start.
      if (ev.type === "portal_reload") {
        reloads = (ev.payload as { reloads?: number }).reloads ?? reloads;
        drain();
        source.close();
        seq = 0;
        connect();
        return;
      }
      // Neither is anything of the conversation's.
      if (ev.type === "portal_versions" || ev.type === "portal_extension_ui") return;
      // A live one (a negative seq) never moves where a reconnect reads on from.
      if (ev.seq > 0) seq = ev.seq;
      if (replay) {
        replay.push(ev);
        return;
      }
      pending.push(ev);
      timer ??= setTimeout(drain, 50);
    };
    source.onerror = () => {
      drain();
      source.close();
      if (closed) return;
      // Cut off before the replay was all in: what was read sits in `replay`, which is gone, and `seq` is past it. Read
      // from the start again, or the chat would show only what came after.
      if (replay?.length) seq = 0;
      failed += 1;
      // Said by the portal: it has no such chat, which is not an outage to keep retrying.
      api.session(chatId).then(
        () => (retry = setTimeout(connect, reconnectDelay(failed))),
        (e) => {
          if (closed) return;
          if (e instanceof ApiError && e.status === 404) set({ missing: true, loading: false });
          else retry = setTimeout(connect, reconnectDelay(failed));
        },
      );
    };
  };
  connect();
  stream.close = () => {
    closed = true;
    clearTimeout(retry);
    clearTimeout(timer);
    es?.close();
  };
  return stream;
}

/** Where a chat's events leave it: the last status among them, or nothing where none says. */
function statusOf(events: readonly PortalEvent[]): SessionStatus | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === "portal_status") return (ev.payload as { status?: SessionStatus } | undefined)?.status;
  }
  return undefined;
}

function watch(chatId: string, watcher: () => void): () => void {
  let stream = streams.get(chatId);
  if (!stream) streams.set(chatId, (stream = open(chatId)));
  stream.watchers.add(watcher);
  return () => {
    stream.watchers.delete(watcher);
    if (stream.watchers.size || streams.get(chatId) !== stream) return;
    stream.close();
    streams.delete(chatId);
  };
}

/** A chat's events by its id, streamed while the component is drawn; nothing, and nothing asked, without an id. */
export function useChatEvents(chatId: string | undefined): ChatEvents {
  const subscribe = useCallback((watcher: () => void) => (chatId ? watch(chatId, watcher) : () => {}), [chatId]);
  return useSyncExternalStore(subscribe, () => (chatId ? streams.get(chatId)?.state ?? LOADING : EMPTY));
}

// Before the stream is open: the same object each time, as useSyncExternalStore wants.
const LOADING: ChatEvents = { ...EMPTY, loading: true };
