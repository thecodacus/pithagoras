import { useEffect, useState } from "react";
import { local } from "./safe-storage";

import { msg, tc } from "./i18n";
/**
 * Keyboard shortcuts, and the person's own choice of them.
 *
 * A shortcut is kept as the physical key (`KeyboardEvent.code`) and its
 * modifiers, not as the character it types: with Alt, a Mac types "√" for V,
 * and on a German keyboard "/" is Shift+7. The physical key is the same
 * whatever the layout and the modifiers, and it is shown with what that key
 * says on this keyboard where the browser can tell (see `useKeyLabels`).
 *
 * Every action has a default; what somebody changes is kept in this browser,
 * and only what differs from the default is stored, so a default changed in a
 * later version still reaches everyone who did not choose otherwise.
 */

export interface Binding {
  code: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
}

export type ActionId =
  | "voice.toggle"
  | "voice.mute"
  | "voice.hold"
  | "voice.stop"
  | "voice.picture"
  | "voice.repeat"
  | "voice.conversation"
  | "voice.canvas"
  | "voice.files"
  | "voice.pictures"
  | "voice.terminal"
  | "voice.browser"
  | "voice.settings"
  | "voice.faster"
  | "voice.slower"
  | "voice.steer"
  | "voice.ptt"
  | "voice.sounds";

export interface Action {
  id: ActionId;
  label: string;
  /** Where it works. Voice-mode ones only while voice mode is on. */
  scope: "Voice mode";
  /** Held rather than pressed: acts on the key going down and coming up. */
  hold?: boolean;
  /** Works while typing in a field too; only sensible with a modifier. */
  anywhere?: boolean;
  default: Binding | null;
}

export const ACTIONS: Action[] = [
  { id: "voice.toggle", label: msg("Start or end voice mode"), scope: "Voice mode", anywhere: true, default: { code: "KeyV", alt: true } },
  { id: "voice.mute", label: msg("Mute or unmute the microphone"), scope: "Voice mode", default: { code: "KeyM" } },
  { id: "voice.hold", label: msg("Talk, with push-to-talk on (hold)"), scope: "Voice mode", hold: true, default: { code: "Space" } },
  { id: "voice.stop", label: msg("Stop the agent, or end voice mode when it is idle"), scope: "Voice mode", default: { code: "Escape" } },
  { id: "voice.picture", label: msg("Add a picture"), scope: "Voice mode", default: { code: "KeyP" } },
  { id: "voice.repeat", label: msg("Repeat the last reply"), scope: "Voice mode", default: { code: "KeyR" } },
  { id: "voice.conversation", label: msg("Show or hide the conversation"), scope: "Voice mode", default: { code: "KeyC" } },
  { id: "voice.canvas", label: msg("Show or hide canvases"), scope: "Voice mode", default: { code: "KeyD" } },
  { id: "voice.files", label: msg("Show or hide files"), scope: "Voice mode", default: { code: "KeyF" } },
  { id: "voice.pictures", label: msg("Show or hide pictures"), scope: "Voice mode", default: { code: "KeyI" } },
  { id: "voice.terminal", label: msg("Show or hide the terminal"), scope: "Voice mode", default: { code: "KeyT" } },
  { id: "voice.browser", label: msg("Show or hide the browser"), scope: "Voice mode", default: { code: "KeyB" } },
  { id: "voice.settings", label: msg("Open or close voice settings"), scope: "Voice mode", default: { code: "KeyO" } },
  { id: "voice.faster", label: msg("Speak faster"), scope: "Voice mode", default: { code: "Period" } },
  { id: "voice.slower", label: msg("Speak slower"), scope: "Voice mode", default: { code: "Comma" } },
  { id: "voice.steer", label: msg("Switch between stopping and adding to the task"), scope: "Voice mode", default: { code: "KeyA" } },
  { id: "voice.ptt", label: msg("Turn push-to-talk on or off"), scope: "Voice mode", default: { code: "KeyH" } },
  { id: "voice.sounds", label: msg("Turn sound effects on or off"), scope: "Voice mode", default: { code: "KeyM", shift: true } },
];

export interface FixedShortcut {
  label: string;
  keys: Binding;
  scope: string;
  /** The command character, whichever one is in use: `keys` is only what it is until another is chosen. */
  command?: true;
}

/** Shortcuts that are part of how text fields work, listed so they can be found, not changed. */
export const FIXED: FixedShortcut[] = [
  { label: msg("Jump to the message box"), keys: { code: "Slash" }, scope: "Chat", command: true },
  { label: msg("Send the message"), keys: { code: "Enter" }, scope: "Chat" },
  { label: msg("New line in the message"), keys: { code: "Enter", shift: true }, scope: "Chat" },
  { label: msg("Stop the run"), keys: { code: "Escape" }, scope: "Chat" },
];

const STORE = "keybindings";
export const CHANGED = "keybindings-changed";

type Stored = Partial<Record<ActionId, Binding | null>>;

const isBinding = (v: unknown): v is Binding => !!v && typeof (v as Binding).code === "string" && !!(v as Binding).code;

/**
 * Tab, alone or with Shift: how the keyboard moves from one button to the next,
 * which no shortcut may take. One stored by an older version is not taken either.
 */
export const movesFocus = (b: { code: string; ctrl?: boolean; alt?: boolean; meta?: boolean }): boolean => b.code === "Tab" && !b.ctrl && !b.alt && !b.meta;

/** What was chosen in this browser, as stored: only what differs from the defaults. */
function stored(): Stored {
  try {
    const raw = JSON.parse(local.get(STORE) ?? "{}");
    const out: Stored = {};
    for (const action of ACTIONS) {
      const v = raw?.[action.id];
      if (v === null) out[action.id] = null;
      else if (isBinding(v) && !movesFocus(v)) out[action.id] = normalize(v);
    }
    return out;
  } catch {
    return {};
  }
}

const normalize = (b: Binding): Binding => ({
  code: b.code,
  ...(b.ctrl ? { ctrl: true } : {}),
  ...(b.alt ? { alt: true } : {}),
  ...(b.shift ? { shift: true } : {}),
  ...(b.meta ? { meta: true } : {}),
});

export const same = (a: Binding | null | undefined, b: Binding | null | undefined): boolean =>
  !!a && !!b && a.code === b.code && !!a.ctrl === !!b.ctrl && !!a.alt === !!b.alt && !!a.shift === !!b.shift && !!a.meta === !!b.meta;

/** Every action's shortcut now: the chosen one, or the default. `null` is none. */
export function resolve(choice: Stored = stored()): Record<ActionId, Binding | null> {
  const out = {} as Record<ActionId, Binding | null>;
  for (const action of ACTIONS) out[action.id] = action.id in choice ? choice[action.id]! : action.default;
  return out;
}

function save(choice: Stored) {
  local.set(STORE, JSON.stringify(choice));
  window.dispatchEvent(new Event(CHANGED));
}

/**
 * Gives `id` the shortcut `binding` (or none, with null). An action that had
 * it already loses it, so one key never does two things; its name is returned
 * so that the person can be told.
 */
export function assign(id: ActionId, binding: Binding | null, current: Stored = stored()): { choice: Stored; took?: ActionId } {
  if (binding && movesFocus(binding)) return { choice: current };
  const resolved = resolve(current);
  const choice: Stored = { ...current };
  let took: ActionId | undefined;
  if (binding) {
    for (const action of ACTIONS) {
      if (action.id !== id && same(resolved[action.id], binding)) { choice[action.id] = null; took = action.id; }
    }
  }
  const def = ACTIONS.find(a => a.id === id)!.default;
  if (binding ? same(binding, def) : def === null) delete choice[id];
  else choice[id] = binding ? normalize(binding) : null;
  return { choice, took };
}

export function setBinding(id: ActionId, binding: Binding | null): ActionId | undefined {
  const { choice, took } = assign(id, binding);
  save(choice);
  return took;
}

export function resetBinding(id: ActionId): ActionId | undefined {
  return setBinding(id, ACTIONS.find(a => a.id === id)!.default);
}

export function resetAll() {
  save({});
}

/** The shortcut a key event is, or undefined for a key alone that is only a modifier. */
export function bindingOf(e: { code: string; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean }): Binding | undefined {
  if (!e.code || /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(e.code) || e.code === "CapsLock" || e.code === "Fn") return undefined;
  return normalize({ code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey });
}

/** Whether this key event is `binding`. A held key comes up without its modifiers, so the release matches by key alone. */
export function matches(binding: Binding | null, e: { code: string; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean; type?: string }): boolean {
  if (!binding) return false;
  if (e.type === "keyup") return e.code === binding.code;
  return same(binding, bindingOf(e) ?? null);
}

/** The keys that are a symbol, the same in every language: the ones with a word for a name are in SPOKEN. */
const NAMES: Record<string, string> = {
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Minus: "-", Equal: "=", Backquote: "`",
};

/** The keys with a word for a name, in the language shown: a key's "Home" is not the folder's. */
const SPOKEN: Record<string, () => string> = {
  Space: () => tc("Space", "key"),
  Escape: () => tc("Esc", "key"),
  Enter: () => tc("Enter", "key"),
  Backspace: () => tc("Backspace", "key"),
  Tab: () => tc("Tab", "key"),
  Delete: () => tc("Del", "key"),
  Home: () => tc("Home", "key"),
  End: () => tc("End", "key"),
  PageUp: () => tc("Page up", "key"),
  PageDown: () => tc("Page down", "key"),
};

/**
 * What a key is called: a named key by its name, in the language shown, any
 * other by what it types on this keyboard when the layout is known, and by the
 * US layout otherwise.
 */
export function keyName(code: string, layout?: Map<string, string> | null): string {
  const named = NAMES[code];
  if (SPOKEN[code]) return SPOKEN[code]();
  const typed = layout?.get(code);
  if (typed && typed.trim()) return typed.toUpperCase();
  if (named) return named;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad/.test(code)) return "Num " + code.slice(6);
  return code;
}

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");

/** "Ctrl+Shift+M", or "⌥V" on a Mac: how a shortcut is written for this computer. */
export function describe(b: Binding | null, layout?: Map<string, string> | null, onMac = mac): string {
  if (!b) return "";
  const key = keyName(b.code, layout);
  if (onMac) return `${b.ctrl ? "⌃" : ""}${b.alt ? "⌥" : ""}${b.shift ? "⇧" : ""}${b.meta ? "⌘" : ""}${key}`;
  return [b.ctrl && tc("Ctrl", "key"), b.alt && tc("Alt", "key"), b.shift && tc("Shift", "key"), b.meta && "Win", key].filter(Boolean).join("+");
}

/** The shortcuts now, kept up to date when they are changed anywhere in the page. */
export function useKeybindings(): Record<ActionId, Binding | null> {
  const [bindings, setBindings] = useState(() => resolve());
  useEffect(() => {
    const update = () => setBindings(resolve());
    window.addEventListener(CHANGED, update);
    window.addEventListener("storage", update);
    return () => { window.removeEventListener(CHANGED, update); window.removeEventListener("storage", update); };
  }, []);
  return bindings;
}

/** What each key types on this keyboard, where the browser says (Chromium does, over HTTPS). */
export function useKeyLabels(): Map<string, string> | null {
  const [layout, setLayout] = useState<Map<string, string> | null>(null);
  useEffect(() => {
    const keyboard = (navigator as any).keyboard;
    if (!keyboard?.getLayoutMap) return;
    let alive = true;
    keyboard.getLayoutMap().then((map: Map<string, string>) => { if (alive) setLayout(new Map(map)); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return layout;
}
