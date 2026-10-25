import type { PanelController, Panels } from "@pithagoras/extension-api";
import { slotEntries, useSlot } from "./slots";

/**
 * The panels beside the conversation on screen, opened and closed by name
 * from anywhere in the page: an extension's, by "<package>/<id>" or by the
 * `name` its entry gave it, as the terminal's is "terminal", Git's "git",
 * Files' "files", Canvases' "canvas" and the subagents' "agents" (the chat
 * resolves it, see Chat.tsx).
 *
 * What is handed over with `open` is the panel's to read: a path for Files to
 * show, anything an extension's panel says it takes.
 */
/** What the chat on screen answers for: its panels, open or not. Which panels there are is the slot's to say. */
export type ChatPanels = Pick<PanelController, "isOpen" | "open" | "close">;

let current: ChatPanels | undefined;

/** The chat on screen says how its panels are opened; nothing, when it leaves. */
export function setPanelController(controller: ChatPanels | undefined): void {
  current = controller;
}

const onScreen = (): ChatPanels => {
  if (!current) throw new Error("No chat is on screen to open a panel in");
  return current;
};

const named = (entries: ReturnType<typeof slotEntries<"chat.panel">>, key: string) => entries.some((entry) => entry.key === key || entry.name === key);

export const panels: PanelController = {
  isOpen: (key) => current?.isOpen(key) ?? false,
  open: (key, params) => onScreen().open(key, params),
  close: (key) => current?.close(key),
  has: (key) => named(slotEntries("chat.panel"), key),
  useHas: (key) => named(useSlot("chat.panel"), key),
};

const scoped = new Map<string, Panels>();
/** An extension's own panels in the chat on screen, by the id each was registered with: the same object each time. */
export function panelsFor(extension: string): Panels {
  let own = scoped.get(extension);
  if (!own) {
    own = {
      isOpen: (id) => panels.isOpen(`${extension}/${id}`),
      open: (id, params) => panels.open(`${extension}/${id}`, params),
      close: (id) => panels.close(`${extension}/${id}`),
    };
    scoped.set(extension, own);
  }
  return own;
}
