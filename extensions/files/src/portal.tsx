import type { ComponentProps } from "react";
import type { ConfirmOptions, Portal, Ui } from "@pithagoras/extension-api";

/** The portal the extension was loaded into, for every part of it: set before anything is registered. */
export let portal: Portal;

export function setPortal(given: Portal): void {
  portal = given;
}

// The extension's texts, in the language in effect: its own German where it has it (see de.ts).
export const t = (text: string, vars?: Record<string, string | number>) => portal.t(text, vars);
export const tp = (n: number, one: string, other: string, vars?: Record<string, string | number>) => portal.tp(n, one, other, vars);
/** A text to be translated where it is shown, marked here as one: a title the portal draws. */
export const msg = <T extends string>(text: T): T => text;
/** A hook: the language in effect, drawing the component again when it changes. */
export const useLanguage = () => portal.locale.use();

/** A question with two answers, asked over the page: resolves true for yes. */
export const confirmDialog = (options: ConfirmOptions) => portal.ui.confirm(options);
/** The browser's storage, which never throws. */
export const local = {
  get: (key: string) => portal.ui.storage.local.get(key),
  set: (key: string, value: string) => portal.ui.storage.local.set(key, value),
};
export const session = {
  get: (key: string) => portal.ui.storage.session.get(key),
  set: (key: string, value: string) => portal.ui.storage.session.set(key, value),
  remove: (key: string) => portal.ui.storage.session.remove(key),
};

/** A request the server refused, with what it said besides the message: the portal's own kind. */
export const isApiError = (e: unknown): e is InstanceType<Portal["api"]["ApiError"]> => e instanceof portal.api.ApiError;

// The portal's own component, drawn as one of the extension's.
export function Markdown(props: ComponentProps<Ui["Markdown"]>) {
  const Own = portal.ui.Markdown;
  return <Own {...props} />;
}

// What the portal has for it, by the names the extension's parts use.
/** A size in bytes, "1.5 MB". */
export const bytesLabel = (n: number) => portal.format.bytes(n);
/** Enter that means "done", not Enter that picks a word with an input method. */
export const isEnter: Ui["isEnter"] = (e) => portal.ui.isEnter(e);
export const isEscape: Ui["isEscape"] = (e) => portal.ui.isEscape(e);
/** `where` is the folder `dir` or inside it, by the text of the path. */
export const within = (dir: string, where: string): boolean => portal.chats.files.below(dir, where) !== undefined;
/** Markdown with the chat's folder's pictures turned into the portal's addresses. */
export const folderPictures = (markdown: string, folder: string, url: (path: string) => string, base = "") => portal.chats.files.pictures(markdown, folder, url, base);
