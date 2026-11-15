import { finishedRuns, tabTitle } from "../attention";
import { brand } from "../brand";
import { t } from "../i18n";
import type { SessionStatus } from "../api";
import type { Chats } from "./chats";
import type { Sessions } from "./sessions";

/**
 * What the portal says to a person who is not looking at it: the browser tab's title, and a notification when a chat
 * they left running is done or asks them something. The kernel does it, whichever interface is drawn, so that "the
 * agent finished" is heard under any of them. (The shell used to.)
 */
export interface AlertsDeps {
  sessions: Sessions;
  chats: Chats;
  setTitle: (title: string) => void;
  /** A notification, if they asked for them and are somewhere else: see notify.ts. */
  notify: (title: string, body: string, tag: string, open: () => void) => void;
  /** Takes the person to a chat: what clicking a notification does. */
  open: (id: string) => void;
  /** The page is hidden and they asked to be told: the list is then asked for, slowly (see HIDDEN_MS). */
  watchingHidden: () => boolean;
  /** Called when the language changes: the title is in it. Returns the unsubscribe. */
  onLanguage: (listener: () => void) => () => void;
}

/**
 * The list stops being polled while the page is hidden, but a chat left running there can only be seen finishing
 * through it: the open one has its stream, the rest do not. So while someone asked to be told and something is
 * running, a hidden page keeps asking, more slowly.
 */
export const HIDDEN_MS = 15_000;

export function createAlerts(deps: AlertsDeps) {
  const { sessions, chats } = deps;

  /** Starts them; returns what stops them. */
  function start(): () => void {
    const stops: (() => void)[] = [];

    // The tab: the chat on screen, and whether it waits for an answer.
    let title: string | undefined;
    const say = () => {
      const id = chats.screen.get();
      const active = sessions.find(id);
      const waiting = Boolean(active && id && chats.peek(id).dialogs[0]);
      const next = tabTitle(active ? { title: active.title, status: active.status } : null, waiting);
      if (next === title) return;
      deps.setTitle((title = next));
    };
    // The questions of the chat on screen are in its own store, which is another one when the chat on screen is.
    let unwatchChat: (() => void) | undefined;
    let asked: string | undefined;
    const followChat = () => {
      unwatchChat?.();
      const id = chats.screen.get();
      unwatchChat = id ? chats.stateOf(id)?.subscribe(sayAsked) : undefined;
      sayAsked();
    };
    // A question that is waiting for an answer is news once, the first time it is there.
    function sayAsked() {
      say();
      const id = chats.screen.get();
      const active = sessions.find(id);
      const now = active && id ? chats.peek(id).dialogs[0]?.id : undefined;
      if (now === asked) return;
      asked = now;
      if (now && active) deps.notify(active.title, t("Waiting for your answer"), `ask-${active.id}`, () => deps.open(active.id));
    }
    stops.push(chats.screen.subscribe(followChat), sessions.store.subscribe(say), sessions.unlisted.subscribe(say), deps.onLanguage(() => ((title = undefined), say())));
    followChat();
    stops.push(() => {
      unwatchChat?.();
      deps.setTitle(brand.name);
    });

    // Told when a chat that was running is done.
    const last = new Map<string, SessionStatus>();
    let seen: unknown;
    const finished = () => {
      const { list } = sessions.store.get();
      if (list === seen) return;
      seen = list;
      for (const s of finishedRuns(last, list)) {
        deps.notify(s.title, s.status === "error" ? t("Stopped with an error") : t("Finished"), s.id, () => deps.open(s.id));
      }
      last.clear();
      for (const s of list) last.set(s.id, s.status);
    };
    stops.push(sessions.store.subscribe(finished));
    finished();

    // A hidden page keeps asking for the list while a chat runs and someone wants to hear of it.
    let timer: ReturnType<typeof setInterval> | undefined;
    const keepAsking = () => {
      const running = sessions.store.get().list.some((s) => s.status === "running");
      if (running && timer === undefined) {
        timer = setInterval(() => {
          if (deps.watchingHidden()) sessions.refresh().catch(() => {});
        }, HIDDEN_MS);
      } else if (!running && timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    };
    stops.push(sessions.store.subscribe(keepAsking), () => clearInterval(timer));
    keepAsking();

    return () => stops.forEach((stop) => stop());
  }

  return { start };
}
