import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNow } from "../use-now";
import { LuSquare, LuTrash2 } from "react-icons/lu";
import { api, ApiError, type BackgroundState } from "../api";
import { useFollowBottom } from "../use-follow-bottom";
import { formatElapsed, stripAnsi } from "../transcript";
import { t, useLanguage } from "../i18n";

/** Output kept on screen for one job; the file has the rest. */
const KEEP = 400_000;

/**
 * The agent's background jobs, in the terminal panel: which are running and
 * for how long, and one of them followed as it writes — like a background
 * shell in Claude Code. What extensions show in pi's footer is above them.
 */
export function BackgroundJobs({
  sessionId,
  state,
  selected,
  onSelect,
  onChanged,
}: {
  sessionId: string;
  state: BackgroundState;
  selected: string | null;
  onSelect: (key: string) => void;
  onChanged: () => void;
}) {
  const jobs = state.jobs.filter((j) => !j.attached);
  const job = jobs.find((j) => j.key === selected) ?? jobs[0];
  const now = useNow(jobs.some((j) => j.state === "running"));
  const [error, setError] = useState<string | null>(null);

  const took = (from: number, to?: number) => formatElapsed(Math.max(0, Math.floor(((to ?? now) - from) / 1000)));

  return (
    <div className="bg-jobs">
      {(state.statuses.length > 0 || state.widgets.length > 0) && (
        <div className="bg-ext">
          {state.statuses.map((s) => (
            <div key={s.key} className="bg-ext-status"><span>{s.key}</span>{s.text}</div>
          ))}
          {state.widgets.map((w) => (
            <pre key={w.key} className="bg-ext-widget">{w.lines.join("\n")}</pre>
          ))}
        </div>
      )}
      {!state.supported && (
        <p className="bg-jobs-empty">{t("Background jobs can only be followed when pi runs on the host (EXECUTOR=host).")}</p>
      )}
      {state.supported && !jobs.length && (
        <p className="bg-jobs-empty">{t("Nothing running in the background. What the agent leaves running — a dev server, a watcher, an extension's job — shows up here.")}</p>
      )}
      {jobs.length > 0 && (
        <>
          <div className="bg-jobs-list">
            <div role="listbox" aria-label={t("Background jobs")} className="contents">
            {jobs.map((j) => (
              <button
                key={j.key}
                type="button"
                role="option"
                aria-selected={j.key === job?.key}
                onClick={() => onSelect(j.key)}
                className={`bg-job is-${j.state}`}
              >
                <i className="bg-job-dot" aria-hidden />
                <span className="bg-job-command">{j.command}</span>
                <span className="bg-job-meta">
                  {j.state === "exited" ? t("finished · ran {time}", { time: took(j.startedAt, j.exitedAt) }) : j.state === "stopped" ? t("paused") : took(j.startedAt)}
                </span>
              </button>
            ))}
            </div>
            {jobs.some((j) => j.state === "exited") && (
              <button type="button" className="bg-jobs-clear" onClick={() => {
                setError(null);
                api.clearBackground(sessionId).then(onChanged, (e) => setError((e as Error).message));
              }} title={t("Forget the finished jobs")}>
                <LuTrash2 aria-hidden /> {t("Clear finished")}
              </button>
            )}
          </div>
          {job && (
            <div className="bg-job-view">
              <div className="bg-job-head">
                <code>{job.command}</code>
                <span className={`bg-job-state is-${job.state}`}>{job.state === "exited" ? t("finished") : job.state === "stopped" ? t("paused") : t("running")}</span>
                {job.pids.length > 0 && <span className="bg-job-pid">pid {job.pids.join(", ")}</span>}
                {job.state !== "exited" && (
                  <button
                    type="button"
                    className="bg-job-stop"
                    onClick={() => {
                      setError(null);
                      api.stopBackground(sessionId, job.key).then(onChanged, (e) => setError((e as Error).message));
                    }}
                  >
                    <LuSquare aria-hidden fill="currentColor" /> {t("Stop")}
                  </button>
                )}
              </div>
              {error && <p role="alert" className="bg-jobs-error">{error}</p>}
              {job.hasOutput ? (
                <JobOutput key={job.key} sessionId={sessionId} jobKey={job.key} live={job.state !== "exited"} />
              ) : (
                <p className="bg-jobs-empty">{job.attached ? t("This job's output does not go to a file, so it cannot be followed from here — it is a command the chat shows.") : t("This job's output does not go to a file, so it cannot be followed from here.")}</p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** One job's output file, followed from where it was last read. Not drawn again for the second's tick of the list above it. */
const JobOutput = memo(function JobOutput({ sessionId, jobKey, live }: { sessionId: string; jobKey: string; live: boolean }) {
  useLanguage();
  const [text, setText] = useState("");
  const [gone, setGone] = useState<string | null>(null);
  // The last read did not go through: what was read stays, and it is asked again.
  const [lagging, setLagging] = useState<string | null>(null);
  const offset = useRef<number | undefined>(undefined);
  const { attach, onScroll, follow } = useFollowBottom<HTMLPreElement>();
  useEffect(() => {
    let stop = false;
    let timer = 0;
    // How long to wait after a read that failed: longer each time, so that a portal that is down is not asked every second.
    let wait = 1000;
    const read = async () => {
      try {
        const out = await api.backgroundOutput(sessionId, jobKey, offset.current);
        if (stop) return;
        offset.current = out.size;
        wait = 1000;
        setLagging(null);
        if (out.text) setText((t) => (t + out.text).slice(-KEEP));
      } catch (e) {
        if (stop) return;
        // Not a file the portal can follow, or a chat that is gone: a second try changes nothing.
        if (e instanceof ApiError && e.status === 404) {
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
  }, [sessionId, jobKey, live]);
  useLayoutEffect(() => follow(), [text]);
  // Up to KEEP characters: not worked through again by a draw that has no new output.
  const plain = useMemo(() => stripAnsi(text), [text]);
  if (gone) return <p className="bg-jobs-empty">{gone}</p>;
  return (
    <>
      <pre ref={attach} onScroll={onScroll} className="bg-job-output">
        {plain || (live ? t("Waiting for output…") : t("(no output)"))}
      </pre>
      {lagging && <p role="alert" className="bg-jobs-error">{t("The output could not be read — trying again: {error}", { error: lagging })}</p>}
    </>
  );
});
