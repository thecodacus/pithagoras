import { useCallback, useSyncExternalStore } from "react";
import { portal } from "./portal";

/**
 * Whether a subagent's chat waits on the person: a dialog in it, or a question its agent or the guard asked there
 * (the portal's `asking` on a child chat, GET /api/sessions/:id). Nobody may have that chat open, so the panel and
 * the tray say so, with the way to it. Asked every few seconds while the subagent runs, once for each chat however
 * many parts ask.
 */

const EVERY_MS = 4000;

interface Poll {
  asking: boolean;
  watchers: Set<() => void>;
  stop(): void;
}

const polls = new Map<string, Poll>();

function start(chatId: string): Poll {
  const poll: Poll = { asking: false, watchers: new Set(), stop: () => {} };
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ask = async () => {
    try {
      const chat = await portal.api.json<{ asking?: boolean }>(`/api/sessions/${encodeURIComponent(chatId)}`);
      const asking = chat.asking === true;
      if (!stopped && asking !== poll.asking) {
        poll.asking = asking;
        for (const watcher of [...poll.watchers]) watcher();
      }
    } catch {
      // Asked again at the next turn: a chat that is gone is over, and its subagent with it.
    }
    if (!stopped) timer = setTimeout(ask, EVERY_MS);
  };
  void ask();
  poll.stop = () => {
    stopped = true;
    clearTimeout(timer);
  };
  return poll;
}

function watch(chatId: string, watcher: () => void): () => void {
  let poll = polls.get(chatId);
  if (!poll) polls.set(chatId, (poll = start(chatId)));
  poll.watchers.add(watcher);
  return () => {
    poll.watchers.delete(watcher);
    if (poll.watchers.size || polls.get(chatId) !== poll) return;
    poll.stop();
    polls.delete(chatId);
  };
}

/** Whether the chat `chatId` waits on the person, asked while `running`; false otherwise, and nothing is asked. */
export function useAsking(chatId: string | undefined, running: boolean): boolean {
  const on = running && !!chatId;
  const subscribe = useCallback((watcher: () => void) => (on ? watch(chatId!, watcher) : () => {}), [chatId, on]);
  return useSyncExternalStore(subscribe, () => (on ? polls.get(chatId!)?.asking ?? false : false));
}
