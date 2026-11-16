import { ApiError, type Session, type SessionStatus, type api as realApi } from "../api";
import { reconcile } from "../reconcile";
import * as questions from "./confirms";
import type { Ask, Unasked } from "./confirms";
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

  /** Counts the asks for the list. */
  let asks = 0;
  /**
   * The last ask whose answer is shown, or the last ask made before a change shown here (a delete, a rename): an answer
   * to it or to an earlier one is older than what is shown. Not "the last ask made": the list is polled every few
   * seconds, and a portal slower than that would then never be shown.
   */
  let shown = 0;
  /** A change the portal has made, shown before the list is asked for again: no answer asked for before it is put over it. */
  const changedHere = (change: (s: SessionsState) => SessionsState) => {
    shown = asks;
    store.update(change);
  };

  /**
   * Asks for the list. Rejects when the portal does not answer; the state says so too. An answer older than what is
   * shown is not put in (a poll sent before a delete brought the chat back), and resolves to the list as it is.
   */
  async function refresh(): Promise<Session[]> {
    const mine = ++asks;
    let r: Awaited<ReturnType<SessionsApi["sessions"]>>;
    try {
      r = await api.sessions();
    } catch (e) {
      if (mine > shown) store.update((s) => (s.status === "offline" ? s : { ...s, status: "offline" }));
      throw e;
    }
    if (mine <= shown) return store.get().list;
    shown = mine;
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
      changedHere((s) => ({ ...s, list: s.list.map((c) => (c.id === id ? { ...c, title } : c)) }));
      await refreshQuietly();
    },
    async pin(id: string, pinned: boolean): Promise<void> {
      await api.pinSession(id, pinned);
      changedHere((s) => ({ ...s, list: s.list.map((c) => (c.id === id ? { ...c, pinned } : c)) }));
      await refreshQuietly();
    },
    /**
     * Deletes a chat, and its sub-chats with it, once the person says yes to the kernel's question, which names them.
     * False where they said no, and nothing was done. A failure rejects.
     *
     * `gone` is called as soon as the chat is out of the list, before the list is asked for again: a page that showed
     * the chat goes to the next one in the same draw, not through a moment with no chat while the list is on its way.
     */
    async remove(id: string, gone?: (list: readonly Session[]) => void, by?: Unasked): Promise<boolean> {
      const chat = find(id);
      if (!(await deps.ask(questions.byWhom(questions.deleteChat(chat?.title ?? id, false, subChatsOf(id)), by?.unasked)))) return false;
      await api.deleteSession(id);
      goneFromList([id]);
      gone?.(store.get().list);
      await refreshQuietly();
      return true;
    },
    /**
     * Deletes several at once, after one question for all of them. `null` where the person said no; otherwise the
     * ones the portal kept, each with what it said, one after the other so that it need not do many at once.
     */
    async removeMany(ids: readonly string[], by?: Unasked): Promise<{ id: string; error: string }[] | null> {
      // Every one is named and counted, listed or not (an agent's chat, a sub-chat kept out of the list): a part that
      // keeps its own selection deletes nothing the question did not name. One not known here is named by its id.
      const chosen = [...new Set(ids)];
      const subs = chosen.reduce((n, id) => n + subChatsOf(id).length, 0);
      const busy = (id: string) => [find(id), ...subChatsOf(id)].some((c) => c?.status === "running" || c?.asking);
      if (!(await deps.ask(questions.byWhom(questions.deleteChats(chosen.map((id) => ({ title: find(id)?.title ?? id, busy: busy(id) })), subs), by?.unasked)))) return null;
      const failed: { id: string; error: string }[] = [];
      const done: string[] = [];
      for (const id of chosen) {
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

  /** A chat's sub-chats the list has, whether or not the chat itself is in it. */
  const subChatsOf = (id: string): Session[] => store.get().list.filter((c) => c.parent === id);

  /**
   * Deleted by now, and shown so, whether or not the list then loads: the chats and their sub-chats are out of it, and
   * out of what was fetched of chats outside it, where `find` would still have them. One still looked at is missing.
   */
  function goneFromList(ids: readonly string[]): void {
    const gone = new Set(ids);
    const goes = (c: Session) => gone.has(c.id) || Boolean(c.parent && gone.has(c.parent));
    changedHere((s) => ({ ...s, list: s.list.filter((c) => !goes(c)) }));
    for (const [id, held] of Object.entries(unlisted.get())) {
      if (!gone.has(id) && !(held.session && goes(held.session))) continue;
      setUnlisted(id, watching.has(id) ? { session: null, missing: true } : null);
    }
  }

  return { store, unlisted, refresh, start, watch, find, patchStatus, actions };
}

export type Sessions = ReturnType<typeof createSessions>;
export type { Store };
