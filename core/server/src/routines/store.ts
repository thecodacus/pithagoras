import { nanoid } from "nanoid";
import { getDb } from "../db.js";
import { freeSlug } from "../slug.js";
import { isValidCron, nextRun, parseCron } from "./cron.js";
import { oneOffDone, type RoutineRow } from "./supervisor.js";

/**
 * What creating and changing a routine means, written once: the HTTP API and the
 * agent's tools both go through it, so a rule changed here holds for both.
 */

export type Timing = { schedule: string; runAt: string | null };

/**
 * A routine either repeats on a schedule or happens once at a moment. Both or
 * neither is not a thing, and saying so beats guessing which was meant.
 */
export function readTiming(input: { schedule?: unknown; runAt?: unknown }): Timing | { error: string } {
  const schedule = typeof input.schedule === "string" ? input.schedule.trim() : "";
  const runAt = typeof input.runAt === "string" ? input.runAt.trim() : "";

  if (schedule && runAt) return { error: "Give a schedule or a time to run once, not both" };
  if (!schedule && !runAt) return { error: "Needs a schedule, or a time to run once" };

  if (schedule) {
    const bad = isValidCron(schedule);
    return bad ? { error: bad } : { schedule, runAt: null };
  }

  const at = new Date(runAt);
  if (Number.isNaN(at.getTime())) return { error: `"${runAt}" is not a time I can read` };
  return { schedule: "", runAt: at.toISOString() };
}

/**
 * What to set on a routine that is given a new timing. Setting one clears the
 * other: a routine either repeats or happens once.
 *
 * A one-off given a new moment is armed again: the old outcome is forgotten, or
 * it would look done the moment it was saved. And switched back on, unless the
 * person said otherwise — it was switched off by having run, not by anybody,
 * and a new time that then never fires is not what giving it one means.
 */
export function timingSets(
  row: RoutineRow,
  timing: Timing,
  enabledGiven: boolean,
): { sets: string[]; values: unknown[] } {
  const sets = ["schedule = ?", "run_at = ?"];
  if (timing.runAt && timing.runAt !== row.run_at) {
    sets.push("last_run = NULL", "last_status = NULL", "last_output = NULL");
    if (!enabledGiven && oneOffDone(row)) sets.push("enabled = 1");
  }
  return { sets, values: [timing.schedule, timing.runAt] };
}

export interface NewRoutine {
  name: string;
  /** A slug that reconnects the routine to the sessions that slug had; without one it is made from the name. */
  slug?: string;
  timing: Timing;
  instructions: string;
  freshSession: boolean;
  /** Where its reports go: null inherits the portal default, "" never reports. */
  reportChannel: string | null;
  reportTarget: string | null;
  workspace: string | null;
}

/**
 * Slugs own the sessions, so two routines must never share one. Nor may a new
 * routine take the name of one that was deleted, which would continue that
 * one's conversation, with its instructions and what it read: it gets a slug
 * of its own, unless it is asked for by `explicit`, the way back to the old runs.
 */
export const freeRoutineSlug = (desired: string, explicit = false): string => {
  const taken = (getDb().prepare("SELECT slug FROM routines").all() as { slug: string }[]).map((r) => r.slug);
  if (!explicit) {
    const runs = getDb().prepare("SELECT DISTINCT routine_slug FROM sessions WHERE kind = 'routine' AND routine_slug IS NOT NULL").all() as { routine_slug: string }[];
    taken.push(...runs.map((r) => r.routine_slug));
  }
  return freeSlug(desired, taken, "routine");
};

export function insertRoutine(r: NewRoutine): { id: string; slug: string } {
  const id = nanoid(10);
  const slug = freeRoutineSlug(r.slug ?? r.name, r.slug !== undefined);
  getDb()
    .prepare(
      `INSERT INTO routines
         (id, slug, name, schedule, run_at, instructions, fresh_session, next_run,
          report_channel, report_target, workspace)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      slug,
      r.name.trim(),
      r.timing.schedule,
      r.timing.runAt,
      r.instructions.trim(),
      r.freshSession ? 1 : 0,
      r.timing.schedule ? (nextRun(parseCron(r.timing.schedule))?.toISOString() ?? null) : r.timing.runAt,
      r.reportChannel,
      r.reportTarget,
      r.workspace,
    );
  return { id, slug };
}
