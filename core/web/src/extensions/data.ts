import { useEffect, useSyncExternalStore } from "react";
import type { Portal, SessionRow, SessionsView } from "@pithagoras/extension-api";
import type { Session } from "../api";
import type { Asked, ChatController } from "../kernel/chats";
import type { SessionsState } from "../kernel/sessions";
import { useKernel, pageKernel, type Kernel } from "../kernel/context";
import { createPrefs } from "../kernel/prefs";
import { useStore } from "../kernel/store";
import { useModels, useMe, useSessions, useSettings, useStatus, useViewport, useComposer } from "../kernel/use";
import { local } from "../safe-storage";

/**
 * The data contract an extension is given (docs/guide/data-contract.md): the kernel's stores, as small members of
 * `portal`. A hook reads the stores of the nearest `KernelProvider`, as the page's own parts do; a function (an action,
 * an address) has no React around it and uses the page's. The stores are the page's, so what an extension does through
 * them is what the portal's own interface does, with the same questions asked first.
 */
type Data = Pick<Portal, "sessions" | "composer" | "models" | "settings" | "me" | "status" | "prefs" | "env" | "media"> & { controller: Portal["chats"]["controller"] };

/** What `SessionRow` has: the rest of what the portal says of a chat (where its session file is, who it came in from over a channel) is the page's own. */
const ROW = ["id", "title", "workspace", "status", "pinned", "created_at", "updated_at", "last_error", "kind", "mode", "provider", "model", "thinking_level", "parent", "listed", "asking", "trustedResults"] as const satisfies readonly (keyof SessionRow)[];

const rows = new WeakMap<Session, SessionRow>();
/** A chat as the contract names it, frozen: the same object for as long as the page's row is the same one. */
function rowOf(s: Session): SessionRow {
  let row = rows.get(s);
  if (!row) {
    const picked: Record<string, unknown> = {};
    for (const key of ROW) if (key in s) picked[key] = (s as unknown as Record<string, unknown>)[key];
    if (Array.isArray(picked.trustedResults)) picked.trustedResults = Object.freeze([...picked.trustedResults]);
    rows.set(s, (row = Object.freeze(picked) as unknown as SessionRow));
  }
  return row;
}

const lists = new WeakMap<readonly Session[], readonly SessionRow[]>();
/** The list as the contract names it: the same array for as long as the page's list is the same one, so that a poll that found nothing is no draw. */
function listOf(list: readonly Session[]): readonly SessionRow[] {
  let mapped = lists.get(list);
  if (!mapped) lists.set(list, (mapped = Object.freeze(list.map(rowOf))));
  return mapped;
}

/** What `sessions.use` hands a part: the page's state, as the contract names it. */
export const sessionsView = (state: SessionsState): SessionsView => Object.freeze({ list: listOf(state.list), status: state.status, executor: state.executor, error: state.error });

/** A delete a part starts is not the person's own click: the person's switch for "Ask before deleting" does not spare it the question. */
const BY_PART = Object.freeze({ unasked: true });
const parted = new WeakMap<ChatController, ChatController>();
/** A chat's actions as a part gets them: the page's own, with its deletes asking whatever the switch says. Frozen, and the same object each time. */
function forPart(c: ChatController): ChatController {
  let mine = parted.get(c);
  if (!mine) {
    mine = Object.freeze({
      ...c,
      deleteMessage: (seq: number, asked?: Asked) => c.deleteMessage(seq, { ...asked, ...BY_PART }),
      removeTurn: (seq: number, asked?: Asked) => c.removeTurn(seq, { ...asked, ...BY_PART }),
    });
    parted.set(c, mine);
  }
  return mine;
}

/** The members that are the same for every extension, apart from its preferences, which are its own. `kernel`: the page's own unless a test gives one. */
export function dataFor(extension: string, kernel: Kernel = pageKernel): Data {
  /** Preferences under the extension's own name: no other package reads them. */
  const prefs = createPrefs(local, extension);
  return {
    controller: (chatId) => forPart(kernel.chats.controller(chatId)) as unknown as ReturnType<Data["controller"]>,
    sessions: {
      use: (pick, same) => useSessions((state) => (pick ? pick(sessionsView(state)) : (sessionsView(state) as never)), same),
      find: (id) => {
        const found = kernel.sessions.find(id);
        return found ? rowOf(found) : null;
      },
      actions: {
        create: async (workspace) => rowOf(await kernel.sessions.actions.create(workspace)),
        rename: (id, title) => kernel.sessions.actions.rename(id, title),
        pin: (id, pinned) => kernel.sessions.actions.pin(id, pinned),
        remove: (id) => kernel.sessions.actions.remove(id, undefined, BY_PART),
        removeMany: (ids) => kernel.sessions.actions.removeMany(ids, BY_PART),
        dismissError: () => kernel.sessions.actions.dismissError(),
      },
    },
    composer: {
      use: useComposer,
      actions: {
        setDraft: (chatId, text) => kernel.composer.setDraft(chatId, text),
        attach: (chatId, files) => kernel.composer.attach(chatId, files),
        detach: (chatId, attachmentId) => kernel.composer.detach(chatId, attachmentId),
        loadCommands: (chatId, key) => kernel.composer.loadCommands(chatId, key),
        canSubmit: (chatId) => kernel.composer.canSubmit(chatId),
        submit: (chatId, options) => kernel.composer.submit(chatId, options),
      },
    },
    models: {
      use() {
        const { models } = useKernel();
        // Asked for by the first part that reads it: `status` says how it went. A part drawn after an ask that failed
        // asks again, so that the page does not need a reload once the portal answers again.
        useEffect(() => {
          if (models.store.get().status !== "ready") void models.load();
        }, [models]);
        return useModels();
      },
      useChat(chatId) {
        const { models } = useKernel();
        useEffect(() => void models.loadChat(chatId), [models, chatId]);
        return useStore(models.chats, () => models.current(chatId));
      },
      set: async (chatId, choice) => {
        await kernel.models.set(chatId, choice);
      },
    },
    settings: {
      use() {
        const { settings } = useKernel();
        useEffect(() => {
          if (settings.store.get().status !== "ready") void settings.load();
        }, [settings]);
        return useSettings();
      },
    },
    me: {
      use() {
        const { me } = useKernel();
        useEffect(() => {
          if (me.store.get().status !== "ready") void me.load();
        }, [me]);
        return useMe();
      },
    },
    status: { use: useStatus },
    prefs: {
      use: (key, fallback) => useSyncExternalStore(prefs.subscribe, () => prefs.snapshot(key, fallback)),
      set: (key, value) => prefs.set(key, value),
      remove: (key) => prefs.remove(key),
    },
    env: { useViewport },
    media: {
      image: (chatId, name) => kernel.media.image(chatId, name),
      picture: (chatId, path, version) => kernel.media.picture(chatId, path, version),
      video: (chatId, path, version) => kernel.media.video(chatId, path, version),
      file: (chatId, path, version) => kernel.media.file(chatId, path, version),
    },
  };
}
