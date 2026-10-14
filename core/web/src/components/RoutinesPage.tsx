import { useEffect, useRef, useState } from "react";
import { Select } from "./Select";
import {
  LuBot,
  LuCheck,
  LuChevronLeft,
  LuChevronRight,
  LuClock,
  LuFolder,
  LuHouse,
  LuPlay,
  LuPlus,
  LuRefreshCw,
  LuTrash2,
} from "react-icons/lu";
import { PageHeader, Stat } from "./PageHeader";
import { RowsSkeleton } from "./Skeleton";
import { api, type Agent, type ReportTarget, type ReportTo, type Routine, type Workspace } from "../api";
import { ErrorBanner, Segments, Switch, SwitchTrack, btnCls, inputCls, primaryCls } from "./SettingsUi";
import { confirmDialog } from "./ConfirmDialog";
import { below } from "../paths";
import { pollWhileVisible } from "../poll";
import { formatDateTime, labelOf, msg, t, tp, tx } from "../i18n";
import { useFlash } from "../use-flash";
import { serverTime, sinceThen } from "../time";
import { ToolSwitches } from "./ToolSwitches";


const STATUS_STYLE: Record<string, string> = {
  ok: "text-ok",
  error: "text-danger",
  running: "text-accent",
  interrupted: "text-warn",
  stopped: "text-warn",
};

const STATUS_LABEL: Record<string, string> = {
  ok: msg("ok"),
  error: msg("error"),
  running: msg("running"),
  interrupted: msg("interrupted"),
  stopped: msg("stopped"),
};
const statusLabel = (status: string) => labelOf(STATUS_LABEL, status);

const PRESETS = [
  { label: msg("Every 15 min"), cron: "*/15 * * * *" },
  { label: msg("Hourly"), cron: "@hourly" },
  { label: msg("Daily 9am"), cron: "0 9 * * *" },
  { label: msg("Weekdays 8am"), cron: "0 8 * * 1-5" },
  { label: msg("Weekly"), cron: "@weekly" },
];

const when = (iso: string | null) => {
  if (!iso) return t("never");
  const then = serverTime(iso);
  // A run stamped a moment ahead of this clock.
  if (+then - Date.now() > 30_000) return t("soon");
  return sinceThen(then) || iso;
};

/** datetime-local wants "YYYY-MM-DDTHH:mm" in local time, not an ISO string. */
const toLocalInput = (iso: string | null) => {
  const d = iso ? new Date(iso) : new Date(Date.now() + 60 * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const until = (iso: string | null) => {
  if (!iso) return t("not scheduled");
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  if (!Number.isFinite(mins) || mins < 0) return t("due");
  if (mins < 1) return t("in under a minute");
  if (mins < 60) return t("in {n}m", { n: mins });
  if (mins < 1440) return t("in {n}h", { n: Math.round(mins / 60) });
  return t("in {n}d", { n: Math.round(mins / 1440) });
};

const MODES: { id: "repeats" | "once"; label: string }[] = [
  { id: "repeats", label: msg("Repeats") },
  { id: "once", label: msg("Once") },
];

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
      <Segments label={t("Schedule")} className="mb-2 flex gap-1" value={mode} options={MODES} onChange={onMode} />

      {mode === "repeats" ? (
        <SchedulePicker value={schedule} onChange={onSchedule} />
      ) : (
        <div>
          <span className="text-xs text-fg-muted">{t("Run at")}</span>
          <input
            type="datetime-local"
            value={runAt}
            onChange={(e) => onRunAt(e.target.value)}
            aria-label={t("Run at")}
            className={`${inputCls} mt-1 text-xs`}
          />
          {!runAt && <p role="alert" className="mt-1 text-[11px] text-warn">{t("Pick a time to run it at.")}</p>}
          <p className="mt-1 text-[11px] text-fg-faint">
            {t("Your local time. It runs once and then switches itself off, keeping the result. A time that passed while the portal was down still runs when it comes back.")}
          </p>
        </div>
      )}
    </div>
  );
}

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

/**
 * Work that happens on a schedule rather than because somebody asked.
 *
 * A routine is a standing instruction and a cron expression: it fires, the
 * agent does the job, and it goes quiet again. What it did last time is kept,
 * because that is the only way to know a routine is working.
 */
export function RoutinesPage({ onOpenSession }: { onOpenSession: (id: string) => void }) {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [loading, setLoading] = useState(true);
  // What a save or a run was refused, kept until the next one; and what the poll could not read, which is only true
  // until the next poll that can.
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const places = usePlaces();

  const load = () =>
    api
      .routines()
      .then((r) => {
        setRoutines(r.routines);
        setLoadError(null);
      })
      .catch((e) => setLoadError((e as Error).message))
      .finally(() => setLoading(false));

  useEffect(() => {
    load();
    return pollWhileVisible(load, 5000);
  }, []);

  const open = routines.find((r) => r.id === openId);

  // Shown in the list and in a routine alike: a refused save or run is said where it was asked for.
  const errorBox = (error || loadError) && (
    <ErrorBanner className="mt-4" onClose={error ? () => setError(null) : undefined}>{error || loadError}</ErrorBanner>
  );

  if (open) {
    return (
      <div className="h-full overflow-y-auto px-4 py-6">
        <div className="mx-auto w-full max-w-3xl">
          {errorBox}
          <RoutineDetail
            routine={open}
            onBack={() => {
              setOpenId(null);
              setError(null);
            }}
            onChanged={load}
            onError={setError}
            onOpenSession={onOpenSession}
            places={places}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-4 py-6">
      <div className="mx-auto w-full max-w-3xl">
        <PageHeader
          icon={<LuClock />}
          title={t("Routines")}
          description={
            <>
              {t("Work the agent does on a schedule instead of because you asked. It wakes up, follows its instructions, and goes quiet again.")}
            </>
          }
        >
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Stat value={routines.length} label={tp(routines.length, "routine", "routines")} />
            <Stat value={routines.filter((r) => r.enabled).length} label={t("enabled")} tone="text-accent" />
            <Stat
              value={routines.filter((r) => r.lastStatus === "error").length}
              label={t("failing")}
              tone="text-danger"
            />
          </div>
        </PageHeader>

        {errorBox}

        <div className="mt-4 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
            {t("Scheduled")}
          </h3>
          <button onClick={() => setAdding(!adding)} className={adding ? btnCls : primaryCls}>
            <LuPlus className="h-4 w-4" /> {adding ? t("Cancel") : t("New routine")}
          </button>
        </div>

        {adding && (
          <NewRoutine
            places={places}
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
          <RowsSkeleton />
        ) : routines.length === 0 ? (
          <div className="mt-3 rounded-xl border border-dashed border-line px-4 py-10 text-center">
            <p className="text-sm text-fg-muted">{t("No routines yet.")}</p>
            <p className="mx-auto mt-2 max-w-md text-xs text-fg-faint">
              {t("A morning summary of what changed overnight, a nightly check that backups ran, a weekly tidy of a directory — anything you would otherwise remember to ask for.")}
            </p>
          </div>
        ) : (
          <ul className="stagger-in mt-3 space-y-1.5">
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
                          ? `${t("once")} · ${r.runAt ? formatDateTime(r.runAt) : t("no time set")}`
                          : r.schedule}
                      </span>
                      {" · "}
                      <span
                        className={r.workspaceProblem ? "text-danger" : ""}
                        title={r.workspaceProblem ? `${r.workspace}: ${r.workspaceProblem}` : (r.workspace ?? t("Home — the agent's own directory"))}
                      >
                        {placeName(r.workspace, places.root, places.agents)}
                        {r.workspaceProblem ? ` (${t("gone")})` : ""}
                      </span>
                      {" · "}
                      {r.done ? t("done") : r.enabled ? until(r.nextRun) : t("disabled")}
                      {r.lastStatus && (
                        <>
                          {" · "}
                          <span className={STATUS_STYLE[r.lastStatus] ?? ""}>{statusLabel(r.lastStatus)}</span>
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
          {tx("Repeating schedules use the server's clock and five-field cron, or a shorthand like {example}; a one-off uses the time you pick in your own timezone. A routine still running when its next slot comes round is skipped rather than stacked.", { example: <code>@daily</code> })}
        </p>
      </div>
    </div>
  );
}

/**
 * The projects a routine can run in, and the root they are under, and the
 * agents other than the first, whose homes it can run in too. `list` is null
 * until they are read.
 */
interface Places {
  root: string | null;
  list: Workspace[] | null;
  agents: Agent[];
  error: string | null;
}

/** Read once for the page, not again for each routine opened. */
function usePlaces(): Places {
  const [places, setPlaces] = useState<Places>({ root: null, list: null, agents: [], error: null });
  useEffect(() => {
    api
      .workspaces()
      .then((r) => setPlaces((p) => ({ ...p, root: r.root, list: r.workspaces, error: null })))
      .catch((e) => setPlaces((p) => ({ ...p, root: null, list: [], error: (e as Error).message })));
    // Without them only Home is offered, as before there were agents.
    api
      .agents()
      .then((r) => setPlaces((p) => ({ ...p, agents: r.agents })))
      .catch(() => {});
  }, []);
  return places;
}

/** Home, an agent, or where under the projects' root it runs: "site", or "site/docs" for a folder in one. */
const placeName = (workspace: string | null, root: string | null, agents: readonly Agent[] = []) => {
  if (!workspace) return agents.find((a) => a.first)?.name ?? t("Home");
  const agent = agents.find((a) => a.home === workspace);
  if (agent) return agent.name;
  const under = root ? below(root, workspace) : undefined;
  if (under) return under;
  return workspace.split("/").filter(Boolean).pop() ?? workspace;
};

/**
 * Where a routine's runs happen: Home — the first agent's own directory, with
 * its notes and memory — another agent's home, or one of the projects. "" is
 * Home.
 *
 * A place that is not a project in the list, such as a folder in one that the
 * agent chose, is still shown. It is called gone only when the server says it
 * cannot be used (`problem`), not merely because the list lacks it.
 */
function WorkspacePicker({
  value,
  onChange,
  places,
  problem,
}: {
  value: string;
  onChange: (v: string) => void;
  places: Places;
  problem?: string | null;
}) {
  const { list, root, agents, error } = places;
  const first = agents.find((a) => a.first);
  const others = agents.filter((a) => !a.first);
  const known = list?.some((w) => w.path === value) || others.some((a) => a.home === value);
  return (
    // Not a label: it would pass a click on the hint to the Select's button.
    <div className="block">
      <span className="text-xs text-fg-muted">{t("Runs in")}</span>
      <Select
        className="mt-1 w-full"
        aria-label={t("Where it runs")}
        value={value}
        onChange={onChange}
        placeholder={t("Loading…")}
        options={[
          {
            value: "",
            label: <span className="inline-flex items-center gap-2"><LuHouse className="h-3.5 w-3.5 text-accent" />{first?.name ?? t("Home")}</span>,
            text: first?.name ?? t("Home"),
            hint: t("The agent's own directory, with its notes and memory"),
          },
          ...others.map((a) => ({
            value: a.home,
            label: <span className="inline-flex items-center gap-2"><LuBot className="h-3.5 w-3.5 text-accent" />{a.name}</span>,
            text: a.name,
            hint: t("{name}'s own directory, with its notes and memory", { name: a.name }),
          })),
          ...(list ?? []).map((w) => ({
            value: w.path,
            label: <span className="inline-flex items-center gap-2"><LuFolder className="h-3.5 w-3.5 text-fg-subtle" />{w.name}</span>,
            text: w.name,
            hint: `${w.path}${w.isGit ? " · git" : ""}`,
          })),
          // Shown for what it is, rather than as nothing.
          ...(value && list && !known
            ? [{ value, label: placeName(value, root, agents), text: placeName(value, root, agents), hint: problem ? t("Not there any more — runs fail until another is chosen") : value }]
            : []),
        ]}
      />
      <p className="mt-1 text-[11px] text-fg-faint">
        {t("Its runs work in this directory. Each place keeps its own session, so moving it back picks up where it left off.")}
        {error && ` ${t("The projects could not be listed ({error}), so only Home is offered.", { error })}`}
      </p>
      {problem && value && (
        <p role="alert" className="mt-1 text-[11px] text-danger">
          {t("{place} is not there any more ({problem}). Its runs fail until another place is chosen.", { place: value, problem })}
        </p>
      )}
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
      <span className="text-xs text-fg-muted">{t("Schedule")}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={t("Schedule")}
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
            {t(p.label)}
          </button>
        ))}
      </div>
      {preview.error && <p role="alert" className="mt-1.5 text-[11px] text-danger">{preview.error}</p>}
      {preview.runs && preview.runs.length > 0 && (
        <p className="mt-1.5 text-[11px] text-fg-subtle">
          {t("Next: {when}", { when: preview.runs.map((r) => formatDateTime(r)).join(" · ") })}
        </p>
      )}
    </div>
  );
}

function NewRoutine({
  places,
  onCancel,
  onCreated,
  onError,
}: {
  places: Places;
  onCancel: () => void;
  onCreated: (r: Routine) => Promise<void>;
  onError: (e: string) => void;
}) {
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"repeats" | "once">("repeats");
  const [schedule, setSchedule] = useState("0 9 * * *");
  const [runAt, setRunAt] = useState(toLocalInput(null));
  const [instructions, setInstructions] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    onError("");
    try {
      await onCreated(
        await api.createRoutine(
          mode === "repeats"
            ? { name, schedule, instructions, workspace: workspace || null }
            : { name, runAt: new Date(runAt).toISOString(), instructions, workspace: workspace || null }
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
        <span className="text-xs text-fg-muted">{t("Name")}</span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("Morning summary")}
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
        <span className="text-xs text-fg-muted">{t("Instructions")}</span>
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={5}
          placeholder={t("What to do when it fires. Written as an instruction, not a question — nobody is there to answer one.")}
          className={`${inputCls} mt-1 resize-y text-xs leading-relaxed`}
        />
      </label>

      <WorkspacePicker value={workspace} onChange={setWorkspace} places={places} />

      <div className="flex items-center gap-2">
        <button disabled={!name.trim() || busy || (mode === "once" && !runAt)} onClick={create} className={primaryCls}>
          {busy ? <LuRefreshCw className="h-4 w-4 animate-spin" /> : <LuCheck className="h-4 w-4" />}
          {t("Create")}
        </button>
        <button onClick={onCancel} className={btnCls}>
          {t("Cancel")}
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
  places,
}: {
  routine: Routine;
  onBack: () => void;
  onChanged: () => Promise<void>;
  onError: (e: string) => void;
  onOpenSession: (id: string) => void;
  places: Places;
}) {
  const [name, setName] = useState(r.name);
  const [mode, setMode] = useState<"repeats" | "once">(r.mode);
  const [schedule, setSchedule] = useState(r.schedule || "0 9 * * *");
  const [runAt, setRunAt] = useState(toLocalInput(r.runAt));
  const [instructions, setInstructions] = useState(r.instructions);
  const [fresh, setFresh] = useState(r.freshSession);
  const [guard, setGuard] = useState(r.guard);
  const [workspace, setWorkspace] = useState(r.workspace ?? "");
  // "" = inherit the portal default, "off" = stay quiet, else "channel\u0000target".
  const [report, setReport] = useState(reportValue(r));
  const [targets, setTargets] = useState<ReportTarget[]>([]);
  const [fallback, setFallback] = useState<ReportTo | null>(null);
  const [busy, setBusy] = useState<null | "save" | "run">(null);
  const [saved, flashSaved] = useFlash();
  const [runs, setRuns] = useState<{ id: string; title: string }[]>([]);

  // Whether the fields say something other than `from` does: a draft, against what they were filled from.
  const differs = (from: Routine) =>
    name !== from.name ||
    mode !== from.mode ||
    (mode === "repeats" ? schedule !== from.schedule : toLocalInput(from.runAt) !== runAt) ||
    instructions !== from.instructions ||
    fresh !== from.freshSession ||
    guard !== from.guard ||
    workspace !== (from.workspace ?? "") ||
    report !== reportValue(from);
  const dirty = differs(r);

  const fill = (from: Routine) => {
    setName(from.name);
    setMode(from.mode);
    setSchedule(from.schedule || "0 9 * * *");
    setRunAt(toLocalInput(from.runAt));
    setInstructions(from.instructions);
    setFresh(from.freshSession);
    setGuard(from.guard);
    setWorkspace(from.workspace ?? "");
    setReport(reportValue(from));
  };
  // The fields as they are now, for a save that finishes after more was typed.
  const live = useRef({ name, mode, schedule, runAt, instructions, fresh, guard, workspace, report });
  live.current = { name, mode, schedule, runAt, instructions, fresh, guard, workspace, report };

  // What the form was last filled from: the fields are filled again from the routine
  // for another routine, after this form's own save (see the Save button), or when
  // nothing typed would be lost, that is, when they still say what the routine said
  // before. A change of the routine's `updatedAt` that is no save of this form (the
  // enable switch saves at once, and the agent can change a routine) must not take a
  // draft away, and must not be missed by a form that has none.
  const filled = useRef({ id: r.id, from: r });
  useEffect(() => {
    const was = filled.current;
    if (r.id === was.id && differs(was.from) && dirty) return;
    filled.current = { id: r.id, from: r };
    fill(r);
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

  const act = async (which: "save" | "run", fn: () => Promise<unknown>) => {
    setBusy(which);
    onError("");
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
        <LuChevronLeft className="h-3.5 w-3.5" /> {t("Routines")}
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
            aria-label={t("Routine name")}
            className="w-full rounded bg-transparent text-sm font-medium text-fg outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
          <p className="truncate text-xs text-fg-subtle">
            {r.done ? t("already ran") : r.enabled ? until(r.nextRun) : t("disabled")} ·{" "}
            <span className="font-mono">{r.slug}</span>
          </p>
        </div>
        <Switch
          on={r.enabled}
          onChange={() => act("save", () => api.updateRoutine(r.id, { enabled: !r.enabled }))}
          disabled={busy !== null}
          label={r.name}
          title={r.enabled ? t("Disable") : t("Enable")}
          className="mt-1"
        />
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
          <span className="text-xs text-fg-muted">{t("Instructions")}</span>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={8}
            className={`${inputCls} mt-1 resize-y text-xs leading-relaxed`}
          />
          <p className="mt-1 text-[11px] text-fg-faint">
            {t("Given to the agent verbatim, with a note that it was woken by a schedule and that nobody is waiting on a reply.")}
          </p>
        </label>

        <WorkspacePicker
          value={workspace}
          onChange={setWorkspace}
          places={places}
          problem={workspace === (r.workspace ?? "") ? r.workspaceProblem : null}
        />

        <button
          type="button"
          role="switch"
          aria-checked={fresh}
          onClick={() => setFresh(!fresh)}
          className="flex w-full items-center gap-3 rounded-lg px-1 py-1.5 text-left transition hover:bg-fg/5"
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm text-fg">{t("Fresh session each run")}</p>
            <p className="text-[11px] text-fg-subtle">
              {t("Off: one session it keeps, so a run can see what the last one did. On: a clean start every time.")}
            </p>
          </div>
          <SwitchTrack on={fresh} />
        </button>

        <button
          type="button"
          role="switch"
          aria-checked={guard}
          onClick={() => setGuard(!guard)}
          className="flex w-full items-center gap-3 rounded-lg px-1 py-1.5 text-left transition hover:bg-fg/5"
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm text-fg">{t("Injection guard")}</p>
            <p className="text-[11px] text-fg-subtle">
              {t("On: after reading anything untrusted — logs fetched over the network, a web page, mail — this run cannot push, write onto PATH, upload or read credentials. Turn it off for work that reads those things and then has to act on them. Content is still labelled as untrusted, and anything it does that the rules would have stopped is recorded in Audit.")}
            </p>
          </div>
          <SwitchTrack on={guard} />
        </button>

        {/* Not a label: it would pass a click on the hint to the Select's button. */}
        <div className="block pt-1">
          <span className="mb-1 block text-xs text-fg-subtle">{t("Report to")}</span>
          <Select
            aria-label={t("Report to")}
            className="w-full"
            value={report}
            onChange={setReport}
            options={[
              {
                value: "",
                label: fallback ? t("Default — {target}", { target: labelFor(targets, fallback) ?? fallback.channel }) : t("Default — none set"),
              },
              { value: "off", label: t("Never report") },
              ...targets.map((x) => ({ value: `${x.channel}\u0000${x.target}`, label: `${x.channel} — ${x.label}` })),
            ]}
          />
          <p className="mt-1 text-[11px] text-fg-faint">
            {t("The agent decides whether a run is worth reporting and writes the message itself. It only has somewhere to send it if this points at a conversation.")}
            {targets.length === 0 &&
              ` ${t("Nothing to pick yet — message a channel that can start a conversation, and it appears here.")}`}
          </p>
        </div>
      </section>

      {/* Saved as each switch is flipped, like a project's: not part of the form's Save. The Browser switch
          that was here is the browser's group in this list. Drawn again when the routine moves, since the
          layers under it are those of where it runs. */}
      <section className="mb-6">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">{t("Tools")}</h3>
        <p className="mt-1 text-[11px] text-fg-faint">
          {t("What every run starts with, against what its agent and project leave. The browser's tools are off for a routine unless switched on here; every page a run opens is recorded in Audit. Saved as each switch is flipped.")}
        </p>
        <div className="mt-2 rounded-xl border border-line bg-raised/40">
          <ToolSwitches key={`${r.id}\u0000${r.workspace ?? ""}`} routine={r.id} />
        </div>
      </section>

      {r.lastStatus && (
        <section className="mb-6">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">{t("Last run")}</h3>
          <div className="mt-2 rounded-xl border border-line bg-raised/40 p-3">
            <p className="text-xs">
              <span className={STATUS_STYLE[r.lastStatus] ?? "text-fg-muted"}>{statusLabel(r.lastStatus)}</span>
              <span className="text-fg-faint">
                {" "}
                · {when(r.lastRun)}
                {r.lastMs ? ` · ${t("took {n}s", { n: Math.round(r.lastMs / 1000) })}` : ""}
              </span>
              {/* Writing the account out and never sending it looks identical to
                  having nothing to say, unless this says which happened. */}
              {reported(r) ? (
                <span className="text-ok"> · {t("reported")}</span>
              ) : (
                <span className="text-fg-faint"> · {t("nothing sent")}</span>
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
            {t("Sessions ({n})", { n: runs.length })}
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
              const sent = JSON.stringify(live.current);
              const stored = await api.updateRoutine(r.id, {
                name,
                ...(mode === "repeats"
                  ? { schedule, runAt: "" }
                  : { schedule: "", runAt: new Date(runAt).toISOString() }),
                instructions,
                freshSession: fresh,
                guard,
                // Only when it changed: a place that has gone would refuse the save.
                ...(workspace !== (r.workspace ?? "") ? { workspace: workspace || null } : {}),
                ...reportPatch(report),
              });
              // What the server kept is what the form is filled from now: the server's clock
              // counts seconds, so the reload that follows may carry the stamp it already had
              // and have nothing new in it for the effect to see. Not for a routine the form
              // has moved on from while this was on its way. The server trims, so unless more
              // was typed since, the fields show what it kept.
              if (filled.current.id === stored.id) {
                filled.current = { id: stored.id, from: stored };
                if (JSON.stringify(live.current) === sent) fill(stored);
              }
              flashSaved();
            })
          }
          disabled={busy !== null || !dirty || (mode === "once" && !runAt)}
          className={primaryCls}
        >
          {busy === "save" ? (
            <LuRefreshCw className="h-4 w-4 animate-spin" />
          ) : saved ? (
            <LuCheck className="h-4 w-4" />
          ) : null}
          {saved ? t("Saved") : t("Save")}
        </button>

        <button
          onClick={() => act("run", () => api.runRoutine(r.id))}
          disabled={busy !== null}
          className={btnCls}
          title={t("Run it now, without waiting for the schedule")}
        >
          {busy === "run" ? (
            <LuRefreshCw className="h-4 w-4 animate-spin" />
          ) : (
            <LuPlay className="h-4 w-4" />
          )}
          {busy === "run" ? t("Running…") : t("Run now")}
        </button>

        <button
          onClick={async () => {
            if (
              await confirmDialog({
                title: t("Delete \"{name}\"?", { name: r.name }),
                message: t("Its sessions are kept."),
                confirmLabel: t("Delete"),
                danger: true,
                deletes: true,
              })
            ) {
              act("save", async () => {
                await api.deleteRoutine(r.id);
                onBack();
              });
            }
          }}
          disabled={busy !== null}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-fg-subtle transition hover:bg-danger/10 hover:text-danger disabled:opacity-40"
        >
          <LuTrash2 className="h-3.5 w-3.5" /> {t("Delete")}
        </button>
      </div>
    </>
  );
}
