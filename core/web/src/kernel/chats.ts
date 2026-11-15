import { ApiError, type ChatMode, type PortalEvent, type PromptOptions, type SessionStatus, type api as realApi } from "../api";
import type { UiRequest } from "../components/ExtensionDialog";
import { appendLiveEvents, resetLiveEvents } from "../live-events";
import { modeConfirm, modeLabel } from "../mode-names";
import { reconnectDelay } from "../poll";
import * as questions from "./confirms";
import type { Ask } from "./confirms";
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
  events: [],
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
  /** What the list needs of a chat's stream: its status, at once, and a fresh list. */
  sessions: Pick<Sessions, "patchStatus" | "refresh">;
  fanOut: FanOut;
  /** Live streams at once; `MOST_LIVE` unless a test says otherwise. */
  most?: number;
}

/** What `deleteMessage`, `trustFlagged` and `setMode` take: the question comes first, and `accepted` once it was said yes to. */
export interface Asked {
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
  /** Answers a question the agent asked in the chat (`ask_user` and what an extension's dialog asks), or cancels it. */
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
  /** How often the chat was loaded again from the start: what was asked for before is the old list's. */
  loadedAgain: number;
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

  const set = (e: Entry, change: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) =>
    e.state.update((s) => ({ ...s, ...(typeof change === "function" ? change(s) : change) }));

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
      e.fanning = fan();
      const fresh = seq === 0;
      const es = deps.open(`/api/sessions/${id}/events?since=${seq}`);
      source = es;
      /** Reads the chat again from the start, keeping what is shown until it has all come. */
      const reload = () => {
        es.close();
        seq = 0;
        replacing = true;
        connect();
      };
      es.onopen = () => {
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
        // Said by the portal: it has no such chat, which is not an outage to keep retrying.
        api.session(id).then(
          () => {
            if (!cancelled) retry = setTimeout(connect, reconnectDelay(failed));
          },
          (err) => {
            if (cancelled) return;
            if (err instanceof ApiError && err.status === 404) set(e, { missing: true, loaded: true });
            else retry = setTimeout(connect, reconnectDelay(failed));
          },
        );
      };
    };
    e.reconnect = () => {
      if (cancelled) return;
      source?.close();
      clearTimeout(retry);
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
          if (err instanceof ApiError && err.status === 404) set(e, { missing: true, loaded: true });
          else set(e, (s) => ({ failures: s.failures + 1 }));
        },
      );
    void tick();
    const stop = deps.poll(() => void tick(), SNAPSHOT_MS);
    e.stop = () => {
      live = false;
      stop();
    };
  }

  /** The chat on screen first, then in the order they were first read: the first `most` are streamed, the rest polled. */
  function rebalance(): void {
    const order = [...entries.values()].sort((a, b) => Number(b.id === screen.get()) - Number(a.id === screen.get()) || a.order - b.order);
    order.forEach((e, i) => {
      const mode = i < most ? "live" : "polled";
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

  /** Reads a chat: its stream is opened with the first to ask and closed with the last. Returns the release. */
  function acquire(id: string, onScreen = false): () => void {
    let e = entries.get(id);
    if (!e) {
      e = { id, state: createStore<ChatState>(LOADING), count: 0, order: ++counter, mode: null, fanning: false, stop: () => {}, loadedAgain: 0 };
      entries.set(id, e);
    }
    e.count++;
    const held = e;
    if (onScreen) {
      screen.set(id);
      fanOut.onScreen(id);
    }
    if (held.count === 1 || onScreen) rebalance();
    return () => {
      if (--held.count > 0) return;
      held.stop();
      held.stop = () => {};
      if (entries.get(id) === held) entries.delete(id);
      // A place freed: the first of those that waited is streamed now.
      rebalance();
    };
  }

  /** The chat shown, which has its stream before the others. Returns the release. */
  function open(id: string): () => void {
    const release = acquire(id, true);
    const e = entries.get(id)!;
    // It was streamed already, for a panel, before it was on screen: opened again, so that what the server says to a
    // page as a stream opens is said to this one too.
    if (e.mode === "live" && !e.fanning) e.reconnect?.();
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
    const removeMessage = async (seq: number, asked?: Asked) => {
      if (!(await deps.ask(questions.deleteMessage()))) return false;
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
        if (!(await deps.ask(questions.trustFlagged()))) return false;
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
      respond: (requestId, answer) => api.respondUi(id, requestId, answer),
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
          if (!(await deps.ask(questions.useMode(modeLabel(picked), modeConfirm(picked) ?? picked.confirm)))) return false;
          confirmed = true;
        }
        asked?.accepted?.();
        await api.setMode(id, mode, confirmed || undefined);
        await refreshed();
        return true;
      },
    };
    controllers.set(id, c);
    return c;
  }

  return { screen, acquire, open, peek, stateOf, dismissDialog, controller, live: () => [...entries.values()].filter((e) => e.mode === "live").map((e) => e.id), polled: () => [...entries.values()].filter((e) => e.mode === "polled").map((e) => e.id) };
}

export type Chats = ReturnType<typeof createChats>;
