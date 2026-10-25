import { useState, type ComponentType, type ReactNode } from "react";
import { useNow } from "../use-now";
import { LuPlay, LuRefreshCw, LuSquareTerminal } from "react-icons/lu";
import type { BackgroundJob } from "../api";
import { formatElapsed } from "../transcript";
import { Ring } from "./ChatActivity";
import { statusParts } from "../status-commands";
import { t } from "../i18n";

/**
 * What is running beside the conversation, just above the box: what the
 * installed extensions have going in the chat (`chat.tray`: its subagents,
 * say), jobs the agent left running, and the status lines extensions set.
 * Each opens its window (a job, where an extension shows jobs); the tray
 * itself says only that it is going and for how long. A status that names one
 * of the chat's commands runs it when clicked.
 *
 * The extensions' chips are theirs to draw or not: the tray is on the page
 * while there are any, and shown only while something in it is drawn (see
 * chat.css).
 */
export function RunningTray({
  extensions,
  jobs,
  statuses,
  commands = new Set(),
  onJob,
  onCommand,
}: {
  /** What the `chat.tray` entries draw, each in its own element: nothing, where there are none. */
  extensions?: ReactNode;
  jobs: BackgroundJob[];
  statuses: { key: string; text: string }[];
  /** The chat's commands, by name without the slash. */
  commands?: ReadonlySet<string>;
  /** Where a job is shown. Without it, a job is only listed. */
  onJob?: (key: string) => void;
  onCommand?: (command: string) => Promise<void>;
}) {
  const [runningCommand, setRunningCommand] = useState<string | null>(null);
  const run = async (command: string) => {
    if (!onCommand || runningCommand) return;
    setRunningCommand(command);
    try {
      await onCommand(`/${command}`);
    } finally {
      setRunningCommand(null);
    }
  };
  const runningJobs = jobs.filter((j) => j.state !== "exited" && !j.attached);
  const now = useNow(runningJobs.length > 0);
  if (!extensions && runningJobs.length + statuses.length === 0) return null;
  const since = (at?: number) => (at ? formatElapsed(Math.max(0, Math.floor((now - at) / 1000))) : "");

  return (
    <div className="running-tray" role="group" aria-label={t("Running beside the conversation")}>
      {extensions}
      {runningJobs.map((j) => {
        const chip = (
          <>
            <span className="running-chip-icon"><i className="running-dot" /></span>
            <LuSquareTerminal className="running-chip-kind" aria-hidden />
            <span className="running-chip-label is-mono">{j.command}</span>
            <span className="running-chip-time">{j.state === "stopped" ? t("paused") : since(j.startedAt)}</span>
          </>
        );
        return onJob ? (
          <button key={j.key} type="button" className="running-chip is-job" onClick={() => onJob(j.key)} title={j.command}>
            {chip}
          </button>
        ) : (
          <span key={j.key} className="running-chip is-job" title={j.command}>
            {chip}
          </span>
        );
      })}
      {statuses.map((s) => {
        const parts = onCommand ? statusParts(s.text, commands) : [{ text: s.text }];
        const named = parts.flatMap((p) => ("command" in p ? [p.command] : []));
        const text = parts.map((p, i) => ("command" in p ? (
          <span key={i} className="running-chip-command">/{p.command}</span>
        ) : <span key={i}>{p.text}</span>));
        // One command: the whole chip runs it. Several: each is its own button.
        if (named.length === 1) {
          const busy = runningCommand === named[0];
          return (
            <button key={s.key} type="button" className="running-chip is-status is-action" disabled={runningCommand !== null} onClick={() => void run(named[0])} title={t("{name} — click to run /{command}", { name: s.key, command: named[0] })}>
              <span className="running-chip-label">{text}</span>
              {busy ? <LuRefreshCw className="running-chip-kind animate-spin" aria-hidden /> : <LuPlay className="running-chip-kind" aria-hidden />}
            </button>
          );
        }
        return (
          <span key={s.key} className="running-chip is-status" title={`${s.key}: ${s.text}`}>
            <span className="running-chip-label">
              {parts.map((p, i) => ("command" in p ? (
                <button key={i} type="button" className="running-chip-command" disabled={runningCommand !== null} onClick={() => void run(p.command)} title={t("Run /{command}", { command: p.command })}>/{p.command}</button>
              ) : <span key={i}>{p.text}</span>))}
            </span>
          </span>
        );
      })}
    </div>
  );
}

/**
 * A chip of an extension's in the tray (`ui.TrayChip`), drawn as the portal draws its own: what it is, what it is
 * doing, and how long it has run, counting.
 */
export function TrayChip({ icon: Icon, label, detail, since, title, onClick }: {
  icon?: ComponentType<{ "aria-hidden"?: boolean; className?: string }>;
  label: string;
  detail?: string;
  since?: number;
  title?: string;
  onClick?: () => void;
}) {
  const now = useNow(since !== undefined);
  const chip = (
    <>
      <span className="running-chip-icon"><Ring /></span>
      {Icon && <Icon className="running-chip-kind" aria-hidden />}
      <span className="running-chip-label">{label}</span>
      {detail && <span className="running-chip-detail">{detail}</span>}
      {since !== undefined && <span className="running-chip-time">{formatElapsed(Math.max(0, Math.floor((now - since) / 1000)))}</span>}
    </>
  );
  const named = title ?? (detail ? `${label} — ${detail}` : label);
  return onClick ? (
    <button type="button" className="running-chip is-extension" onClick={onClick} title={named}>
      {chip}
    </button>
  ) : (
    <span className="running-chip is-extension" title={named}>
      {chip}
    </span>
  );
}
