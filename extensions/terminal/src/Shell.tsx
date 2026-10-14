import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { portal, t } from "./portal";
import { orderedInput } from "./text";

/**
 * A shell of the person's own, in the folder of the chat it was opened from.
 * Its own chunk: the terminal emulator is large, and only a chat whose Shell
 * tab is opened needs it.
 *
 * Output arrives over SSE and keystrokes go back as POSTs, the same shape the
 * conversation already uses, and no websocket to add. The scrollback is
 * replayed on connect, so closing the panel and opening it again keeps the
 * screen.
 */
export function Shell({ chatId }: { chatId: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!host.current) return;
    // What xterm says to a screen reader, in the language of the page: the name of the input, and what it says when too much came at once.
    Terminal.strings.promptLabel = t("Terminal input");
    Terminal.strings.tooMuchOutput = t("Too much output to read out; move through the lines to read it.");
    const term = new Terminal({
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      // The portal's colours for a terminal, which a theme may set.
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

    const route = (path = "") => portal.api.url(`/terminal${path}`);
    const post = (path: string, body: unknown) => portal.api.json(route(path), { method: "POST", body: JSON.stringify(body) });
    const close = (termId: string) => portal.api.json(route(`/${termId}`), { method: "DELETE" }).catch(() => {});

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
      post(`/${id}/resize`, { rows: term.rows, cols: term.cols }).catch(() => {});
    };

    Promise.resolve()
      .then(() => post("", { chat: chatId }) as Promise<{ id: string; cwd: string }>)
      .then(({ id: termId }) => {
        if (closed) return void close(termId);
        id = termId;
        // Keystrokes that go nowhere (the shell has exited, or the portal has
        // restarted) would vanish, and the panel look merely unresponsive.
        // Said once, not on every key, and again after the stream has come back:
        // what it replays starts with a reset, which clears the screen of the notice.
        let told = false;
        source = new EventSource(route(`/${termId}/stream`));
        source.onmessage = (m) => term.write(JSON.parse(m.data));
        source.onopen = () => {
          told = false;
        };
        term.onData(
          orderedInput(
            (data) => post(`/${termId}/input`, { data }),
            () => {
              if (told || closed) return;
              told = true;
              term.write(`\r\n[${t("Connection to the shell lost — close this panel and open it again")}]\r\n`);
            },
          ),
        );
        resize();
      })
      .catch((e) => term.write(`\r\n${t("Could not open a shell: {error}", { error: (e as Error).message })}\r\n`));

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
      if (id) void close(id);
      term.dispose();
    };
  }, [chatId]);

  return <div ref={host} className="terminal-shell" />;
}

/** The terminal's colours as the page has them now (the portal's `--terminal` and `--terminal-fg`), in the form xterm takes. */
function terminalColours() {
  const style = getComputedStyle(document.documentElement);
  const colour = (token: string) => `rgb(${style.getPropertyValue(token).trim().split(/\s+/).join(", ")})`;
  return { background: colour("--terminal"), foreground: colour("--terminal-fg") };
}
