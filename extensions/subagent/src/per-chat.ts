import { readFileSync } from "node:fs";
import path from "node:path";
import { isModelChoice, writeOwn } from "./settings";

/**
 * What each chat says its subagents run on, set in the chat's model menu: "auto", the model the chat is on, or
 * "provider/model". A chat that says nothing has the settings' model (settings.ts). Kept in `chats.json` in the
 * extension's own folder, by chat id, and taken out when the chat is deleted.
 */

let file: string | undefined;
let kept: Record<string, string> = {};

/** Reads what the chats said from `dir`, as the half starts. What cannot be read is nothing said. */
export function openChats(dir: string): void {
  file = path.join(dir, "chats.json");
  try {
    const read = JSON.parse(readFileSync(file, "utf8"));
    kept = Object.fromEntries(Object.entries(read && typeof read === "object" && !Array.isArray(read) ? read : {}).filter(([, model]) => isModelChoice(model))) as Record<string, string>;
  } catch {
    kept = {};
  }
}

/** What the chat says, or nothing where it says nothing. */
export const chatModel = (chatId: string): string | undefined => (Object.hasOwn(kept, chatId) ? kept[chatId] : undefined);

/** Says it for the chat, or with null says nothing again. Saved at once. */
export function setChatModel(chatId: string, model: string | null): void {
  if (!file) throw new Error("The subagent's chat settings are not open");
  const next = { ...kept };
  if (model === null) delete next[chatId];
  else next[chatId] = model;
  writeOwn(file, next);
  kept = next;
}

/** The chat is gone: what it said goes with it. */
export function forgetChat(chatId: string): void {
  if (chatModel(chatId) !== undefined) setChatModel(chatId, null);
}

/** Takes what `given` says for each chat that says nothing here yet; the chats it took. */
export function takeChats(given: Record<string, unknown>): string[] {
  const taken = Object.entries(given).filter(([chatId, model]) => isModelChoice(model) && chatModel(chatId) === undefined);
  if (taken.length) {
    if (!file) throw new Error("The subagent's chat settings are not open");
    const next = { ...kept, ...Object.fromEntries(taken) } as Record<string, string>;
    writeOwn(file, next);
    kept = next;
  }
  return taken.map(([chatId]) => chatId);
}
