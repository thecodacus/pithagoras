import { useSyncExternalStore } from "react";
import { portal } from "./portal";

/**
 * What one chat's subagents run on, as its model menu shows it: the chat's own choice (null follows `default`), and
 * what the extension's settings say for every chat. Fetched with the chat (client.tsx), not when its model menu opens:
 * asked then, the menu opened without it and the row arrived a moment later, pushing the rest down. Kept per chat, so
 * going back to one draws it at once, and asked again quietly.
 */
export interface Choice {
  model: string | null;
  default: string;
}

const held = new Map<string, Choice>();
const askedAt = new Map<string, number>();
const watchers = new Set<() => void>();

/** Where the server half keeps it. The portal throws for this where the half is not running: that is no choice known, not a failure of this half. */
const url = (chatId: string) => portal.api.url(`/chats/${encodeURIComponent(chatId)}/model`);
/** Only an answer that is one: a server that says something else leaves the menu as it was. */
const isChoice = (value: unknown): value is Choice =>
  !!value && typeof (value as Choice).default === "string" && ((value as Choice).model === null || typeof (value as Choice).model === "string");

function put(chatId: string, choice: Choice | undefined): void {
  if (choice) held.set(chatId, choice);
  else held.delete(chatId);
  for (const watcher of [...watchers]) watcher();
}

/** Asks the server half for a chat's choice, unless it was asked within `freshMs`. A chat it does not know (not saved yet) has none. */
export function fetchChoice(chatId: string, freshMs = 30_000): void {
  const at = askedAt.get(chatId);
  if (at !== undefined && Date.now() - at < freshMs) return;
  askedAt.set(chatId, Date.now());
  // Built inside the chain: with the server half down there is no address, which is the same as an answer that failed.
  Promise.resolve()
    .then(() => portal.api.json<unknown>(url(chatId)))
    .then(
      (answer) => isChoice(answer) && put(chatId, answer),
      () => askedAt.delete(chatId),
    );
}

/** What every chat holds is asked again when next shown: the default changed. */
export function forgetChoices(): void {
  askedAt.clear();
}

/** A chat's choice as it is known now, drawn again when that changes. */
export function useChoice(chatId: string): Choice | undefined {
  return useSyncExternalStore(
    (watcher) => {
      watchers.add(watcher);
      return () => void watchers.delete(watcher);
    },
    () => held.get(chatId),
  );
}

/** Sets a chat's choice: shown at once, and as the server half said it back; the one before again, and thrown, when it is refused. */
export async function setChoice(chatId: string, model: string | null): Promise<void> {
  const before = held.get(chatId);
  if (before) put(chatId, { ...before, model });
  try {
    const answer = await portal.api.json<unknown>(url(chatId), { method: "PUT", body: JSON.stringify({ model }) });
    if (isChoice(answer)) put(chatId, answer);
  } catch (e) {
    put(chatId, before);
    throw e;
  }
}
