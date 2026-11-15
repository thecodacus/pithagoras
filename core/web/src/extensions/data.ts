import { useEffect, useSyncExternalStore } from "react";
import type { Portal } from "@pithagoras/extension-api";
import { useKernel, pageKernel } from "../kernel/context";
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

/** The members that are the same for every extension, apart from its preferences, which are its own. */
export function dataFor(extension: string): Data {
  const kernel = pageKernel;
  /** Preferences under the extension's own name: no other package reads them. */
  const prefs = createPrefs(local, extension);
  return {
    controller: (chatId) => kernel.chats.controller(chatId),
    sessions: {
      use: useSessions,
      find: (id) => kernel.sessions.find(id),
      actions: {
        create: (workspace) => kernel.sessions.actions.create(workspace),
        rename: (id, title) => kernel.sessions.actions.rename(id, title),
        pin: (id, pinned) => kernel.sessions.actions.pin(id, pinned),
        remove: (id) => kernel.sessions.actions.remove(id),
        removeMany: (ids) => kernel.sessions.actions.removeMany(ids),
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
