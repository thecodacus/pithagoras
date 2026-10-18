import type { AppShortcut, Chat, Shortcut, VoiceShortcut, VoiceWindows } from "@pithagoras/extension-api";
import { addAction, bindingFrom, type Action, type ActionId } from "../keybindings";
import { t } from "../i18n";
import { translate } from "./strings";

/**
 * The extensions' keyboard shortcuts (`portal.shortcuts.register`). Each is an
 * action of keybindings.ts beside the portal's own, under `x:<package>/<id>`:
 * listed in Settings → Shortcuts, changed and reset there the same way. What
 * it does is kept here, for voice mode to run when its key is pressed (scope
 * "voice"), or for the page's one listener (app-shortcuts.ts, scope "app").
 */

type Held = { extension: string; scope: "voice" | "app"; run: VoiceShortcut["run"] | AppShortcut["run"] };
const held = new Map<ActionId, Held>();

const SCOPES = { voice: "Voice mode", app: "Portal" } as const;

export function registerShortcut(extension: string, shortcut: Shortcut): () => void {
  if (typeof shortcut?.id !== "string" || !shortcut.id || typeof shortcut.label !== "string" || typeof shortcut.run !== "function") {
    throw new Error("A shortcut needs an id, a label and something to run");
  }
  if (shortcut.scope !== "voice" && shortcut.scope !== "app") throw new Error(`A shortcut's scope is "voice" or "app": "${String((shortcut as { scope?: unknown }).scope)}" is not one`);
  const given = bindingFrom(shortcut.default ?? null);
  if (given === undefined) throw new Error("A shortcut's default is a key, { code } with ctrl, alt, shift or meta, and not Tab; or null for none");
  const id = `x:${extension}/${shortcut.id}` as const;
  const off = addAction({ id, label: shortcut.label, scope: SCOPES[shortcut.scope], default: given, extension });
  const mine: Held = { extension, scope: shortcut.scope, run: shortcut.run };
  held.set(id, mine);
  return () => {
    off();
    if (held.get(id) === mine) held.delete(id);
  };
}

/** What an extension's voice shortcut runs, given the chat on screen and the extension's own voice windows there. */
export function runShortcut(id: ActionId, chat: Chat, windowsOf: (extension: string) => VoiceWindows): boolean | void {
  const shortcut = held.get(id);
  if (!shortcut || shortcut.scope !== "voice") return false;
  try {
    return (shortcut.run as VoiceShortcut["run"])({ chat, windows: windowsOf(shortcut.extension) });
  } catch (e) {
    console.error(`[extensions] ${shortcut.extension}'s shortcut failed:`, e);
    return false;
  }
}

/** What an extension's shortcut for anywhere in the portal runs: the key that was pressed, and where. */
export function runAppShortcut(id: ActionId, event: KeyboardEvent): boolean | void {
  const shortcut = held.get(id);
  if (!shortcut || shortcut.scope !== "app") return false;
  try {
    return (shortcut.run as AppShortcut["run"])({ target: event.target, event });
  } catch (e) {
    console.error(`[extensions] ${shortcut.extension}'s shortcut failed:`, e);
    return false;
  }
}

/** An action's name, in the language shown: the portal's by its own texts, an extension's by the extension's. */
export const actionLabel = (action: Action): string => (action.extension ? translate(action.extension, action.label) : t(action.label));
