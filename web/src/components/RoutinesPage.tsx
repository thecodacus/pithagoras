import { useEffect, useState } from "react";
import {
  LuCheck,
  LuChevronLeft,
  LuChevronRight,
  LuCircleAlert,
  LuClock,
  LuPlay,
  LuPlus,
  LuRefreshCw,
  LuTrash2,
} from "react-icons/lu";
import { api, type ReportTarget, type ReportTo, type Routine } from "../api";

const inputCls =
  "w-full rounded-lg border border-line bg-raised/60 px-3 py-2 text-sm outline-none transition placeholder:text-fg-faint focus:border-accent/60";
const primaryCls =
  "inline-flex items-center gap-1.5 rounded-lg bg-accent/12 px-3 py-2 text-sm text-accent ring-1 ring-inset ring-accent/25 transition hover:bg-accent/20 disabled:opacity-40";
const btnCls =
  "inline-flex items-center gap-1.5 rounded-lg bg-fg/5 px-3 py-2 text-sm text-fg transition hover:bg-fg/10 disabled:opacity-40";

const STATUS_STYLE: Record<string, string> = {
  ok: "text-ok",
  error: "text-danger",
  running: "text-accent",
};

const PRESETS = [
  { label: "Every 15 min", cron: "*/15 * * * *" },
  { label: "Hourly", cron: "@hourly" },
  { label: "Daily 9am", cron: "0 9 * * *" },
  { label: "Weekdays 8am", cron: "0 8 * * 1-5" },
  { label: "Weekly", cron: "@weekly" },
];

const when = (iso: string | null) => {
  if (!iso) return "never";
  const then = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z").getTime();
  const mins = Math.round((Date.now() - then) / 60000);
  if (!Number.isFinite(mins)) return iso;
  if (mins < 0) return "soon";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};

/** datetime-local wants "YYYY-MM-DDTHH:mm" in local time, not an ISO string. */
const toLocalInput = (iso: string | null) => {
  const d = iso ? new Date(iso) : new Date(Date.now() + 60 * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const until = (iso: string | null) => {
  if (!iso) return "not scheduled";
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  if (!Number.isFinite(mins) || mins < 0) return "due";
  if (mins < 1) return "in under a minute";
  if (mins < 60) return `in ${mins}m`;
  if (mins < 1440) return `in ${Math.round(mins / 60)}h`;
  return `in ${Math.round(mins / 1440)}d`;
};

/**
 * Picking when. A routine either repeats or happens once, never both.
 *
 * The one-off input is the browser's own datetime picker, so the time you type
 * is your local time — unlike cron, which runs on the server's clock.
 */
function Timing({
  mode,
  schedule,
  runAt,
  onMode,
  onSchedule,
  onRunAt,
}: {
  mode: "repeats" | "once";
  schedule: string;
  runAt: string;
  onMode: (m: "repeats" | "once") => void;
  onSchedule: (v: string) => void;
  onRunAt: (v: string) => void;
}) {
  return (
    <div>
      <div className="mb-2 flex gap-1">
        {(["repeats", "once"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onMode(m)}
            className={`rounded-lg px-2.5 py-1 text-xs transition ${
              mode === m
                ? "bg-accent/12 text-accent ring-1 ring-inset ring-accent/25"
                : "bg-fg/5 text-fg-muted hover:bg-fg/10"
            }`}
          >
            {m === "repeats" ? "Repeats" : "Once"}
          </button>
        ))}
      </div>

      {mode === "repeats" ? (
        <SchedulePicker value={schedule} onChange={onSchedule} />
      ) : (
        <div>
          <span className="text-xs text-fg-muted">Run at</span>
          <input
            type="datetime-local"
            value={runAt}
            onChange={(e) => onRunAt(e.target.value)}
            className={`${inputCls} mt-1 text-xs [color-scheme:dark]`}
          />
          <p className="mt-1 text-[11px] text-fg-faint">
            Your local time. It runs once and then switches itself off, keeping the result. A time
            that passed while the portal was down still runs when it comes back.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Work that happens on a schedule rather than because somebody asked.
 *
 * A routine is a standing instruction and a cron expression: it fires, the
 * agent does the job, and it goes quiet again. What it did last time is kept,
 * because that is the only way to know a routine is working.
 */
/** The select's value for a routine: "" inherits, "off" is silent. */
function reportValue(r: Routine): string {
  if (r.reportChannel === "") return "off";
  if (r.reportChannel && r.reportTarget) return `${r.reportChannel}\u0000${r.reportTarget}`;
  return "";
}

/** Three states, and the empty string means two different things over the wire. */
function reportPatch(value: string): { reportChannel: string | null; reportTarget: string | null } {
  if (value === "off") return { reportChannel: "", reportTarget: "" };
  if (!value) return { reportChannel: null, reportTarget: null };
  const [channel, target] = value.split("\u0000");
  return { reportChannel: channel, reportTarget: target };
}

/** Did the last run reach anyone? Only meaningful once a run has finished. */
const reported = (r: Routine) =>
  Boolean(r.lastReportAt && r.lastRun && r.lastReportAt >= r.lastRun);

const labelFor = (targets: ReportTarget[], to: ReportTo) =>
  targets.find((t) => t.channel === to.channel && t.target === to.target)?.label;

export function RoutinesPage({ onOpenSession }: { onOpenSession: (id: string) => void }) {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api
      .routines()
      .then((r) => setRoutines(r.routines))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const open = routines.find((r) => r.id === openId);

  if (open) {
    return (
      <div className="h-full overflow-y-auto px-4 py-6">
        <div className="mx-auto w-full max-w-3xl">
          <RoutineDetail
            routine={open}
            onBack={() => setOpenId(null)}
            onChanged={load}
            onError={setError}
            onOpenSession={onOpenSession}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-4 py-6">
      <div className="mx-auto w-full max-w-3xl">
        <header className="rounded-2xl border border-line bg-gradient-to-br from-accent/10 via-transparent to-transparent px-5 py-5">
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent/12 text-accent">
              <LuClock className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-fg">Routines</h2>
              <p className="mt-0.5 max-w-xl text-sm text-fg-muted">
                Work the agent does on a schedule instead of because you asked. It wakes up, follows
                its instructions, and goes quiet again.
              </p>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Stat value={routines.length} label="routines" />
            <Stat value={routines.filter((r) => r.enabled).length} label="enabled" tone="text-accent" />
            <Stat
              value={routines.filter((r) => r.lastStatus === "error").length}
              label="failing"
              tone="text-danger"
            />
          </div>
        </header>

        {error && (
          <div className="mt-4 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            <LuCircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1">{error}</span>
            <button onClick={() => setError(null)}>✕</button>
          </div>
        )}

        <div className="mt-4 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
            Scheduled
          </h3>
          <button onClick={() => setAdding(!adding)} className={adding ? btnCls : primaryCls}>
            <LuPlus className="h-4 w-4" /> {adding ? "Cancel" : "New routine"}
          </button>
        </div>

        {adding && (
          <NewRoutine
            onCancel={() => setAdding(false)}
            onError={setError}
            onCreated={async (created) => {
              setAdding(false);
              await load();
              setOpenId(created.id);
            }}
          />
        )}

        {loading ? (
          <p className="py-10 text-center text-sm text-fg-subtle">Loading…</p>
        ) : routines.length === 0 ? (
          <div className="mt-3 rounded-xl border border-dashed border-line px-4 py-10 text-center">
            <p className="text-sm text-fg-muted">No routines yet.</p>
            <p className="mx-auto mt-2 max-w-md text-xs text-fg-faint">
              A morning summary of what changed overnight, a nightly check that backups ran, a
              weekly tidy of a directory — anything you would otherwise remember to ask for.
            </p>
          </div>
        ) : (
          <ul className="mt-3 space-y-1.5">
            {routines.map((r) => (
              <li key={r.id}>
                <button
                  onClick={() => setOpenId(r.id)}
                  className="flex w-full items-center gap-3 rounded-xl border border-line bg-raised/40 px-3 py-2.5 text-left transition hover:bg-fg/5"
                >
                  <LuClock
                    className={`h-4 w-4 shrink-0 ${r.enabled ? "text-accent" : "text-fg-faint"}`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-fg">{r.name}</p>
                    <p className="truncate text-[11px] text-fg-faint">
                      <span className="font-mono">
                        {r.mode === "once"
                          ? `once · ${r.runAt ? new Date(r.runAt).toLocaleString() : "no time set"}`
                          : r.schedule}
                      </span>
                      {r.done ? " · done" : r.enabled ? ` · ${until(r.nextRun)}` : " · disabled"}
                      {r.lastStatus && (
                        <>
                          {" · "}
                          <span className={STATUS_STYLE[r.lastStatus] ?? ""}>{r.lastStatus}</span>
                          {" "}
                          {when(r.lastRun)}
                        </>
                      )}
                    </p>
                  </div>
                  <LuChevronRight className="h-4 w-4 shrink-0 text-fg-faint" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-6 text-[11px] leading-relaxed text-fg-faint">
          Repeating schedules use the server's clock and five-field cron, or a shorthand like{" "}
          <code>@daily</code>; a one-off uses the time you pick in your own timezone. A routine
          still running when its next slot comes round is skipped rather than stacked.
        </p>
      </div>
    </div>
  );
}

function Stat({ value, label, tone }: { value: number; label: string; tone?: string }) {
  return (
    <div className="flex items-baseline gap-1.5 rounded-lg bg-raised/60 px-2.5 py-1">
      <span className={`text-sm tabular-nums ${tone ?? "text-fg"}`}>{value}</span>
      <span className="text-[11px] text-fg-subtle">{label}</span>
    </div>
  );
}

function SchedulePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [preview, setPreview] = useState<{ runs?: string[]; error?: string }>({});

  useEffect(() => {
    if (!value.trim()) return setPreview({});
    let cancelled = false;
    const t = setTimeout(() => {
      api
        .previewSchedule(value)
        .then((r) => !cancelled && setPreview({ runs: r.runs }))
        .catch((e) => !cancelled && setPreview({ error: (e as Error).message }));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [value]);

  return (
    <div>
      <span className="text-xs text-fg-muted">Schedule</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0 9 * * *"
        className={`${inputCls} mt-1 font-mono text-xs`}
      />
      <div className="mt-1.5 flex flex-wrap gap-1">
        {PRESETS.map((p) => (
          <button
            key={p.cron}
            type="button"
            onClick={() => onChange(p.cron)}
            className="rounded-lg bg-fg/5 px-2 py-0.5 text-[11px] text-fg-muted transition hover:bg-fg/10 hover:text-fg"
          >
            {p.label}
          </button>
        ))}
      </div>
      {preview.error && <p className="mt-1.5 text-[11px] text-danger">{preview.error}</p>}
      {preview.runs && preview.runs.length > 0 && (
        <p className="mt-1.5 text-[11px] text-fg-subtle">
          Next: {preview.runs.slice(0, 3).map((r) => new Date(r).toLocaleString()).join(" · ")}
        </p>
      )}
    </div>
  );
}

function NewRoutine({
  onCancel,
  onCreated,
  onError,
}: {
  onCancel: () => void;
  onCreated: (r: Routine) => Promise<void>;
  onError: (e: string) => void;
}) {
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"repeats" | "once">("repeats");
  const [schedule, setSchedule] = useState("0 9 * * *");
  const [runAt, setRunAt] = useState(toLocalInput(null));
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      await onCreated(
        await api.createRoutine(
          mode === "repeats"
            ? { name, schedule, instructions }
            : { name, runAt: new Date(runAt).toISOString(), instructions }
        )
      );
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 space-y-3 rounded-xl border border-line bg-raised/40 p-3">
      <label className="block">
        <span className="text-xs text-fg-muted">Name</span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Morning summary"
          className={`${inputCls} mt-1`}
        />
      </label>

      <Timing
        mode={mode}
        schedule={schedule}
        runAt={runAt}
        onMode={setMode}
        onSchedule={setSchedule}
        onRunAt={setRunAt}
      />

      <label className="block">
        <span className="text-xs text-fg-muted">Instructions</span>
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={5}
          placeholder="What to do when it fires. Written as an instruction, not a question — nobody is there to answer one."
          className={`${inputCls} mt-1 resize-y text-xs leading-relaxed`}
        />
      </label>

      <div className="flex items-center gap-2">
        <button disabled={!name.trim() || busy} onClick={create} className={primaryCls}>
          {busy ? <LuRefreshCw className="h-4 w-4 animate-spin" /> : <LuCheck className="h-4 w-4" />}
          Create
        </button>
        <button onClick={onCancel} className={btnCls}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function RoutineDetail({
  routine: r,
  onBack,
  onChanged,
  onError,
  onOpenSession,
}: {
  routine: Routine;
  onBack: () => void;
  onChanged: () => Promise<void>;
  onError: (e: string) => void;
  onOpenSession: (id: string) => void;
}) {
  const [name, setName] = useState(r.name);
  const [mode, setMode] = useState<"repeats" | "once">(r.mode);
  const [schedule, setSchedule] = useState(r.schedule || "0 9 * * *");
  const [runAt, setRunAt] = useState(toLocalInput(r.runAt));
  const [instructions, setInstructions] = useState(r.instructions);
  const [fresh, setFresh] = useState(r.freshSession);
  // "" = inherit the portal default, "off" = stay quiet, else "channel\u0000target".
  const [report, setReport] = useState(reportValue(r));
  const [targets, setTargets] = useState<ReportTarget[]>([]);
  const [fallback, setFallback] = useState<ReportTo | null>(null);
  const [busy, setBusy] = useState<null | "save" | "run">(null);
  const [saved, setSaved] = useState(false);
  const [runs, setRuns] = useState<{ id: string; title: string }[]>([]);

  useEffect(() => {
    setName(r.name);
    setMode(r.mode);
    setSchedule(r.schedule || "0 9 * * *");
    setRunAt(toLocalInput(r.runAt));
    setInstructions(r.instructions);
    setFresh(r.freshSession);
    setReport(reportValue(r));
  }, [r.id, r.updatedAt]);

  useEffect(() => {
    api
      .reportTargets()
      .then((x) => {
        setTargets(x.targets);
        setFallback(x.default);
      })
      .catch(() => {});
  }, [r.id]);

  useEffect(() => {
    api
      .routineSessions(r.id)
      .then((x) => setRuns(x.sessions.map((s) => ({ id: s.id, title: s.title }))))
      .catch(() => {});
  }, [r.id, r.lastRun]);

  const dirty =
    name !== r.name ||
    mode !== r.mode ||
    (mode === "repeats" ? schedule !== r.schedule : toLocalInput(r.runAt) !== runAt) ||
    instructions !== r.instructions ||
    fresh !== r.freshSession ||
    report !== reportValue(r);

  const act = async (which: "save" | "run", fn: () => Promise<unknown>) => {
    setBusy(which);
    try {
      await fn();
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <button
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1.5 text-xs text-fg-subtle transition hover:text-fg-muted"
      >
        <LuChevronLeft className="h-3.5 w-3.5" /> Routines
      </button>

      <div className="mb-5 flex items-start gap-3">
        <div
          className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${
            r.enabled ? "bg-accent/10 text-accent" : "bg-fg/5 text-fg-subtle"
          }`}
        >
          <LuClock className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-transparent text-sm font-medium text-fg outline-none"
          />
          <p className="truncate text-xs text-fg-subtle">
            {r.done ? "already ran" : r.enabled ? until(r.nextRun) : "disabled"} ·{" "}
            <span className="font-mono">{r.slug}</span>
          </p>
        </div>
        <button
          onClick={() => act("save", () => api.updateRoutine(r.id, { enabled: !r.enabled }))}
          disabled={busy !== null}
          title={r.enabled ? "Disable" : "Enable"}
          className={`relative mt-1 h-5 w-9 shrink-0 rounded-full transition disabled:opacity-40 ${
            r.enabled ? "bg-accent" : "bg-raised"
          }`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
              r.enabled ? "left-[1.125rem]" : "left-0.5"
            }`}
          />
        </button>
      </div>

      <section className="mb-6 space-y-3">
        <Timing
          mode={mode}
          schedule={schedule}
          runAt={runAt}
          onMode={setMode}
          onSchedule={setSchedule}
          onRunAt={setRunAt}
        />

        <label className="block">
          <span className="text-xs text-fg-muted">Instructions</span>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={8}
            className={`${inputCls} mt-1 resize-y text-xs leading-relaxed`}
          />
          <p className="mt-1 text-[11px] text-fg-faint">
            Given to the agent verbatim, with a note that it was woken by a schedule and that
            nobody is waiting on a reply.
          </p>
        </label>

        <button
          type="button"
          onClick={() => setFresh(!fresh)}
          className="flex w-full items-center gap-3 rounded-lg px-1 py-1.5 text-left transition hover:bg-fg/5"
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm text-fg">Fresh session each run</p>
            <p className="text-[11px] text-fg-subtle">
              Off: one session it keeps, so a run can see what the last one did. On: a clean start
              every time.
            </p>
          </div>
          <span
            className={`relative h-5 w-9 shrink-0 rounded-full transition ${
              fresh ? "bg-accent" : "bg-raised"
            }`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                fresh ? "left-[1.125rem]" : "left-0.5"
              }`}
            />
          </span>
        </button>

        <label className="block pt-1">
          <span className="mb-1 block text-xs text-fg-subtle">Report to</span>
          <select
            value={report}
            onChange={(e) => setReport(e.target.value)}
            className="w-full rounded-lg border border-line bg-raised/60 px-3 py-2 text-sm outline-none transition focus:border-accent/60"
          >
            <option value="">
              {fallback
                ? `Default — ${labelFor(targets, fallback) ?? fallback.channel}`
                : "Default — none set"}
            </option>
            <option value="off">Never report</option>
            {targets.map((t) => (
              <option key={`${t.channel}\u0000${t.target}`} value={`${t.channel}\u0000${t.target}`}>
                {t.channel} — {t.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-fg-faint">
            The agent decides whether a run is worth reporting and writes the message itself. It
            only has somewhere to send it if this points at a conversation.
            {targets.length === 0 &&
              " Nothing to pick yet — message a channel that can start a conversation, and it appears here."}
          </p>
        </label>
      </section>

      {r.lastStatus && (
        <section className="mb-6">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">Last run</h3>
          <div className="mt-2 rounded-xl border border-line bg-raised/40 p-3">
            <p className="text-xs">
              <span className={STATUS_STYLE[r.lastStatus] ?? "text-fg-muted"}>{r.lastStatus}</span>
              <span className="text-fg-faint">
                {" "}
                · {when(r.lastRun)}
                {r.lastMs ? ` · took ${Math.round(r.lastMs / 1000)}s` : ""}
              </span>
              {/* Writing the account out and never sending it looks identical to
                  having nothing to say, unless this says which happened. */}
              {reported(r) ? (
                <span className="text-ok"> · reported</span>
              ) : (
                <span className="text-fg-faint"> · nothing sent</span>
              )}
            </p>
            {r.lastOutput && (
              <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-fg-muted">
                {r.lastOutput}
              </pre>
            )}
          </div>
        </section>
      )}

      {runs.length > 0 && (
        <section className="mb-6">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
            Sessions ({runs.length})
          </h3>
          <ul className="mt-2 space-y-1">
            {runs.slice(0, 8).map((s) => (
              <li key={s.id}>
                <button
                  onClick={() => onOpenSession(s.id)}
                  className="flex w-full items-center gap-2 rounded-lg border border-line bg-raised/40 px-3 py-2 text-left text-xs text-fg-muted transition hover:bg-fg/5"
                >
                  <span className="min-w-0 flex-1 truncate">{s.title}</span>
                  <LuChevronRight className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={() =>
            act("save", async () => {
              await api.updateRoutine(r.id, {
                name,
                ...(mode === "repeats"
                  ? { schedule, runAt: "" }
                  : { schedule: "", runAt: new Date(runAt).toISOString() }),
                instructions,
                freshSession: fresh,
                ...reportPatch(report),
              });
              setSaved(true);
              setTimeout(() => setSaved(false), 2000);
            })
          }
          disabled={busy !== null || !dirty}
          className={primaryCls}
        >
          {busy === "save" ? (
            <LuRefreshCw className="h-4 w-4 animate-spin" />
          ) : saved ? (
            <LuCheck className="h-4 w-4" />
          ) : null}
          {saved ? "Saved" : "Save"}
        </button>

        <button
          onClick={() => act("run", () => api.runRoutine(r.id))}
          disabled={busy !== null}
          className={btnCls}
          title="Run it now, without waiting for the schedule"
        >
          {busy === "run" ? (
            <LuRefreshCw className="h-4 w-4 animate-spin" />
          ) : (
            <LuPlay className="h-4 w-4" />
          )}
          {busy === "run" ? "Running…" : "Run now"}
        </button>

        <button
          onClick={() => {
            if (confirm(`Delete "${r.name}"? Its sessions are kept.`)) {
              act("save", async () => {
                await api.deleteRoutine(r.id);
                onBack();
              });
            }
          }}
          disabled={busy !== null}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-fg-subtle transition hover:bg-danger/10 hover:text-danger disabled:opacity-40"
        >
          <LuTrash2 className="h-3.5 w-3.5" /> Delete
        </button>
      </div>
    </>
  );
}
