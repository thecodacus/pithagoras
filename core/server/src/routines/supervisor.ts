import { nanoid } from "nanoid";
import { createSession, findRoutineSession, getDb, getSession, type SessionRow } from "../db.js";
import { agentHome } from "../agent-home.js";
import { checkWorkspace } from "../workspaces.js";
import { EXECUTOR_KIND } from "../executor-kind.js";
import { sessions } from "../session-manager.js";
import { forgetBrowserSession } from "../browser/tools.js";
import { isDue, nextRun, parseCron } from "./cron.js";
import { reportFraming, reportToFor } from "../pi/report-tool.js";

/**
 * Runs routines when they are due.
 *
 * A routine is a standing instruction and a schedule: when it fires the agent
 * is given the instruction, does the work, and goes quiet again. Nothing is
 * waiting on the other end the way a chat is, so a run is allowed to take as
 * long as it takes and its outcome is recorded rather than replied to.
 */

export interface RoutineRow {
  id: string;
  slug: string;
  name: string;
  enabled: number;
  schedule: string;
  /** An ISO instant, for a routine that runs once instead of repeating. */
  run_at: string | null;
  instructions: string;
  fresh_session: number;
  /** 0 turns off the injection guard's blocking rules for this routine's runs. */
  guard: number;
  /** 1 lets this routine's runs drive the agent's browser. */
  browser: number;
  /** Where its runs happen: null for Home, else a project's directory. */
  workspace: string | null;
  /**
   * Where this routine's reports go. null inherits the portal default; the
   * empty string means it never reports, whatever the default is.
   */
  report_channel: string | null;
  report_target: string | null;
  last_report_at: string | null;
  last_run: string | null;
  last_status: string | null;
  last_output: string | null;
  last_ms: number | null;
  next_run: string | null;
  created_at: string;
  updated_at: string;
}

/** How long a single run may take before it is abandoned. */
const RUN_TIMEOUT_MS = 60 * 60_000;

/** Enough of the outcome to see what happened without storing a transcript. */
const MAX_OUTPUT = 4000;

const TICK_MS = 20_000;

/** What a run that a restart cut off says of itself. */
const INTERRUPTED = "The portal restarted during this run";
/** And one that somebody stopped in its chat. */
const STOPPED = "Stopped before it finished.";

class RoutineSupervisor {
  /** Routines with a run in flight — a slow one must not stack on itself. */
  private running = new Set<string>();
  /**
   * Routines that may not start a run, and by how many holds: the folder they
   * run in is being deleted. Counted, so that one delete finishing does not
   * lift the hold of another still under way.
   */
  private held = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  private rows(): RoutineRow[] {
    return getDb().prepare("SELECT * FROM routines").all() as RoutineRow[];
  }

  start(): void {
    if (this.timer) return;
    this.settleInterrupted();
    this.refreshSchedules();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Recompute when routines fire next: all of them, or only these. Cheap, and
   * keeps the UI honest. One transaction, so a long list is one write.
   */
  refreshSchedules(only?: string[]): void {
    const wanted = only && new Set(only);
    const update = getDb().prepare("UPDATE routines SET next_run = ? WHERE id = ?");
    getDb().transaction(() => {
      for (const row of this.rows()) {
        if (!wanted || wanted.has(row.id)) update.run(whenNext(row), row.id);
      }
    })();
  }

  /**
   * Runs a restart cut off, which are still marked as running: nothing else
   * ever finishes them, and they would show as running for good. A one-off whose
   * moment it was is not run again: the cut-off run may have done part of what
   * it was asked, and doing it twice is worse than telling the person it did not
   * finish. It is switched off like any one-off that has run, and giving it a
   * new time arms it again.
   */
  private settleInterrupted(): void {
    const update = getDb().prepare(
      "UPDATE routines SET last_status = 'interrupted', last_output = ? WHERE id = ?",
    );
    const off = getDb().prepare("UPDATE routines SET enabled = 0 WHERE id = ?");
    getDb().transaction(() => {
      for (const row of this.rows()) {
        if (row.last_status !== "running") continue;
        update.run(INTERRUPTED, row.id);
        if (oneOffDone(row)) off.run(row.id);
      }
    })();
  }

  /**
   * Keeps these routines from starting a run, by schedule or by hand, until the
   * returned release is called: their folder is being deleted, and a run begun
   * meanwhile would have it removed from under it.
   */
  hold(slugs: string[]): () => void {
    for (const slug of slugs) this.held.set(slug, (this.held.get(slug) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const slug of slugs) {
        const left = (this.held.get(slug) ?? 1) - 1;
        if (left > 0) this.held.set(slug, left);
        else this.held.delete(slug);
      }
    };
  }

  isRunning(slug: string): boolean {
    return this.running.has(slug);
  }

  private async tick(): Promise<void> {
    const now = new Date();
    for (const row of this.rows()) {
      if (!row.enabled || this.running.has(row.slug) || this.held.has(row.slug)) continue;

      if (isOneOff(row)) {
        // Deliberately catches up: a one-off whose moment passed while the
        // server was down should still happen, unlike a recurring one which
        // simply waits for its next slot.
        // Not `> now`: a time that cannot be read compares false to anything,
        // and would run on every tick. Such a one never fires, like a bad cron.
        if (oneOffDone(row) || !(new Date(row.run_at!) <= now)) continue;
        void this.run(row, "schedule");
        continue;
      }

      let cron;
      try {
        cron = parseCron(row.schedule);
      } catch {
        continue;
      }
      if (!isDue(cron, now, row.last_run ? new Date(row.last_run) : null)) continue;
      void this.run(row, "schedule");
    }
  }

  /**
   * Run one routine.
   *
   * Not awaited by the tick: a routine that takes twenty minutes must not hold
   * up every other one, and the next tick skips it because it is still marked
   * as running.
   *
   * Answers the routine as the run left it, or nothing when it was deleted
   * while it ran.
   */
  async run(row: RoutineRow, trigger: "schedule" | "manual"): Promise<RoutineRow | undefined> {
    if (this.running.has(row.slug)) throw new Error(`"${row.name}" is already running`);
    if (this.held.has(row.slug)) throw new Error(`"${row.name}" cannot run while the folder it runs in is being deleted`);
    this.running.add(row.slug);

    const started = Date.now();
    const lastRun = new Date(started).toISOString();
    // Written before the work, so a crash mid-run cannot make it fire again
    // the moment the server comes back.
    getDb()
      .prepare("UPDATE routines SET last_run = ?, last_status = 'running' WHERE id = ?")
      .run(lastRun, row.id);

    let fresh: SessionRow | undefined;
    try {
      const session = this.sessionFor(row);
      if (row.fresh_session) fresh = session;
      // Stop pressed in its chat: pi settles as it does for any run that ends,
      // so this would be recorded as ok, with half an answer.
      let stopped = false;
      const output = await sessions.ask(session.id, prompt(row, trigger), {
        timeoutMs: RUN_TIMEOUT_MS,
        onStopped: () => (stopped = true),
      });
      if (stopped) this.finish(row.id, "stopped", output ? `${STOPPED}\n\n${output}` : STOPPED, Date.now() - started);
      else this.finish(row.id, "ok", output, Date.now() - started);
    } catch (e) {
      this.finish(row.id, "error", (e as Error).message, Date.now() - started);
    } finally {
      this.running.delete(row.slug);
      // A clean session is never used again: its pi would otherwise be held until
      // the portal stops, one more with every run. Its transcript stays. Not while
      // a subagent it started is still working, nor a job it started (a build, or a
      // dev server, that pi-background-tasks runs for the agent and ends when it is
      // told that pi is going): the idle reaper takes it then.
      if (fresh && !sessions.backgroundWork(fresh.id)) {
        // A run that ran out of time is still going. Stopped under it, its chat
        // would stay "running" for good: nothing settles it, a Stop does nothing,
        // and no agent looks around while anything is working.
        if (!sessions.closing && getSession(fresh.id)?.status === "running") await endRun(fresh.id);
        // Looked at now: the job was started by the last call, a moment ago. A portal that is stopping lets every pi go.
        if (sessions.closing || !(await sessions.holdsJobs(fresh.id, true))) {
          await sessions.stop(fresh.id).catch(() => {});
          forgetBrowserSession(fresh.id);
        }
      }
      // A one-off has nothing left to do. Disabled rather than deleted, so the
      // result stays readable and it can be re-armed by giving it a new time.
      // Not one run by hand ahead of its moment: that was a try, and the
      // moment it was set for is still to come. Not one given a new moment
      // while it ran either: that is the moment it was set for now.
      if (oneOffDone({ ...row, last_run: lastRun })) {
        getDb().prepare("UPDATE routines SET enabled = 0 WHERE id = ? AND run_at = ?").run(row.id, row.run_at);
      }
      this.refreshSchedules([row.id]);
    }

    return getDb().prepare("SELECT * FROM routines WHERE id = ?").get(row.id) as RoutineRow | undefined;
  }

  private finish(id: string, status: string, output: string, ms: number): void {
    // A run the portal's own stop aborted ends like any other, and would be
    // recorded as ok: it was cut off, as a crash cuts one off.
    if (sessions.closing) [status, output] = ["interrupted", INTERRUPTED];
    getDb()
      .prepare("UPDATE routines SET last_status = ?, last_output = ?, last_ms = ? WHERE id = ?")
      .run(status, (output ?? "").slice(0, MAX_OUTPUT), ms, id);
  }

  /**
   * The session a run happens in.
   *
   * By default a routine keeps one, so a run can see what the last one did —
   * "nothing new since yesterday" needs yesterday. `fresh_session` gives each
   * run a clean one instead, for work where history is only noise.
   */
  private sessionFor(row: RoutineRow): SessionRow {
    // Its project, or Home. One that has gone is a failed run, said as such:
    // falling back to Home would do the work somewhere it was never meant for.
    const where = row.workspace ? checkWorkspace(row.workspace) : { path: agentHome() };
    if ("error" in where) {
      throw new Error(`Its project ${row.workspace} cannot be used (${where.error}). Choose where it runs in the routine.`);
    }
    if (!row.fresh_session) {
      const existing = findRoutineSession(row.slug, where.path);
      if (existing) return existing;
    }

    const id = nanoid(12);
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    createSession({
      id,
      title: row.fresh_session ? `${row.name} — ${stamp}` : row.name,
      workspace: where.path,
      executor: EXECUTOR_KIND,
      kind: "routine",
      routine_slug: row.slug,
    });
    return getSession(id)!;
  }
}

/**
 * Stops the run a session is in, waiting no longer for a pi that will not wind
 * down than a restart does.
 */
async function endRun(sessionId: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    sessions.abort(sessionId).catch(() => {}),
    new Promise<void>((resolve) => (timer = setTimeout(resolve, sessions.abortGraceMs))),
  ]);
  clearTimeout(timer);
}

/**
 * What the agent is actually asked.
 *
 * The instruction is given verbatim, with a line of context around it: an agent
 * that does not know it was woken by a schedule tends to answer as if somebody
 * is waiting, and asks a follow-up question nobody will ever read.
 */
function prompt(row: RoutineRow, trigger: "schedule" | "manual"): string {
  const how =
    trigger === "manual"
      ? "run by hand"
      : isOneOff(row)
        ? "at the time it was scheduled for"
        : `on its schedule (${row.schedule})`;
  const reporting = reportFraming(reportToFor(row.slug));
  return [
    `<routine name="${row.name}" trigger="${how}">`,
    "This is a scheduled task. Nobody is waiting on a reply — do the work, then",
    "finish with a short account of what you did and anything that needs a human.",
    "Do not ask questions; there is nobody to answer them.",
    ...(reporting ? ["", reporting] : []),
    "</routine>",
    "",
    row.instructions.trim(),
  ].join("\n");
}

/** A routine with a moment rather than a pattern. */
export const isOneOff = (row: { run_at: string | null; schedule: string }) =>
  Boolean(row.run_at) && !row.schedule.trim();

/**
 * A one-off that has had its run: one at or after the moment it was set for.
 * A run before it — by hand, to try it out — does not count. If that moment
 * cannot be read there is no "before" to tell apart, and any run is its run.
 */
export const oneOffDone = (row: { run_at: string | null; schedule: string; last_run: string | null }) => {
  if (!isOneOff(row) || !row.last_run) return false;
  const at = new Date(row.run_at!).getTime();
  return Number.isNaN(at) || new Date(row.last_run).getTime() >= at;
};

/** When it fires next, or null if it never will again. */
export function whenNext(row: RoutineRow): string | null {
  if (!row.enabled) return null;
  if (isOneOff(row)) return oneOffDone(row) ? null : row.run_at;
  try {
    return nextRun(parseCron(row.schedule))?.toISOString() ?? null;
  } catch {
    // An unparseable schedule is reported by the API on save; here it simply
    // never fires.
    return null;
  }
}

export const routineSupervisor = new RoutineSupervisor();
