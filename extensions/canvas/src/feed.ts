import { useSyncExternalStore } from "react";

/**
 * A chat's canvases as the server half tells them (`portal.server.on`): all of
 * them when a page opens the chat, then each change. Kept here, outside any
 * component, so the panel and the voice window read the same list, and one
 * drawn after the list came has it at once.
 */
export type Canvas = {
  id: string;
  title: string;
  content: string;
  revision: number;
  status: string;
  active_call: string | null;
  updated_at: string;
  persisted: boolean;
  /** A write was cut off, and the text from before it can be put back. */
  restorable?: boolean;
};
export type CanvasMessage =
  | { type: "create" | "update" | "focus"; canvas: Canvas }
  | { type: "delete"; id: string }
  | { type: "snapshot"; canvases: Canvas[] };

const NONE: Canvas[] = [];
const lists = new Map<string, Canvas[]>();
const watchers = new Map<string, Set<() => void>>();
/** What the agent did that the person should see, by chat: a count that grows with each (see `useAsked`). */
const asked = new Map<string, { count: number; id: string }>();
/** Writes already followed, so that each one brings its canvas up once. */
const followed = new Set<string>();

const changed = (chat: string) => {
  for (const watcher of watchers.get(chat) ?? []) watcher();
};
const ask = (chat: string, id: string) => asked.set(chat, { count: (asked.get(chat)?.count ?? 0) + 1, id });

/** A message from the server half, or a list the panel asked for itself. */
export function hear(chat: string, message: CanvasMessage): void {
  const rows = lists.get(chat) ?? NONE;
  if (message.type === "snapshot") lists.set(chat, message.canvases);
  else if (message.type === "delete") lists.set(chat, rows.filter((row) => row.id !== message.id));
  else lists.set(chat, [message.canvas, ...rows.filter((row) => row.id !== message.canvas.id)]);
  // The agent made a document, read one, or began a write: it is brought up.
  if (message.type === "create" || message.type === "focus") ask(chat, message.canvas.id);
  else if (message.type === "update" && message.canvas.status === "writing" && message.canvas.active_call && !followed.has(message.canvas.active_call)) {
    followed.add(message.canvas.active_call);
    ask(chat, message.canvas.id);
  }
  changed(chat);
}

/** Whether the server half has told the page this chat's canvases yet. */
export const known = (chat: string) => lists.has(chat);

function watch(chat: string, watcher: () => void) {
  let set = watchers.get(chat);
  if (!set) watchers.set(chat, (set = new Set()));
  set.add(watcher);
  return () => {
    set.delete(watcher);
    if (!set.size) watchers.delete(chat);
  };
}

/** The chat's canvases, newest first. */
export const canvasesOf = (chat: string): Canvas[] => lists.get(chat) ?? NONE;
/** How many times the agent asked for a canvas of the chat to be seen, and which canvas it was last. */
export const askedOf = (chat: string): { count: number; id: string } => ({ count: asked.get(chat)?.count ?? 0, id: asked.get(chat)?.id ?? "" });

/** A hook: the chat's canvases, drawn again as they change. */
export const useCanvases = (chat: string): Canvas[] => useSyncExternalStore((w) => watch(chat, w), () => canvasesOf(chat));

/** A hook: what the agent asked to be seen (see askedOf), drawn again as it grows. */
export function useAsked(chat: string): { count: number; id: string } {
  useSyncExternalStore((w) => watch(chat, w), () => askedOf(chat).count);
  return askedOf(chat);
}
