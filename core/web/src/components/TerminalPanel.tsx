import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { orderedInput } from "../ordered-input";
import { api } from "../api";

import { t } from "../i18n";

/**
 * A shell in the workspace of the session you are looking at.
 *
 * Output arrives over SSE and keystrokes go back as POSTs — the same shape the
 * transcript already uses, and no websocket to add. The scrollback is replayed
 * on connect, so collapsing the panel and opening it again keeps the screen.
 */
export function TerminalPanel({ sessionId }: { sessionId: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!host.current) return;
    // What xterm says to a screen reader, in the language of the page: the name of the input, and what it says when too much came at once.
    Terminal.strings.promptLabel = t("Terminal input");
    Terminal.strings.tooMuchOutput = t("Too much output to read out; move through the lines to read it.");
    const term = new Terminal({
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      // The portal's own colours for a terminal (see index.css), which a theme may set.
      theme: terminalColours(),
      cursorBlink: true,
      scrollback: 5000,
      // The screen is drawn in a canvas, which a screen reader cannot read: this adds the rows and a live region it can.
      screenReaderMode: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    fit.fit();

    let id: string | null = null;
    let source: EventSource | null = null;
    let closed = false;
    // Dragging the panel fires the observer for every pixel, and most of those
    // leave the character grid as it was.
    let sent = "";
    const resize = () => {
      const size = `${term.rows}x${term.cols}`;
      if (!id || size === sent) return;
      sent = size;
      api.terminalResize(id, term.rows, term.cols).catch(() => {});
    };

    api
      .openTerminal(sessionId)
      .then(({ id: termId }) => {
        if (closed) return void api.closeTerminal(termId).catch(() => {});
        id = termId;
        // Keystrokes that go nowhere — the shell has exited, or the portal has
        // restarted — used to vanish, and the panel looked merely unresponsive.
        // Said once, not on every key — and again after the stream has come back:
        // what it replays starts with a reset, which clears the screen of the notice.
        let told = false;
        source = new EventSource(`/api/terminal/${termId}/stream`);
        source.onmessage = (m) => term.write(JSON.parse(m.data));
        source.onopen = () => {
          told = false;
        };
        term.onData(
          orderedInput(
            (data) => api.terminalInput(termId, data),
            () => {
              if (told || closed) return;
              told = true;
              term.write(`\r\n[${t("Connection to the shell lost — close this panel and open it again")}]\r\n`);
            },
          ),
        );
        resize();
      })
      .catch((e) => term.write(`\r\n${t("Could not open a shell: {error}", { error: e.message })}\r\n`));

    // The panel is resizable, so the pty has to be told when it changes.
    const observer = new ResizeObserver(() => {
      fit.fit();
      resize();
    });
    observer.observe(host.current);

    // Another theme chosen, or light for dark: its colours follow.
    const themed = new MutationObserver(() => (term.options.theme = terminalColours()));
    themed.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });

    return () => {
      closed = true;
      observer.disconnect();
      themed.disconnect();
      source?.close();
      if (id) api.closeTerminal(id).catch(() => {});
      term.dispose();
    };
  }, [sessionId]);

  return <div ref={host} className="h-full w-full bg-[rgb(var(--terminal))] p-1" />;
}

/** The terminal's colours as the page has them now, in the form xterm takes. */
function terminalColours() {
  const style = getComputedStyle(document.documentElement);
  const colour = (token: string) => `rgb(${style.getPropertyValue(token).trim().split(/\s+/).join(", ")})`;
  return { background: colour("--terminal"), foreground: colour("--terminal-fg") };
}
