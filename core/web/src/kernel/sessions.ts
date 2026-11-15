import { ApiError, type Session, type SessionStatus, type api as realApi } from "../api";
import { reconcile } from "../reconcile";
import { splitSubChats } from "../sub-chats";
import * as questions from "./confirms";
import type { Ask } from "./confirms";
import { createStore, type Store } from "./store";

/**
 * The chat list, and what a person does to a chat from it. The kernel owns it (the shell used to): the list is asked
 * for once and every few seconds while the page is on screen, whoever draws it, and an action is one call here that
 * asks what must be asked, calls the portal, and brings the list up to date.
 */

/** `loading` until the list was asked for; `offline` when the last time it was asked for did not answer. */
export type SessionsStatus = "loading" | "ready" | "offline";

export interface SessionsState {
  /** The task list: agent and routine chats are not in it (see `chat`). Kept as it was when a poll says the same. */
  list: Session[];
  status: SessionsStatus;
  executor: string;
  /** What the first ask failed with, until a list comes: the page says it once, and the poll is the retry. */
  error: string | null;
}

/** A chat that is not in the list, which its address opens: an agent's, a routine's, a sub-chat an extension keeps out of it. */
export interface Unlisted {
  session: Session | null;
  /** The portal says it has no such chat: deleted, say, on another device. Not an outage to keep retrying. */
  missing: boolean;
}

export type SessionsApi = Pick<typeof realApi, "sessions" | "session" | "createSession" | "renameSession" | "pinSession" | "deleteSession">;

export interface SessionsDeps {
  api: SessionsApi;
  ask: Ask;
  /** What is installed changed since the page last went through it, wherever it was changed (see EXTENSIONS_CHANGED). */
  installed?: (revision: string) => void;
  /** Calls `tick` every `ms` while the page is on screen, and returns what stops it (poll.ts). */
  poll: (tick: () => void, ms: number) => () => void;
}

/** How often the list, and a chat outside it, are asked for again. Events keep a chat current between ticks. */
export const LIST_MS = 5000;

const none: Unlisted = { session: null, missing: false };

export function createSessions(deps: SessionsDeps) {
  const { api } = deps;
  const store = createStore<SessionsState>({ list: [], status: "loading", executor: "host", error: null });
  /** The chats outside the list that something looks at, by id. */
  const unlisted = createStore<Readonly<Record<string, Unlisted>>>({});
  const listed = (id: string) => store.get().list.some((s) => s.id === id);

  /** Asks for the list. Rejects when the portal does not answer; the state says so too. */
  async function refresh(): Promise<Session[]> {
    let r: Awaited<ReturnType<SessionsApi["sessions"]>>;
    try {
      r = await api.sessions();
    } catch (e) {
      store.update((s) => (s.status === "offline" ? s : { ...s, status: "offline" }));
      throw e;
    }
    deps.installed?.(r.extensions);
    // Kept as it was when it says the same: a list asked for every few seconds is mostly unchanged, and a new array is a draw for nothing.
    store.update((s) => ({ list: reconcile(s.list, r.sessions), status: "ready", executor: r.executor, error: null }));
    return store.get().list;
  }

  /** Asks for the list now and every few seconds while the page is on screen. Returns what stops it. */
  function start(): () => void {
    refresh().catch((e) => store.update((s) => ({ ...s, status: "offline", error: (e as Error).message })));
    return deps.poll(() => refresh().catch(() => {}), LIST_MS);
  }

  const setUnlisted = (id: string, next: Unlisted | null) =>
    unlisted.update((all) => {
      if (!next) {
        if (!(id in all)) return all;
        const { [id]: _gone, ...rest } = all;
        return rest;
      }
      const was = all[id];
      return was && was.missing === next.missing ? { ...all, [id]: { ...was, session: reconcile(was.session, next.session), missing: next.missing } } : { ...all, [id]: next };
    });

  const watching = new Map<string, { count: number; stop: () => void }>();
  /**
   * Keeps a chat the list does not have in view, for as long as something is looking at it: fetched, and again every
   * few seconds (the list's own poll is what keeps a listed chat current). Without it a link to an agent's or a
   * routine's chat landed on the empty state. Returns the release.
   */
  function watch(id: string): () => void {
    let w = watching.get(id);
    if (!w) {
      let live = true;
      const load = () => {
        // In the list since: that is the one to read, and this holds nothing.
        if (listed(id)) return setUnlisted(id, null);
        api.session(id).then(
          (s) => live && setUnlisted(id, { session: s, missing: false }),
          (e) => {
            if (!live) return;
            // Said by the portal: it has no such chat, which is not an outage to keep retrying.
            if (e instanceof ApiError && e.status === 404) setUnlisted(id, { session: null, missing: true });
            else setUnlisted(id, { ...(unlisted.get()[id] ?? none), session: null });
          },
        );
      };
      load();
      const stopPoll = deps.poll(() => {
        if (unlisted.get()[id]?.missing) return;
        load();
      }, LIST_MS);
      w = { count: 0, stop: () => { live = false; stopPoll(); } };
      watching.set(id, w);
    }
    w.count++;
    const held = w;
    return () => {
      if (--held.count > 0) return;
      held.stop();
      if (watching.get(id) === held) watching.delete(id);
    };
  }

  /** The chat by its id, from the list or from what `watch` fetched. */
  const find = (id: string | undefined): Session | null => {
    if (!id) return null;
    return store.get().list.find((s) => s.id === id) ?? unlisted.get()[id]?.session ?? null;
  };

  /** A chat's status as its own stream says it, shown at once: the round trip of a list is what made Stop appear a beat late. */
  function patchStatus(id: string, status: SessionStatus): void {
    store.update((s) => (s.list.some((c) => c.id === id && c.status !== status) ? { ...s, list: s.list.map((c) => (c.id === id ? { ...c, status } : c)) } : s));
    const was = unlisted.get()[id];
    if (was?.session && was.session.status !== status) unlisted.update((all) => ({ ...all, [id]: { ...was, session: { ...was.session!, status } } }));
  }

  /** `refresh`, with an outage not told: a change was saved by now and is shown so, whether or not the list then loads. */
  const refreshQuietly = () => refresh().then(() => undefined, () => undefined);

  const actions = {
    /** A chat started in `workspace`, or where "New" goes (the agent picked for new chats) without one. */
    async create(workspace?: string): Promise<Session> {
      const s = await api.createSession(workspace);
      await refreshQuietly();
      return s;
    },
    async rename(id: string, title: string): Promise<void> {
      await api.renameSession(id, title);
      store.update((s) => ({ ...s, list: s.list.map((c) => (c.id === id ? { ...c, title } : c)) }));
      await refreshQuietly();
    },
    async pin(id: string, pinned: boolean): Promise<void> {
      await api.pinSession(id, pinned);
      store.update((s) => ({ ...s, list: s.list.map((c) => (c.id === id ? { ...c, pinned } : c)) }));
      await refreshQuietly();
    },
    /**
     * Deletes a chat, and its sub-chats with it, once the person says yes to the kernel's question, which names them.
     * False where they said no, and nothing was done. A failure rejects.
     */
    async remove(id: string): Promise<boolean> {
      const chat = find(id);
      const subs = splitSubChats(store.get().list).under.get(id) ?? [];
      if (!(await deps.ask(questions.deleteChat(chat?.title ?? id, false, subs)))) return false;
      await api.deleteSession(id);
      goneFromList([id]);
      await refreshQuietly();
      return true;
    },
    /**
     * Deletes several at once, after one question for all of them. `null` where the person said no; otherwise the
     * ones the portal kept, each with what it said, one after the other so that it need not do many at once.
     */
    async removeMany(ids: readonly string[]): Promise<{ id: string; error: string }[] | null> {
      const all = splitSubChats(store.get().list);
      const chosen = ids.map((id) => store.get().list.find((s) => s.id === id)).filter((s): s is Session => !!s);
      const subs = chosen.reduce((n, s) => n + (all.under.get(s.id)?.length ?? 0), 0);
      const busy = (s: Session) => [s, ...(all.under.get(s.id) ?? [])].some((c) => c.status === "running" || c.asking);
      if (!(await deps.ask(questions.deleteChats(chosen.map((s) => ({ title: s.title, busy: busy(s) })), subs)))) return null;
      const failed: { id: string; error: string }[] = [];
      const done: string[] = [];
      for (const id of ids) {
        try {
          await api.deleteSession(id);
          done.push(id);
        } catch (e) {
          failed.push({ id, error: (e as Error).message });
        }
      }
      goneFromList(done);
      await refreshQuietly();
      return failed;
    },
    /** The error the first ask for the list failed with, dismissed. */
    dismissError(): void {
      store.update((s) => (s.error ? { ...s, error: null } : s));
    },
  };

  /** Deleted by now, and shown so, whether or not the list then loads: the chats and their sub-chats are out of it. */
  function goneFromList(ids: readonly string[]): void {
    const gone = new Set(ids);
    store.update((s) => ({ ...s, list: s.list.filter((c) => !gone.has(c.id) && !(c.parent && gone.has(c.parent))) }));
  }

  return { store, unlisted, refresh, start, watch, find, patchStatus, actions };
}

export type Sessions = ReturnType<typeof createSessions>;
export type { Store };
