import { useEffect, useState } from "react";
import { LuCheckCheck, LuPlus, LuRefreshCw, LuTrash2 } from "react-icons/lu";
import { api, type ActivityNote, type Agent, type ToolRule } from "../api";
import { Select } from "./Select";
import { inputSmCls } from "./SettingsUi";
import { pollWhileVisible } from "../poll";
import { msg, t } from "../i18n";
import { when } from "../time";

/** The role a look runs as; rules for it are what it may run besides reading. See the server's heartbeat-names.ts. */
const HEARTBEAT_ROLE = "heartbeat";

/** How often it can look: the server takes any 15 minutes to a week; these are the ones offered. */
const INTERVALS: [number, string][] = [
  [0, msg("Never")],
  [30, msg("Every 30 minutes")],
  [60, msg("Every hour")],
  [120, msg("Every 2 hours")],
  [240, msg("Every 4 hours")],
  [480, msg("Every 8 hours")],
  [1440, msg("Once a day")],
];

/**
 * The agent looking around on its own: how often, when it keeps quiet, what it
 * may run besides reading, and how the last look went. Off until an interval is
 * chosen. It reads what WATCH.md asks it to keep an eye on; what it found is in
 * its Activity.
 */
export function HeartbeatSettings({ agent, onChanged }: { agent: Agent; onChanged: () => Promise<void> }) {
  const hb = agent.heartbeat;
  const [quietStart, setQuietStart] = useState(hb.quietStart);
  const [quietEnd, setQuietEnd] = useState(hb.quietEnd);
  const [rules, setRules] = useState<ToolRule[]>([]);
  const [command, setCommand] = useState("");
  const [error, setError] = useState("");

  const showRules = (all: ToolRule[]) => setRules(all.filter((r) => r.role === HEARTBEAT_ROLE && !r.person_key));
  useEffect(() => {
    api.toolRules().then((r) => showRules(r.rules), () => {});
    // One agent per mount: see AgentView's key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A look under way is followed until it is done.
  useEffect(() => (hb.running ? pollWhileVisible(() => void onChanged(), 3000) : undefined), [hb.running, onChanged]);

  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const save = (patch: Partial<{ minutes: number; quietStart: string; quietEnd: string }>) =>
    act(() => api.setHeartbeat(agent.id, { minutes: hb.minutes, quietStart, quietEnd, ...patch }));
  // Quiet hours are saved once both ends say something, or neither does.
  const saveQuiet = (start: string, end: string) => {
    if (Boolean(start) === Boolean(end) && (start !== hb.quietStart || end !== hb.quietEnd)) void save({ quietStart: start, quietEnd: end });
  };

  const status = hb.running ? t("Looking…") : hb.status;

  return (
    <section className="mt-5">
      <p className="text-xs text-fg-muted">{t("Looks around on its own at what WATCH.md lists, and notes what deserves your attention. It can only read. Off until you choose how often.")}</p>

      {!hb.available ? (
        <p className="mt-3 text-xs text-warn">{t("Needs the host executor: in a container nothing would hold a look to reading.")}</p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div className="w-48 text-xs text-fg-muted">
              {t("How often")}
              <Select
                className="mt-1 w-full"
                aria-label={t("How often")}
                value={String(hb.minutes)}
                onChange={(v) => void save({ minutes: Number(v) })}
                options={INTERVALS.map(([m, label]) => ({ value: String(m), label: t(label) }))}
              />
            </div>
            <div className="text-xs text-fg-muted">
              {t("Quiet hours")} <span className="text-[11px] text-fg-faint">{t("the portal's time ({zone})", { zone: hb.timeZone })}</span>
              <div className="mt-1 flex items-center gap-1.5">
                <input type="time" aria-label={t("Quiet from")} value={quietStart} onChange={(e) => setQuietStart(e.target.value)} onBlur={() => saveQuiet(quietStart, quietEnd)} className={`${inputSmCls} !w-32`} />
                <span>{t("to")}</span>
                <input type="time" aria-label={t("Quiet until")} value={quietEnd} onChange={(e) => setQuietEnd(e.target.value)} onBlur={() => saveQuiet(quietStart, quietEnd)} className={`${inputSmCls} !w-32`} />
              </div>
            </div>
            <button
              type="button"
              disabled={hb.running || !hb.watching}
              onClick={() => void act(() => api.lookNow(agent.id))}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent/12 px-3 py-2 text-xs text-accent ring-1 ring-inset ring-accent/25 transition hover:bg-accent/20 disabled:opacity-40"
            >
              <LuRefreshCw className={`h-3.5 w-3.5 ${hb.running ? "animate-spin" : ""}`} />
              {t("Look now")}
            </button>
          </div>
          {!hb.watching && (
            <p className="mt-2 text-xs text-fg-muted">{t("Write WATCH.md above to tell it what to keep an eye on: until then it has nothing to look at.")}</p>
          )}
          <div className="mt-3 text-xs text-fg-muted">
            {t("Commands it may run")}
            <p className="text-[11px] text-fg-faint">{t("Besides reading files. For every agent's heartbeat: a command runs only as written, with * where it varies.")}</p>
            <ul className="mt-1.5 space-y-1">
              {rules.map((r) => (
                <li key={r.id} className="flex items-center gap-2 rounded-lg border border-line bg-raised/40 py-1 pl-2.5 pr-1">
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-muted">{r.pattern}</span>
                  <button type="button" onClick={() => void act(async () => showRules((await api.deleteToolRule(r.id)).rules))} title={t("Revoke")} aria-label={t("Revoke")} className="shrink-0 rounded-lg p-1 text-fg-faint transition hover:bg-danger/10 hover:text-danger">
                    <LuTrash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
            <form
              className="mt-1.5 flex gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                const pattern = command.trim();
                if (!pattern) return;
                void act(async () => {
                  showRules((await api.addToolRule({ role: HEARTBEAT_ROLE, tool: "bash", pattern })).rules);
                  setCommand("");
                });
              }}
            >
              <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="gh pr list*" aria-label={t("Command it may run")} className={`${inputSmCls} font-mono text-xs`} />
              <button type="submit" disabled={!command.trim()} className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-fg/5 px-2.5 text-xs text-fg transition hover:bg-fg/10 disabled:opacity-40">
                <LuPlus className="h-3.5 w-3.5" />
                {t("Allow")}
              </button>
            </form>
          </div>
          {(status || hb.last) && (
            <p className="mt-2 text-xs text-fg-faint">
              {hb.last && !hb.running ? t("Last looked {when}: {status}", { when: when(hb.last), status: status ?? "" }) : status}
            </p>
          )}
        </>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </section>
  );
}

/**
 * What the agent noticed on its own, newest first. A note opens the look it was
 * made in, to see what it read and how it decided, and is read once opened.
 */
export function ActivityFeed({ agent, onChanged, onSelect }: { agent: Agent; onChanged: () => Promise<void>; onSelect: (session: string) => void }) {
  const [notes, setNotes] = useState<ActivityNote[] | null>(null);
  const [error, setError] = useState("");
  const loadNotes = () => api.activity(agent.id).then((r) => setNotes(r.notes), () => {});
  useEffect(() => {
    void loadNotes();
    // A look can leave a note while this is open.
    return pollWhileVisible(() => void loadNotes(), 10_000);
    // One agent per mount: see AgentView's key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      await loadNotes();
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const unread = notes?.filter((n) => !n.read_at).length ?? 0;

  return (
    <section className="mt-5">
      {(unread > 0 || error) && (
        <div className="mb-2 flex items-center gap-2">
          {error && <p role="alert" className="text-xs text-danger">{error}</p>}
          {unread > 0 && (
            <button type="button" onClick={() => void act(() => api.markActivityRead(agent.id))} className="ml-auto inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg">
              <LuCheckCheck className="h-3.5 w-3.5" />
              {t("Mark all read")}
            </button>
          )}
        </div>
      )}
      {notes && notes.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line px-4 py-10 text-center">
          <p className="text-sm text-fg-muted">{t("Nothing noticed yet.")}</p>
          <p className="mx-auto mt-2 max-w-md text-xs text-fg-faint">{t("What its heartbeat notices on its own lands here. Set it up under Heartbeat.")}</p>
        </div>
      ) : (
        <ul className="space-y-1.5">
          {(notes ?? []).map((n) => (
            <li key={n.id} className="group relative">
              {/* The delete beside it rather than inside: one button cannot hold another. */}
              <button
                type="button"
                onClick={() => {
                  if (!n.read_at) void act(() => api.markNoteRead(agent.id, n.id));
                  if (n.session_id) onSelect(n.session_id);
                }}
                title={n.session_id ? t("Open the look this was noted in") : undefined}
                className="flex w-full gap-2 rounded-lg border border-line bg-raised/40 py-2 pl-3 pr-9 text-left transition hover:border-accent/40 hover:bg-raised/70"
              >
                <span aria-hidden className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${n.read_at ? "bg-transparent" : "bg-accent"}`} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-fg">{n.title}</span>
                  {n.detail && <span className="mt-0.5 block whitespace-pre-wrap text-xs text-fg-muted">{n.detail}</span>}
                  <span className="mt-1 block text-[11px] text-fg-faint">{when(n.at)}</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => void act(() => api.deleteNote(agent.id, n.id))}
                title={t("Delete note")}
                aria-label={t("Delete note")}
                className="absolute right-2 top-2 rounded p-1 text-fg-subtle opacity-0 transition hover:text-danger focus:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
              >
                <LuTrash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
