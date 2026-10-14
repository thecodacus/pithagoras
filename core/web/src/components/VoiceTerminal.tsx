import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { PortalEvent } from '../api';
import { useFollowBottom } from '../use-follow-bottom';
import { SHELL_TOOL, unwrap } from '../tool-activity';
import { stripAnsi, toolOutputText } from '../transcript';
import { t, useLanguage } from "../i18n";

type Run = { id: string; command: string; output: string; running: boolean; error: boolean; interrupted?: boolean };

/**
 * The commands in `events`, oldest first, the last `limit` of them. `ended`:
 * the run is over though no event says so — see buildTranscript.
 *
 * One pass, whatever the length: this runs again with every token streamed.
 */
export function terminalRuns(events: PortalEvent[], limit = 6, maxOutput = 20000, ended = false) {
  const runs: (Run & { result?: unknown })[] = [];
  const byId = new Map<string, Run & { result?: unknown }>();
  const open = new Set<Run>();
  // What the chat does with a call whose end never came: it was cut off.
  const settle = () => {
    for (const run of open) { run.running = false; run.interrupted = true; }
    open.clear();
  };
  for (const event of events) {
    const p = event.payload ?? {};
    switch (event.type) {
      case 'tool_execution_start': {
        const { name, input } = unwrap(p);
        if (!SHELL_TOOL.test(name)) break;
        const run = { id: p.toolCallId ?? String(event.seq), command: input.command ?? input.cmd ?? name, output: '', running: true, error: false };
        runs.push(run);
        byId.set(run.id, run);
        open.add(run);
        break;
      }
      case 'tool_execution_update':
      case 'tool_execution_end': {
        let run = p.toolCallId ? byId.get(p.toolCallId) : undefined;
        if (!p.toolCallId && SHELL_TOOL.test(unwrap(p).name)) run = [...open].at(-1);
        if (!run) break;
        // Only the newest output is shown: read once, at the end.
        const result = p.partialResult ?? p.result;
        if (result !== undefined) run.result = result;
        if (event.type === 'tool_execution_end') {
          run.running = false;
          run.error = !!p.isError;
          delete run.interrupted;
          open.delete(run);
        }
        break;
      }
      case 'portal_status':
        if (typeof p.status === 'string' && p.status !== 'running') settle();
        break;
      case 'agent_end':
      case 'agent_start':
        settle();
        break;
    }
  }
  if (ended) settle();
  return runs.slice(-limit).map(({ result, ...run }) => {
    const text = result === undefined ? undefined : toolOutputText(result);
    return typeof text === 'string' ? { ...run, output: text.slice(-maxOutput) } : run;
  });
}

/**
 * What the agent ran and what came back, as a terminal would show it.
 *
 * `focus` is a tool call to bring into view — "Show the whole output" on a call
 * in the chat — marked for a moment so the eye finds it among the others.
 * `onFocused` hands it back once it has been shown, so opening the terminal
 * again later does not scroll back to it.
 */
export function VoiceTerminal({ events, limit, maxOutput, ended, focus, onFocused, hidden = false }: {
  events: PortalEvent[];
  limit?: number;
  maxOutput?: number;
  ended?: boolean;
  focus?: { id: string; at: number } | null;
  onFocused?: () => void;
  /** Behind another tab: kept as it was, rather than worked out anew with every token. */
  hidden?: boolean;
}) {
  // The command being shown, while it is: new output does not scroll away from it.
  const focused = useRef<string | null>(null);
  const { ref, attach, onScroll, follow, settle } = useFollowBottom<HTMLDivElement>({ paused: () => !!focused.current });
  const seen = useRef(events);
  if (!hidden) seen.current = events;
  const shownEvents = seen.current;
  const runs = useMemo(() => terminalRuns(shownEvents, limit, maxOutput, ended), [shownEvents, limit, maxOutput, ended]);
  const release = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(release.current), []);
  // Follows new output, but leaves you where you scrolled to read earlier lines.
  // Before paint, so new lines are never shown at the old scroll position.
  useLayoutEffect(() => { if (!focused.current) follow(); }, [shownEvents]);
  useEffect(() => {
    if (!focus || !ref.current) return;
    onFocused?.();
    const el = ref.current.querySelector<HTMLElement>(`[data-run="${CSS.escape(focus.id)}"]`);
    // Not among those drawn: whatever was being shown before keeps its own release.
    if (!el) return;
    window.clearTimeout(release.current);
    focused.current = focus.id;
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    el.classList.remove('is-focused');
    void el.offsetWidth;
    el.classList.add('is-focused');
    // Shown: from here it follows again if that left it near the end — moving
    // up to show the command read as leaving the end.
    release.current = window.setTimeout(() => { focused.current = null; settle(); }, 1200);
  }, [focus?.id, focus?.at]);
  return <div ref={attach} onScroll={onScroll} className="voice-terminal-output" role="region" aria-label={t("Agent terminal output")}>
    {!runs.length && <p className="voice-terminal-empty">{t("No commands yet. What the agent runs shows up here as it runs.")}</p>}
    {runs.map(run => <TerminalRun key={run.id} {...run} />)}
  </div>;
}

/** One command. Kept apart so a run whose output has not changed is not cleaned of its codes again. */
const TerminalRun = memo(function TerminalRun({ id, command, output, running, error, interrupted }: Run) {
  const shown = useMemo(() => stripAnsi(output), [output]);
  // Memoized, so not drawn again from above when the language changes: it asks itself.
  useLanguage();
  return <div data-run={id} className="voice-terminal-run">
    <div className="voice-terminal-command"><span aria-hidden>$</span><code>{command}</code>{running && <i role="img" aria-label={t("Command running")} />}{interrupted && <small>{t("interrupted")}</small>}</div>
    {shown && <pre className={error ? 'is-error' : ''}>{shown}</pre>}
  </div>;
});
