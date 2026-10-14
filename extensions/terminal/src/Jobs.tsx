import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { LuSquare, LuTrash2 } from "react-icons/lu";
import { portal, t } from "./portal";
import { formatElapsed, stripAnsi } from "./text";

/** Output kept on screen for one job; the file has the rest. */
const KEEP = 400_000;

const jobUrl = (chatId: string, key: string) => `/api/sessions/${encodeURIComponent(chatId)}/background/${encodeURIComponent(key)}`;

/**
 * The agent's background jobs in a chat: which are running and for how long,
 * and one of them followed as it writes, like a background shell in Claude
 * Code. What pi's extensions show in its footer is above them.
 */
export function Jobs({ chatId, selected, onSelect }: { chatId: string; selected: string | null; onSelect: (key: string) => void }) {
  // Drawn as part of what the portal draws only when it changes: it follows the language itself.
  portal.locale.use();
  const { background: state, refreshBackground } = portal.chats.use(chatId, (feed) => ({ background: feed.background, refreshBackground: feed.refreshBackground }));
  const jobs = state.jobs.filter((j) => !j.attached);
  const job = jobs.find((j) => j.key === selected) ?? jobs[0];
  const now = portal.ui.useNow(jobs.some((j) => j.state === "running"));
  const [error, setError] = useState<string | null>(null);

  const took = (from: number, to?: number) => formatElapsed(Math.max(0, Math.floor(((to ?? now) - from) / 1000)));

  return (
    <div className="terminal-jobs">
      {(state.statuses.length > 0 || state.widgets.length > 0) && (
        <div className="terminal-ext">
          {state.statuses.map((s) => (
            <div key={s.key} className="terminal-ext-status">
              <span>{s.key}</span>
              {s.text}
            </div>
          ))}
          {state.widgets.map((w) => (
            <pre key={w.key} className="terminal-ext-widget">
              {w.lines.join("\n")}
            </pre>
          ))}
        </div>
      )}
      {!state.supported && <p className="terminal-jobs-empty">{t("Background jobs can only be followed when pi runs on the host (EXECUTOR=host).")}</p>}
      {state.supported && !jobs.length && (
        <p className="terminal-jobs-empty">{t("Nothing running in the background. What the agent leaves running — a dev server, a watcher, an extension's job — shows up here.")}</p>
      )}
      {jobs.length > 0 && (
        <>
          <div className="terminal-jobs-list">
            <div role="listbox" aria-label={t("Background jobs")} className="terminal-jobs-options">
              {jobs.map((j) => (
                <button key={j.key} type="button" role="option" aria-selected={j.key === job?.key} onClick={() => onSelect(j.key)} className={`terminal-job is-${j.state}`}>
                  <i className="terminal-job-dot" aria-hidden />
                  <span className="terminal-job-command">{j.command}</span>
                  <span className="terminal-job-meta">
                    {j.state === "exited" ? t("finished · ran {time}", { time: took(j.startedAt, j.exitedAt) }) : j.state === "stopped" ? t("paused") : took(j.startedAt)}
                  </span>
                </button>
              ))}
            </div>
            {jobs.some((j) => j.state === "exited") && (
              <button
                type="button"
                className="terminal-jobs-clear"
                onClick={() => {
                  setError(null);
                  portal.api.json(`/api/sessions/${encodeURIComponent(chatId)}/background/clear`, { method: "POST" }).then(refreshBackground, (e) => setError((e as Error).message));
                }}
                title={t("Forget the finished jobs")}
              >
                <LuTrash2 aria-hidden /> {t("Clear finished")}
              </button>
            )}
          </div>
          {job && (
            <div className="terminal-job-view">
              <div className="terminal-job-head">
                <code>{job.command}</code>
                <span className={`terminal-job-state is-${job.state}`}>{job.state === "exited" ? t("finished") : job.state === "stopped" ? t("paused") : t("running")}</span>
                {job.pids.length > 0 && <span className="terminal-job-pid">pid {job.pids.join(", ")}</span>}
                {job.state !== "exited" && (
                  <button
                    type="button"
                    className="terminal-job-stop"
                    onClick={() => {
                      setError(null);
                      portal.api.json(`${jobUrl(chatId, job.key)}/stop`, { method: "POST" }).then(refreshBackground, (e) => setError((e as Error).message));
                    }}
                  >
                    <LuSquare aria-hidden fill="currentColor" /> {t("Stop")}
                  </button>
                )}
              </div>
              {error && (
                <p role="alert" className="terminal-jobs-error">
                  {error}
                </p>
              )}
              {job.hasOutput ? (
                <JobOutput key={job.key} chatId={chatId} jobKey={job.key} live={job.state !== "exited"} />
              ) : (
                <p className="terminal-jobs-empty">{t("This job's output does not go to a file, so it cannot be followed from here.")}</p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** One job's output file, followed from where it was last read. Not drawn again for the second's tick of the list above it. */
const JobOutput = memo(function JobOutput({ chatId, jobKey, live }: { chatId: string; jobKey: string; live: boolean }) {
  portal.locale.use();
  const [text, setText] = useState("");
  const [gone, setGone] = useState<string | null>(null);
  // The last read did not go through: what was read stays, and it is asked again.
  const [lagging, setLagging] = useState<string | null>(null);
  const offset = useRef<number | undefined>(undefined);
  const { attach, onScroll, follow } = portal.ui.useFollowBottom<HTMLPreElement>();
  useEffect(() => {
    let stop = false;
    let timer = 0;
    // How long to wait after a read that failed: longer each time, so that a portal that is down is not asked every second.
    let wait = 1000;
    const read = async () => {
      try {
        const from = offset.current === undefined ? "" : `?from=${offset.current}`;
        const out = await portal.api.json<{ text: string; from: number; size: number }>(`${jobUrl(chatId, jobKey)}/output${from}`);
        if (stop) return;
        offset.current = out.size;
        wait = 1000;
        setLagging(null);
        if (out.text) setText((t) => (t + out.text).slice(-KEEP));
      } catch (e) {
        if (stop) return;
        // Not a file the portal can follow, or a chat that is gone: a second try changes nothing.
        if (e instanceof portal.api.ApiError && e.status === 404) {
          setGone(e.message);
          return;
        }
        // The portal could not be reached, or was restarting: one failed read must not end the following of a job that goes on writing.
        setLagging((e as Error).message);
        timer = window.setTimeout(read, wait);
        wait = Math.min(wait * 2, 15_000);
        return;
      }
      if (!stop && live) timer = window.setTimeout(read, 1000);
    };
    void read();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [chatId, jobKey, live]);
  useLayoutEffect(() => follow(), [text]);
  // Up to KEEP characters: not worked through again by a draw that has no new output.
  const plain = useMemo(() => stripAnsi(text), [text]);
  if (gone) return <p className="terminal-jobs-empty">{gone}</p>;
  return (
    <>
      <pre ref={attach} onScroll={onScroll} className="terminal-job-output">
        {plain || (live ? t("Waiting for output…") : t("(no output)"))}
      </pre>
      {lagging && (
        <p role="alert" className="terminal-jobs-error">
          {t("The output could not be read — trying again: {error}", { error: lagging })}
        </p>
      )}
    </>
  );
});
