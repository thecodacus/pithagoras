import { useState } from "react";
import { useNow } from "../use-now";
import { LuBot, LuPlay, LuRefreshCw, LuSquareTerminal } from "react-icons/lu";
import type { BackgroundJob } from "../api";
import { subagentName, type Subagent } from "../subagents";
import { formatElapsed } from "../transcript";
import { Ring } from "./ChatActivity";
import { statusParts } from "../status-commands";
import { t } from "../i18n";

/**
 * What is running beside the conversation, just above the box: subagents,
 * jobs the agent left running, and the status lines extensions set. Each opens
 * its window; the tray itself says only that it is going and for how long. A
 * status that names one of the chat's commands runs it when clicked.
 */
export function RunningTray({
  agents,
  jobs,
  statuses,
  commands = new Set(),
  onAgent,
  onJob,
  onCommand,
}: {
  agents: Subagent[];
  jobs: BackgroundJob[];
  statuses: { key: string; text: string }[];
  /** The chat's commands, by name without the slash. */
  commands?: ReadonlySet<string>;
  onAgent: (id: string) => void;
  onJob: (key: string) => void;
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
  const runningAgents = agents.filter((a) => a.status === "running");
  const runningJobs = jobs.filter((j) => j.state !== "exited" && !j.attached);
  const any = runningAgents.length + runningJobs.length + statuses.length > 0;
  const now = useNow(runningAgents.length > 0 || runningJobs.length > 0);
  if (!any) return null;
  const since = (at?: number) => (at ? formatElapsed(Math.max(0, Math.floor((now - at) / 1000))) : "");

  return (
    <div className="running-tray" role="group" aria-label={t("Running beside the conversation")}>
      {runningAgents.map((a) => (
        <button key={a.id} type="button" className="running-chip is-agent" onClick={() => onAgent(a.id)} title={a.detail ? `${subagentName(a)} — ${a.detail}` : subagentName(a)}>
          <span className="running-chip-icon"><Ring /></span>
          <LuBot className="running-chip-kind" aria-hidden />
          <span className="running-chip-label">{subagentName(a)}</span>
          {a.detail && <span className="running-chip-detail">{a.detail}</span>}
          <span className="running-chip-time">{since(a.since)}</span>
        </button>
      ))}
      {runningJobs.map((j) => (
        <button key={j.key} type="button" className="running-chip is-job" onClick={() => onJob(j.key)} title={j.command}>
          <span className="running-chip-icon"><i className="running-dot" /></span>
          <LuSquareTerminal className="running-chip-kind" aria-hidden />
          <span className="running-chip-label is-mono">{j.command}</span>
          <span className="running-chip-time">{j.state === "stopped" ? t("paused") : since(j.startedAt)}</span>
        </button>
      ))}
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
