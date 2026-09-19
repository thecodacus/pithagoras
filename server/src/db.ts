import Database from "better-sqlite3";
import { piSetting } from "./pi-settings.js";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type SessionStatus = "idle" | "running" | "error" | "interrupted";

export interface SessionRow {
  id: string;
  title: string;
  workspace: string;
  executor: string;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
  last_error: string | null;
  /** Per-session overrides of the portal defaults; null means "use the default". */
  provider: string | null;
  model: string | null;
  thinking_level: string | null;
  /** SQLite has no boolean; 0 or 1. */
  pinned: number;
  /** pi's own session file, so the exact conversation is reopened on restart. */
  pi_session_file: string | null;
  /**
   * "task" for the ones you create here, "agent" for one reached through a
   * channel, "routine" for one a schedule owns.
   */
  kind: "task" | "agent" | "routine";
  /**
   * Agent sessions only: the slug of the channel it arrived through.
   *
   * The slug rather than the channel's id, because ids are regenerated when a
   * channel is deleted and recreated — which orphaned every conversation it
   * had. A slug is stable and yours to choose, so re-adding a channel under the
   * same one picks its conversations back up.
   */
  channel_slug: string | null;
  /**
   * Agent sessions only: the conversation key, as `<channel slug>:<package key>`.
   * The package decides what a conversation is — a Telegram chat id, a Slack
   * channel — and the prefix keeps two channels using the same key apart.
   */
  channel_key: string | null;
  /** Routine sessions only: the slug of the routine that owns this session. */
  routine_slug: string | null;
  /** Lowest role this conversation has served — see the migration for why. */
  role: "primary" | "colleague" | "guest" | "unknown";
  /** Who last spoke here, surviving a restart that empties the in-memory map. */
  last_person_key: string | null;
  /** May this session drive the agent's browser? Off unless turned on. */
  browser: number;
}

export interface EventRow {
  seq: number;
  session_id: string;
  type: string;
  payload: string;
  created_at: string;
}

const DATA_DIR = process.env.DATA_DIR || "./data";
let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(path.join(DATA_DIR, "portal.db"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workspace TEXT NOT NULL,
      executor TEXT NOT NULL DEFAULT 'host',
      status TEXT NOT NULL DEFAULT 'idle',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_error TEXT,
      provider TEXT,
      model TEXT,
      thinking_level TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      pi_session_file TEXT,
      kind TEXT NOT NULL DEFAULT 'task',
      channel_slug TEXT,
      channel_key TEXT,
      routine_slug TEXT
    );
    -- The index on (channel_id, channel_key) is created in migrate(), not here.
    -- CREATE TABLE IF NOT EXISTS is a no-op against an existing table, so on an
    -- upgrade these columns do not exist yet at this point and indexing them
    -- fails — which took the server down until the migration had run.

    -- Every event pi emits is appended here. This is what makes the portal
    -- fire-and-forget: a browser that reconnects days later replays from its
    -- last seen seq instead of having missed the run entirely.
    CREATE TABLE IF NOT EXISTS canvases (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'saved',
      active_call TEXT,
      agent_read_revision INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_canvases_session ON canvases(session_id);

    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);

    -- Two-way links into the agent session. Each row is one connection
    -- (a Telegram bot, a Slack app, an inbound webhook); messages arriving on
    -- any of them go to the same agent, and its replies go back the same way.
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      -- Stable, yours to choose, and what agent sessions are keyed on. Delete a
      -- channel and recreate it under the same slug and its conversations come
      -- back; the primary key is regenerated and would not.
      slug TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      config TEXT NOT NULL DEFAULT '{}',
      -- Appended to the agent's system prompt for messages arriving here, so
      -- one door can carry standing guidance the others do not.
      instructions TEXT NOT NULL DEFAULT '',
      -- What the channel relays while the agent works, rather than only at the
      -- end. Both are per channel: a phone wants less noise than a war room.
      relay_progress INTEGER NOT NULL DEFAULT 1,
      relay_tools INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Scheduled work. Each routine owns one session, so a run can see what the
    -- last one did rather than starting blind every time.
    CREATE TABLE IF NOT EXISTS routines (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      -- Five-field cron, or one of the @shorthands. Empty for a one-off.
      schedule TEXT NOT NULL DEFAULT '',
      -- Set instead of a schedule: an ISO instant to run at, once.
      run_at TEXT,
      -- What the agent is asked to do, verbatim.
      instructions TEXT NOT NULL DEFAULT '',
      -- Start each run in a clean session instead of the routine's own.
      fresh_session INTEGER NOT NULL DEFAULT 0,
      -- Whether the injection guard's blocking rules apply to this routine's
      -- runs. On by default. Work that reads logs and then fixes what it found
      -- trips them honestly: fetching the logs taints the session, and a fix
      -- that pushes, or a grep for the word "token", is exactly what the rules
      -- exist to stop when the content is hostile.
      guard INTEGER NOT NULL DEFAULT 1,
      -- Where a run's report goes. NULL inherits the portal default; '' means
      -- this routine never reports, whatever the default is.
      report_channel TEXT,
      report_target TEXT,
      -- When a run last reached a person. Distinguishes "nothing to say" from
      -- "wrote it out and never sent it", which look identical otherwise.
      last_report_at TEXT,
      last_run TEXT,
      last_status TEXT,
      last_output TEXT,
      last_ms INTEGER,
      next_run TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Portal-wide defaults applied to every new session. Env vars are the
    -- fallback, so an untouched install still works out of the box.
    -- Who the agent talks to. Identified by the platform's own stable id,
    -- scoped by channel, because a display name is chosen by whoever types it.
    CREATE TABLE IF NOT EXISTS people (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      -- primary | colleague | guest | unknown
      role TEXT NOT NULL DEFAULT 'unknown',
      notes TEXT NOT NULL DEFAULT '',
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen TEXT,
      announced_at TEXT
    );

    -- Questions a colleague's session could not answer, waiting on the primary
    -- user. The id is short because a human types it back in a chat.
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      person_key TEXT NOT NULL,
      person_name TEXT NOT NULL DEFAULT '',
      channel_slug TEXT NOT NULL,
      channel_key TEXT NOT NULL,
      question TEXT NOT NULL,
      asked_at TEXT NOT NULL DEFAULT (datetime('now')),
      answered_at TEXT,
      answer TEXT,
      -- The exact thing the agent wants to do, when it is asking for permission
      -- rather than an opinion. Approving grants this and nothing else.
      action_tool TEXT,
      action TEXT
    );

    -- A permission granted once, for one exact action, in one conversation.
    -- Not a role change: it expires, it is used up, and it authorises the thing
    -- that was shown to the person who approved it.
    CREATE TABLE IF NOT EXISTS grants (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      subject TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      used_at TEXT
    );

    -- Things the portal said into a conversation while nobody was talking to
    -- it: a routine's report, an answer relayed back. Held until that
    -- conversation next runs, then folded into its context — otherwise the
    -- agent is asked "why did you say that?" about a message it never saw.
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      consumed_at TEXT,
      -- 1 when the person has not seen this yet: the channel could not be
      -- spoken to, so it waits and goes out with the next reply.
      pending_delivery INTEGER NOT NULL DEFAULT 0
    );

    -- Exceptions to what a non-primary role may run. Without these the only
    -- choice is read-only or full trust, and the useful middle — "colleagues may
    -- list my inbox, nothing else" — has nowhere to live.
    CREATE TABLE IF NOT EXISTS tool_rules (
      id TEXT PRIMARY KEY,
      -- colleague | guest | all (both)
      role TEXT NOT NULL,
      tool TEXT NOT NULL,
      -- Glob against the command for bash, the path for file tools.
      pattern TEXT NOT NULL,
      -- One person, when the rule came from approving their request. NULL
      -- applies to everyone holding the role, which is a much bigger thing to
      -- say and should only happen deliberately.
      person_key TEXT,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- What the guard did, and why. Refusals were going to the container log,
    -- which answers "is it working" and not "what has my agent been asked to do
    -- this week" — the question somebody actually has.
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL DEFAULT (datetime('now')),
      -- refused | allowed-by-rule | allowed-by-approval | stranger | answered
      kind TEXT NOT NULL,
      tool TEXT NOT NULL DEFAULT '',
      -- The command or path it was about, as the guard saw it.
      subject TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      person_key TEXT,
      session_id TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  migrate(db);
  return db;
}

/**
 * Migrations run in place rather than recreating the table, so existing
 * sessions and their event history survive an upgrade.
 */
function migrate(d: Database.Database): void {
  const names = (d.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map(
    (c) => c.name
  );
  if (names.includes("project") && !names.includes("workspace")) {
    d.exec("ALTER TABLE sessions RENAME COLUMN project TO workspace");
  }
  // Model and effort used to live only in the running pi process, so a restart
  // silently reverted every session to the portal defaults.
  for (const col of ["provider", "model", "thinking_level"]) {
    if (!names.includes(col)) d.exec(`ALTER TABLE sessions ADD COLUMN ${col} TEXT`);
  }
  if (!names.includes("pinned")) {
    d.exec("ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  }
  if (!names.includes("pi_session_file")) {
    d.exec("ALTER TABLE sessions ADD COLUMN pi_session_file TEXT");
  }
  // The lowest role this session has ever served. Ratchets down and never up:
  // once a guest has spoken in a conversation, the private context files stay
  // out of it even if the next message is from the primary user.
  if (!names.includes("browser")) {
    d.exec("ALTER TABLE sessions ADD COLUMN browser INTEGER NOT NULL DEFAULT 0");
  }
  if (!names.includes("last_person_key")) {
    d.exec("ALTER TABLE sessions ADD COLUMN last_person_key TEXT");
  }
  if (!names.includes("role")) {
    d.exec("ALTER TABLE sessions ADD COLUMN role TEXT NOT NULL DEFAULT 'primary'");
  }

  if (!names.includes("kind")) {
    d.exec("ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'task'");
  }
  // channel_id was the original link and was a mistake — see channel_slug.
  // There is no data worth migrating, so the old column and its sessions go.
  if (names.includes("channel_id")) {
    d.exec("DROP INDEX IF EXISTS idx_sessions_channel");
    d.exec("DELETE FROM sessions WHERE kind = 'agent'");
    d.exec("ALTER TABLE sessions DROP COLUMN channel_id");
  }
  if (!names.includes("channel_slug")) {
    d.exec("ALTER TABLE sessions ADD COLUMN channel_slug TEXT");
  }
  if (!names.includes("channel_key")) d.exec("ALTER TABLE sessions ADD COLUMN channel_key TEXT");
  if (!names.includes("routine_slug")) d.exec("ALTER TABLE sessions ADD COLUMN routine_slug TEXT");
  // The key already carries its channel's slug, so it is unique on its own.
  d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_channel_key
            ON sessions(channel_key) WHERE channel_key IS NOT NULL`);

  const channelCols = (d.prepare("PRAGMA table_info(channels)").all() as { name: string }[]).map(
    (c) => c.name
  );
  if (channelCols.length && !channelCols.includes("instructions")) {
    d.exec("ALTER TABLE channels ADD COLUMN instructions TEXT NOT NULL DEFAULT ''");
  }
  if (channelCols.length && !channelCols.includes("slug")) {
    d.exec("ALTER TABLE channels ADD COLUMN slug TEXT NOT NULL DEFAULT ''");
    // Nothing sensible to backfill from, and no data to lose.
    d.exec("DELETE FROM channels WHERE slug = ''");
  }
  if (channelCols.length && !channelCols.includes("relay_progress")) {
    d.exec("ALTER TABLE channels ADD COLUMN relay_progress INTEGER NOT NULL DEFAULT 1");
  }
  if (channelCols.length && !channelCols.includes("relay_tools")) {
    d.exec("ALTER TABLE channels ADD COLUMN relay_tools INTEGER NOT NULL DEFAULT 1");
  }
  d.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_slug ON channels(slug)");
  const routineCols = (d.prepare("PRAGMA table_info(routines)").all() as { name: string }[]).map(
    (c) => c.name
  );
  if (routineCols.length && !routineCols.includes("run_at")) {
    d.exec("ALTER TABLE routines ADD COLUMN run_at TEXT");
  }
  for (const col of ["report_channel", "report_target", "last_report_at"]) {
    if (routineCols.length && !routineCols.includes(col)) {
      d.exec(`ALTER TABLE routines ADD COLUMN ${col} TEXT`);
    }
  }
  if (routineCols.length && !routineCols.includes("guard")) {
    d.exec("ALTER TABLE routines ADD COLUMN guard INTEGER NOT NULL DEFAULT 1");
  }
  if (routineCols.length && !routineCols.includes("browser")) {
    d.exec("ALTER TABLE routines ADD COLUMN browser INTEGER NOT NULL DEFAULT 0");
  }
  d.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_routines_slug ON routines(slug)");
  d.exec("CREATE INDEX IF NOT EXISTS idx_notes_pending ON notes(session_id, consumed_at)");
  d.exec("CREATE INDEX IF NOT EXISTS idx_grants_open ON grants(session_id, tool, used_at)");
  d.exec("CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at DESC)");
  const ruleCols = (d.prepare("PRAGMA table_info(tool_rules)").all() as { name: string }[]).map(
    (c) => c.name
  );
  if (ruleCols.length && !ruleCols.includes("person_key")) {
    d.exec("ALTER TABLE tool_rules ADD COLUMN person_key TEXT");
  }
  const questionCols = (d.prepare("PRAGMA table_info(questions)").all() as { name: string }[]).map(
    (c) => c.name
  );
  for (const col of ["action_tool", "action"]) {
    if (questionCols.length && !questionCols.includes(col)) {
      d.exec(`ALTER TABLE questions ADD COLUMN ${col} TEXT`);
    }
  }
  const noteCols = (d.prepare("PRAGMA table_info(notes)").all() as { name: string }[]).map(
    (c) => c.name
  );
  if (noteCols.length && !noteCols.includes("pending_delivery")) {
    d.exec("ALTER TABLE notes ADD COLUMN pending_delivery INTEGER NOT NULL DEFAULT 0");
  }
}

export function createSession(row: {
  id: string;
  title: string;
  workspace: string;
  executor: string;
  kind?: "task" | "agent" | "routine";
  channel_slug?: string | null;
  channel_key?: string | null;
  routine_slug?: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (id, title, workspace, executor, kind, channel_slug, channel_key, routine_slug)
       VALUES (@id, @title, @workspace, @executor, @kind, @channel_slug, @channel_key, @routine_slug)`
    )
    .run({
      kind: "task",
      channel_slug: null,
      channel_key: null,
      routine_slug: null,
      ...row,
    });
}

/** The sessions you create yourself. Agent sessions have their own tab. */
export function listSessions(): SessionRow[] {
  // Pinned first, then most recently touched — the order the sidebar shows.
  return getDb()
    .prepare("SELECT * FROM sessions WHERE kind = 'task' ORDER BY pinned DESC, updated_at DESC")
    .all() as SessionRow[];
}

/** Conversations reached through a channel, newest first. */
export function listAgentSessions(): SessionRow[] {
  return getDb()
    .prepare("SELECT * FROM sessions WHERE kind = 'agent' ORDER BY updated_at DESC")
    .all() as SessionRow[];
}

export function findChannelSession(key: string): SessionRow | undefined {
  return getDb().prepare("SELECT * FROM sessions WHERE channel_key = ?").get(key) as
    | SessionRow
    | undefined;
}

/** The session a routine owns, if it has run before. */
export function findRoutineSession(slug: string): SessionRow | undefined {
  return getDb()
    .prepare("SELECT * FROM sessions WHERE routine_slug = ? AND kind = 'routine' ORDER BY created_at ASC")
    .get(slug) as SessionRow | undefined;
}

export function listRoutineSessions(slug?: string): SessionRow[] {
  const sql = slug
    ? "SELECT * FROM sessions WHERE kind = 'routine' AND routine_slug = ? ORDER BY updated_at DESC"
    : "SELECT * FROM sessions WHERE kind = 'routine' ORDER BY updated_at DESC";
  return (slug ? getDb().prepare(sql).all(slug) : getDb().prepare(sql).all()) as SessionRow[];
}

/** How many conversations a channel would strand if it were removed. */
export function countChannelSessions(slug: string): number {
  const row = getDb()
    .prepare("SELECT count(*) AS n FROM sessions WHERE channel_slug = ?")
    .get(slug) as { n: number };
  return row.n;
}

export function getSession(id: string): SessionRow | undefined {
  return getDb().prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
}

export function updateSession(
  id: string,
  fields: Partial<
    Pick<
      SessionRow,
      | "title"
      | "status"
      | "last_error"
      | "provider"
      | "model"
      | "thinking_level"
      | "pinned"
      | "pi_session_file"
    >
  >
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    values.push(v);
  }
  if (!sets.length) return;
  sets.push("updated_at = datetime('now')");
  getDb()
    .prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`)
    .run(...values, id);
}

export function deleteSession(id: string): void {
  const d = getDb();
  d.prepare("DELETE FROM canvases WHERE session_id = ?").run(id);
  d.prepare("DELETE FROM events WHERE session_id = ?").run(id);
  d.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

/**
 * When an event happened, in epoch milliseconds.
 *
 * SQLite writes `datetime('now')` as UTC with no zone marker, which JS parses
 * as local time — an hour or ten out, depending on where the portal runs. The
 * live path writes a real ISO string, so both shapes turn up in the same table.
 */
export function eventTime(createdAt: string | undefined): number | undefined {
  if (!createdAt) return undefined;
  const iso = /[Zz]|[+-]\d\d:?\d\d$/.test(createdAt)
    ? createdAt
    : createdAt.replace(" ", "T") + "Z";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

export function appendEvent(sessionId: string, type: string, payload: unknown): EventRow {
  const encodedPayload = JSON.stringify(payload);
  const info = getDb()
    .prepare("INSERT INTO events (session_id, type, payload) VALUES (?, ?, ?)")
    .run(sessionId, type, encodedPayload);
  return {
    seq: Number(info.lastInsertRowid),
    session_id: sessionId,
    type,
    payload: encodedPayload,
    created_at: new Date().toISOString(),
  };
}

/** Events after `since`, for replaying what a disconnected browser missed. */
/**
 * Where to start replaying so a session gets its own last `keep` events.
 *
 * Counted within the session, not across the table. seq is a single sequence
 * shared by every session, so "the last 20,000 seq" is "whatever this
 * conversation happened to do while the portal was busy with others" — on a
 * busy box that can be almost nothing.
 */
export function replayStart(sessionId: string, keep: number): number {
  const row = getDb()
    .prepare(
      "SELECT seq FROM events WHERE session_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?"
    )
    .get(sessionId, keep) as { seq: number } | undefined;
  return row?.seq ?? 0;
}

/** Every message the portal sent to the agent in this session, oldest first. */
export function sentMessages(sessionId: string): { seq: number; message: string }[] {
  const rows = getDb()
    .prepare("SELECT seq, payload FROM events WHERE session_id = ? AND type = 'portal_prompt' ORDER BY seq ASC")
    .all(sessionId) as { seq: number; payload: string }[];
  return rows.map((r) => ({ seq: r.seq, message: String(JSON.parse(r.payload)?.message ?? "") }));
}

/**
 * Drops a stretch of a session's transcript: `from` up to, not including, `to` — or to the end.
 * Returns what it removed, so the caller can put it back.
 */
export function deleteEventsBetween(sessionId: string, from: number, to: number | null): EventRow[] {
  const db = getDb();
  return db.transaction(() => {
    const rows = db
      .prepare("SELECT * FROM events WHERE session_id = ? AND seq >= ? AND (? IS NULL OR seq < ?) ORDER BY seq ASC")
      .all(sessionId, from, to, to) as EventRow[];
    db.prepare("DELETE FROM events WHERE session_id = ? AND seq >= ? AND (? IS NULL OR seq < ?)").run(
      sessionId,
      from,
      to,
      to,
    );
    return rows;
  })();
}

/** Puts events back under the seq they had — the inverse of deleteEventsBetween. */
export function restoreEvents(rows: EventRow[]): void {
  const db = getDb();
  const insert = db.prepare(
    "INSERT OR REPLACE INTO events (seq, session_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  db.transaction(() => {
    for (const r of rows) insert.run(r.seq, r.session_id, r.type, r.payload, r.created_at);
  })();
}

/**
 * The highest seq ever handed out, deleted events included: everything recorded
 * from now on is greater. Read from the sequence rather than the table, because
 * the newest rows may be the ones just removed.
 */
export function latestSeq(): number {
  const row = getDb().prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get() as
    | { seq: number }
    | undefined;
  return row?.seq ?? 0;
}

/** Drops one event. */
export function deleteEvent(seq: number): void {
  getDb().prepare("DELETE FROM events WHERE seq = ?").run(seq);
}

/** The page before a cursor, oldest first — what a transcript scrolls back into. */
export function eventsBefore(sessionId: string, before: number, limit = 1500): EventRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM (
         SELECT * FROM events WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?
       ) ORDER BY seq ASC`
    )
    .all(sessionId, before, limit) as EventRow[];
}

export function eventsSince(sessionId: string, since = 0, limit = 5000): EventRow[] {
  return getDb()
    .prepare(
      "SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?"
    )
    .all(sessionId, since, limit) as EventRow[];
}

/**
 * A session marked `running` at boot cannot actually be running — the process
 * that owned it died with the previous server. Mark them interrupted so the UI
 * can offer a resume instead of showing a spinner forever.
 */
export function markOrphanedSessionsInterrupted(): number {
  const info = getDb()
    .prepare(
      "UPDATE sessions SET status = 'interrupted', updated_at = datetime('now') WHERE status = 'running'"
    )
    .run();
  return info.changes;
}

// --- global settings ---

export interface GlobalSettings {
  provider: string;
  model: string;
  thinkingLevel: string;
}

/**
 * Read fresh each time rather than cached: pi's settings.json is editable from
 * the Advanced tab, and a stale copy would keep launching the old model.
 *
 * `defaultProvider` / `defaultModel` come from pi itself, so an install
 * configured through the CLI behaves the same here without being set twice.
 * "openrouter" is only the last resort, once pi has no opinion either.
 */
const SETTING_DEFAULTS = (): GlobalSettings => ({
  provider: process.env.PI_PROVIDER || piSetting("defaultProvider") || "openrouter",
  model: process.env.PI_MODEL || piSetting("defaultModel") || "",
  thinkingLevel:
    process.env.PI_THINKING_LEVEL || piSetting("defaultThinkingLevel") || "medium",
});

/** Only what the portal was explicitly told; absent keys fall through. */
export function getStoredSettings(): Partial<GlobalSettings> {
  const rows = getDb().prepare("SELECT key, value FROM settings").all() as {
    key: string;
    value: string;
  }[];
  return Object.fromEntries(
    rows.filter((r) => r.value).map((r) => [r.key, r.value])
  ) as Partial<GlobalSettings>;
}

/** What pi is actually launched with: stored, else env, else pi's file. */
export function getSettings(): GlobalSettings {
  const stored = getStoredSettings();
  const defaults = SETTING_DEFAULTS();
  return {
    provider: stored.provider || defaults.provider,
    model: stored.model || defaults.model,
    thinkingLevel: stored.thinkingLevel || defaults.thinkingLevel,
  };
}

export { SETTING_DEFAULTS as getSettingDefaults };

/**
 * An empty value clears the override rather than storing "", so a field can be
 * handed back to pi's own defaults instead of being pinned forever.
 */
export function setSettings(patch: Partial<GlobalSettings>): GlobalSettings {
  const upsert = getDb().prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  const clear = getDb().prepare("DELETE FROM settings WHERE key = ?");
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v !== "string") continue;
    if (v.trim()) upsert.run(k, v.trim());
    else clear.run(k);
  }
  return getSettings();
}

/** Where reports go when a routine does not name a destination of its own. */
export interface ReportTo {
  channel: string;
  target: string;
}

export function getDefaultReportTo(): ReportTo | null {
  const stored = getStoredSettings() as Record<string, string>;
  const channel = stored.report_channel;
  const target = stored.report_target;
  return channel && target ? { channel, target } : null;
}

export function setDefaultReportTo(to: ReportTo | null): void {
  const upsert = getDb().prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  const clear = getDb().prepare("DELETE FROM settings WHERE key = ?");
  if (!to) {
    clear.run("report_channel");
    clear.run("report_target");
    return;
  }
  upsert.run("report_channel", to.channel);
  upsert.run("report_target", to.target);
}

/** Something the portal said into a conversation, waiting to join its context. */
export function addNote(sessionId: string, text: string, pendingDelivery = false): void {
  getDb()
    .prepare("INSERT INTO notes (session_id, text, pending_delivery) VALUES (?, ?, ?)")
    .run(sessionId, text, pendingDelivery ? 1 : 0);
}

/**
 * Messages the person has not seen, because their channel cannot be spoken to.
 *
 * Reading them hands over responsibility for delivering them, so they are only
 * taken at the point they are about to go out with a reply.
 */
export function takeDeliveries(sessionId: string): string[] {
  const rows = getDb()
    .prepare("SELECT id, text FROM notes WHERE session_id = ? AND pending_delivery = 1 ORDER BY id ASC")
    .all(sessionId) as { id: number; text: string }[];
  const mark = getDb().prepare("UPDATE notes SET pending_delivery = 0 WHERE id = ?");
  for (const r of rows) mark.run(r.id);
  return rows.map((r) => r.text);
}

/** Take the pending notes for a conversation. Reading them consumes them. */
export function takeNotes(sessionId: string): string[] {
  const rows = getDb()
    .prepare("SELECT id, text FROM notes WHERE session_id = ? AND consumed_at IS NULL ORDER BY id ASC")
    .all(sessionId) as { id: number; text: string }[];
  if (!rows.length) return [];
  const mark = getDb().prepare("UPDATE notes SET consumed_at = datetime('now') WHERE id = ?");
  for (const r of rows) mark.run(r.id);
  return rows.map((r) => r.text);
}

export interface ToolRule {
  id: string;
  role: string;
  tool: string;
  pattern: string;
  /** Null applies to the whole role; set narrows it to one person. */
  person_key: string | null;
  note: string;
  created_at: string;
}

export const listToolRules = (): ToolRule[] =>
  getDb().prepare("SELECT * FROM tool_rules ORDER BY tool, pattern").all() as ToolRule[];

export function addToolRule(rule: Omit<ToolRule, "created_at" | "person_key"> & { person_key?: string | null }): void {
  getDb()
    .prepare(
      "INSERT INTO tool_rules (id, role, tool, pattern, note, person_key) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(rule.id, rule.role, rule.tool, rule.pattern, rule.note, rule.person_key ?? null);
}

export const deleteToolRule = (id: string): void => {
  getDb().prepare("DELETE FROM tool_rules WHERE id = ?").run(id);
};

/** How long an approval stays good. Long enough to act on, short enough to forget. */
const GRANT_MINUTES = 15;

export function addGrant(id: string, sessionId: string, tool: string, subject: string): void {
  getDb()
    .prepare("INSERT INTO grants (id, session_id, tool, subject, expires_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, sessionId, tool, subject, new Date(Date.now() + GRANT_MINUTES * 60_000).toISOString());
}

/**
 * Spend a matching approval, if one is open.
 *
 * Matched on the exact subject that was shown to whoever approved it: they said
 * yes to a command they read, so a different command is a different question.
 * Marked used in the same breath, because an approval is for one act.
 */
export function useGrant(sessionId: string, tool: string, subject: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT id FROM grants
       WHERE session_id = ? AND tool = ? AND subject = ? AND used_at IS NULL AND expires_at > ?
       ORDER BY created_at ASC LIMIT 1`
    )
    .get(sessionId, tool, subject, new Date().toISOString()) as { id: string } | undefined;
  if (!row) return false;
  getDb().prepare("UPDATE grants SET used_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
  return true;
}

export interface AuditRow {
  id: number;
  at: string;
  kind: string;
  tool: string;
  subject: string;
  reason: string;
  person_key: string | null;
  session_id: string | null;
}

/** Keeps the log from growing without bound; old entries are not evidence. */
const AUDIT_KEEP = 2000;

export function recordAudit(entry: {
  kind: string;
  tool?: string;
  subject?: string;
  reason?: string;
  personKey?: string | null;
  sessionId?: string | null;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO audit (kind, tool, subject, reason, person_key, session_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    entry.kind,
    entry.tool ?? "",
    (entry.subject ?? "").slice(0, 2000),
    entry.reason ?? "",
    entry.personKey ?? null,
    entry.sessionId ?? null
  );
  db.prepare(
    `DELETE FROM audit WHERE id <= (SELECT MAX(id) FROM audit) - ?`
  ).run(AUDIT_KEEP);
}

export const listAudit = (limit = 200): AuditRow[] =>
  getDb().prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(limit) as AuditRow[];

/** Does this routine's runs get the guard's blocking rules? Unknown means yes. */
export function routineGuards(slug: string | null | undefined): boolean {
  if (!slug) return true;
  const row = getDb().prepare("SELECT guard FROM routines WHERE slug = ?").get(slug) as
    | { guard: number }
    | undefined;
  return row ? row.guard === 1 : true;
}

/** Does this session get the browser? Routines answer for their own runs. */
export function browserAllowed(session: SessionRow): boolean {
  if (session.kind === "routine" && session.routine_slug) {
    const row = getDb().prepare("SELECT browser FROM routines WHERE slug = ?").get(
      session.routine_slug
    ) as { browser: number } | undefined;
    return row ? row.browser === 1 : false;
  }
  return session.browser === 1;
}

/**
 * Domains the browser may be pointed at, as globs. Empty means no restriction —
 * the on/off switch is the gate, and a list nobody filled in should not quietly
 * block everything.
 */
export function browserAllowlist(): string[] {
  const raw = (getStoredSettings() as Record<string, string>).browser_allowlist ?? "";
  return raw
    .split(/[\n,]/)
    .map((d) => d.trim())
    .filter(Boolean);
}

export function setBrowserAllowlist(domains: string): void {
  const upsert = getDb().prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  upsert.run("browser_allowlist", domains.trim());
}
