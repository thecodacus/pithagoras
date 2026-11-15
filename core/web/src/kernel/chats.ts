import { ApiError, type ChatMode, type PortalEvent, type PromptOptions, type SessionStatus, type api as realApi } from "../api";
import type { UiRequest } from "../components/ExtensionDialog";
import { t } from "../i18n";
import { appendLiveEvents, resetLiveEvents } from "../live-events";
import { modeConfirm, modeLabel } from "../mode-names";
import { reconnectDelay, type Visibility } from "../poll";
import { toolNameOf } from "../tool-payload";
import { flaggedOf, toolOutputText } from "../transcript";
import * as questions from "./confirms";
import type { Ask, Unasked } from "./confirms";
import type { Sessions } from "./sessions";
import { createStore, type Store } from "./store";

/**
 * The chats the page has open, and what a person does in one.
 *
 * A chat's events come on a stream of its own (replay, then the tail). The kernel keeps one stream for each chat
 * however many parts of the page read it, and at most `MOST_LIVE` of them at once: the browser allows six connections
 * to one origin, shared by every tab, and the portal speaks HTTP/1.1, so a page with many chats streaming would
 * leave no connection for its own `/api` calls. The chat on screen has one first; of the others, those that asked
 * first keep theirs, and the rest get a snapshot of the chat's latest events, asked for again every few seconds.
 *
 * What a stream says that is not the conversation is passed on, from the chat on screen's: what the installed
 * extensions' server halves tell their browser halves, the dialogs an extension is blocking on, the fills of the
 * message box, and the chat's status for the list. A chat read beside it (a child chat's run in a panel) is only read.
 */

/** Live streams a page keeps at once: the most that leaves the browser's connections to `/api`. */
export const MOST_LIVE = 4;
/** How much of a chat a snapshot holds: the latest events, as a stream's replay is. */
const SNAPSHOT_EVENTS = 200;
/** How often a snapshot is asked for again. */
const SNAPSHOT_MS = 5000;

export interface ChatState {
  /** The chat's own events: pi's and the portal's (`portal_*`). Of a long conversation its latest part, more as it is paged back. */
  events: PortalEvent[];
  /** The versions of the chat's messages, as its stream says: see messageVersions on the server. */
  versions: Readonly<Record<number, number[]>>;
  /** How the chat stands, as its events last said: "idle" until one says otherwise. */
  status: SessionStatus;
  /** The replay (or the snapshot) has arrived: before that the events are not the chat, and drawn they would be half-built. */
  loaded: boolean;
  /** Whether anything older than what is held is still on the server. */
  moreBefore: boolean;
  loadingBefore: boolean;
  /** Connection attempts that failed in a row. */
  failures: number;
  /** The portal says it has no such chat: deleted, say, on another device. Nothing more is asked. */
  missing: boolean;
  /** The questions an extension is blocking on, in the order they came (select, confirm, input, editor). */
  dialogs: readonly UiRequest[];
  /** Results of the chat the person trusted here, by the id of the result. */
  trusted: readonly string[];
  /** Streamed; false for a snapshot asked for every few seconds, past `MOST_LIVE`. */
  live: boolean;
}

/** Before a chat's stream is open: the same object each time, as `useSyncExternalStore` wants. */
export const LOADING: ChatState = {
  events: Object.freeze([]) as unknown as PortalEvent[],
  versions: {},
  status: "idle",
  loaded: false,
  moreBefore: false,
  loadingBefore: false,
  failures: 0,
  missing: false,
  dialogs: [],
  trusted: [],
  live: true,
};

/** The part of an `EventSource` a stream uses; tests give their own. */
export interface StreamSource {
  onopen: ((e: unknown) => void) | null;
  onmessage: ((m: { data: string }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  addEventListener(type: string, listener: (m: { data: string }) => void): void;
  close(): void;
}

/** Where what is not the conversation goes: the extensions' side of the page, which the data layer does not import. */
export interface FanOut {
  /** What an extension's server half said to the pages open on a chat. */
  serverPush(chatId: string, extension: string, data: unknown): void;
  /** What an extension said to its browser half in a chat (`portal_extension_ui`). */
  extensionMessage(chatId: string, extension: string, data: unknown): void;
  /** An event of the chat on screen: a fill of the message box goes to it. */
  fill(chatId: string, event: PortalEvent): void;
  /** The chat whose stream is on screen, or none: the one a browser half that comes later has missed the start of. */
  onScreen(chatId: string | undefined): void;
}

export type ChatsApi = Pick<
  typeof realApi,
  "olderEvents" | "session" | "prompt" | "abort" | "editMessage" | "deleteMessage" | "takeBackQueued" | "sendQueuedNow" | "switchVersion" | "trustFlagged" | "chatModes" | "setMode" | "renameSession" | "compact" | "respondUi"
>;

export interface ChatsDeps {
  api: ChatsApi;
  ask: Ask;
  /** Opens a chat's stream at an address. */
  open: (url: string) => StreamSource;
  /** Calls `tick` every `ms` while the page is on screen (poll.ts). */
  poll: (tick: () => void, ms: number) => () => void;
  /** Calls `run` at the next frame, or a little later where frames are not drawn (a tab nobody sees). Returns the cancel. */
  frame: (run: () => void) => () => void;
  /** What the list needs of a chat's stream: its status, at once, and a fresh list; and a chat's title, to name it in a question. */
  sessions: Pick<Sessions, "patchStatus" | "refresh"> & Partial<Pick<Sessions, "find">>;
  fanOut: FanOut;
  /** Live streams at once; `MOST_LIVE` unless a test says otherwise. */
  most?: number;
  /**
   * Whether the page is on screen (`document`). While it is not, only the chat on screen keeps its stream: the browser's
   * connections are shared by every tab of the portal, and a tab nobody looks at should not hold them.
   */
  visibility?: Visibility;
  /** Where an action reads the chat it is bound to (to name it in a question, to find what it answers): this store, unless a harness holds the chats. */
  read?: (id: string) => ChatState;
}

/** What `deleteMessage`, `trustFlagged` and `setMode` take: the question comes first, and `accepted` once it was said yes to. */
export interface Asked extends Unasked {
  /** Called once the person said yes (at once where nothing is asked), right before the portal is asked: a view's own sign that it is on its way. */
  accepted?: () => void;
}

/** A chat's actions, bound to its id: one that asks (rule 8 of the data contract) asks here, whatever calls it. */
export interface ChatController {
  readonly id: string;
  send(message: string, options?: PromptOptions): Promise<void>;
  abort(): Promise<void>;
  /** Replaces a sent message: it and everything after it are dropped, and the new text is sent. */
  edit(seq: number, message: string): Promise<void>;
  /** Removes a sent message and the agent's answer to it, once the person says yes. False where they said no. */
  deleteMessage(seq: number, asked?: Asked): Promise<boolean>;
  /** Removes the turn a flagged result came in (the message that began it, and the answer): the same as `deleteMessage`, and asks the same. */
  removeTurn(seq: number, asked?: Asked): Promise<boolean>;
  /** Trusts a result flagged as a suspected prompt injection, once the person says yes. False where they said no. */
  trustFlagged(result: string, asked?: Asked): Promise<boolean>;
  queued: {
    /** Takes back a message that waits for the agent to read it. */
    takeBack(seq: number): Promise<void>;
    /** Stops the run and sends a waiting message now, the others still waiting behind it. */
    sendNow(seq: number): Promise<void>;
  };
  /** Shows another version of a message, and what followed it then. */
  switchVersion(seq: number, to: number): Promise<void>;
  /** Folds the conversation so far into a summary, to make room in the model's window. */
  compact(): Promise<void>;
  /**
   * Answers a question the agent asked in the chat (its `ask_question` tool: a `portal_question` event of the chat), or
   * cancels any question. What an extension of the agent asks in a dialog (the guard's question before a call it held,
   * among them) is answered in the portal's own dialog, and only cancelled here: `ok: false` for any other answer.
   */
  respond(requestId: string, answer: { value?: unknown; cancelled?: boolean }): Promise<{ ok: boolean; note?: string }>;
  /** Reads what is above the oldest event held. */
  loadEarlier(): Promise<void>;
  rename(title: string): Promise<void>;
  /** The modes the chat may be put in: none where it may not choose one. */
  modes(): Promise<ChatMode[]>;
  /**
   * Puts the chat, which has said nothing yet, in a mode. A mode that asks first (an extension's `confirm`) is asked
   * about here: False where the person said no.
   */
  setMode(mode: string, asked?: Asked): Promise<boolean>;
}

interface Entry {
  id: string;
  state: Store<ChatState>;
  /** How many parts of the page read it. */
  count: number;
  /** When it was first read: the order past the chat on screen. */
  order: number;
  mode: "live" | "polled" | null;
  /** Whether the live stream is passing on what it hears (it was the chat on screen when it opened). */
  fanning: boolean;
  /** What stops the live stream or the polling. */
  stop: () => void;
  /** Reads on from where the stream is, over a new connection. */
  reconnect?: () => void;
  /** The live stream's connection is open: what the server says as a stream opens may have been heard already. */
  opened: boolean;
  /** How often the chat was loaded again from the start: what was asked for before is the old list's. */
  loadedAgain: number;
}

/**
 * One list of events is read by the chat on screen, by every part that reads the chat, and by the kernel's own questions
 * (which quote a message, name the tool a result came from): a part that sorted it, or cut a payload short for its own
 * drawing, would change all of them, and a question would no longer say what the action does. So what the store holds is
 * frozen, and a part that changes it fails at the line that does. An event is frozen once, as it first comes in.
 */
function frozen(events: PortalEvent[]): void {
  for (const ev of events) if (!Object.isFrozen(ev)) deepFreeze(ev);
  Object.freeze(events);
}

function deepFreeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const inner of Object.values(value)) deepFreeze(inner);
}

const statusOf = (events: readonly PortalEvent[]): SessionStatus | undefined => {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "portal_status") return (events[i].payload as { status?: SessionStatus } | undefined)?.status;
  }
  return undefined;
};

/** The id in the list of dialogs: an extension's question waits until it is answered or cancelled. */
const DIALOGS = ["select", "confirm", "input", "editor"];

export function createChats(deps: ChatsDeps) {
  const { api, sessions, fanOut } = deps;
  const most = deps.most ?? MOST_LIVE;
  const entries = new Map<string, Entry>();
  let counter = 0;
  /** The chat on screen: the one whose stream is passed on. */
  const screen = createStore<string | undefined>(undefined);
  const hidden = () => deps.visibility?.hidden ?? false;
  // For the page's lifetime, as the stores are.
  deps.visibility?.addEventListener("visibilitychange", () => rebalance());

  const set = (e: Entry, change: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) =>
    e.state.update((s) => {
      const next = { ...s, ...(typeof change === "function" ? change(s) : change) };
      if (next.events !== s.events) frozen(next.events);
      return next;
    });

  /** A chat's stream: replay, then tail. Keeps what is shown until a reload has all come. `keep`: there is something shown to keep. */
  function startLive(e: Entry, keep: boolean): void {
    const id = e.id;
    let cancelled = false;
    let seq = 0;
    let failed = 0;
    // Loading the chat again, from the start: what arrives replaces what is held, once it has all come. See portal_reload.
    let replacing = keep;
    // How often the chat's events were put back under seqs this page had read past, as its stream last said: see bumpReloads on the server.
    let reloads: number | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let source: StreamSource | undefined;
    // Counts the connections: what was asked about one that has since been replaced (`reconnect`) is not acted on.
    let generation = 0;
    // Whether the connection now open has sent all of its replay: one cut off before that has to be read again from the start.
    let caughtUp = false;
    // Once caught up, what arrives is applied a frame at a time, not an event at a time: a reply is a token every few
    // milliseconds, and each was a draw of the chat.
    let pending: PortalEvent[] = [];
    let cancelFrame: (() => void) | undefined;
    const drain = () => {
      cancelFrame?.();
      cancelFrame = undefined;
      const batch = pending;
      pending = [];
      if (batch.length) set(e, (s) => ({ events: appendLiveEvents(s.events, batch), status: statusOf(batch) ?? s.status }));
    };
    const soon = () => {
      cancelFrame ??= deps.frame(drain);
    };
    /** Passing on what the stream says is for the chat on screen, whenever it is that. */
    const fan = () => screen.get() === id;
    const connect = () => {
      if (cancelled) return;
      generation++;
      e.fanning = fan();
      e.opened = false;
      caughtUp = false;
      const fresh = seq === 0;
      // The id may be an extension's (`chats.useEvents`): it is one part of the address, whatever it holds.
      const es = deps.open(`/api/sessions/${encodeURIComponent(id)}/events?since=${seq}`);
      source = es;
      /** Reads the chat again from the start, keeping what is shown until it has all come. */
      const reload = () => {
        es.close();
        seq = 0;
        replacing = true;
        connect();
      };
      es.onopen = () => {
        e.opened = true;
        failed = 0;
        set(e, { failures: 0 });
      };
      // A count other than the last one seen: events came back while this page was away, under seqs it had read past,
      // and going on from its cursor would never show them. A stream reading from the start has them all.
      es.addEventListener("reloads", (m) => {
        const now = (JSON.parse(m.data) as { reloads: number }).reloads;
        const missed = reloads !== undefined && now !== reloads && !fresh;
        reloads = now;
        if (missed) reload();
      });
      es.addEventListener("versions", (m) => set(e, { versions: (JSON.parse(m.data) as { versions: Record<number, number[]> }).versions }));
      es.addEventListener("live-reset", () => {
        drain();
        set(e, (s) => ({ events: resetLiveEvents(s.events) }));
      });
      // What the installed extensions' server halves tell what they drew on this chat: see extensions/server-feed.ts.
      es.addEventListener("extension", (m) => {
        if (!fan()) return;
        const { extension, data } = JSON.parse(m.data) as { extension: string; data: unknown };
        fanOut.serverPush(id, extension, data);
      });
      // Until it has caught up, what arrives is history being replayed. It is gathered and applied in one go: drawing
      // the conversation once per event is what made a long one open at the top, build downwards over seconds and then jump to the end.
      let replay: PortalEvent[] | null = [];
      // Applied straight from the event, not by re-fetching: the round trip is what made the Stop button appear a beat
      // late, or not at all when the reply came back before the list did.
      const applyStatus = (ev: PortalEvent) => {
        if (ev.type !== "portal_status" || !fan()) return;
        const status = (ev.payload as { status?: SessionStatus }).status;
        if (status) sessions.patchStatus(id, status);
        sessions.refresh().catch(() => {});
      };
      // Dialogs an extension is blocking on. notify/setStatus/setWidget are one-way and must not open a modal.
      const applyDialog = (ev: PortalEvent) => {
        if (ev.type === "extension_ui_request") {
          const req = ev.payload as UiRequest;
          if (DIALOGS.includes(req.method)) set(e, (s) => (s.dialogs.some((x) => x.id === req.id) ? {} : { dialogs: [...s.dialogs, req] }));
        }
        if (ev.type === "extension_ui_cancel") {
          const asked = (ev.payload as { id: string }).id;
          set(e, (s) => (s.dialogs.some((x) => x.id === asked) ? { dialogs: s.dialogs.filter((x) => x.id !== asked) } : {}));
        }
      };
      const flush = () => {
        const batch = replay;
        replay = null;
        if (!batch) return;
        if (replacing) {
          replacing = false;
          // What was being fetched from above the old list belongs to it.
          e.loadedAgain++;
          set(e, { loadingBefore: false, events: appendLiveEvents([], batch) });
        } else if (batch.length) set(e, (s) => ({ events: appendLiveEvents(s.events, batch) }));
        if (!batch.length) return;
        set(e, (s) => ({ status: statusOf(batch) ?? s.status }));
        // Only where the chat ended up is news; the statuses it passed through on the way were each a request for the list.
        const last = [...batch].reverse().find((ev) => ev.type === "portal_status");
        if (last) applyStatus(last);
        batch.forEach(applyDialog);
        if (fan()) for (const ev of batch) fanOut.fill(id, ev);
      };
      es.onmessage = (m) => {
        const ev: PortalEvent = JSON.parse(m.data);
        // A message was taken out of the conversation: drop what it covered, rather than reloading everything to find
        // out what is left. While the replay is still being gathered that buffer is where they are, so it is filtered
        // instead of the held list.
        if (ev.type === "portal_removed") {
          // What arrived before it is in the list it filters.
          drain();
          // `also` and `kept`: messages sent into a run go with the stretch the agent read them in, not the one whose seq range they were sent in.
          const { from, to, also = [], kept = [], reloads: now } = ev.payload as { from: number; to: number | null; also?: number[]; kept?: number[]; reloads?: number };
          // Heard, so not missed: the count this brings is not a reason to load again.
          if (now !== undefined) reloads = now;
          const covered = (at: number) => also.includes(at) || (at >= from && (to == null || at < to) && !kept.includes(at));
          if (replay) replay = replay.filter((x) => !covered(x.seq));
          else set(e, (s) => ({ events: s.events.filter((x) => !covered(x.seq)) }));
          return;
        }
        // Another version of a message was brought back, or an edit undone: events came back under seqs this stream
        // has read past, so it reads the chat again from the start.
        if (ev.type === "portal_versions") {
          set(e, { versions: (ev.payload as { versions: Record<number, number[]> }).versions });
          return;
        }
        if (ev.type === "portal_reload") {
          reloads = (ev.payload as { reloads?: number }).reloads ?? reloads;
          drain();
          reload();
          return;
        }
        // An extension to what its browser half drew in this chat: theirs, and nothing of the conversation.
        if (ev.type === "portal_extension_ui") {
          if (fan()) {
            const { extension, data } = ev.payload as { extension: string; data: unknown };
            fanOut.extensionMessage(id, extension, data);
          }
          return;
        }
        // Live-only events (dialogs) use a negative seq and must not move the resume cursor, or reconnecting would skip real history.
        if (ev.seq > 0) seq = ev.seq;
        if (replay) {
          replay.push(ev);
          return;
        }
        pending.push(ev);
        soon();
        applyStatus(ev);
        applyDialog(ev);
        if (fan()) fanOut.fill(id, ev);
      };
      es.addEventListener("caught-up", () => {
        caughtUp = true;
        // The dialogs this connection's replay holds are the ones open now: the server sends each that is still open as
        // a stream opens. One this page heard of on an earlier connection and the replay lacks was answered or timed
        // out while it was away, and no cancel will come for it.
        if (e.state.get().dialogs.length) set(e, { dialogs: [] });
        flush();
        set(e, { loaded: true });
        // Only now do we know where the replayed window starts, and therefore whether the conversation continues above it.
        const asked = e.loadedAgain;
        const oldest = e.state.get().events.find((x) => x.seq > 0)?.seq;
        if (oldest === undefined) return;
        api
          .olderEvents(id, oldest, 1)
          // The answer for a chat that was loaded again since says nothing of the one shown now.
          .then((r) => asked === e.loadedAgain && set(e, { moreBefore: r.events.length > 0 }))
          .catch(() => {});
      });
      es.onerror = () => {
        drain();
        // Keep what arrived once the chat has caught up: the resume cursor has already moved past it. Cut off before that,
        // what was read is not the chat, and the cursor is past it: the chat is read again from the start, whatever is shown
        // staying until all of it has come. The same when the chat was being read again: part of it would replace all of
        // what is shown.
        if (replacing || replay?.length) {
          replay = null;
          seq = 0;
          replacing = true;
        } else flush();
        es.close();
        failed += 1;
        set(e, { failures: failed });
        // Said by the portal: it has no such chat, which is not an outage to keep retrying. A connection made while it
        // was asked (the chat opened, and reconnected) is the one that counts: a second would be left open beside it.
        const asked = generation;
        api.session(id).then(
          () => {
            if (!cancelled && asked === generation) retry = setTimeout(connect, reconnectDelay(failed));
          },
          (err) => {
            if (cancelled || asked !== generation) return;
            if (err instanceof ApiError && err.status === 404) gone(e);
            else retry = setTimeout(connect, reconnectDelay(failed));
          },
        );
      };
    };
    e.reconnect = () => {
      if (cancelled) return;
      source?.close();
      clearTimeout(retry);
      // Its replay was not all in: what it held went with the connection, and the cursor is past it. As when a stream
      // breaks there, the chat is read again from the start, whatever is shown staying until all of it has come.
      if (!caughtUp) {
        seq = 0;
        replacing = true;
      }
      connect();
    };
    connect();
    e.stop = () => {
      cancelled = true;
      clearTimeout(retry);
      cancelFrame?.();
      source?.close();
      e.reconnect = undefined;
    };
  }

  /**
   * The portal says it has no such chat: nothing more is asked of it, so its stream or polling stops, and it holds no
   * place from then on (`rebalance` leaves it out), a chat that exists taking it.
   */
  function gone(e: Entry): void {
    set(e, { missing: true, loaded: true });
    e.stop();
    rebalance();
  }

  /** A chat past `most`: its latest events, asked for now and again every few seconds. */
  function startPolled(e: Entry): void {
    let live = true;
    const tick = () =>
      api.olderEvents(e.id, Number.MAX_SAFE_INTEGER, SNAPSHOT_EVENTS).then(
        (r) => {
          if (!live) return;
          set(e, (s) => {
            // What was paged back stays above the snapshot, which only says what is newest.
            const first = r.events.find((x) => x.seq > 0)?.seq ?? Infinity;
            const above = s.events.filter((x) => x.seq > 0 && x.seq < first);
            return { events: [...above, ...appendLiveEvents([], r.events)], status: statusOf(r.events) ?? s.status, loaded: true, moreBefore: above.length ? s.moreBefore : r.more, failures: 0, live: false };
          });
        },
        (err) => {
          if (!live) return;
          if (err instanceof ApiError && err.status === 404) gone(e);
          else set(e, (s) => ({ failures: s.failures + 1 }));
        },
      );
    // Not while the page is hidden: nothing is drawn, and it is streamed again as the page comes back.
    if (!hidden()) void tick();
    const stop = deps.poll(() => void tick(), SNAPSHOT_MS);
    e.stop = () => {
      live = false;
      stop();
    };
  }

  /**
   * The chat on screen first, then in the order they were first read: the first `most` are streamed, the rest polled.
   * While the page is hidden only the chat on screen is streamed; the others wait, polled, until it is shown again.
   */
  function rebalance(): void {
    const order = [...entries.values()].filter((e) => !e.state.get().missing).sort((a, b) => Number(b.id === screen.get()) - Number(a.id === screen.get()) || a.order - b.order);
    const away = hidden();
    order.forEach((e, i) => {
      const mode = i < most && (!away || e.id === screen.get()) ? "live" : "polled";
      if (e.mode === mode) return;
      const had = e.mode;
      e.stop();
      e.stop = () => {};
      e.mode = mode;
      if (mode === "live") {
        // Taken back from a snapshot: it is read from the start, and what was shown stays until all of it has come.
        set(e, { live: true });
        startLive(e, had !== null);
      } else {
        set(e, { live: false });
        startPolled(e);
      }
    });
  }

  let scheduled = false;
  /**
   * `rebalance`, now where every chat read has a place (nothing is started that a next step takes back); where they
   * compete it is done once the step in progress is over. Switching chats is several steps (the old one is let go of,
   * by the chat view and by the frame, the new one is read, then opened), and done at each, the place the old one frees
   * would be given to a waiting chat, the new one polled for a moment, and the waiting chat's stream closed again: a
   * stream and two snapshots asked of the portal for nothing.
   */
  function rebalanceSoon(competing: boolean): void {
    if (!competing) return rebalance();
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      rebalance();
    });
  }

  /** Reads a chat: its stream is opened with the first to ask and closed with the last. Returns the release. */
  function acquire(id: string, onScreen = false): () => void {
    let e = entries.get(id);
    if (!e) {
      e = { id, state: createStore<ChatState>(LOADING), count: 0, order: ++counter, mode: null, fanning: false, opened: false, stop: () => {}, loadedAgain: 0 };
      entries.set(id, e);
    }
    e.count++;
    const held = e;
    if (onScreen) {
      screen.set(id);
      fanOut.onScreen(id);
    }
    if (held.count === 1 || onScreen) rebalanceSoon(entries.size > most);
    return () => {
      if (--held.count > 0) return;
      const competing = entries.size > most;
      held.stop();
      held.stop = () => {};
      if (entries.get(id) === held) entries.delete(id);
      // A place freed: the first of those that waited is streamed now.
      rebalanceSoon(competing);
    };
  }

  /** The chat shown, which has its stream before the others. Returns the release. */
  function open(id: string): () => void {
    const release = acquire(id, true);
    const e = entries.get(id)!;
    // It was streamed already, for a panel, before it was on screen: opened again, so that what the server says to a
    // page as a stream opens is said to this one too. Not where its connection has not opened yet (a chat view that
    // reads it is drawn, and so subscribes, before the frame that opens it): it has heard nothing, and passes on what
    // it hears from now on.
    if (e.mode === "live" && !e.fanning) {
      if (e.opened) e.reconnect?.();
      else e.fanning = true;
    }
    return () => {
      if (screen.get() === id) {
        screen.set(undefined);
        fanOut.onScreen(undefined);
        const left = entries.get(id);
        if (left) left.fanning = false;
      }
      release();
    };
  }

  /** A chat's state as it is: nothing before it is read. */
  const peek = (id: string): ChatState => entries.get(id)?.state.get() ?? LOADING;
  /** The store of a chat that is read now, for a hook to subscribe to. */
  const stateOf = (id: string): Store<ChatState> | undefined => entries.get(id)?.state;

  /** The extension's question was answered (or the person cancelled it): the next waits behind it. */
  function dismissDialog(id: string, requestId: string): void {
    const e = entries.get(id);
    if (e) set(e, (s) => (s.dialogs.some((x) => x.id === requestId) ? { dialogs: s.dialogs.filter((x) => x.id !== requestId) } : {}));
  }

  const controllers = new Map<string, ChatController>();
  /** The chat's actions: the same object each time, so that what is drawn with it is not drawn again for it. */
  function controller(id: string): ChatController {
    let c = controllers.get(id);
    if (c) return c;
    const refreshed = () => sessions.refresh().then(() => undefined, () => undefined);
    const events = () => (deps.read ?? peek)(id).events;
    /** The chat's title where it is not the one on screen: a question about another chat says which. */
    const elsewhere = () => (screen.get() === id ? undefined : sessions.find?.(id)?.title || id);
    const removeMessage = async (seq: number, asked?: Asked) => {
      if (!(await deps.ask(questions.byWhom(questions.deleteMessage({ chat: elsewhere(), text: messageText(events(), seq) }), asked?.unasked)))) return false;
      asked?.accepted?.();
      await api.deleteMessage(id, seq);
      return true;
    };
    c = {
      id,
      async send(message, options) {
        await api.prompt(id, message, options);
        void refreshed();
      },
      async abort() {
        await api.abort(id);
        void refreshed();
      },
      async edit(seq, message) {
        await api.editMessage(id, seq, message);
        void refreshed();
      },
      deleteMessage: removeMessage,
      removeTurn: removeMessage,
      async trustFlagged(result, asked) {
        if (!(await deps.ask(questions.byWhom(questions.trustFlagged({ chat: elsewhere(), tool: flaggedTool(events(), result) }), asked?.unasked)))) return false;
        asked?.accepted?.();
        await api.trustFlagged(id, result);
        const e = entries.get(id);
        if (e) set(e, (s) => (s.trusted.includes(result) ? {} : { trusted: [...s.trusted, result] }));
        return true;
      },
      queued: {
        async takeBack(seq) {
          await api.takeBackQueued(id, seq);
        },
        async sendNow(seq) {
          await api.sendQueuedNow(id, seq);
          void refreshed();
        },
      },
      async switchVersion(seq, to) {
        await api.switchVersion(id, seq, to);
      },
      async compact() {
        await api.compact(id);
        void refreshed();
      },
      async respond(requestId, answer) {
        // An answer other than "no" to anything but the agent's own question would say yes to a dialog the portal draws
        // itself, with what it warns of, without the person having seen it: the guard's question before a held call is one.
        if (!answer.cancelled && !events().some((ev) => ev.type === "portal_question" && (ev.payload as { id?: unknown } | undefined)?.id === requestId)) {
          return { ok: false, note: t("This is not a question the agent asked in this chat, so it was not answered here.") };
        }
        return api.respondUi(id, requestId, answer);
      },
      async loadEarlier() {
        const e = entries.get(id);
        if (!e) return;
        const { events, loadingBefore } = e.state.get();
        const oldest = events.find((x) => x.seq > 0)?.seq;
        if (!oldest || loadingBefore) return;
        set(e, { loadingBefore: true });
        const asked = e.loadedAgain;
        try {
          const r = await api.olderEvents(id, oldest);
          // Loaded again, or another chat opened, meanwhile: what is above the new list is another question.
          if (asked !== e.loadedAgain) return;
          set(e, (s) => ({ events: [...r.events, ...s.events], moreBefore: r.more }));
        } catch {
          // Leave the button where it is; trying again is free.
        } finally {
          // Not the flag of what was asked since: it was reset when the list was replaced, and may be set again.
          if (asked === e.loadedAgain) set(e, { loadingBefore: false });
        }
      },
      async rename(title) {
        await api.renameSession(id, title);
        await refreshed();
      },
      async modes() {
        return (await api.chatModes(id)).modes;
      },
      async setMode(mode, asked) {
        // One that cannot be read is not known to ask: the portal refuses a mode that asks without a yes.
        const list = await api.chatModes(id).then((r) => r.modes, () => [] as ChatMode[]);
        const picked = list.find((m) => m.id === mode);
        let confirmed = false;
        if (picked?.confirm) {
          if (!(await deps.ask(questions.byWhom(questions.useMode(modeLabel(picked), modeConfirm(picked) ?? picked.confirm), asked?.unasked)))) return false;
          confirmed = true;
        }
        asked?.accepted?.();
        await api.setMode(id, mode, confirmed || undefined);
        await refreshed();
        return true;
      },
    };
    // What every part of the page calls: one that replaced a method would replace it for the others too, the question with it.
    Object.freeze(c.queued);
    Object.freeze(c);
    controllers.set(id, c);
    return c;
  }

  return { screen, acquire, open, peek, stateOf, dismissDialog, controller, live: () => [...entries.values()].filter((e) => e.mode === "live").map((e) => e.id), polled: () => [...entries.values()].filter((e) => e.mode === "polled").map((e) => e.id) };
}

export type Chats = ReturnType<typeof createChats>;

/** How long the part of a message or a result that a question quotes is. */
const QUOTED = 80;
const quote = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > QUOTED ? `${flat.slice(0, QUOTED - 1)}…` : flat;
};

/** The start of the message sent at `seq`, where the chat's events hold it, to name it in the question. */
function messageText(events: readonly PortalEvent[], seq: number): string | undefined {
  const sent = events.find((ev) => ev.seq === seq && ev.type === "portal_prompt");
  const text = String((sent?.payload as { message?: unknown } | undefined)?.message ?? "").replace(/^\[Audio mode\]\n/, "");
  return text.trim() ? quote(text) : undefined;
}

/** The tool whose result the guard flagged with `result`, where the chat's events hold it. */
function flaggedTool(events: readonly PortalEvent[], result: string): string | undefined {
  for (const ev of events) {
    if (ev.type !== "tool_execution_end") continue;
    const text = toolOutputText((ev.payload as { result?: unknown } | undefined)?.result);
    if (typeof text === "string" && flaggedOf(text)?.id === result) return toolNameOf(ev.payload, "") || undefined;
  }
  return undefined;
}
