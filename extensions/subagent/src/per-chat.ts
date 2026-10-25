import { readFileSync } from "node:fs";
import path from "node:path";
import { isModelChoice, writeOwn } from "./settings";

/**
 * What each chat says its subagents run on, set in the chat's model menu: "auto", the model the chat is on, or
 * "provider/model". A chat that says nothing has the settings' model (settings.ts). Kept in `chats.json` in the
 * extension's own folder, `{"chats": {"<chat id>": model}, "handedOver": {…}}`, and taken out when the chat is deleted.
 * `handedOver` marks the chats whose value a hand-off gave (takeChats) and nobody has set since.
 */

let file: string | undefined;
let kept: Record<string, string> = {};
let handed: Record<string, string> = {};

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const choices = (value: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(record(value)).filter(([, model]) => isModelChoice(model))) as Record<string, string>;

/** Reads what the chats said from `dir`, as the half starts. What cannot be read is nothing said. */
export function openChats(dir: string): void {
  file = path.join(dir, "chats.json");
  try {
    const read = record(JSON.parse(readFileSync(file, "utf8")));
    kept = choices(read.chats);
    handed = Object.fromEntries(Object.entries(choices(read.handedOver)).filter(([chatId, model]) => kept[chatId] === model));
  } catch {
    kept = {};
    handed = {};
  }
}

/** What the chat says, or nothing where it says nothing. */
export const chatModel = (chatId: string): string | undefined => (Object.hasOwn(kept, chatId) ? kept[chatId] : undefined);

/** Writes `next` with the marks that are still what is kept; a failure leaves everything as it was. */
function save(next: Record<string, string>, marks: Record<string, string>): void {
  if (!file) throw new Error("The subagent's chat settings are not open");
  const stillHanded = Object.fromEntries(Object.entries(marks).filter(([chatId, model]) => Object.hasOwn(next, chatId) && next[chatId] === model));
  writeOwn(file, Object.keys(stillHanded).length ? { chats: next, handedOver: stillHanded } : { chats: next });
  kept = next;
  handed = stillHanded;
}

/** Says it for the chat, or with null says nothing again. Saved at once. What the person says is not what a hand-off gave, whatever it is. */
export function setChatModel(chatId: string, model: string | null): void {
  const next = { ...kept };
  if (model === null) delete next[chatId];
  else next[chatId] = model;
  const marks = { ...handed };
  delete marks[chatId];
  save(next, marks);
}

/** The chat is gone: what it said goes with it. */
export function forgetChat(chatId: string): void {
  if (chatModel(chatId) !== undefined) setChatModel(chatId, null);
}

/** Forgets the chats `exists` does not know, as the half starts: one deleted while it was off did not tell it. The chats it forgot. */
export function pruneChats(exists: (chatId: string) => boolean): string[] {
  const gone = Object.keys(kept).filter((chatId) => !exists(chatId));
  if (gone.length) save(Object.fromEntries(Object.entries(kept).filter(([chatId]) => !gone.includes(chatId))), handed);
  return gone;
}

/**
 * Takes what `given` says for each chat that says nothing here yet, or whose value is still the one an earlier
 * hand-off gave (the person went back meanwhile, and what the older version holds now is newer): the chats it took,
 * and those whose own, different choice it left as it was. Chats `exists` does not know are not taken.
 */
export function takeChats(given: Record<string, unknown>, exists: (chatId: string) => boolean = () => true): { taken: string[]; left: string[] } {
  const offered = Object.entries(choices(given)).filter(([chatId]) => exists(chatId));
  const takes = ([chatId, model]: [string, string]) => chatModel(chatId) === undefined || (handed[chatId] === kept[chatId] && kept[chatId] !== model);
  const taken = offered.filter(takes);
  const left = offered.filter((one) => !takes(one) && kept[one[0]] !== one[1]);
  if (taken.length) save({ ...kept, ...Object.fromEntries(taken) }, { ...handed, ...Object.fromEntries(taken) });
  return { taken: taken.map(([chatId]) => chatId), left: left.map(([chatId]) => chatId) };
}
