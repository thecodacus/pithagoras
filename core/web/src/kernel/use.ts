import { useCallback, useSyncExternalStore } from "react";
import { LOADING, type ChatState } from "./chats";
import { chats, composer, me, models, prefs, sessions, settings, status, viewport } from "./wire";
import type { ComposerState } from "./composer";
import type { SessionsState, Unlisted } from "./sessions";
import { useStore } from "./store";

/** The kernel's stores as hooks: what an interface reads the page's data through. */

/** The chat list, or what `pick` takes of it. */
export const useSessions = <P = SessionsState>(pick?: (state: SessionsState) => P): P => useStore(sessions.store, pick);

/** A chat that is not in the list, for as long as the component is drawn. */
export function useUnlisted(id: string | undefined): Unlisted {
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
    [id],
  );
  return useSyncExternalStore(subscribe, () => (id ? sessions.unlisted.get()[id] ?? NOT_ASKED : NOT_ASKED));
}
const NOT_ASKED: Unlisted = { session: null, missing: false };

function useChatState(id: string | undefined, onScreen: boolean): ChatState {
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
    [id, onScreen],
  );
  return useSyncExternalStore(subscribe, () => (id ? chats.peek(id) : LOADING));
}

/** A chat read beside the one on screen: streamed while the component is drawn, and shared with any other that reads it. */
export const useChat = (id: string | undefined): ChatState => useChatState(id, false);
/** The chat on screen: streamed first of all, and what its stream says besides the conversation is passed on. */
export const useOpenChat = (id: string | undefined): ChatState => useChatState(id, true);

/** What is written in a chat's box, and put with it. */
export const useComposer = (id: string): ComposerState => useStore(composer.store, (all) => all[id] ?? composer.get(id));

export const useModels = () => useStore(models.store);
export const useSettings = () => useStore(settings.store);
export const useMe = () => useStore(me.store);
export const useStatus = () => useSyncExternalStore(status.subscribe, status.get);

/** Whether the window is a phone's or a desk's, drawn again when it becomes the other. */
export function useViewport() {
  const subscribe = useCallback((listener: () => void) => {
    const release = viewport.watch();
    const stop = viewport.store.subscribe(listener);
    return () => {
      stop();
      release();
    };
  }, []);
  return useSyncExternalStore(subscribe, viewport.store.get);
}

/** A preference of this browser, drawn again when it changes. */
export function usePref(key: string, fallback: string): string {
  return useSyncExternalStore(prefs.subscribe, () => prefs.snapshot(key, fallback));
}
