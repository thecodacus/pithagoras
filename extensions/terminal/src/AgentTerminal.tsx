import { memo, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { portal, t } from "./portal";
import { terminalRuns, type Run } from "./runs";
import { stripAnsi } from "./text";

/**
 * What the agent ran in a chat and what came back, as a terminal would show it.
 *
 * `focus` is a tool call to bring into view ("Show the whole output" on a call
 * in the chat), marked for a moment so the eye finds it among the others.
 * `onFocused` hands it back once it has been shown, so opening the terminal
 * again later does not scroll back to it.
 */
export function AgentTerminal({ chatId, limit, maxOutput, focus, onFocused, hidden = false }: {
  chatId: string;
  limit?: number;
  maxOutput?: number;
  focus?: { id: string; at: number } | null;
  onFocused?: () => void;
  /** Behind another tab: kept as it was, rather than worked out anew with every token. */
  hidden?: boolean;
}) {
  // Drawn as part of what the portal draws only when it changes: it follows the language itself.
  portal.locale.use();
  const { events, status } = portal.chats.use(chatId, (feed) => ({ events: feed.events, status: feed.status }));
  const ended = status === "interrupted" || status === "error";
  // The command being shown, while it is: new output does not scroll away from it.
  const focused = useRef<string | null>(null);
  const { ref, attach, onScroll, follow, settle } = portal.ui.useFollowBottom<HTMLDivElement>({ paused: () => !!focused.current });
  const seen = useRef(events);
  if (!hidden) seen.current = events;
  const shownEvents = seen.current;
  const runs = useMemo(() => terminalRuns(shownEvents, limit, maxOutput, ended), [shownEvents, limit, maxOutput, ended]);
  const release = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(release.current), []);
  // Follows new output, but leaves you where you scrolled to read earlier lines.
  // Before paint, so new lines are never shown at the old scroll position.
  useLayoutEffect(() => {
    if (!focused.current) follow();
  }, [shownEvents]);
  useEffect(() => {
    if (!focus || !ref.current) return;
    onFocused?.();
    const el = ref.current.querySelector<HTMLElement>(`[data-run="${CSS.escape(focus.id)}"]`);
    // Not among those drawn: whatever was being shown before keeps its own release.
    if (!el) return;
    window.clearTimeout(release.current);
    focused.current = focus.id;
    el.scrollIntoView({ block: "start", behavior: "smooth" });
    el.classList.remove("is-focused");
    void el.offsetWidth;
    el.classList.add("is-focused");
    // Shown: from here it follows again if that left it near the end (moving
    // up to show the command read as leaving the end).
    release.current = window.setTimeout(() => {
      focused.current = null;
      settle();
    }, 1200);
  }, [focus?.id, focus?.at]);
  return (
    <div ref={attach} onScroll={onScroll} className="terminal-output" role="region" aria-label={t("Agent terminal output")}>
      {!runs.length && <p className="terminal-empty">{t("No commands yet. What the agent runs shows up here as it runs.")}</p>}
      {runs.map((run) => (
        <TerminalRun key={run.id} {...run} />
      ))}
    </div>
  );
}

/** One command. Kept apart so a run whose output has not changed is not cleaned of its codes again. */
const TerminalRun = memo(function TerminalRun({ id, command, output, running, error, interrupted }: Run) {
  const shown = useMemo(() => stripAnsi(output), [output]);
  // Memoized, so not drawn again from above when the language changes: it asks itself.
  portal.locale.use();
  return (
    <div data-run={id} className="terminal-run">
      <div className="terminal-command">
        <span aria-hidden>$</span>
        <code>{command}</code>
        {running && <i role="img" aria-label={t("Command running")} />}
        {interrupted && <small>{t("interrupted")}</small>}
      </div>
      {shown && <pre className={error ? "is-error" : ""}>{shown}</pre>}
    </div>
  );
});
