import { Type } from "typebox";
import { getDb, getSession } from "../db.js";
import { unscopeKey } from "../agent.js";
import { agentAt } from "../agents.js";
import { placeProblem, routinePlace } from "../workspaces.js";
import { channelSupervisor } from "../channels/supervisor.js";
import { fail, say } from "./tool-result.js";
import {
  routineSupervisor,
  whenNext,
  type RoutineRow,
} from "../routines/supervisor.js";
import { insertRoutine, readTiming, timingSets } from "../routines/store.js";

/**
 * Routine management, as tools the agent can call.
 *
 * Registered inline rather than shipped as a package: the portal already owns
 * routines, and a package would have to call back over HTTP with a credential
 * to reach the database it is sitting next to.
 *
 * This is what makes "remind me every morning to check the backups" work from a
 * chat — the agent writes the routine itself instead of telling you where the
 * button is.
 *
 * Only registered for conversations with the agent: through a channel, on the
 * Agent page, or a chat in an agent's home. A task session working in some
 * repository has no business touching the schedule, and a routine run does not
 * get them either: a routine able to create routines can
 * form a chain with nobody watching it.
 *
 * There is no delete. Disabling stops a routine firing and leaves it visible,
 * so a misheard "cancel the morning thing" is recoverable; deleting outright
 * stays a deliberate act in the UI.
 */

const ok = say;
const bad = fail;

const rows = () =>
  getDb()
    .prepare("SELECT * FROM routines ORDER BY created_at ASC")
    .all() as RoutineRow[];

const byName = (needle: string): RoutineRow | undefined => {
  const key = needle.trim().toLowerCase();
  const all = rows();
  return (
    all.find((r) => r.slug === key) ??
    all.find((r) => r.name.toLowerCase() === key) ??
    all.find((r) => r.id === needle.trim())
  );
};

const describe = (r: RoutineRow) => ({
  name: r.name,
  slug: r.slug,
  enabled: Boolean(r.enabled),
  when: r.run_at ? `once at ${r.run_at}` : r.schedule,
  nextRun: whenNext(r),
  lastRun: r.last_run,
  lastStatus: r.last_status,
  instructions: r.instructions,
  runsIn: r.workspace ?? "Home",
  ...problem(r.workspace),
});

/** Said only when there is something wrong with where it runs, as the Routines page says it. */
function problem(workspace: string | null): { problem?: string } {
  const why = placeProblem(workspace);
  return why ? { problem: `${workspace}: ${why}. Its runs fail until it is given another place.` } : {};
}

/**
 * A project to run in, by name or path, or Home when there is none: read as the HTTP API reads it. Home is the home
 * of the agent the conversation is with. Left as null (the first agent's) it would run as that agent, whichever
 * agent was asked, so a routine made in a second agent's chat is placed in that agent's home.
 */
function place(raw: unknown, sessionId?: string): { workspace: string | null } | { error: string } {
  const home = typeof raw === "string" ? /^\s*(home)?\s*$/i.test(raw) : raw === undefined || raw === null;
  const agent = home && sessionId ? agentAt(getSession(sessionId)?.workspace ?? "") : undefined;
  const where = routinePlace(agent ? agent.home : raw);
  return "error" in where ? { error: `Cannot run in "${raw}": ${where.error}` } : where;
}

const WORKSPACE_PARAM = Type.Optional(Type.String({ description: "Project name or path to run in, or home (the default: the folder of the agent you are, not a project)" }));

/**
 * Where a routine created from a conversation should report.
 *
 * Back into the conversation that asked for it. Someone setting up a morning
 * summary from a Telegram chat means "tell me here" — anything else makes them
 * configure a destination for a thing they just described in one sentence.
 *
 * The portal default remains the fallback, for a routine created any other way
 * — and for a conversation whose channel cannot speak first. A browser chat is
 * an agent session like any other, but "reply in the portal" is not somewhere a
 * report can be delivered, and pointing a routine there would be worse than
 * leaving it on the default.
 */
export function reportBackTo(sessionId?: string): {
  channel: string | null;
  target: string | null;
} {
  if (!sessionId) return { channel: null, target: null };
  const session = getSession(sessionId);
  if (!session?.channel_slug || !session.channel_key)
    return { channel: null, target: null };
  if (!channelSupervisor.canSend(session.channel_slug))
    return { channel: null, target: null };
  return {
    channel: session.channel_slug,
    target: unscopeKey(session.channel_slug, session.channel_key),
  };
}

/** An ExtensionFactory — see pi's InlineExtension. */
export function routineTools(sessionId?: string) {
  return (pi: any): void => {
    pi.registerTool({
      name: "routines_list",
      label: "List routines",
      description: "List the routines: what each does, its next run, how the last went.",
      promptSnippet: "see the scheduled work that already exists",
      parameters: Type.Object({}),
      async execute() {
        const all = rows();
        if (!all.length) return ok("No routines are set up.");
        return ok(JSON.stringify(all.map(describe), null, 2));
      },
    });

    pi.registerTool({
      name: "routine_create",
      label: "Create routine",
      description:
        "Schedule work for later: give schedule to repeat, or runAt for once, not both. " +
        "instructions are what you will be told when it fires, with nobody to ask: a standing order to yourself.",
      promptSnippet: "schedule work for later, once or repeatedly",
      parameters: Type.Object({
        name: Type.String({ description: "Short name, e.g. Morning summary" }),
        instructions: Type.String(),
        schedule: Type.Optional(Type.String({ description: "5-field cron or @shorthand, e.g. 0 9 * * 1-5 or @daily" })),
        runAt: Type.Optional(Type.String({ description: "ISO 8601 time, e.g. 2026-08-01T09:00:00Z" })),
        freshSession: Type.Optional(Type.Boolean({ description: "Each run starts without memory of the last; default false" })),
        workspace: WORKSPACE_PARAM,
      }),
      async execute(_id: string, p: any) {
        if (!p.name?.trim()) return bad("A routine needs a name");
        const t = readTiming(p);
        if ("error" in t) return bad(t.error);
        const where = place(p.workspace, sessionId);
        if ("error" in where) return bad(where.error);

        const back = reportBackTo(sessionId);
        const { id, slug } = insertRoutine({
          name: p.name,
          timing: t,
          instructions: p.instructions ?? "",
          freshSession: Boolean(p.freshSession),
          reportChannel: back.channel,
          reportTarget: back.target,
          workspace: where.workspace,
        });
        routineSupervisor.refreshSchedules([id]);

        const created = byName(slug)!;
        return ok(
          `Created "${created.name}". Next run: ${whenNext(created) ?? "not scheduled"}.` +
            (back.channel
              ? " It will report back into this conversation."
              : ""),
        );
      },
    });

    pi.registerTool({
      name: "routine_update",
      label: "Update routine",
      description: "Change a routine; only the fields given change.",
      parameters: Type.Object({
        routine: Type.String({ description: "Name or slug" }),
        name: Type.Optional(Type.String()),
        instructions: Type.Optional(Type.String()),
        schedule: Type.Optional(Type.String({ description: "Cron; clears runAt" })),
        runAt: Type.Optional(Type.String({ description: "ISO time; clears schedule" })),
        enabled: Type.Optional(Type.Boolean({ description: "false pauses it and keeps it: how to cancel one" })),
        workspace: WORKSPACE_PARAM,
      }),
      async execute(_id: string, p: any) {
        const row = byName(p.routine ?? "");
        if (!row) return bad(`No routine called "${p.routine}"`);

        const sets: string[] = [];
        const values: unknown[] = [];

        if (typeof p.name === "string" && p.name.trim()) {
          sets.push("name = ?");
          values.push(p.name.trim());
        }
        if (typeof p.instructions === "string") {
          sets.push("instructions = ?");
          values.push(p.instructions.trim());
        }
        if (typeof p.enabled === "boolean") {
          sets.push("enabled = ?");
          values.push(p.enabled ? 1 : 0);
        }
        if (p.workspace !== undefined) {
          const where = place(p.workspace, sessionId);
          if ("error" in where) return bad(where.error);
          sets.push("workspace = ?");
          values.push(where.workspace);
        }
        if (p.schedule !== undefined || p.runAt !== undefined) {
          const t = readTiming(p);
          if ("error" in t) return bad(t.error);
          const change = timingSets(row, t, typeof p.enabled === "boolean");
          sets.push(...change.sets);
          values.push(...change.values);
        }
        if (!sets.length)
          return bad("Nothing to change — pass at least one field");

        sets.push("updated_at = datetime('now')");
        getDb()
          .prepare(`UPDATE routines SET ${sets.join(", ")} WHERE id = ?`)
          .run(...values, row.id);
        routineSupervisor.refreshSchedules([row.id]);

        const after = byName(row.slug)!;
        return ok(
          `Updated "${after.name}". Next run: ${whenNext(after) ?? "not scheduled"}`,
        );
      },
    });

    pi.registerTool({
      name: "routine_run",
      label: "Run routine now",
      description: "Run a routine now, e.g. to test one you just made.",
      parameters: Type.Object({
        routine: Type.String({ description: "Name or slug" }),
      }),
      async execute(_id: string, p: any) {
        const row = byName(p.routine ?? "");
        if (!row) return bad(`No routine called "${p.routine}"`);
        const after = await routineSupervisor.run(row, "manual");
        if (!after) return bad(`"${row.name}" was deleted while it ran`);
        const output = (after.last_output ?? "").trim();
        return after.last_status === "ok"
          ? ok(output || "Ran, with no output.")
          : bad(`It failed: ${output}`);
      },
    });
  };
}
