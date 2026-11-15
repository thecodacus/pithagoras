import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { LOADING, type ChatState } from "./chats";
import { useKernel } from "./context";
import type { ComposerState } from "./composer";
import type { SessionsState, Unlisted } from "./sessions";
import { useStore } from "./store";

/** The kernel's stores as hooks: what an interface reads the page's data through. They read the stores of the nearest `KernelProvider`, the page's own where there is none. */

/** The chat list, or what `pick` takes of it (drawn again when what it picked is no longer `same`). */
export const useSessions = <P = SessionsState>(pick?: (state: SessionsState) => P, same?: (a: P, b: P) => boolean): P => useStore(useKernel().sessions.store, pick, same);

/** A chat that is not in the list, for as long as the component is drawn. */
export function useUnlisted(id: string | undefined): Unlisted {
  const { sessions } = useKernel();
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!id) return () => {};
      const release = sessions.watch(id);
      const stop = sessions.unlisted.subscribe(listener);
      return () => {
        stop();
        release();
      };
    },
    [id, sessions],
  );
  return useSyncExternalStore(subscribe, () => (id ? sessions.unlisted.get()[id] ?? NOT_ASKED : NOT_ASKED));
}
const NOT_ASKED: Unlisted = { session: null, missing: false };

function useChatState(id: string | undefined, onScreen: boolean): ChatState {
  const { chats } = useKernel();
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!id) return () => {};
      const release = onScreen ? chats.open(id) : chats.acquire(id);
      const stop = chats.stateOf(id)?.subscribe(listener);
      return () => {
        stop?.();
        release();
      };
    },
    [id, onScreen, chats],
  );
  return useSyncExternalStore(subscribe, () => (id ? chats.peek(id) : LOADING));
}

/** A chat read beside the one on screen: streamed while the component is drawn, and shared with any other that reads it. */
export const useChat = (id: string | undefined): ChatState => useChatState(id, false);
/** The chat on screen: streamed first of all, and what its stream says besides the conversation is passed on. */
export const useOpenChat = (id: string | undefined): ChatState => useChatState(id, true);

/** What is written in a chat's box, and put with it. */
export function useComposer(id: string): ComposerState {
  const { composer } = useKernel();
  return useStore(composer.store, (all) => all[id] ?? composer.get(id));
}

/**
 * Settings is where a provider is added and the default model is chosen: what the page holds of the models and the
 * public settings is asked for again once it is closed, by those that were asked for in the first place.
 */
export function useReloadAfterSettings(open: boolean): void {
  const { models, settings } = useKernel();
  const was = useRef(false);
  useEffect(() => {
    if (open) {
      was.current = true;
      return;
    }
    if (!was.current) return;
    was.current = false;
    for (const store of [models, settings]) if (store.store.get().status !== "loading") void store.load();
  }, [open, models, settings]);
}

export const useModels = () => useStore(useKernel().models.store);
export const useSettings = () => useStore(useKernel().settings.store);
export const useMe = () => useStore(useKernel().me.store);
export const useStatus = () => {
  const { status } = useKernel();
  return useSyncExternalStore(status.subscribe, status.get);
};

/** Whether the window is a phone's or a desk's, drawn again when it becomes the other. */
export function useViewport() {
  const { viewport } = useKernel();
  const subscribe = useCallback(
    (listener: () => void) => {
      const release = viewport.watch();
      const stop = viewport.store.subscribe(listener);
      return () => {
        stop();
        release();
      };
    },
    [viewport],
  );
  return useSyncExternalStore(subscribe, viewport.store.get);
}

/** A preference of this browser, drawn again when it changes. */
export function usePref(key: string, fallback: string): string {
  const { prefs } = useKernel();
  return useSyncExternalStore(prefs.subscribe, () => prefs.snapshot(key, fallback));
}
