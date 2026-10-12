import express, { type Router } from "express";
import { getDb, getDefaultReportTo, listRoutineSessions, setDefaultReportTo, setRoutineBrowser } from "../db.js";
import { channelSupervisor } from "../channels/supervisor.js";
import { unscopeKey } from "../agent.js";
import { isValidSlug, slugify } from "../slug.js";
import { isValidCron, nextRun, parseCron } from "../routines/cron.js";
import { isOneOff, oneOffDone, routineSupervisor, type RoutineRow } from "../routines/supervisor.js";
import { insertRoutine, readTiming, timingSets } from "../routines/store.js";
import { placeProblem, routinePlace } from "../workspaces.js";
import { insideReal } from "../within.js";

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
  /** A one-off that has already run. Kept so its result stays readable. Not one a restart cut off or somebody stopped: that did not finish. */
  done: oneOffDone(row) && row.last_status !== "interrupted" && row.last_status !== "stopped",
  instructions: row.instructions,
  freshSession: Boolean(row.fresh_session),
  guard: row.guard === 1,
  browser: row.browser === 1,
  /** Where its runs happen: null for Home, else a project's directory. */
  workspace: row.workspace ?? null,
  /** Why that place cannot be used now, such as a project that was deleted; null when it can. */
  workspaceProblem: placeProblem(row.workspace),
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

/**
 * Where a routine runs, as sent: absent leaves it as it is, and anything else
 * is read as the agent's tool reads it. The place it already has is taken as
 * it is, even one that has gone: saving another change must not need a new
 * place first.
 */
export function readWorkspace(body: any, current?: string | null): { workspace: string | null } | { error: string } | undefined {
  if (!body || !("workspace" in body)) return undefined;
  if (current && body.workspace === current) return { workspace: current };
  return routinePlace(body.workspace);
}

/** The routines that run in this folder, or in one below it, or through a link to either. */
export function routinesIn(dir: string): { id: string; slug: string; name: string; enabled: boolean }[] {
  const inside = insideReal(dir);
  return (getDb().prepare("SELECT id, slug, name, enabled, workspace FROM routines ORDER BY name").all() as Pick<RoutineRow, "id" | "slug" | "name" | "enabled" | "workspace">[])
    .filter((r) => inside(r.workspace))
    .map((r) => ({ id: r.id, slug: r.slug, name: r.name, enabled: r.enabled === 1 }));
}

/**
 * Switches off the routines whose folder has been deleted: each run would fail
 * there. Their sessions are left alone, the record of what they did, and they
 * run again once given another place and switched on. Taken from routinesIn
 * before the folder went, since a link into it cannot be followed after.
 * Returns the names of those that were on.
 */
export function switchOffRoutines(all: { id: string; name: string; enabled: boolean }[]): string[] {
  const routines = all.filter((r) => r.enabled);
  if (!routines.length) return [];
  const off = getDb().prepare("UPDATE routines SET enabled = 0, updated_at = datetime('now') WHERE id = ?");
  getDb().transaction(() => {
    for (const r of routines) off.run(r.id);
  })();
  routineSupervisor.refreshSchedules(routines.map((r) => r.id));
  return routines.map((r) => r.name);
}

/**
 * Takes the routines out with the folder they ran in, the home of an agent
 * deleted with its folder: an agent made later under the same name gets a new
 * folder at the same place, and would otherwise run what was written for the
 * one before it. Their sessions are left alone, as when a routine is deleted.
 * Returns their names.
 */
export function removeRoutines(all: { id: string; name: string }[]): string[] {
  const del = getDb().prepare("DELETE FROM routines WHERE id = ?");
  getDb().transaction(() => {
    for (const r of all) del.run(r.id);
  })();
  return all.map((r) => r.name);
}

/**
 * Somewhere a report could be sent.
 *
 * Built from conversations that already exist rather than asked for as a chat
 * id: you pick "Telegram — Sam Rivera", and a channel that can only answer
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
    // The key is stored scoped by channel, and by agent for a channel bound to a
    // second one; the package expects its own key back.
    const target = unscopeKey(r.channel_slug, r.channel_key);
    const id = `${r.channel_slug}\u0000${target}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ channel: r.channel_slug, target, label: r.title });
  }
  return out;
}

/** `toolsChanged` is told when a routine's tools changed here, so its runs that are going are told at once. */
export function routinesRouter(toolsChanged: (slug: string) => void = () => {}): Router {
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
    const place = readWorkspace(req.body);
    if (place && "error" in place) return res.status(400).json({ error: place.error });

    const { id } = insertRoutine({
      name,
      slug: typeof req.body?.slug === "string" && req.body.slug ? req.body.slug : undefined,
      timing,
      instructions: typeof instructions === "string" ? instructions : "",
      freshSession: Boolean(freshSession),
      reportChannel: report.channel,
      reportTarget: report.target,
      workspace: place?.workspace ?? null,
    });
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
    if (typeof schedule === "string" || typeof runAt === "string") {
      const timing = readTiming({ schedule, runAt });
      if ("error" in timing) return res.status(400).json({ error: timing.error });
      const change = timingSets(row, timing, typeof enabled === "boolean");
      sets.push(...change.sets);
      values.push(...change.values);
    }
    if (typeof instructions === "string") {
      sets.push("instructions = ?");
      values.push(instructions.trim());
    }
    if (typeof req.body?.guard === "boolean") {
      sets.push("guard = ?");
      values.push(req.body.guard ? 1 : 0);
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
    const place = readWorkspace(req.body, row.workspace);
    if (place && "error" in place) return res.status(400).json({ error: place.error });
    if (place) {
      sets.push("workspace = ?");
      values.push(place.workspace);
    }

    if (sets.length) {
      sets.push("updated_at = datetime('now')");
      getDb().prepare(`UPDATE routines SET ${sets.join(", ")} WHERE id = ?`).run(...values, row.id);
      routineSupervisor.refreshSchedules([row.id]);
    }
    // Its tools' lists as well, which are what a run goes by: the switch alone would answer 200 and change nothing.
    if (typeof req.body?.browser === "boolean") {
      const slug = rowById(row.id)!.slug;
      setRoutineBrowser(slug, req.body.browser);
      toolsChanged(slug);
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
      const after = await routineSupervisor.run(row, "manual");
      if (!after) return res.status(404).json({ error: `"${row.name}" was deleted while it ran` });
      res.json(toApi(after));
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
    for (let i = 0; i < 3; i++) {
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
