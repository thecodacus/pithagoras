import { useEffect, useState } from "react";
import { local } from "./safe-storage";
import { DEFAULT_TRIGGER } from "./slash-palette";

const KEY = "commandTrigger";
export const CHANGED = "command-trigger-changed";

/**
 * Whether `text` can be what a command starts with: one punctuation mark or
 * symbol. A letter or a digit is what a message starts with, so every message
 * would open the list; `-`, `_` and `:` are what a command's own name is made
 * of (`skill:review`), and would be read as part of it.
 */
export function validTrigger(text: string): boolean {
  return /^[\p{P}\p{S}]$/u.test(text) && !"-_:".includes(text);
}

/**
 * What was typed into a field that held `before` and now holds `after`: the
 * last character of what was inserted, wherever the caret was or whatever was
 * selected, and none for a deletion. The field is one character wide, so the
 * new one lands before the old, after it, or over it.
 */
export function typedCharacter(before: string, after: string): string {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  return [...after.slice(start, after.length - end)].pop() ?? "";
}

/**
 * The character a command starts with in this browser, "/" until another is
 * chosen.
 *
 * Kept per browser like the keyboard shortcuts, not on the server: what is
 * convenient to type depends on the keyboard (a German one reaches "/" with
 * Shift), and a phone's differs from the laptop's. Only a choice other than
 * the default is stored, so a default changed later still reaches everyone who
 * did not choose.
 */
export function commandTrigger(): string {
  // Storage blocked, or something else in it: the usual one.
  const kept = local.get(KEY);
  return kept !== null && validTrigger(kept) ? kept : DEFAULT_TRIGGER;
}

export function setCommandTrigger(next: string): void {
  if (!validTrigger(next)) return;
  if (next === DEFAULT_TRIGGER) local.remove(KEY);
  else local.set(KEY, next);
  window.dispatchEvent(new Event(CHANGED));
}

/** The trigger now, kept up to date when it is changed anywhere in the page or in another tab. */
export function useCommandTrigger(): string {
  const [trigger, setTrigger] = useState(commandTrigger);
  useEffect(() => {
    const update = () => setTrigger(commandTrigger());
    window.addEventListener(CHANGED, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(CHANGED, update);
      window.removeEventListener("storage", update);
    };
  }, []);
  return trigger;
}
