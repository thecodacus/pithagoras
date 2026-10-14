export interface ClipboardEnv {
  /** `navigator.clipboard`, where the browser has one. */
  clipboard?: { writeText(text: string): Promise<void> };
  /** Whether the page may use it: browsers only allow it in a secure context. */
  secure: boolean;
  /** The old way, for pages that are not. Returns whether it worked. */
  legacy: (text: string) => boolean;
}

/** Puts a hidden textarea on the page, selects it and copies. Works over plain HTTP. */
function legacyCopy(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  document.body.appendChild(area);
  // Whatever had focus gets it back: the message box, most likely, mid-sentence.
  const before = document.activeElement as HTMLElement | null;
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    before?.focus?.();
  }
}

const browser = (): ClipboardEnv => ({
  clipboard: navigator.clipboard,
  secure: window.isSecureContext,
  legacy: legacyCopy,
});

/**
 * Copies `text`, and says whether it got there.
 *
 * The portal is as often as not opened over plain HTTP on a home network, where
 * `navigator.clipboard` does not exist — a copy button that only worked on
 * localhost would be a button that does nothing where it is most used.
 */
export async function copyText(text: string, env: ClipboardEnv = browser()): Promise<boolean> {
  if (env.secure && env.clipboard) {
    try {
      await env.clipboard.writeText(text);
      return true;
    } catch {
      // Refused (no focus, no permission): the old way may still be allowed.
    }
  }
  return env.legacy(text);
}
