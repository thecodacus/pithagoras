import type { Panels } from "./slots";

/**
 * The panels beside the conversation on screen, opened and closed by name
 * from anywhere in the page: the portal's own ("files", "git", "terminal",
 * "browser", "agents", "canvas") and an extension's ("<package>/<id>").
 *
 * What is handed over with `open` is the panel's to read: a path for Files to
 * show, a tool call for the terminal to scroll to, anything an extension's
 * panel says it takes.
 */
export interface PanelController {
  isOpen(key: string): boolean;
  open(key: string, params?: unknown): void;
  close(key: string): void;
}

let current: PanelController | undefined;

/** The chat on screen says how its panels are opened; nothing, when it leaves. */
export function setPanelController(controller: PanelController | undefined): void {
  current = controller;
}

const onScreen = (): PanelController => {
  if (!current) throw new Error("No chat is on screen to open a panel in");
  return current;
};

export const panels: PanelController = {
  isOpen: (key) => current?.isOpen(key) ?? false,
  open: (key, params) => onScreen().open(key, params),
  close: (key) => current?.close(key),
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
