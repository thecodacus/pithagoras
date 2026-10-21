import { useEffect, useRef } from "react";
import type { PanelProps, SlotMap } from "@pithagoras/extension-api";
import { api } from "./api";
import { refresh, useBrowserState } from "./state";
import { portal, t } from "../portal";

/**
 * The browser's own web UI, in a frame through the server half, switched on
 * like a screen: beside a chat (the panel) and in voice mode (the window).
 * While there is none to show, it says why.
 */
function Screen({ onFrame }: { onFrame?: (frame: HTMLIFrameElement) => void }) {
  portal.locale.use();
  const { state, failed } = useBrowserState();
  let said: string | null = null;
  if (failed) said = t("Could not connect to the browser viewer.");
  else if (state && state.install.container !== "running") said = t("The browser viewer is unavailable.");
  return (
    <div className="browser-screen">
      {said ? (
        <p>{said}</p>
      ) : (
        state && (
          <iframe
            src={api.uiUrl()}
            title={t("The agent's browser")}
            className="browser-power"
            onLoad={onFrame && ((e) => onFrame(e.currentTarget))}
            // The VNC client wants the keyboard and the clipboard.
            allow="clipboard-read; clipboard-write; fullscreen"
          />
        )
      )}
    </div>
  );
}

/** The browser beside a chat. */
export function BrowserPanel() {
  return <Screen />;
}

/** What the panel has in its head: Fullscreen, for the panel alone, the one beside it staying where it is. */
export function PanelActions({ panel }: PanelProps) {
  return (
    <button type="button" onClick={() => panel.fullscreen()} className="rounded px-1.5 py-0.5 text-[11px] text-fg-faint transition hover:text-fg">
      {t("Fullscreen")}
    </button>
  );
}

/**
 * The fields the browser's web UI takes keys through for the remote page —
 * everything typed there, into the page or its address bar, goes by one of
 * these, not to a field of the viewer's own. On a desktop and with the
 * on-screen keyboard.
 */
const VIEWER_KEYS = "#overlayInput, #keyboard-input-assist";

/** Where focus is typing. */
const editing = (target: EventTarget | null) => !!(target as Element | null)?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]');

/**
 * The browser in voice mode. Escape restores it from inside the page in it,
 * as it does on the stage: once the page has focus, the key is that page's and
 * never reaches the stage. Heard before the viewer, which would pass it on to
 * the page. A field of the viewer's own keeps its Escape, as one on the stage
 * does — but not the field the viewer takes the remote page's keys through,
 * which has focus whenever the page does.
 *
 * Kept loaded once opened, it asks how the browser stands each time it is
 * opened again: the browser may have started since it last said there was none.
 */
export function BrowserWindow({ opened, maximized, restore }: SlotMap["voice.window"]["props"]) {
  useEffect(() => {
    void refresh();
  }, [opened]);
  const latest = useRef({ maximized, restore });
  latest.current = { maximized, restore };
  const hear = (frame: HTMLIFrameElement) => {
    try {
      frame.contentWindow?.addEventListener(
        "keydown",
        (e) => {
          if (e.code !== "Escape" || !latest.current.maximized) return;
          if (editing(e.target) && !(e.target as Element).matches(VIEWER_KEYS)) return;
          e.preventDefault();
          e.stopPropagation();
          latest.current.restore();
        },
        true,
      );
    } catch {
      // Not the portal's page: its keys stay its own.
    }
  };
  return <Screen onFrame={hear} />;
}
