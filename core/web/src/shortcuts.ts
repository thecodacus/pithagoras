import { DEFAULT_TRIGGER } from "./slash-palette";

/** What of a key event, and of where it landed, the rules below need. */
export interface KeyInfo {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  /** The element that has focus: a text field, a button, or nothing but the page. */
  target?: { tagName?: string; isContentEditable?: boolean } | null;
  /** AltGr is held: on Windows it reaches the page as Ctrl and Alt together. */
  altGraph?: boolean;
}

const TEXT_ENTRY = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** Whether typing here is meant for the thing that has focus. */
function isTyping(target: KeyInfo["target"]): boolean {
  if (!target) return false;
  return Boolean(target.isContentEditable) || TEXT_ENTRY.has((target.tagName ?? "").toUpperCase());
}

/**
 * The command character from anywhere on the page goes to the message box,
 * ready for a command.
 *
 * Not while typing somewhere else — it is a character there — and not with a
 * modifier, which are the browser's and the system's own. AltGr is not one: it
 * is how a German keyboard types "@", which may be the character.
 */
export function opensComposer(e: KeyInfo, trigger = DEFAULT_TRIGGER): boolean {
  const modified = e.altGraph ? e.metaKey : e.ctrlKey || e.metaKey || e.altKey;
  return e.key === trigger && !modified && !isTyping(e.target);
}

/**
 * Escape in the message box stops the run.
 *
 * With words typed too: stopping leaves them in the box, so it costs nothing,
 * and half-way through writing the agent a correction is exactly when it is
 * seen going the wrong way. Not while an input method is composing, where
 * Escape is how a candidate is dismissed; and not when the command list is
 * open, where it closes that instead.
 */
export function stopsRun(ctx: {
  key: string;
  running: boolean;
  composing: boolean;
  paletteOpen: boolean;
}): boolean {
  return ctx.key === "Escape" && ctx.running && !ctx.composing && !ctx.paletteOpen;
}

/**
 * Enter that means "done", not Enter that picks a word.
 *
 * With an input method — Japanese, Chinese, Korean — Enter first confirms the
 * candidate being composed, and that keydown reaches the page too. Taken as
 * "send", it sent half a sentence. Safari reports the confirming keydown after
 * composition has ended, as keyCode 229, so that is checked as well.
 */
export function isEnter(e: KeyEvent): boolean {
  return e.key === "Enter" && !isComposing(e);
}

/**
 * Escape that means "never mind", not Escape that dismisses an input method's
 * candidates.
 *
 * The same keydown reaches the page, and taken as "cancel" it threw away the
 * message being rewritten, or closed the dialog being typed into, along with
 * the word that was only meant to be taken back.
 */
export function isEscape(e: KeyEvent): boolean {
  return e.key === "Escape" && !isComposing(e);
}

/** A React event carries it on `nativeEvent`, a DOM one on itself. */
type KeyEvent = { key: string; keyCode?: number; nativeEvent?: { isComposing?: boolean }; isComposing?: boolean };

/**
 * An input method has the key: composing, or Safari's keydown just after it
 * ended. What every key rule of the message box asks, not `isComposing` alone,
 * which misses the second.
 */
export const isComposing = (e: KeyEvent): boolean => Boolean(e.nativeEvent?.isComposing ?? e.isComposing) || e.keyCode === 229;
