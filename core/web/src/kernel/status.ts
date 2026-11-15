import type { UpdateStatus } from "../api";
import type { Chats } from "./chats";
import type { Sessions } from "./sessions";
import { derived } from "./store";

/**
 * How the portal stands, for a part that shows it: whether it can be reached, whether there is an update, and where
 * the agent's chats run. Codes, not words: the interface says them in the page's language.
 */
export interface StatusState {
  /** `offline`: the list does not come. `unstable`: the chat on screen lost its stream more than once in a row. */
  connection: "online" | "unstable" | "offline";
  update: {
    /** How many commits the portal is behind, where it has told that there are some. */
    behind: number;
    running: boolean;
    /** An update was restarting the portal and it has not come back in a long while. */
    lost: boolean;
  };
  /** Where the chats run: "host" or "container". */
  executor: string;
}

/** What the update module says (update.ts), so that this does not import it. */
export interface UpdateSource {
  snapshot(): { status: UpdateStatus | null; lost: boolean };
  subscribe(listener: () => void): () => void;
}

export function createStatus(deps: { sessions: Sessions; chats: Chats; update: UpdateSource }) {
  const { sessions, chats, update } = deps;
  /** The store of the chat on screen is another one when the chat is: its failures are followed through the screen store. */
  const onChat = (listener: () => void) => {
    let off: (() => void) | undefined;
    const follow = () => {
      off?.();
      const id = chats.screen.get();
      off = id ? chats.stateOf(id)?.subscribe(listener) : undefined;
      listener();
    };
    const stop = chats.screen.subscribe(follow);
    follow();
    return () => {
      stop();
      off?.();
    };
  };
  return derived<StatusState>([sessions.store.subscribe, onChat, update.subscribe], () => {
    const { status, executor } = sessions.store.get();
    const id = chats.screen.get();
    const failures = id ? chats.peek(id).failures : 0;
    const { status: up, lost } = update.snapshot();
    return {
      connection: status === "offline" ? "offline" : failures >= 2 ? "unstable" : "online",
      update: { behind: up?.notice?.count ?? 0, running: up?.run?.state === "running" || up?.run?.state === "restarting", lost },
      executor,
    };
  });
}
