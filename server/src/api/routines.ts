import express, { type Router } from "express";
import { nanoid } from "nanoid";
import { getDb, getDefaultReportTo, listRoutineSessions, setDefaultReportTo } from "../db.js";
import { channelSupervisor } from "../channels/supervisor.js";
import { isValidSlug, slugify } from "../slug.js";
import { isValidCron, nextRun, parseCron } from "../routines/cron.js";
import { isOneOff, routineSupervisor, whenNext, type RoutineRow } from "../routines/supervisor.js";

/**
 * Scheduled work: a standing instruction, a cron expression, and a record of
 * how the last run went.
 */

const toApi = (row: RoutineRow) => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  enabled: Boolean(row.enabled),
  schedule: row.schedule,
  runAt: row.run_at,
  /** "once" or "repeats" — the two are mutually exclusive. */
  mode: isOneOff(row) ? ("once" as const) : ("repeats" as const),
  /** A one-off that has already run. Kept so its result stays readable. */
  done: isOneOff(row) && Boolean(row.last_run),
  instructions: row.instructions,
  freshSession: Boolean(row.fresh_session),
  /** null inherits the portal default; "" is an explicit "never report". */
  reportChannel: row.report_channel,
  reportTarget: row.report_target,
  lastReportAt: row.last_report_at,
  lastRun: row.last_run,
  lastStatus: routineSupervisor.isRunning(row.slug) ? "running" : row.last_status,
  lastOutput: row.last_output,
  lastMs: row.last_ms,
  nextRun: row.next_run,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * A routine either repeats on a schedule or happens once at a moment. Both or
 * neither is not a thing, and saying so beats guessing which was meant.
 */
function readTiming(input: { schedule?: unknown; runAt?: unknown }):
  | { schedule: string; runAt: string | null }
  | { error: string } {
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
 * A destination, as three states rather than two.
 *
 * Absent or null inherits the portal default; the empty string is an explicit
 * "this one stays quiet" that a later change to the default must not override.
 */
function readReport(body: any): { channel: string | null; target: string | null } {
  const channel = body?.reportChannel;
  if (channel === "") return { channel: "", target: "" };
  if (typeof channel === "string" && channel && typeof body?.reportTarget === "string") {
    return { channel, target: body.reportTarget };
  }
  return { channel: null, target: null };
}

/** Slugs own the sessions, so two routines must never share one. */
function freeSlug(desired: string, exceptId?: string): string {
  const base = slugify(desired) || "routine";
  const taken = new Set(
    (getDb().prepare("SELECT id, slug FROM routines").all() as { id: string; slug: string }[])
      .filter((r) => r.id !== exceptId)
      .map((r) => r.slug)
  );
  if (!taken.has(base)) return base;
  for (let n = 2; n < 500; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  throw new Error(`Could not find a free slug for "${desired}"`);
}

/**
 * Somewhere a report could be sent.
 *
 * Built from conversations that already exist rather than asked for as a chat
 * id: you pick "Telegram — Anirban Kar", and a channel that can only answer
 * (a webhook) never appears, because it cannot speak first.
 */
function reportTargets() {
  const rows = getDb()
    .prepare(
      `SELECT channel_slug, channel_key, title FROM sessions
       WHERE kind = 'agent' AND channel_slug IS NOT NULL AND channel_key IS NOT NULL
       ORDER BY updated_at DESC`
    )
    .all() as { channel_slug: string; channel_key: string; title: string }[];

  const seen = new Set<string>();
  const out: { channel: string; target: string; label: string }[] = [];
  for (const r of rows) {
    if (!channelSupervisor.canSend(r.channel_slug)) continue;
    // The key is stored scoped by channel; the package expects its own key back.
    const target = r.channel_key.startsWith(`${r.channel_slug}:`)
      ? r.channel_key.slice(r.channel_slug.length + 1)
      : r.channel_key;
    const id = `${r.channel_slug}\u0000${target}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ channel: r.channel_slug, target, label: r.title });
  }
  return out;
}

export function routinesRouter(): Router {
  const router = express.Router();

  /** Destinations a routine can report to, and the portal-wide default. */
  router.get("/routines/report-targets", (_req, res) => {
    res.json({ targets: reportTargets(), default: getDefaultReportTo() });
  });

  router.put("/routines/report-default", (req, res) => {
    const { channel, target } = req.body ?? {};
    if (!channel || !target) {
      setDefaultReportTo(null);
      return res.json({ default: null });
    }
    if (typeof channel !== "string" || typeof target !== "string") {
      return res.status(400).json({ error: "channel and target must be strings" });
    }
    setDefaultReportTo({ channel, target });
    res.json({ default: getDefaultReportTo() });
  });

  const rowById = (id: string) =>
    getDb().prepare("SELECT * FROM routines WHERE id = ?").get(id) as RoutineRow | undefined;

  router.get("/routines", (_req, res) => {
    const rows = getDb()
      .prepare("SELECT * FROM routines ORDER BY created_at ASC")
      .all() as RoutineRow[];
    res.json({ routines: rows.map(toApi) });
  });

  router.post("/routines", (req, res) => {
    const { name, schedule, runAt, instructions, freshSession } = req.body ?? {};
    const report = readReport(req.body);
    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name required" });
    }

    const timing = readTiming({ schedule, runAt });
    if ("error" in timing) return res.status(400).json({ error: timing.error });

    const id = nanoid(10);
    const slug = freeSlug(typeof req.body?.slug === "string" && req.body.slug ? req.body.slug : name);
    getDb()
      .prepare(
        `INSERT INTO routines
           (id, slug, name, schedule, run_at, instructions, fresh_session, next_run,
            report_channel, report_target)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        slug,
        name.trim(),
        timing.schedule,
        timing.runAt,
        typeof instructions === "string" ? instructions.trim() : "",
        freshSession ? 1 : 0,
        timing.schedule ? (nextRun(parseCron(timing.schedule))?.toISOString() ?? null) : timing.runAt,
        report.channel,
        report.target
      );
    res.json(toApi(rowById(id)!));
  });

  router.patch("/routines/:id", (req, res) => {
    const row = rowById(req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });

    const { name, slug, schedule, runAt, instructions, enabled, freshSession } = req.body ?? {};
    const sets: string[] = [];
    const values: unknown[] = [];

    if (typeof slug === "string" && slug.trim() && slug.trim() !== row.slug) {
      const next = slugify(slug);
      if (!isValidSlug(next)) return res.status(400).json({ error: `"${slug}" is not a usable slug` });
      const clash = getDb()
        .prepare("SELECT id FROM routines WHERE slug = ? AND id != ?")
        .get(next, row.id);
      if (clash) return res.status(409).json({ error: `Another routine already uses "${next}"` });
      sets.push("slug = ?");
      values.push(next);
    }
    if (typeof name === "string" && name.trim()) {
      sets.push("name = ?");
      values.push(name.trim());
    }
    // Setting one clears the other: a routine either repeats or happens once.
    if (typeof schedule === "string" || typeof runAt === "string") {
      const timing = readTiming({ schedule, runAt });
      if ("error" in timing) return res.status(400).json({ error: timing.error });
      sets.push("schedule = ?", "run_at = ?");
      values.push(timing.schedule, timing.runAt);
      // Re-arming a one-off that already ran: forget the old outcome, or it
      // would look done the moment it was saved.
      if (timing.runAt && timing.runAt !== row.run_at) {
        sets.push("last_run = NULL", "last_status = NULL", "last_output = NULL");
      }
    }
    if (typeof instructions === "string") {
      sets.push("instructions = ?");
      values.push(instructions.trim());
    }
    if ("reportChannel" in (req.body ?? {})) {
      const report = readReport(req.body);
      sets.push("report_channel = ?", "report_target = ?");
      values.push(report.channel, report.target);
    }
    if (typeof enabled === "boolean") {
      sets.push("enabled = ?");
      values.push(enabled ? 1 : 0);
    }
    if (typeof freshSession === "boolean") {
      sets.push("fresh_session = ?");
      values.push(freshSession ? 1 : 0);
    }

    if (sets.length) {
      sets.push("updated_at = datetime('now')");
      getDb().prepare(`UPDATE routines SET ${sets.join(", ")} WHERE id = ?`).run(...values, row.id);
      routineSupervisor.refreshSchedules();
    }
    res.json(toApi(rowById(row.id)!));
  });

  router.delete("/routines/:id", (req, res) => {
    const row = rowById(req.params.id);
    if (!row) return res.json({ ok: true });
    // Its sessions are left alone: they are the record of what it did, and
    // deleting the schedule is not the same as wanting that gone.
    getDb().prepare("DELETE FROM routines WHERE id = ?").run(row.id);
    res.json({ ok: true, keptSessions: listRoutineSessions(row.slug).length });
  });

  /** Run it now. Returns once the run finishes, which can be a while. */
  router.post("/routines/:id/run", async (req, res) => {
    const row = rowById(req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    try {
      res.json(toApi(await routineSupervisor.run(row, "manual")));
    } catch (e) {
      res.status(409).json({ error: (e as Error).message });
    }
  });

  /** What a schedule would do next, without saving it. */
  router.post("/routines/preview", (req, res) => {
    const schedule = req.body?.schedule;
    if (typeof schedule !== "string") return res.status(400).json({ error: "schedule required" });
    const bad = isValidCron(schedule);
    if (bad) return res.status(400).json({ error: bad });

    const cron = parseCron(schedule);
    const runs: string[] = [];
    let at = new Date();
    for (let i = 0; i < 5; i++) {
      const next = nextRun(cron, at);
      if (!next) break;
      runs.push(next.toISOString());
      at = next;
    }
    res.json({ expression: cron.expression, runs });
  });

  router.get("/routines/:id/sessions", (req, res) => {
    const row = rowById(req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json({ sessions: listRoutineSessions(row.slug) });
  });

  return router;
}
