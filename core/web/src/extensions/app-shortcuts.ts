import { useEffect, useRef } from "react";
import { actions as actionList, isEditing, matches, useKeybindings } from "../keybindings";
import { runAppShortcut } from "./shortcuts";

/**
 * The extensions' shortcuts for anywhere in the portal (`portal.shortcuts.register({ scope: "app" })`), run by one listener on the
 * page. Heard after the page's own parts, so that a part that handled the key (and said so) has it: what is left is the extension's.
 *
 * A key alone is left to a field the person is typing in; one with Ctrl, Alt or the Windows/Command key in it works there too. A dialog
 * has the keys while it is open. AltGr is reported as Ctrl+Alt on Windows and types a character on some layouts (µ for AltGr+M on a
 * German one): there it is a letter of the text, not a shortcut.
 */
export function useAppShortcuts(): void {
  const bindings = useKeybindings();
  const current = useRef(bindings);
  current.current = bindings;
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || document.querySelector('[aria-modal="true"]')) return;
      for (const action of actionList()) {
        if (action.scope !== "Portal") continue;
        const binding = current.current[action.id];
        if (!binding || !matches(binding, e)) continue;
        if (e.getModifierState?.("AltGraph")) return;
        if (isEditing(e.target) && !(binding.ctrl || binding.alt || binding.meta)) return;
        if (e.repeat) return void e.preventDefault();
        if (runAppShortcut(action.id, e) !== false) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, []);
}
