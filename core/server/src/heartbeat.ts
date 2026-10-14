import { readFileSync } from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { createSession, getDb, getSession, type SessionRow } from "./db.js";
import { AgentError, getAgent, listAgents, type Agent } from "./agents.js";
import { countNotes } from "./activity.js";
import { EXECUTOR_KIND } from "./executor-kind.js";
import { sessions } from "./session-manager.js";
import { NOTE_TOOL } from "./pi/heartbeat-names.js";
import { WATCH_FILE } from "./pi/context-files.js";

/**
 * An agent looking around on its own.
 *
 * Every so often, an agent with a heartbeat reads what its WATCH.md asks it to
 * keep an eye on and decides whether anything deserves the attention of the
 * person it works for. It can only read (see HEARTBEAT_ROLE); what it found
 * goes into its Activity as notes, and most looks find nothing and say nothing.
 *
 * It never gets in the way: a look waits while any chat is working, since a
 * home lab has one model on one card, and it keeps quiet in the hours it was
 * told to.
 */

export { WATCH_FILE };

/** The shortest interval offered: a look costs a turn of the model, and more often than this is a busy loop. */
export const MIN_MINUTES = 15;
/** A week. */
export const MAX_MINUTES = 7 * 24 * 60;

/** How long one look may take before it is abandoned. */
const LOOK_TIMEOUT_MS = 20 * 60_000;

const TICK_MS = 60_000;

/** What a look shows once a restart cut it off. */
const INTERRUPTED = "Interrupted by a restart";

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** What the agent is asked to watch, or "" when there is nothing. */
export function watchList(agent: Agent): string {
  try {
    return readFileSync(path.join(agent.home, WATCH_FILE), "utf8").trim();
  } catch {
    return "";
  }
}

const minuteOfDay = (hhmm: string) => {
  const m = HHMM.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

/**
 * Whether `now` falls in the quiet hours, on the server's clock. A span that
 * runs past midnight (22:00–07:00) wraps; without both ends there are none.
 */
export function inQuietHours(now: Date, start: string | null, end: string | null): boolean {
  if (!start || !end) return false;
  const from = minuteOfDay(start);
  const to = minuteOfDay(end);
  if (Number.isNaN(from) || Number.isNaN(to) || from === to) return false;
  const at = now.getHours() * 60 + now.getMinutes();
  return from < to ? at >= from && at < to : at >= from || at < to;
}

/** Whether a look is due: switched on, the interval passed since the last, and not in quiet hours. */
export function heartbeatDue(agent: Agent, now: Date): boolean {
  if (!agent.heartbeat_minutes) return false;
  if (inQuietHours(now, agent.quiet_start, agent.quiet_end)) return false;
  if (!agent.last_heartbeat) return true;
  const last = new Date(agent.last_heartbeat).getTime();
  return Number.isNaN(last) || now.getTime() - last >= agent.heartbeat_minutes * 60_000;
}

/** How often it looks and when it keeps quiet. Minutes null or 0 switch it off. */
export function setHeartbeat(
  id: string,
  input: { minutes?: unknown; quietStart?: unknown; quietEnd?: unknown },
): Agent {
  if (!getAgent(id)) throw new AgentError("No such agent", 404);
  const minutes = input.minutes ?? null;
  if (minutes !== null && minutes !== 0) {
    if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
      throw new AgentError(`Looks are between every ${MIN_MINUTES} minutes and once a week`, 400);
    }
  }
  const quiet = (v: unknown) => (typeof v === "string" ? v.trim() : v ?? "");
  const start = quiet(input.quietStart);
  const end = quiet(input.quietEnd);
  if (typeof start !== "string" || typeof end !== "string" || Boolean(start) !== Boolean(end)) {
    throw new AgentError("Quiet hours need a start and an end, or neither", 400);
  }
  if (start && (!HHMM.test(start) || !HHMM.test(end))) throw new AgentError("Quiet hours are times like 22:00", 400);
  getDb()
    .prepare("UPDATE agents SET heartbeat_minutes = ?, quiet_start = ?, quiet_end = ? WHERE id = ?")
    .run(minutes || null, start || null, end || null, id);
  return getAgent(id)!;
}

/** The session an agent's looks happen in: one per agent, so a look can see what the last one said. */
function sessionFor(agent: Agent): SessionRow {
  const existing = getDb()
    .prepare("SELECT * FROM sessions WHERE kind = 'heartbeat' AND workspace = ? ORDER BY created_at DESC LIMIT 1")
    .get(agent.home) as SessionRow | undefined;
  if (existing) return existing;
  const id = nanoid(12);
  createSession({ id, title: `${agent.name} · heartbeat`, workspace: agent.home, executor: EXECUTOR_KIND, kind: "heartbeat" });
  return getSession(id)!;
}

/**
 * What the agent is asked. WATCH.md verbatim, with a frame saying that nobody
 * asked, that it can only read, and that silence is the right answer most of
 * the time — an agent that thinks someone is waiting writes a report about
 * nothing.
 */
function prompt(agent: Agent, watch: string, trigger: "schedule" | "manual"): string {
  return [
    `<heartbeat agent="${agent.name}" at="${new Date().toISOString()}" trigger="${trigger === "manual" ? "asked to look now" : "on its interval"}">`,
    // A sentence to a line, not wrapped: the look is read in the chat view too.
    `Nobody asked you anything. This is you looking around on your own, at what the person you work for asked you to keep an eye on (${WATCH_FILE}, below).`,
    "You can read; you cannot change anything, run commands or send anything, beyond what a standing rule allows. Do not try to work around a refusal.",
    `When something deserves their attention, call ${NOTE_TOOL} once for each thing.`,
    "Your earlier looks are above in this conversation: do not note again what you already noted, unless it changed.",
    `When nothing is new, call nothing and reply "Nothing new." Most looks should end that way.`,
    "</heartbeat>",
    "",
    watch,
  ].join("\n");
}

class HeartbeatSupervisor {
  private running = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  start(): void {
    if (this.timer) return;
    // A look cut off by a restart never reached its `finally`; nothing else
    // would ever take "Looking" off the agent's page.
    getDb().prepare("UPDATE agents SET heartbeat_status = ? WHERE heartbeat_status = 'Looking'").run(INTERRUPTED);
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  isRunning(agentId: string): boolean {
    return this.running.has(agentId);
  }

  /**
   * Whether the model is in use: a look under way, or any chat or routine
   * working. One look at a time, and none while anything else is using the
   * model — asked on a schedule and by hand alike.
   */
  isBusy(): boolean {
    return this.running.size > 0 || sessions.anyBusy();
  }

  private async tick(): Promise<void> {
    const now = new Date();
    if (this.isBusy()) return;
    const due = listAgents().find((a) => heartbeatDue(a, now));
    if (due) void this.run(due, "schedule").catch(() => {});
  }

  /** One look. Not awaited by the tick; a look by hand is, by whoever asked for it. */
  async run(agent: Agent, trigger: "schedule" | "manual"): Promise<Agent> {
    if (this.running.has(agent.id)) throw new AgentError(`${agent.name} is already looking`, 409);
    const status = (text: string) =>
      getDb().prepare("UPDATE agents SET heartbeat_status = ? WHERE id = ?").run(text, agent.id);
    // Written first, so a look that crashes the server does not fire again the
    // moment it comes back, and a look that cannot happen waits its interval.
    getDb().prepare("UPDATE agents SET last_heartbeat = ? WHERE id = ?").run(new Date().toISOString(), agent.id);

    // The container executor runs pi without the portal's extensions, so
    // nothing would hold a look to reading.
    if (EXECUTOR_KIND !== "host") {
      status("Looks need the host executor: in a container nothing holds them to reading");
      return getAgent(agent.id)!;
    }
    const watch = watchList(agent);
    if (!watch) {
      status(`Nothing to watch: ${WATCH_FILE} is empty`);
      return getAgent(agent.id)!;
    }

    this.running.add(agent.id);
    status("Looking");
    const before = countNotes(agent.id);
    try {
      const session = sessionFor(agent);
      // Stop pressed in the look's chat ends it like any other, and would read
      // as one that found nothing.
      let stopped = false;
      await sessions.ask(session.id, prompt(agent, watch, trigger), { timeoutMs: LOOK_TIMEOUT_MS, onStopped: () => (stopped = true) });
      const left = countNotes(agent.id) - before;
      // A look the portal's own stop aborted ends like any other, and would read
      // as one that found nothing: it was cut off, as a crash cuts one off.
      status(sessions.closing ? INTERRUPTED : stopped ? "Stopped" : left ? `${left} new ${left === 1 ? "note" : "notes"}` : "Nothing new");
    } catch (e) {
      // The first line: pi's errors go on to explain where its docs are.
      status(sessions.closing ? INTERRUPTED : `Failed: ${(e as Error).message.split("\n")[0]}`);
    } finally {
      this.running.delete(agent.id);
    }
    return getAgent(agent.id)!;
  }
}

export const heartbeat = new HeartbeatSupervisor();
