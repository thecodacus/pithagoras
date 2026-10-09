import Database from "better-sqlite3";
import { inTurnWithSettings, piSetting, readPiSettings, readProjectPiSettings } from "./pi-settings.js";
import { packageIndex, packageKey, packageLabel, toolAvailability } from "./extension-switch.js";
import { EDIT_IMAGE_SOURCE, EDIT_IMAGE_TOOL, GENERATE_IMAGE_SOURCE, GENERATE_IMAGE_TOOL, SHOW_IMAGE_SOURCE, imageEditingReady, imageGenerationReady } from "./image-generation.js";
import { PORTAL_BROWSER_TOOLS, browserTool, defaultsFor, mcpServerOf, toolEnabled } from "./tool-policy.js";
import { projectOf } from "./workspaces.js";
import { browserServers, dropMcpCache, mcpAdapter, mcpCachePath, mcpConfigPath, mcpServerNames, onMcpWritten, readMcpCache, readMcpFile, readableMcpConfig, serversAndBrowsers } from "./api/mcp.js";
import { mcpCatalogue, mcpOffer, unlisted, type McpOffer } from "./mcp-offer.js";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { isWithinText } from "./within.js";
import { agentHome, agentHomePath, homeAgentName } from "./agent-home.js";
import { DATA_DIR } from "./data-dir.js";
import { EXECUTOR_KIND } from "./executor-kind.js";
import { RUNS_AS_PRIMARY } from "./pi/runs-as-primary.js";
import { SCHEMA_VERSION, dbFile } from "./schema-version.js";

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
  /**
   * 1 while the chat is still waiting to be named after its first message.
   * A flag rather than a look at the title: a chat somebody calls "New chat" on
   * purpose is theirs, and is not renamed.
   */
  auto_title: number;
  /** pi's own session file, so the exact conversation is reopened on restart. */
  pi_session_file: string | null;
  /** How often its events were put back under seqs pages had read past: see bumpReloads. */
  reloads?: number;
  /**
   * "task" for the ones you create here, "agent" for one reached through a
   * channel, "routine" for one a schedule owns.
   */
  kind: "task" | "agent" | "routine" | "heartbeat";
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
  /** Tools switched off for this conversation, newline separated. */
  tools_off: string;
  /** And switched on against a default that has them off. */
  tools_on: string;
}

/**
 * The slug of the conversations started on the Agent page: the portal's own,
 * not a channel's. No channel can take it (see the channel routes).
 */
export const BROWSER_CHANNEL = "browser";

/**
 * Whether the conversation came in through a channel, where somebody else may
 * be speaking, and not from the portal's own pages, where the owner is signed in.
 */
export const onChannel = (row: Pick<SessionRow, "channel_slug"> | undefined): boolean =>
  Boolean(row?.channel_slug) && row?.channel_slug !== BROWSER_CHANNEL;

export interface EventRow {
  seq: number;
  session_id: string;
  type: string;
  payload: string;
  created_at: string;
}

let db: Database.Database | null = null;


export function getDb(): Database.Database {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(dbFile());
  db.pragma("journal_mode = WAL");
  // All of it or none: a failure part way leaves the database as it was, at
  // its old version, rather than half changed and marked done.
  db.transaction(() => schema(db!))();
  return db;
}

function schema(db: Database.Database): void {
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
      auto_title INTEGER NOT NULL DEFAULT 0,
      pi_session_file TEXT,
      kind TEXT NOT NULL DEFAULT 'task',
      channel_slug TEXT,
      channel_key TEXT,
      routine_slug TEXT,
      reloads INTEGER NOT NULL DEFAULT 0
    );
    -- The index on channel_key is created in migrate(), not here.
    -- CREATE TABLE IF NOT EXISTS is a no-op against an existing table, so on an
    -- upgrade these columns do not exist yet at this point and indexing them
    -- fails — which took the server down until the migration had run.

    CREATE TABLE IF NOT EXISTS canvases (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'saved',
      active_call TEXT,
      agent_read_revision INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      -- The text from before a write that is going on, or was cut off: see restoreCanvas.
      previous_content TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_canvases_session ON canvases(session_id);

    -- Every event pi emits is appended here. This is what makes the portal
    -- fire-and-forget: a browser that reconnects days later replays from its
    -- last seen seq instead of having missed the run entirely.
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);

    -- The other versions of a message: what followed a message that was
    -- edited or sent again, kept so the page can switch back to it. Each row
    -- is one branch not shown now — its events, and pi's file as it was —
    -- after the message sent at seq "anchor" (0: the first message). "seq"
    -- is the branch's own first message, which orders it among the others.
    -- Of pi's file only what differs from the conversation it went on from:
    -- "file" is the rest after its first "file_prefix" characters, which
    -- hash to "prefix_hash"; a switch checks that start is still the same.
    CREATE TABLE IF NOT EXISTS message_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      anchor INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      rows TEXT NOT NULL,
      file TEXT,
      file_prefix INTEGER,
      prefix_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_message_versions ON message_versions(session_id, anchor);

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
      agent_id TEXT NOT NULL DEFAULT '',
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
      announced_at TEXT,
      -- 1 once somebody here chose the name: the platform's own no longer replaces it
      renamed INTEGER NOT NULL DEFAULT 0
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

    -- Portal-wide defaults applied to every new session. Env vars are the
    -- fallback, so an untouched install still works out of the box.
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- A project's exceptions to the portal-wide tool default, between that and
    -- a chat's own. Kept here and not as a file in the folder: the agent works
    -- in the folder and can write to it, and which tools it has is not
    -- something it should be able to give itself back. A project is only a
    -- folder, so it is known by its name; a row exists only while it says
    -- something, and goes with the project.
    CREATE TABLE IF NOT EXISTS project_tools (
      project TEXT PRIMARY KEY,
      tools_off TEXT NOT NULL DEFAULT '',
      tools_on TEXT NOT NULL DEFAULT ''
    );

    -- An agent's exceptions to the portal-wide tool default, for every chat in
    -- its home and every run it does on its own: the first layer above the
    -- default. Here for the same reason as a project's: the agent can write to
    -- its home, and must not be able to give itself tools back.
    CREATE TABLE IF NOT EXISTS agent_tools (
      agent TEXT PRIMARY KEY,
      tools_off TEXT NOT NULL DEFAULT '',
      tools_on TEXT NOT NULL DEFAULT ''
    );

    -- Background subagents started and not yet ended, kept as their events
    -- are written: what a server that went left open is read from here at
    -- start, not dug out of every event there ever was.
    CREATE TABLE IF NOT EXISTS open_subagents (
      session_id TEXT NOT NULL,
      id TEXT NOT NULL,
      PRIMARY KEY (session_id, id)
    );

    -- The pictures of the Images page: the ones it made itself, which are files
    -- in the portal's own images folder, the ones the agent made in a chat with
    -- generate_image or edit_image, which are files in that chat's folder and
    -- are listed here as they are made, and those found lying in a folder the
    -- tools write into that nobody listed (see image-gallery.ts). A row names
    -- the file, never holds it; one whose file is gone is dropped when the
    -- page next looks, and a chat's stay with its folder when the chat goes,
    -- as pictures found there. "path" is a file name in
    -- the images folder for the page's, and a path from the folder for the
    -- agent's: from the chat's, or, for one that was found, from "folder", the
    -- real path of the folder it was found in. "params" is what the request
    -- was made with, as JSON.
    CREATE TABLE IF NOT EXISTS images (
      id TEXT PRIMARY KEY,
      origin TEXT NOT NULL,
      session_id TEXT,
      folder TEXT,
      path TEXT NOT NULL,
      kind TEXT NOT NULL,
      prompt TEXT NOT NULL DEFAULT '',
      params TEXT NOT NULL DEFAULT '{}',
      source_id TEXT,
      bytes INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_images_created ON images(created_at DESC, id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_images_chat_file ON images(session_id, path) WHERE session_id IS NOT NULL;

    -- The voices saved in the settings, for speech to be told to sound like (see voice-presets.ts).
    CREATE TABLE IF NOT EXISTS voice_presets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      instruction TEXT NOT NULL,
      transcript TEXT NOT NULL,
      audio BLOB
    );

    -- Logins signed out before they ran out, by the signature of their cookie.
    -- The cookie carries no state of its own, so without this a copy of one
    -- would go on working for the rest of its thirty days.
    CREATE TABLE IF NOT EXISTS signed_out (
      mac TEXT PRIMARY KEY,
      -- When the cookie would have stopped working anyway; past it, the row goes.
      expires INTEGER NOT NULL
    );

    -- The agents: each a home folder of its own, with its own SOUL.md,
    -- PrimaryUser.md and MEMORY.md, so its own personality and memory. A chat
    -- is an agent's when it works in that agent's home. The first is the Home
    -- there always was, where it always was.
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      home TEXT NOT NULL UNIQUE,
      -- Its avatar, as JSON: NULL is the default orb.
      orb TEXT,
      -- The voice it speaks with in voice mode: a voice library id or 'design';
      -- NULL is the one chosen in the voice settings.
      voice TEXT,
      -- Its heartbeat: how often it looks around on its own, in minutes (NULL
      -- is never), the hours it keeps quiet ('HH:MM', both or neither), and how
      -- the last look went.
      heartbeat_minutes INTEGER,
      quiet_start TEXT,
      quiet_end TEXT,
      last_heartbeat TEXT,
      heartbeat_status TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- What an agent noticed on its own, for the person it works for to read.
    CREATE TABLE IF NOT EXISTS activity (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_id TEXT,
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      at TEXT NOT NULL DEFAULT (datetime('now')),
      read_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_activity_agent ON activity(agent_id, at DESC);
  `);
  migrate(db);
  if ((db.pragma("user_version", { simple: true }) as number) < SCHEMA_VERSION) db.pragma(`user_version = ${SCHEMA_VERSION}`);
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
  // Existing chats have their names already, so they default to none pending.
  if (!names.includes("auto_title")) {
    d.exec("ALTER TABLE sessions ADD COLUMN auto_title INTEGER NOT NULL DEFAULT 0");
  }
  if (!names.includes("pi_session_file")) {
    d.exec("ALTER TABLE sessions ADD COLUMN pi_session_file TEXT");
  }
  if (!names.includes("browser")) {
    d.exec("ALTER TABLE sessions ADD COLUMN browser INTEGER NOT NULL DEFAULT 0");
  }
  if (!names.includes("last_person_key")) {
    d.exec("ALTER TABLE sessions ADD COLUMN last_person_key TEXT");
  }
  // The lowest role this session has ever served. Ratchets down and never up:
  // once a guest has spoken in a conversation, the private context files stay
  // out of it even if the next message is from the primary user.
  if (!names.includes("role")) {
    d.exec("ALTER TABLE sessions ADD COLUMN role TEXT NOT NULL DEFAULT 'primary'");
  }
  // Tools switched off for this conversation, by name, newline separated.
  // Stored as the exceptions rather than the allowed set: a tool installed
  // after the choice was made is on, which is what "off" was never said about.
  if (!names.includes("tools_off")) {
    d.exec("ALTER TABLE sessions ADD COLUMN tools_off TEXT NOT NULL DEFAULT ''");
  }
  // And the ones switched back on against a default that has them off. Two
  // lists rather than one, because a conversation holds exceptions to the
  // default and an exception runs in both directions.
  if (!names.includes("tools_on")) {
    d.exec("ALTER TABLE sessions ADD COLUMN tools_on TEXT NOT NULL DEFAULT ''");
  }

  // How often the chat's events were put back under seqs pages had read past:
  // a page that last saw another count loads the chat again. See bumpReloads.
  if (!names.includes("reloads")) {
    d.exec("ALTER TABLE sessions ADD COLUMN reloads INTEGER NOT NULL DEFAULT 0");
  }
  // Versions kept before pi's file was kept as the part after a checked start:
  // one could not tell whether the conversation it would go back to was still
  // there. Only ever on a test deploy; and the reload markers stored then.
  const versionCols = (d.prepare("PRAGMA table_info(message_versions)").all() as { name: string }[]).map((c) => c.name);
  if (versionCols.length && !versionCols.includes("prefix_hash")) {
    d.exec("ALTER TABLE message_versions ADD COLUMN file_prefix INTEGER");
    d.exec("ALTER TABLE message_versions ADD COLUMN prefix_hash TEXT");
    d.exec("DELETE FROM message_versions");
    d.exec("DELETE FROM events WHERE type = 'portal_reload'");
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
  // The agent a channel talks as. Empty is the first agent, as every channel was before there were others.
  if (channelCols.length && !channelCols.includes("agent_id")) {
    d.exec("ALTER TABLE channels ADD COLUMN agent_id TEXT NOT NULL DEFAULT ''");
  }
  d.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_slug ON channels(slug)");
  // A name set by hand used to be told by there being notes beside it; those keep it.
  const peopleCols = (d.prepare("PRAGMA table_info(people)").all() as { name: string }[]).map((c) => c.name);
  if (peopleCols.length && !peopleCols.includes("renamed")) {
    d.exec("ALTER TABLE people ADD COLUMN renamed INTEGER NOT NULL DEFAULT 0");
    d.exec("UPDATE people SET renamed = 1 WHERE notes != ''");
  }
  // The text from before a write, kept until the write has ended (see canvases.ts).
  const canvasCols = (d.prepare("PRAGMA table_info(canvases)").all() as { name: string }[]).map((c) => c.name);
  if (canvasCols.length && !canvasCols.includes("previous_content")) {
    d.exec("ALTER TABLE canvases ADD COLUMN previous_content TEXT");
  }
  const agentCols = (d.prepare("PRAGMA table_info(agents)").all() as { name: string }[]).map((c) => c.name);
  for (const col of ["voice", "quiet_start", "quiet_end", "last_heartbeat", "heartbeat_status"]) {
    if (!agentCols.includes(col)) d.exec(`ALTER TABLE agents ADD COLUMN ${col} TEXT`);
  }
  if (!agentCols.includes("heartbeat_minutes")) d.exec("ALTER TABLE agents ADD COLUMN heartbeat_minutes INTEGER");
  // The Home there always was is the first agent, named as its SOUL.md names
  // it, and wearing the avatar the portal had.
  if (!d.prepare("SELECT 1 FROM agents LIMIT 1").get()) {
    const orb = d.prepare("SELECT value FROM settings WHERE key = 'orb'").get() as { value: string } | undefined;
    d.prepare("INSERT INTO agents (id, name, home, orb) VALUES ('home', ?, ?, ?)").run(homeAgentName(agentHomePath()), agentHomePath(), orb?.value ?? null);
    d.prepare("DELETE FROM settings WHERE key = 'orb'").run();
  }
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
  // Where a routine's runs happen: NULL for Home, else a project's directory.
  if (routineCols.length && !routineCols.includes("workspace")) {
    d.exec("ALTER TABLE routines ADD COLUMN workspace TEXT");
    // Until now every run was in Home, so every routine session is a Home one.
    // A routine finds its session by place from here on, so one made under an
    // earlier AGENT_HOME is moved to where Home is now rather than lost.
    // Home is asked for only when there is one to move: a new database has none.
    const runs = d.prepare("SELECT count(*) AS n FROM sessions WHERE kind = 'routine'").get() as { n: number };
    if (runs.n) d.prepare("UPDATE sessions SET workspace = ? WHERE kind = 'routine'").run(agentHome());
  }
  if (routineCols.length && !routineCols.includes("browser")) {
    d.exec("ALTER TABLE routines ADD COLUMN browser INTEGER NOT NULL DEFAULT 0");
  }
  // A routine's exceptions to what its agent and project leave, as a chat keeps
  // them. The `browser` column above stays: it answers for the browser's tools
  // where these say nothing about them (see routineTools).
  // Each on its own, as for sessions: a database with one of them is given the other.
  for (const col of ["tools_off", "tools_on"]) {
    if (routineCols.length && !routineCols.includes(col)) d.exec(`ALTER TABLE routines ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
  }
  d.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_routines_slug ON routines(slug)");
  // Where a picture that was found in a folder lies (see image-gallery.ts). The
  // gallery was first kept without it, and CREATE TABLE above leaves such a table as it is.
  const imageCols = (d.prepare("PRAGMA table_info(images)").all() as { name: string }[]).map((c) => c.name);
  if (imageCols.length && !imageCols.includes("folder")) d.exec("ALTER TABLE images ADD COLUMN folder TEXT");
  d.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_images_folder_file ON images(folder, path) WHERE folder IS NOT NULL");
  // What was made of a picture, looked for whenever a picture is forgotten: without it each of them is a pass over the whole gallery.
  d.exec("CREATE INDEX IF NOT EXISTS idx_images_source ON images(source_id) WHERE source_id IS NOT NULL");
  d.exec("CREATE INDEX IF NOT EXISTS idx_notes_pending ON notes(session_id, consumed_at)");
  d.exec("CREATE INDEX IF NOT EXISTS idx_grants_open ON grants(session_id, tool, used_at)");
  d.exec("CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at DESC)");
  // Messages sent into a run, and what settled them. Looked for across every
  // chat at startup (unsettledMessages) and through a whole chat by every
  // edit: the few among tens of thousands of events per chat, read without
  // reading the rest. A query finds them only by repeating the same WHERE.
  d.exec(
    `CREATE INDEX IF NOT EXISTS idx_events_queued ON events(session_id, seq)
       WHERE type = 'portal_prompt' AND json_extract(payload, '$.queued') = 1`,
  );
  d.exec(
    `CREATE INDEX IF NOT EXISTS idx_events_settled ON events(session_id, seq)
       WHERE type IN ('portal_taken', 'portal_unsent')`,
  );
  // The messages a chat has sent, listed when its stream opens and for every edit: see sentMessages.
  d.exec(
    `CREATE INDEX IF NOT EXISTS idx_events_prompts ON events(session_id, seq)
       WHERE type = 'portal_prompt'`,
  );
  // Commands and their ends, looked for at startup: see unansweredCommands.
  d.exec(
    `CREATE INDEX IF NOT EXISTS idx_events_commands ON events(session_id, seq)
       WHERE type IN ('portal_command', 'portal_command_end')`,
  );
  const ruleCols = (d.prepare("PRAGMA table_info(tool_rules)").all() as { name: string }[]).map(
    (c) => c.name
  );
  if (ruleCols.length && !ruleCols.includes("person_key")) {
    d.exec("ALTER TABLE tool_rules ADD COLUMN person_key TEXT");
  }
  // A rule for a tool that runs as the primary user never applies now, and the API refuses to make one. Those an older
  // version made would stay listed as working: dropped, but for a heartbeat's own.
  const asPrimary = Object.keys(RUNS_AS_PRIMARY);
  d.prepare(`DELETE FROM tool_rules WHERE role != 'heartbeat' AND tool IN (${asPrimary.map(() => "?").join(", ")})`).run(...asPrimary);
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
  // Last, because it reads the settings the tables above have to exist for.
  adoptBrowserGrants(d);
}

export function createSession(row: {
  id: string;
  title: string;
  workspace: string;
  executor: string;
  kind?: "task" | "agent" | "routine" | "heartbeat";
  channel_slug?: string | null;
  channel_key?: string | null;
  routine_slug?: string | null;
  auto_title?: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (id, title, workspace, executor, kind, channel_slug, channel_key, routine_slug, auto_title)
       VALUES (@id, @title, @workspace, @executor, @kind, @channel_slug, @channel_key, @routine_slug, @auto_title)`
    )
    .run({
      kind: "task",
      auto_title: 0,
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

/**
 * The chats the sidebar lists: the tasks, and the conversations started on the
 * Agent page, which are chats with that agent like any other. Those that came
 * through a channel stay on the Agent page.
 */
export function listChatSessions(): SessionRow[] {
  return getDb()
    .prepare("SELECT * FROM sessions WHERE kind = 'task' OR (kind = 'agent' AND channel_slug = ?) ORDER BY pinned DESC, updated_at DESC")
    .all(BROWSER_CHANNEL) as SessionRow[];
}

/** Whether any session has a turn running. */
export function anySessionRunning(): boolean {
  return Boolean(getDb().prepare("SELECT 1 FROM sessions WHERE status = 'running' LIMIT 1").get());
}

/** The sessions agents look around in on their own: one per agent, see heartbeat.ts. */
export function listHeartbeatSessions(): SessionRow[] {
  return getDb().prepare("SELECT * FROM sessions WHERE kind = 'heartbeat'").all() as SessionRow[];
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

/**
 * The session a routine owns in `workspace`, if it has run there before. One
 * per place: moved to a project and back, it picks up its Home history again.
 */
export function findRoutineSession(slug: string, workspace: string): SessionRow | undefined {
  return getDb()
    .prepare("SELECT * FROM sessions WHERE routine_slug = ? AND kind = 'routine' AND workspace = ? ORDER BY created_at ASC")
    .get(slug, workspace) as SessionRow | undefined;
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
      | "auto_title"
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

// One transaction: the chat of a delete that failed stays, and it takes messages again, so it must still have its transcript and canvases.
// Inside the bulk routes' own transaction this is a savepoint, so they still remove all of their chats or none.
export const deleteSession = (id: string): void => getDb().transaction(() => removeSession(id))();

function removeSession(id: string): void {
  const d = getDb();
  const folder = (d.prepare("SELECT workspace FROM sessions WHERE id = ?").get(id) as { workspace: string } | undefined)?.workspace;
  d.prepare("DELETE FROM canvases WHERE session_id = ?").run(id);
  d.prepare("DELETE FROM events WHERE session_id = ?").run(id);
  d.prepare("DELETE FROM message_versions WHERE session_id = ?").run(id);
  d.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  setSessionSubagentModel(id, null);
  d.prepare("DELETE FROM open_subagents WHERE session_id = ?").run(id);
  d.prepare("DELETE FROM settings WHERE key = ?").run(trustedKey(id));
  // The pictures stay in the chat's folder, which is not the chat's to take away, and so they stay in the gallery, as pictures of that folder with what they were asked for.
  // Nothing else may name the folder once the chat is gone, so it is kept with them (see image-gallery.ts).
  let real: string | undefined;
  try {
    real = folder ? realpathSync(folder) : undefined;
  } catch {
    // A folder that cannot be reached is not one to keep pictures of: there is nothing to find them in.
  }
  if (real) d.prepare("UPDATE OR IGNORE images SET origin = 'folder', folder = ?, session_id = NULL WHERE session_id = ?").run(real, id);
  // What is left is what could not be kept, and what was made of it no longer names it.
  d.prepare("UPDATE images SET source_id = NULL WHERE source_id IN (SELECT id FROM images WHERE session_id = ?)").run(id);
  d.prepare("DELETE FROM images WHERE session_id = ?").run(id);
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
  // To the millisecond, and the same time live and after a reload: SQLite's
  // own default keeps whole seconds, and a call timed from it took 0.1s or
  // 1.0s depending on where the seconds fell.
  const createdAt = new Date().toISOString();
  const info = getDb()
    .prepare("INSERT INTO events (session_id, type, payload, created_at) VALUES (?, ?, ?, ?)")
    .run(sessionId, type, encodedPayload, createdAt);
  if (type === "portal_subagent") noteOpenSubagent(sessionId, payload);
  return {
    seq: Number(info.lastInsertRowid),
    session_id: sessionId,
    type,
    payload: encodedPayload,
    created_at: createdAt,
  };
}

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

/**
 * Where each message sent into a run was settled, by the seq it was sent at:
 * the portal_taken that put it into the conversation, or the portal_unsent
 * that dropped it. One missing from both is still waiting.
 */
function settledAt(sessionId: string): { taken: Map<number, number>; unsent: Map<number, number> } {
  const taken = new Map<number, number>();
  const unsent = new Map<number, number>();
  const rows = getDb()
    .prepare("SELECT seq, type, payload FROM events WHERE session_id = ? AND type IN ('portal_taken', 'portal_unsent')")
    .all(sessionId) as { seq: number; type: string; payload: string }[];
  for (const r of rows) {
    const p = JSON.parse(r.payload) ?? {};
    if (r.type === "portal_taken") taken.set(Number(p.seq), r.seq);
    else if (Array.isArray(p.seqs)) for (const seq of p.seqs) unsent.set(Number(seq), r.seq);
  }
  return { taken, unsent };
}

/**
 * Where an event sits in the conversation.
 *
 * Its own seq, except for a message sent into a run: that one was written down
 * when it was sent, in the middle of a reply, and read by the agent later — so
 * it sits where it was taken in or dropped, which is where the transcript
 * shows it. One still waiting sits after everything.
 */
function placeOf(
  row: { seq: number; type: string; payload: string },
  settled: ReturnType<typeof settledAt>,
): number {
  // A command's end is where its command is: taken out with it, and kept
  // with one that stays, when the end fell among what is taken out.
  if (row.type === "portal_command_end") {
    const of = (JSON.parse(row.payload) ?? {}).of;
    return typeof of === "number" ? of : row.seq;
  }
  if (row.type !== "portal_prompt" || !(JSON.parse(row.payload) ?? {}).queued) return row.seq;
  return settled.taken.get(row.seq) ?? settled.unsent.get(row.seq) ?? Number.POSITIVE_INFINITY;
}

/** Whether the agent has answered in a chat: there is a conversation of its own to lose. */
export function hasAnswer(sessionId: string): boolean {
  return Boolean(
    getDb()
      .prepare("SELECT 1 FROM events WHERE session_id = ? AND type = 'message_end' AND json_extract(payload, '$.message.role') = 'assistant' LIMIT 1")
      .get(sessionId),
  );
}

/**
 * Every message the portal sent to the agent in this session, in the order the
 * agent read them — which is the order of pi's file. `at` is where each sits in
 * the transcript: see placeOf.
 */
export function sentMessages(
  sessionId: string,
): { seq: number; at: number; message: string; payload: Record<string, unknown> }[] {
  const rows = getDb()
    .prepare("SELECT seq, type, payload FROM events WHERE session_id = ? AND type = 'portal_prompt' ORDER BY seq ASC")
    .all(sessionId) as { seq: number; type: string; payload: string }[];
  const settled = settledAt(sessionId);
  // One sent mid-run and stopped before pi took it in never reached pi's
  // file, and counted here it would put every later message one out.
  return rows
    .filter((r) => !settled.unsent.has(r.seq))
    .map((r) => {
      const payload = JSON.parse(r.payload) ?? {};
      return { seq: r.seq, at: placeOf(r, settled), message: String(payload.message ?? ""), payload };
    })
    .sort((a, b) => a.at - b.at || a.seq - b.seq);
}

/**
 * Messages sent into a run that were neither taken in nor dropped: what a
 * server that died mid-run left behind. By session, oldest first, each with
 * the payload it was sent with.
 *
 * Read once at startup, so in two passes that each read a row once — the
 * queued messages, then what settled them in the sessions that have any —
 * rather than a lookup through a session's events per message.
 */
export function unsettledMessages(): {
  sessionId: string;
  seq: number;
  message: string;
  images: number;
  prompt: Record<string, unknown>;
}[] {
  const rows = getDb()
    .prepare(
      `SELECT session_id, seq, payload FROM events
       WHERE type = 'portal_prompt' AND json_extract(payload, '$.queued') = 1
       ORDER BY session_id, seq`,
    )
    .all() as { session_id: string; seq: number; payload: string }[];
  const settled = new Map<string, ReturnType<typeof settledAt>>();
  const out: ReturnType<typeof unsettledMessages> = [];
  for (const r of rows) {
    if (!settled.has(r.session_id)) settled.set(r.session_id, settledAt(r.session_id));
    const { taken, unsent } = settled.get(r.session_id)!;
    if (taken.has(r.seq) || unsent.has(r.seq)) continue;
    const prompt = JSON.parse(r.payload) ?? {};
    out.push({
      sessionId: r.session_id,
      seq: r.seq,
      message: String(prompt.message ?? ""),
      images: Array.isArray(prompt.images) ? prompt.images.length : 0,
      prompt,
    });
  }
  return out;
}

/**
 * Commands no end was written for. "type IN (…)" is repeated from
 * idx_events_commands, or SQLite does not see that the index covers the
 * query, and reads the whole table twice; ordered as the index is, or it reads
 * the table in seq order to spare itself a sort.
 */
export const UNANSWERED_COMMANDS = `SELECT session_id, seq FROM events
       WHERE type IN ('portal_command', 'portal_command_end') AND type = 'portal_command'
         AND seq NOT IN (
           -- Not one NULL among them: NOT IN a list holding one matches nothing.
           SELECT json_extract(payload, '$.of') FROM events
           WHERE type IN ('portal_command', 'portal_command_end') AND type = 'portal_command_end'
             AND json_extract(payload, '$.of') IS NOT NULL
         )
       ORDER BY session_id, seq`;

/**
 * Commands a server that died left unanswered, with the reason each threw
 * before it did, where pi said so. Found by SQL, from the commands and their
 * ends alone: see idx_events_commands.
 */
export function unansweredCommands(): { sessionId: string; seq: number; error?: string }[] {
  const rows = getDb().prepare(UNANSWERED_COMMANDS).all() as { session_id: string; seq: number }[];
  // Its own failure, marked as its own: not the next one of the same name.
  const threw = getDb().prepare(
    `SELECT json_extract(payload, '$.reason') AS reason FROM events
     WHERE session_id = ? AND seq > ? AND type = 'portal_notice' AND json_extract(payload, '$.of') = ?
     LIMIT 1`,
  );
  return rows.map((r) => {
    const found = threw.get(r.session_id, r.seq, r.seq) as { reason: unknown } | undefined;
    return { sessionId: r.session_id, seq: r.seq, ...(found?.reason != null ? { error: String(found.reason) } : {}) };
  });
}

/** One message the portal sent to the agent, by its seq, or undefined if that is not one. */
export function sentMessage(
  sessionId: string,
  seq: number,
): { seq: number; message: string; payload: Record<string, unknown> } | undefined {
  const row = getDb()
    .prepare("SELECT payload FROM events WHERE session_id = ? AND seq = ? AND type = 'portal_prompt'")
    .get(sessionId, seq) as { payload: string } | undefined;
  if (!row) return undefined;
  const payload = JSON.parse(row.payload) ?? {};
  return { seq, message: String(payload.message ?? ""), payload };
}

/**
 * Drops a stretch of a session's transcript: what sits from `from` up to, not
 * including, `to` — or to the end. Placed as placeOf places it, so a message
 * sent into a run goes with the stretch it was read in, not the one it was
 * typed during.
 *
 * Returns what it removed, so the caller can put it back, and how that differs
 * from the plain seq range — `also` outside it, `kept` inside it — so a page
 * holding the events can drop the same ones.
 */
export function deleteEventsBetween(
  sessionId: string,
  from: number,
  to: number | null,
): { rows: EventRow[]; also: number[]; kept: number[] } {
  const db = getDb();
  return db.transaction(() => {
    const settled = settledAt(sessionId);
    const inRange = (at: number) => at >= from && (to === null || at < to);
    const rows = db
      .prepare(
        `SELECT * FROM events WHERE session_id = ?
           AND ((seq >= ? AND (? IS NULL OR seq < ?))
                OR (type = 'portal_prompt' AND json_extract(payload, '$.queued') = 1)
                -- The ends of commands after the range, for any of its commands: see placeOf.
                OR (type IN ('portal_command', 'portal_command_end') AND type = 'portal_command_end' AND ? IS NOT NULL AND seq >= ?))
         ORDER BY seq ASC`,
      )
      .all(sessionId, from, to, to, to, to) as EventRow[];
    const gone = rows.filter((r) => inRange(placeOf(r, settled)));
    const going = new Set(gone);
    const also = gone.filter((r) => !inRange(r.seq)).map((r) => r.seq);
    const kept = rows.filter((r) => inRange(r.seq) && !going.has(r)).map((r) => r.seq);
    // The range in one statement, less the few messages placed outside it;
    // then the few placed inside it from outside. A long chat's tail is tens
    // of thousands of rows, and one statement per row held up the server.
    db.prepare(
      `DELETE FROM events WHERE session_id = ? AND seq >= ? AND (? IS NULL OR seq < ?)
         AND seq NOT IN (SELECT value FROM json_each(?))`,
    ).run(sessionId, from, to, to, JSON.stringify(kept));
    const drop = db.prepare("DELETE FROM events WHERE seq = ?");
    for (const seq of also) drop.run(seq);
    return { rows: gone, also, kept };
  })();
}

/** A branch of a conversation not shown now: see message_versions. */
export interface MessageVersion {
  id: number;
  anchor: number;
  seq: number;
  rows: EventRow[];
  /** pi's file after its first `filePrefix` characters; null when there was no file. */
  file: string | null;
  filePrefix: number | null;
  prefixHash: string | null;
}

type VersionRow = { id: number; anchor: number; seq: number; rows: string; file: string | null; file_prefix: number | null; prefix_hash: string | null };
const versionOf = (r: VersionRow): MessageVersion => ({
  id: r.id,
  anchor: r.anchor,
  seq: r.seq,
  rows: JSON.parse(r.rows) as EventRow[],
  file: r.file,
  filePrefix: r.file_prefix,
  prefixHash: r.prefix_hash,
});

/** Keeps a branch the conversation is leaving; returns its id. */
export function saveVersion(sessionId: string, v: Omit<MessageVersion, "id">): number {
  return Number(
    getDb()
      .prepare("INSERT INTO message_versions (session_id, anchor, seq, rows, file, file_prefix, prefix_hash) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(sessionId, v.anchor, v.seq, JSON.stringify(v.rows), v.file, v.filePrefix, v.prefixHash).lastInsertRowid,
  );
}

/** The first messages of the branches kept after `anchor`, oldest first. */
export function versionSeqs(sessionId: string): { anchor: number; seq: number }[] {
  return getDb()
    .prepare("SELECT anchor, seq FROM message_versions WHERE session_id = ? ORDER BY seq")
    .all(sessionId) as { anchor: number; seq: number }[];
}

const VERSION_AT = "SELECT * FROM message_versions WHERE session_id = ? AND anchor = ? AND seq = ?";

/** A kept branch, left where it is: undefined if there is none. */
export function findVersion(sessionId: string, anchor: number, seq: number): MessageVersion | undefined {
  const row = getDb().prepare(VERSION_AT).get(sessionId, anchor, seq) as VersionRow | undefined;
  return row && versionOf(row);
}

/** Takes a kept branch out, to be shown again: undefined if there is none. */
export function takeVersion(sessionId: string, anchor: number, seq: number): MessageVersion | undefined {
  const d = getDb();
  return d.transaction(() => {
    const row = d.prepare(VERSION_AT).get(sessionId, anchor, seq) as VersionRow | undefined;
    if (!row) return undefined;
    d.prepare("DELETE FROM message_versions WHERE id = ?").run(row.id);
    return versionOf(row);
  })();
}

/** Forgets one kept branch. */
export function dropVersion(id: number): void {
  getDb().prepare("DELETE FROM message_versions WHERE id = ?").run(id);
}

/**
 * Counts one more time a chat's events were put back under seqs its pages
 * had read past, and returns the count: a page that last saw another loads
 * the chat again.
 */
export function bumpReloads(sessionId: string): number {
  const row = getDb().prepare("UPDATE sessions SET reloads = reloads + 1 WHERE id = ? RETURNING reloads").get(sessionId) as
    | { reloads: number }
    | undefined;
  return row?.reloads ?? 0;
}

/**
 * Forgets the versions kept after the messages at `anchors`, and the versions
 * inside those that nothing else can reach any more: their anchors are
 * messages kept only in what is being forgotten.
 */
export function dropVersionsAt(sessionId: string, anchors: number[]): void {
  const d = getDb();
  d.transaction(() => {
    const find = d.prepare("SELECT id FROM message_versions WHERE session_id = ? AND anchor = ?");
    // The messages inside one, found by SQLite: not the whole of it read into JavaScript.
    const prompts = d.prepare(
      `SELECT json_extract(value, '$.seq') AS seq FROM message_versions, json_each(message_versions.rows)
       WHERE message_versions.id = ? AND json_extract(value, '$.type') = 'portal_prompt'`,
    );
    const drop = d.prepare("DELETE FROM message_versions WHERE id = ?");
    const queue = [...anchors];
    for (let anchor = queue.shift(); anchor !== undefined; anchor = queue.shift()) {
      for (const v of find.all(sessionId, anchor) as { id: number }[]) {
        for (const r of prompts.all(v.id) as { seq: number }[]) queue.push(r.seq);
        drop.run(v.id);
      }
    }
  })();
}

/** Takes events out by seq: see restoreEvents, which this undoes. */
export function deleteEventSeqs(seqs: number[]): void {
  getDb().prepare("DELETE FROM events WHERE seq IN (SELECT value FROM json_each(?))").run(JSON.stringify(seqs));
}

/** Runs `fn` as one transaction: all of what it writes, or none of it. */
export function atomically<T>(fn: () => T): T {
  return getDb().transaction(fn)();
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

/**
 * Adds to what a portal_prompt says, once pi has said what it did with the
 * message: that it queued one sent as starting a run, or the words it queued.
 */
export function notePromptQueued(seq: number, fields: Record<string, unknown>): void {
  getDb()
    .prepare("UPDATE events SET payload = json_patch(payload, ?) WHERE seq = ? AND type = 'portal_prompt'")
    .run(JSON.stringify(fields), seq);
}

/** Drops one event. */
export function deleteEvent(seq: number): void {
  getDb().prepare("DELETE FROM events WHERE seq = ?").run(seq);
}

/**
 * Drops what a session recorded after `seq`, but for its status changes — an
 * error among them is what says why the rest is gone — and the ends of
 * commands sent before it, which stay. Returns the seqs dropped.
 */
export function deleteEventsAfter(sessionId: string, seq: number): number[] {
  const db = getDb();
  const which = `session_id = ? AND seq > ? AND type != 'portal_status'
    AND NOT (type = 'portal_command_end' AND json_extract(payload, '$.of') <= ?)`;
  return db.transaction(() => {
    const gone = db.prepare(`SELECT seq FROM events WHERE ${which} ORDER BY seq`).all(sessionId, seq, seq) as { seq: number }[];
    db.prepare(`DELETE FROM events WHERE ${which}`).run(sessionId, seq, seq);
    return gone.map((r) => r.seq);
  })();
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

/** Events after `since`, for replaying what a disconnected browser missed. */
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
 * can offer a resume instead of showing a spinner forever. Gives the ids of the
 * sessions it marked.
 */
export function markOrphanedSessionsInterrupted(): string[] {
  const rows = getDb()
    .prepare(
      "UPDATE sessions SET status = 'interrupted', updated_at = datetime('now') WHERE status = 'running' RETURNING id"
    )
    .all() as { id: string }[];
  return rows.map((r) => r.id);
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

/** One setting the portal keeps, read on its own rather than with the whole table. */
export function getSetting(key: string): string | undefined {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value || undefined;
}

/** Where a conversation's trusted results are kept: see trustedResults. */
const trustedKey = (sessionId: string) => `taint_trusted:${sessionId}`;

/**
 * The results flagged as a suspected prompt injection in a conversation that
 * the person has looked at and trusted, by the id of the envelope around each
 * (see pi/guard.ts): they no longer hold the conversation back.
 */
export function trustedResults(sessionId: string): Set<string> {
  try {
    return new Set(JSON.parse(getSetting(trustedKey(sessionId)) ?? "[]"));
  } catch {
    return new Set();
  }
}

export function trustResult(sessionId: string, id: string): void {
  putSetting(trustedKey(sessionId), JSON.stringify([...trustedResults(sessionId), id]));
}

/**
 * The speaking instructions saved with the voice settings; empty where the
 * built-in ones are used. They live in the same JSON as the rest of them.
 */
export function getVoiceInstructions(): string {
  try {
    const saved = JSON.parse(getSetting("voice") ?? "{}").responseInstructions;
    return typeof saved === "string" ? saved : "";
  } catch {
    return "";
  }
}

/** The providers saved for voice mode's first call without thinking; undefined where the default list is used. */
export function getSkipThinkingProviders(): string[] | undefined {
  try {
    const saved = JSON.parse(getSetting("voice") ?? "{}").skipThinkingProviders;
    return Array.isArray(saved) ? saved.filter((name): name is string => typeof name === "string") : undefined;
  } catch {
    return undefined;
  }
}

/** Whether voice mode can speak: the add-on is on, with a speech engine (not recognition alone). */
export function voiceSpeaks(): boolean {
  try {
    const voice = JSON.parse(getSetting("voice") ?? "{}");
    return voice.enabled === true && voice.runtime !== "none";
  } catch {
    return false;
  }
}

/**
 * Only what the portal was explicitly told; absent keys fall through.
 *
 * The three model defaults and nothing else of the table: it holds much that is not these, and
 * everything else is read by its own key (see getSetting).
 */
export function getStoredSettings(): Partial<GlobalSettings> {
  const stored: Partial<GlobalSettings> = {};
  for (const key of ["provider", "model", "thinkingLevel"] as const) {
    const value = getSetting(key);
    if (value) stored[key] = value;
  }
  return stored;
}

/**
 * The stored defaults the page may see: the three it edits. The table holds
 * much else — passwords, tokens, keys the portal keeps for its add-ons — and
 * none of that is the page's to have.
 */
export function shownStoredSettings(): Partial<GlobalSettings> {
  const { provider, model, thinkingLevel } = getStoredSettings();
  return { ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}) };
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

/**
 * The model a chat is started on: what its row names, and the defaults for
 * whatever it does not — each half on its own, so a row naming only a
 * provider runs the default model there. Kept in one place, for what the
 * page is told about an idle chat to be what it would run.
 */
export function chatModel(
  session: { provider?: string | null; model?: string | null },
  settings: GlobalSettings = getSettings(),
): { provider: string; model: string } {
  return { provider: session.provider || settings.provider, model: session.model || settings.model };
}

export { SETTING_DEFAULTS as getSettingDefaults };

/**
 * An empty value clears the override rather than storing "", so a field can be
 * handed back to pi's own defaults instead of being pinned forever.
 */
export function setSettings(patch: Partial<GlobalSettings>): GlobalSettings {
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === "string") putSetting(k, v.trim());
  }
  return getSettings();
}

/**
 * The context window a model really has, when that is not what its
 * definition says.
 *
 * pi takes the window from the model's entry in models.json, and everything
 * that depends on it — the percentage, when a chat is compacted — follows that
 * number. A server can hold less: llama.cpp with `--parallel 2` splits
 * `ctx-size` between two slots, so a chat gets half of what the definition
 * promises and a long one fails instead of being compacted. The definition
 * cannot be right for every deployment, so the number is kept here, per model,
 * and wins when it is set.
 */
export const CONTEXT_LIMIT_MIN = 1_024;
export const CONTEXT_LIMIT_MAX = 10_000_000;
const contextLimitKey = (provider: string, model: string) => `context_limit:${provider}/${model}`;

/** A stored window, or nothing where it is not stored, or is not one the portal accepts. */
function storedLimit(key: string): number | undefined {
  const n = Number(getSetting(key));
  return Number.isInteger(n) && n >= CONTEXT_LIMIT_MIN && n <= CONTEXT_LIMIT_MAX ? n : undefined;
}

export function getContextLimit(provider: string, model: string): number | undefined {
  return storedLimit(contextLimitKey(provider, model));
}

/** `null` hands the model back to the default, or to what its definition says. */
export function setContextLimit(provider: string, model: string, tokens: number | null): void {
  storeLimit(contextLimitKey(provider, model), tokens);
}

const DEFAULT_LIMIT_KEY = "context_limit_default";

/** The window every chat is held to, unless its model has one of its own. */
export function getDefaultContextLimit(): number | undefined {
  return storedLimit(DEFAULT_LIMIT_KEY);
}

export function setDefaultContextLimit(tokens: number | null): void {
  storeLimit(DEFAULT_LIMIT_KEY, tokens);
}

function storeLimit(key: string, tokens: number | null): void {
  putSetting(key, tokens === null ? "" : String(tokens));
}

/**
 * The window a chat on this model is held to.
 *
 * What was set for the model wins. Failing that, the default applies as a
 * ceiling, not as a size: a model that declares less than the default keeps
 * what it declares, since raising it would promise room it does not have.
 * `declared` is the model's own number, when it has one.
 */
export function contextWindowFor(provider: string, model: string, declared?: number): number | undefined {
  const own = getContextLimit(provider, model);
  if (own) return own;
  const fallback = getDefaultContextLimit();
  if (!fallback) return declared;
  return declared ? Math.min(declared, fallback) : fallback;
}

/** Why a window is refused, or undefined when it is fine. Shared by everything that accepts one. */
export function contextLimitProblem(tokens: unknown): string | undefined {
  if (Number.isInteger(tokens) && (tokens as number) >= CONTEXT_LIMIT_MIN && (tokens as number) <= CONTEXT_LIMIT_MAX) {
    return undefined;
  }
  // en-US, not the server's locale: the message is English whatever the host is.
  return `The context window must be a whole number between ${CONTEXT_LIMIT_MIN.toLocaleString("en-US")} and ${CONTEXT_LIMIT_MAX.toLocaleString("en-US")} tokens`;
}

/** Where reports go when a routine does not name a destination of its own. */
export interface ReportTo {
  channel: string;
  target: string;
}

export function getDefaultReportTo(): ReportTo | null {
  const channel = getSetting("report_channel");
  const target = getSetting("report_target");
  return channel && target ? { channel, target } : null;
}

export function setDefaultReportTo(to: ReportTo | null): void {
  putSetting("report_channel", to?.channel ?? "");
  putSetting("report_target", to?.target ?? "");
}

/**
 * Something the portal said into a conversation, waiting to join its context.
 *
 * With `forAgent` off it is only kept for delivery, as consumed already: the agent
 * is never handed it, and the conversation is not tainted by it.
 */
export function addNote(sessionId: string, text: string, pendingDelivery = false, forAgent = true): void {
  getDb()
    .prepare(
      `INSERT INTO notes (session_id, text, pending_delivery, consumed_at)
       VALUES (?, ?, ?, ${forAgent ? "NULL" : "datetime('now')"})`
    )
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

/** Read pending notes without consuming them before the prompt is accepted. */
export function pendingNotes(sessionId: string): { id: number; text: string }[] {
  return getDb().prepare("SELECT id, text FROM notes WHERE session_id = ? AND consumed_at IS NULL ORDER BY id ASC")
    .all(sessionId) as { id: number; text: string }[];
}
export function consumeNotes(sessionId: string, ids: number[]): void {
  const mark = getDb().prepare("UPDATE notes SET consumed_at = datetime('now') WHERE id = ? AND session_id = ?");
  getDb().transaction(() => { for (const id of ids) mark.run(id, sessionId); })();
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
export const AUDIT_KEEP = 2000;

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

/**
 * Empties the log, for when its history is no longer wanted; returns how many
 * entries went. With `through`, only entries up to that id go: the ones
 * somebody saw before deciding, not whatever was recorded since. Earlier
 * "cleared" notes survive a clear, and a clear that removed something leaves
 * one more, in the same transaction, so an emptied log cannot pass for a quiet
 * one. The trim to AUDIT_KEEP still ages notes out like any other entry; it
 * only bounds the table's size.
 */
export function clearAudit(through?: number): number {
  const db = getDb();
  return db.transaction(() => {
    const removed = db
      .prepare("DELETE FROM audit WHERE kind != 'cleared' AND id <= ?")
      .run(through ?? Number.MAX_SAFE_INTEGER).changes;
    if (removed > 0) recordAudit({ kind: "cleared", reason: String(removed) });
    return removed;
  })();
}

/** Does this routine's runs get the guard's blocking rules? Unknown means yes. */
export function routineGuards(slug: string | null | undefined): boolean {
  if (!slug) return true;
  const row = getDb().prepare("SELECT guard FROM routines WHERE slug = ?").get(slug) as
    | { guard: number }
    | undefined;
  return row ? row.guard === 1 : true;
}

/**
 * Carry the old per-session browser grant into the tool switches.
 *
 * The browser used to be opt-in per conversation, stored in `sessions.browser`
 * and off by default. It is an MCP server now, and a server's tools are on
 * unless something says otherwise — which on an upgrade would hand every
 * conversation that ever existed a browser signed into real accounts, because
 * nobody had said otherwise about a switch that did not exist yet.
 *
 * So the posture is carried over rather than replaced: the browser's tools go
 * into the defaults as off, and the conversations that had the grant get it
 * back as their own exception. A new install is unaffected and starts the way
 * any other server does. Run once, because after it the operator's own choices
 * are the ones in there.
 *
 * It cannot run when the database opens. Which tools are the browser's is only
 * known once a session has registered them, and on the first start after an
 * upgrade none has: the catalogue is a key this build introduced. So the first
 * call only decides whether there is a posture to carry — an install with
 * conversations in it — and marks it `pending`. It runs again from
 * `rememberTools()` and does the carrying the moment the browser's tools
 * appear. Until then `browserAllowed()` goes on reading the old column. After
 * it, a browser tool that shows up later is carried the same way.
 */
export function adoptBrowserGrants(d: Database.Database = getDb(), fresh: string[] = []): void {
  const flag = d
    .prepare("SELECT value FROM settings WHERE key = 'browser_tools_adopted'")
    .get() as { value: string } | undefined;
  if (flag?.value === "1") return;
  const mark = (value: string) =>
    d
      .prepare(
        "INSERT INTO settings (key, value) VALUES ('browser_tools_adopted', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(value);

  let state = flag?.value;
  if (!state) {
    // Nobody has ever had a conversation: nothing was granted, nothing to keep.
    if (!d.prepare("SELECT 1 FROM sessions LIMIT 1").get()) return void mark("1");
    mark((state = "pending"));
  }

  const servers = mcpServerNames();
  const browsers = browserServers();
  // Waiting: every browser tool seen so far. Carrying: only the ones that are
  // new. The catalogue is what one session happened to have registered — a lazy
  // server has cached some of its tools and not others, and a pinned version
  // that is bumped adds names — so the posture has to reach whatever turns up
  // later, not only what was there on the first day. What was carried over and
  // since changed by the operator is not touched again.
  const names =
    state === "pending"
      ? knownTools()
          .map((t) => t.name)
          .filter((name) => browserTool(name, servers, browsers))
      : fresh.filter((name) => browserTool(name, servers, browsers));
  if (!names.length) return;

  setToolDefaultsOff([...new Set([...toolDefaultsOff(), ...names])]);
  const granted = d
    .prepare("SELECT id FROM sessions WHERE browser = 1 AND kind != 'routine'")
    .all() as { id: string }[];
  for (const { id } of granted) {
    const tools = sessionTools(id);
    setSessionTools(id, { off: tools.off, on: [...new Set([...tools.on, ...names])] });
  }
  mark("carry");
}

/** Is there a grant still waiting for the browser's tools to be seen? */
function browserAdoptionPending(): boolean {
  return getSetting("browser_tools_adopted") === "pending";
}

/**
 * Does this session get the browser? Routines answer for their own runs.
 *
 * For an ordinary conversation this is not stored any more: the browser is an
 * MCP server like any other, so its tools are switched in the tools list, and
 * having the browser is having its tools. A second place recording the same
 * answer could only ever disagree with the first.
 *
 * The `sessions.browser` column is what that second place was. It is still
 * read, and not to be dropped: here while no browser tool has been seen (see
 * `browserColumnDecides`, which a container deployment always is), by
 * `adoptBrowserGrants` to carry the grants over, and by `browserExceptions`.
 */
export function browserAllowed(session: SessionRow): boolean {
  return browserAllowedWith(session, browserPolicy());
}

/**
 * What the answer is worked out from apart from the conversation asked about:
 * the browser's tools as far as they have been seen, the defaults, and whether
 * the old column decides. A pass over many conversations asks for it once. Each
 * of them used to read the MCP file three times and the settings table twice.
 */
export interface BrowserPolicy {
  names: string[];
  /** With none of its tools seen: whether the old column is what answers. */
  columnDecides: boolean;
  defaultsOff: string[];
  /** What a place starts with, by agent, project and routine, worked out the first time a conversation there is asked about. */
  projects: Map<string, string[]>;
  /** The agents' homes, read the first time a conversation is asked about. */
  homes?: AgentHome[];
}

export function browserPolicy(): BrowserPolicy {
  const names = seenBrowserTools();
  return { names, columnDecides: names.length ? false : browserColumnDecides(), defaultsOff: toolDefaultsOff(), projects: new Map() };
}

/** `browserAllowed`, against a policy asked for once; `exceptions` are the conversation's own, where the caller has them already. */
export function browserAllowedWith(session: SessionRow, policy: BrowserPolicy, exceptions?: SessionTools): boolean {
  const routine = routineOf(session);
  if (routine) {
    const row = getDb().prepare("SELECT browser FROM routines WHERE slug = ?").get(routine) as { browser: number } | undefined;
    // A routine that is gone gets nothing; with no browser tool seen, its old switch is all there is to go by.
    if (!row) return false;
    if (!policy.names.length) return row.browser === 1;
  } else if (!policy.names.length) return session.browser === 1 || !policy.columnDecides;
  // Every layer under the conversation's own: its agent, its project, its routine.
  // By what decides it, not by folder: the chats in one project's subfolders share it.
  const homes = (policy.homes ??= agentHomes());
  const key = `${agentIdOf(session.workspace, homes) ?? ""}\u0000${projectOf(session.workspace) ?? ""}\u0000${routine ?? ""}`;
  let defaults = policy.projects.get(key);
  if (!defaults) policy.projects.set(key, (defaults = toolDefaultsFor(session.workspace, routine, undefined, policy.defaultsOff, homes)));
  const own = exceptions ?? sessionTools(session.id);
  return policy.names.some((name) => toolEnabled(name, defaults, own));
}

/** The browser's tools, as far as any session has registered them. */
export function seenBrowserTools(): string[] {
  // Asked for by every routine's tools, so kept until the MCP file or the settings (what was seen) are written.
  const stamp = `${fileStamp(mcpConfigPath())}|${settingsWrites}`;
  if (lastBrowserTools?.stamp === stamp) return lastBrowserTools.names;
  const { servers, browsers } = serversAndBrowsers();
  const names = knownTools()
    .map((t) => t.name)
    .filter((name) => browserTool(name, servers, browsers));
  lastBrowserTools = { stamp, names };
  return names;
}

let lastBrowserTools: { stamp: string; names: string[] } | undefined;

/**
 * With no browser tool seen there is no switch to read, and three situations
 * look the same from here:
 *
 * - A container deployment, where pi is reached over RPC and never reports its
 *   registry. The old per-session grant is still the only answer anyone has.
 * - An upgrade still waiting for the browser's tools to appear, so the grants
 *   can be carried over. The old column stands until they do.
 * - No server that is the browser at all: nothing here to switch, so the column.
 *
 * Anything else is a browser server configured and not yet registered by any
 * session — a fresh install whose first conversation is still starting, or a
 * lazy server whose tools pi has not cached yet. Nobody has said anything about
 * it, which is what a default is for, so it is on, as any other server is.
 */
function browserColumnDecides(): boolean {
  if (EXECUTOR_KIND === "container") return true;
  if (browserAdoptionPending()) return true;
  return !browserConfigured();
}

/**
 * Whether the portal's own browser tools are connected: "1" on, "0" switched
 * off, and unset where nobody has decided — an install from before them, which
 * adoptPortalBrowser moves over once.
 */
export function portalBrowserState(): "on" | "off" | "unset" {
  const value = getSetting("browser_tools");
  return value === "1" ? "on" : value === "0" ? "off" : "unset";
}

export const portalBrowserOn = () => portalBrowserState() === "on";

export function setPortalBrowser(on: boolean): void {
  putSetting("browser_tools", on ? "1" : "0");
}

/**
 * Whether the browser tools show their cursor: on unless switched off on the
 * Browser page ("0"). Off, nothing moves and the actions do not wait for it.
 */
export function browserCursorOn(): boolean {
  return getSetting("browser_cursor") !== "0";
}

export function setBrowserCursor(on: boolean): void {
  putSetting("browser_cursor", on ? "1" : "0");
}

/** Whether the agent has a browser at all: the portal's tools, or an MCP server pointed at it. */
export function browserConfigured(): boolean {
  return portalBrowserOn() || browserServers().length > 0;
}

/**
 * The conversations that disagree with the default about the browser.
 *
 * Every one that says anything about tools, and every one that holds the old
 * grant, is asked — not those whose switches happen to mention the word
 * `browser`, which is not what a server is called when it is called something
 * else, and misses the column where that is still the only record.
 */
export function browserExceptions(): SessionRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM sessions
       WHERE COALESCE(tools_off, '') != '' OR COALESCE(tools_on, '') != '' OR browser = 1
       ORDER BY updated_at DESC`
    )
    .all() as SessionRow[];
  // And the chats of a project or in the home of an agent that says something
  // about tools, which differ from the default through it without having said
  // anything themselves. Not routines: they answer for their own runs, project
  // or not.
  const projects = projectsWithTools();
  const agents = new Set((getDb().prepare("SELECT agent FROM agent_tools").all() as { agent: string }[]).map((r) => r.agent));
  if (projects.size || agents.size) {
    const homes = agents.size ? agentHomes() : [];
    const own = new Set(rows.map((row) => row.id));
    const all = getDb().prepare("SELECT * FROM sessions WHERE kind != 'routine' ORDER BY updated_at DESC").all() as SessionRow[];
    for (const row of all) {
      if (own.has(row.id)) continue;
      const project = projectOf(row.workspace);
      const agent = agents.size ? agentIdOf(row.workspace, homes) : undefined;
      if ((project && projects.has(project)) || (agent && agents.has(agent))) rows.push(row);
    }
    rows.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
  }
  // The policy once for all of them, and what each says about tools from the row that was read.
  const policy = browserPolicy();
  const byDefault = browserByDefaultWith(policy);
  return rows.filter(
    (row) => browserAllowedWith(row, policy, { off: parseToolsOff(row.tools_off), on: parseToolsOff(row.tools_on) }) !== byDefault
  );
}

/** Is the browser on for a conversation that has never said anything about it? */
export function browserByDefault(): boolean {
  return browserByDefaultWith(browserPolicy());
}

function browserByDefaultWith(policy: BrowserPolicy): boolean {
  if (!policy.names.length) return !policy.columnDecides;
  const off = new Set(policy.defaultsOff);
  return policy.names.some((name) => !off.has(name));
}

/**
 * What a conversation says about tools, as exceptions to the default.
 *
 * Two lists because an exception runs both ways: a tool the default leaves on
 * can be switched off here, and one the default has off can be switched on.
 * Exceptions rather than a full picture so that changing a default reaches
 * every conversation that never said anything about it, which is the whole
 * point of having one.
 */
export interface SessionTools {
  off: string[];
  on: string[];
}

export function sessionTools(sessionId: string): SessionTools {
  const row = getDb().prepare("SELECT tools_off, tools_on FROM sessions WHERE id = ?").get(
    sessionId
  ) as { tools_off: string | null; tools_on: string | null } | undefined;
  return { off: parseToolsOff(row?.tools_off), on: parseToolsOff(row?.tools_on) };
}

export function parseToolsOff(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean);
}

/** Sorted and deduped, so the column reads the same however it was written. */
const clean = (names: string[]): string[] =>
  [...new Set(names.map((n) => n.trim()).filter(Boolean))].sort();

export function setSessionTools(sessionId: string, tools: SessionTools): SessionTools {
  const stored = { off: clean(tools.off), on: clean(tools.on) };
  getDb()
    .prepare("UPDATE sessions SET tools_off = ?, tools_on = ? WHERE id = ?")
    .run(stored.off.join("\n"), stored.on.join("\n"), sessionId);
  return stored;
}

/**
 * What a project says about tools, as exceptions to the portal-wide default —
 * the same two lists a chat keeps, one layer up. Nothing for a project that
 * never said anything, which is every project there was.
 */
export function projectTools(project: string): SessionTools {
  const row = getDb().prepare("SELECT tools_off, tools_on FROM project_tools WHERE project = ?").get(
    project
  ) as { tools_off: string; tools_on: string } | undefined;
  return { off: parseToolsOff(row?.tools_off), on: parseToolsOff(row?.tools_on) };
}

export function setProjectTools(project: string, tools: SessionTools): SessionTools {
  const stored = { off: clean(tools.off), on: clean(tools.on) };
  if (!stored.off.length && !stored.on.length) clearProjectTools(project);
  else
    getDb()
      .prepare(
        `INSERT INTO project_tools (project, tools_off, tools_on) VALUES (?, ?, ?)
         ON CONFLICT(project) DO UPDATE SET tools_off = excluded.tools_off, tools_on = excluded.tools_on`
      )
      .run(project, stored.off.join("\n"), stored.on.join("\n"));
  return stored;
}

/** Forgets what a project said about tools, as when it is deleted or made again. */
export function clearProjectTools(project: string): void {
  getDb().prepare("DELETE FROM project_tools WHERE project = ?").run(project);
}

/** The projects that say something about tools, by name. */
export function projectsWithTools(): Set<string> {
  return new Set(
    (getDb().prepare("SELECT project FROM project_tools").all() as { project: string }[]).map((r) => r.project)
  );
}

/**
 * What an agent says about tools, as exceptions to the portal-wide default:
 * for every chat in its home and every run it does on its own — its heartbeat,
 * the routines that run there. Nothing for an agent that never said anything.
 */
export function agentTools(agent: string): SessionTools {
  const row = getDb().prepare("SELECT tools_off, tools_on FROM agent_tools WHERE agent = ?").get(
    agent
  ) as { tools_off: string; tools_on: string } | undefined;
  return { off: parseToolsOff(row?.tools_off), on: parseToolsOff(row?.tools_on) };
}

export function setAgentTools(agent: string, tools: SessionTools): SessionTools {
  const stored = { off: clean(tools.off), on: clean(tools.on) };
  if (!stored.off.length && !stored.on.length) clearAgentTools(agent);
  else
    getDb()
      .prepare(
        `INSERT INTO agent_tools (agent, tools_off, tools_on) VALUES (?, ?, ?)
         ON CONFLICT(agent) DO UPDATE SET tools_off = excluded.tools_off, tools_on = excluded.tools_on`
      )
      .run(agent, stored.off.join("\n"), stored.on.join("\n"));
  return stored;
}

/** Forgets what an agent said about tools, as when it is deleted. */
export function clearAgentTools(agent: string): void {
  getDb().prepare("DELETE FROM agent_tools WHERE agent = ?").run(agent);
}

/**
 * The agent whose home this is or is in, by id: read from the table rather
 * than through agents.ts, which reads this module. The first agent's home is
 * wherever AGENT_HOME says now.
 */
export function agentIdOf(workspace: string | null | undefined, homes: AgentHome[] = agentHomes()): string | undefined {
  if (!workspace) return undefined;
  const at = path.resolve(workspace);
  const exact = homes.find((a) => path.resolve(a.home) === at);
  if (exact) return exact.id;
  // A project's chats follow the project, also where the projects' folder were inside an agent's home.
  if (projectOf(workspace)) return undefined;
  return homes.find((a) => isWithinText(a.home, at))?.id;
}

export interface AgentHome {
  id: string;
  home: string;
}

/** Every agent's home, read once for a pass over many conversations (agentIdOf). */
export function agentHomes(): AgentHome[] {
  // In the order agents.ts lists them (listAgents), so a folder is told to the same agent either way.
  const rows = getDb().prepare("SELECT id, home FROM agents ORDER BY id = 'home' DESC, created_at ASC, name ASC").all() as AgentHome[];
  return rows.map((a) => ({ id: a.id, home: a.id === "home" ? agentHomePath() : a.home }));
}

/**
 * What a routine says about tools, as exceptions to what its agent and project
 * leave: the same two lists a chat keeps.
 *
 * Its old **Browser** switch (the `browser` column) answers for every browser
 * tool its lists do not name: off unless it is on, as it always was for a
 * routine. It is read here, as the lists are, rather than written into them
 * ahead of time: a tool that comes to count as the browser's later — a server
 * pointed at the browser, a catalogue that could not be read for a while — is
 * then held to it as well, with nothing to copy and nothing to miss. The
 * routine's page writes down what it showed of each browser tool, so what was
 * switched there is the lists' to answer.
 */
export function routineTools(slug: string, browser: string[] = seenBrowserTools()): SessionTools {
  const row = getDb().prepare("SELECT tools_off, tools_on, browser FROM routines WHERE slug = ?").get(slug) as
    | { tools_off: string; tools_on: string; browser: number }
    | undefined;
  if (!row) return { off: [], on: [] };
  const own = { off: parseToolsOff(row.tools_off), on: parseToolsOff(row.tools_on) };
  const unnamed = browser.filter((name) => !own.off.includes(name) && !own.on.includes(name));
  return row.browser === 1 ? { off: own.off, on: [...own.on, ...unnamed] } : { off: [...own.off, ...unnamed], on: own.on };
}

/** Only the switch: what the browser tools a routine's lists do not name follow. */
export function setRoutineBrowserSwitch(slug: string, on: boolean): void {
  getDb().prepare("UPDATE routines SET browser = ? WHERE slug = ?").run(on ? 1 : 0, slug);
}

/**
 * The routine's Browser switch, as the API still takes it: every browser tool
 * taken out of its lists, so that all of them follow the switch.
 */
export function setRoutineBrowser(slug: string, on: boolean): void {
  const names = new Set(seenBrowserTools());
  const row = getDb().prepare("SELECT tools_off, tools_on FROM routines WHERE slug = ?").get(slug) as
    | { tools_off: string; tools_on: string }
    | undefined;
  if (!row) return;
  setRoutineBrowserSwitch(slug, on);
  setRoutineTools(slug, {
    off: parseToolsOff(row.tools_off).filter((name) => !names.has(name)),
    on: parseToolsOff(row.tools_on).filter((name) => !names.has(name)),
  });
}

export function setRoutineTools(slug: string, tools: SessionTools): SessionTools {
  const stored = { off: clean(tools.off), on: clean(tools.on) };
  getDb()
    .prepare("UPDATE routines SET tools_off = ?, tools_on = ? WHERE slug = ?")
    .run(stored.off.join("\n"), stored.on.join("\n"), slug);
  return stored;
}

/**
 * The tools that are off by default for a chat in `workspace`, or a run of the
 * routine `routine` there: the layers under a chat's own switches, each an
 * exception to the one before it.
 *
 * 1. the portal-wide default (Settings → Tools);
 * 2. the agent whose home it is in, for its chats and its own runs;
 * 3. the project it is in;
 * 4. the routine, for its runs.
 *
 * A chat's own switches are held against this, and stay the last word. An agent
 * and a project do not meet in practice — a project is under the workspace root,
 * an agent's home is not — but where they did, the project is the nearer, and
 * says it last. A routine is nearer still: it is one task within either.
 *
 * `upTo` stops before a layer, for the page of that layer, which shows what is
 * under it. `base` is the portal-wide default, where the caller has read it
 * already for a pass over many conversations.
 */
export function toolDefaultsFor(
  workspace: string | null | undefined,
  routine?: string | null,
  upTo?: "agent" | "project" | "routine",
  base: string[] = toolDefaultsOff(),
  homes?: AgentHome[],
): string[] {
  let off = base;
  if (upTo === "agent") return off;
  const agent = agentIdOf(workspace, homes);
  if (agent) off = defaultsFor(off, agentTools(agent));
  if (upTo === "project") return off;
  const project = projectOf(workspace);
  if (project) off = defaultsFor(off, projectTools(project));
  if (upTo === "routine") return off;
  return routine ? defaultsFor(off, routineTools(routine)) : off;
}

/** The routine a session is a run of, if it is one: its layer is in its tools. */
export const routineOf = (session: Pick<SessionRow, "kind" | "routine_slug"> | undefined): string | null =>
  session?.kind === "routine" ? (session.routine_slug ?? null) : null;

/** What a session starts with off, every layer under its own switches. */
export function toolDefaultsForSession(session: Pick<SessionRow, "kind" | "routine_slug" | "workspace"> | undefined, homes?: AgentHome[]): string[] {
  return toolDefaultsFor(session?.workspace, routineOf(session), undefined, undefined, homes);
}

/**
 * A setting the portal keeps for itself, outside the model defaults.
 *
 * GlobalSettings is what a session launches with; these are neither that nor
 * pi's, so they go straight to the table rather than widening a type that
 * every launch reads.
 */
/** Counts the writes to the settings, which hold what the portal remembers of the tools: what a view read before one is not reused after it (mcpView). */
let settingsWrites = 0;

export function putSetting(key: string, value: string): void {
  settingsWrites++;
  const db = getDb();
  if (value)
    db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(key, value);
  else db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

/** Remembers a login as signed out until it would have expired, and forgets those that have. */
export function recordSignOut(mac: string, expires: number): void {
  const d = getDb();
  d.prepare("DELETE FROM signed_out WHERE expires < ?").run(Date.now());
  d.prepare("INSERT OR IGNORE INTO signed_out (mac, expires) VALUES (?, ?)").run(mac, expires);
}

/** Asked on every request that carries a login, so prepared once. */
let signedOutQuery: Database.Statement | undefined;

export function isSignedOut(mac: string): boolean {
  signedOutQuery ??= getDb().prepare("SELECT 1 FROM signed_out WHERE mac = ?");
  return signedOutQuery.get(mac) !== undefined;
}

/**
 * What a package's entry looked like before it was switched off, so switching
 * it back on gives that back rather than a plain one.
 */
export function extensionStash(): Record<string, unknown> {
  try {
    const raw = JSON.parse(getSetting("extension_stash") || "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

export function setExtensionStash(stash: Record<string, unknown>): void {
  putSetting("extension_stash", Object.keys(stash).length ? JSON.stringify(stash) : "");
}

/** Tools that are off unless a conversation says otherwise. */
export function toolDefaultsOff(): string[] {
  return parseToolsOff(getSetting("tools_off_default"));
}

export function setToolDefaultsOff(names: string[]): string[] {
  const stored = clean(names);
  putSetting("tools_off_default", stored.join("\n"));
  return stored;
}

/**
 * Every tool the portal has seen a session register, so the settings page can
 * offer a default for one without a conversation being open.
 *
 * A remembered list rather than a live one: pi builds its registry when a
 * session starts, and nobody should have to start a chat to say that a tool
 * should be off in all of them. Refreshed whenever a session does report.
 */
export interface KnownTool {
  name: string;
  source: string;
  /** What the tool says it does, for the list shown before a chat has started. */
  description?: string;
  /**
   * The entry in pi's settings that brought it, so it can go when that does;
   * null for a tool that came from no package of the user's. Absent only in an
   * entry remembered before this was recorded.
   */
  package?: string | null;
  /**
   * Registered by one of the portal's own inline extensions, which nothing of anyone's can be mistaken for.
   * Every report says it, one way or the other; absent only in an entry remembered before this was recorded.
   */
  inline?: boolean;
}

/** A tool a session reported, as it is remembered. */
export const remembered = (t: { name: string; source: string; description?: string; package?: string; inline?: true }): KnownTool => ({
  name: t.name,
  source: t.source,
  description: t.description,
  package: t.package ?? null,
  inline: t.inline === true,
});

/**
 * What each package is called here, where somebody has said.
 *
 * An npm name is an address, not a label: `@juicesharp/rpiv-ask-user-question`
 * is the truth about where a thing came from and a poor heading for the list
 * of what it can do. So a group may be given a name, and keeps the address
 * underneath it for anyone who needs to install or remove the thing.
 *
 * Keyed by what the portal files a tool under — a package, an MCP server, or
 * "built in" — because that is what the heading says.
 */
export function toolGroupNames(): Record<string, string> {
  const raw = getSetting("tool_group_names");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const names: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const label = typeof value === "string" ? value.trim() : "";
      if (key.trim() && label) names[key] = label.slice(0, 60);
    }
    return names;
  } catch {
    return {};
  }
}

export function setToolGroupNames(names: Record<string, unknown>): Record<string, string> {
  const stored: Record<string, string> = {};
  for (const [key, value] of Object.entries(names ?? {})) {
    const label = typeof value === "string" ? value.trim() : "";
    // An empty one is not a name of its own; it is asking for the name back.
    if (key.trim() && label) stored[key.trim()] = label.slice(0, 60);
  }
  putSetting("tool_group_names", JSON.stringify(stored));
  return stored;
}

export function knownTools(): KnownTool[] {
  const raw = getSetting("tools_seen");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t) => t && typeof t.name === "string")
      .map((t) => ({
        name: String(t.name),
        source: String(t.source ?? ""),
        ...(typeof t.description === "string" && t.description ? { description: t.description } : {}),
        ...(typeof t.package === "string" && t.package ? { package: t.package } : t.package === null ? { package: null } : {}),
        ...(typeof t.inline === "boolean" ? { inline: t.inline } : {}),
      }));
  } catch {
    return [];
  }
}

/**
 * The remembered tools that can still be used: not the ones of a package that
 * is switched off or gone. What is remembered stays, for a package that comes
 * back; this is what the settings page and an idle chat show — without the
 * package, which is the portal's bookkeeping and not the page's business.
 * For a chat, `folder` is where it runs, whose project may bring packages of
 * its own.
 */
export function shownTools(folder?: string, view: McpView = mcpView()): (Omit<KnownTool, "package" | "inline"> & { inline?: true; cached?: true })[] {
  const user = readPiSettings().packages;
  const project = folder ? readProjectPiSettings(folder).packages : undefined;
  // An MCP server's tool that the adapter's configuration no longer registers
  // is not there to be switched: listing it was the list saying otherwise.
  const { offers } = view;
  const catalogue = mcpCatalogueIn(view, user, project);
  // The portal's own tools belong to no package, so the packages cannot say
  // that one is not offered: image generation and image editing say so
  // themselves, while they are off.
  // Only their own tools, which are known by being inline, as no label can say: an
  // extension of the same name is loaded whatever the add-on says, and a file
  // called image-generation.ts has the label the portal's factory has.
  const images = imageGenerationReady();
  const editing = imageEditingReady();
  const known = [...view.known().values()];
  // Every MCP server's tools, from the adapter's cache, whether a chat has had them one by one or not: a server is a
  // group like any other, whole or tool by tool. A tool a chat reported is listed as it reported it.
  const seen = new Set(known.map((t) => t.name));
  const available = [...known, ...catalogue.filter((t) => !seen.has(t.name))].filter(toolAvailability(user, project));
  return [...available, ...notYetSeen(available, images, editing)]
    .filter((tool) => images || !(tool.name === GENERATE_IMAGE_TOOL && tool.inline))
    .filter((tool) => editing || !(tool.name === EDIT_IMAGE_TOOL && tool.inline))
    .flatMap((known) => {
      const offer = offers(known);
      if (unlisted(offer)) return [];
      const { package: _package, inline: _inline, ...tool } = known;
      return [{
        ...tool,
        ...(portalOwned(known) ? { inline: true as const } : {}),
        ...(offer === "cached" ? { cached: true as const } : {}),
      }];
    });
}

/**
 * The portal's own tools that a setting just made, for the lists to show before any chat has reported them.
 *
 * What the lists show is what a chat once registered, and one that is open while the add-on is switched on
 * registers the tool after a reload without telling anyone. The tool is the portal's, so the lists know it
 * without waiting; a tool of the same name that a chat has reported, an extension's included while its package is on, is kept as it is.
 */
function notYetSeen(available: KnownTool[], images: boolean, editing: boolean): KnownTool[] {
  // Of the tools that can be loaded: an extension's of the same name in a package that is switched off is not, and the portal's is then the one chats have.
  const seen = new Set(available.map((tool) => tool.name));
  const wanted: [string, string, boolean][] = [
    [GENERATE_IMAGE_TOOL, GENERATE_IMAGE_SOURCE, images],
    [EDIT_IMAGE_TOOL, EDIT_IMAGE_SOURCE, editing],
  ];
  return wanted.filter(([name, , ready]) => ready && !seen.has(name)).map(([name, source]) => ({ name, source, package: null, inline: true }));
}

/** What the portal files its own picture tools under, by name. Read when asked: image-generation.ts imports this module. */
const pictureSource = (name: string): string | undefined =>
  ({ show_image: SHOW_IMAGE_SOURCE, [GENERATE_IMAGE_TOOL]: GENERATE_IMAGE_SOURCE, [EDIT_IMAGE_TOOL]: EDIT_IMAGE_SOURCE } as Record<string, string>)[name];

/**
 * Whether the portal registered this tool itself, for the pages to group its picture tools apart from an extension's of the same name.
 *
 * An entry remembered before `inline` was recorded has no mark at all, so a picture tool of no package,
 * filed under the label the portal files it under, counts too. A report always carries the mark, `false`
 * for an extension's tool, so a loose file called image-generation.ts is never taken for the portal's.
 */
export function portalOwned(tool: KnownTool): boolean {
  return tool.inline === true || (tool.inline === undefined && typeof tool.package !== "string" && pictureSource(tool.name) === tool.source);
}

/** The keys of the packages pi's settings list, or undefined when they cannot be read. */
function listedPackages(): Set<string> | undefined {
  const index = packageIndex(readPiSettings().packages);
  return index && new Set(index.byKey.keys());
}

/**
 * A package was uninstalled: its tools are not remembered any more, whichever
 * version of it they were recorded under. Run once it is gone from pi's
 * settings, so every tool whose package is no longer listed goes — which also
 * catches a folder written one way in the request and another in the settings.
 * Entries from before the package was recorded are found by the name it is
 * filed under. The defaults somebody set are kept, as for any tool that is not
 * loaded.
 *
 * An MCP server's tools are kept although the adapter registers them: the
 * server is configured apart from the package and comes back with it, and a
 * browser tool seen as new again would be given the browser's old default.
 */
export function forgetPackageTools(spec: string): void {
  const listed = listedPackages();
  const key = packageKey(spec);
  const label = packageLabel(spec);
  const servers = mcpServerNames();
  const gone = (t: KnownTool) => {
    if (mcpServerOf(t.name, servers) !== undefined) return false;
    if (typeof t.package === "string") return listed ? !listed.has(packageKey(t.package)) : packageKey(t.package) === key;
    // A guess, for a folder or a repository especially; one that guesses wrong
    // costs a loaded tool its entry only until the next chat reports it.
    return t.package === undefined && label !== undefined && t.source === label;
  };
  const all = knownTools();
  const kept = all.filter((t) => !gone(t));
  if (kept.length !== all.length) putSetting("tools_seen", JSON.stringify(kept));
}

/**
 * An MCP server was removed from the configuration: its tools are not
 * remembered any more, and the adapter's cache of them goes too, or the tools
 * would be listed under it for ever.
 *
 * `before` is the servers as they were, because a tool is told to a server by
 * its name (`browser_staging_click` is not the tool of `browser`) and that
 * needs the longer name to still be there; `after` is what is left. The
 * portal's own browser tools and the adapter's own are the ones a server's
 * name can claim without being its, and they stay. The defaults and exceptions
 * somebody set for the tools are kept, as for any tool that is not loaded: a
 * server that comes back gets them back.
 */
export function mcpServersRemoved(before: string[], after: string[]): void {
  const removed = before.filter((name) => !after.includes(name));
  // Remembered, so a chat that still has the server loaded cannot bring its tools back (see `rememberTools`).
  // A server that is configured again is not one that was removed.
  setRemovedMcpServers([...removedMcpServers(), ...removed].filter((name) => !after.includes(name)));
  if (!removed.length) return;
  const all = knownTools();
  const kept = all.filter((t) => {
    // A server's name is also the start of other tools' names: `web` and pi-web-access's `web_search`.
    if (!adapterTool(t) || noServerOf(t.name)) return true;
    const server = mcpServerOf(t.name, before);
    return server === undefined || !removed.includes(server);
  });
  if (kept.length !== all.length) putSetting("tools_seen", JSON.stringify(kept));
  dropMcpCache(removed);
}

/** The servers the portal has removed and that are not configured again, by name as they were configured. */
function removedMcpServers(): string[] {
  try {
    const parsed = JSON.parse(getSetting("mcp_removed") ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : [];
  } catch {
    return [];
  }
}

function setRemovedMcpServers(names: string[]): void {
  const unique = [...new Set(names)].sort();
  if (JSON.stringify(unique) !== JSON.stringify(removedMcpServers())) putSetting("mcp_removed", JSON.stringify(unique));
}

const ADAPTER_LABEL = "pi-mcp-adapter";

/** The tools that carry no server's name: the adapter's own and the portal's browser tools, which a server's name can start without them being its. */
const noServerOf = (name: string): boolean => (PORTAL_BROWSER_TOOLS as readonly string[]).includes(name) || name === "mcp" || name === "mcp_script" || name === "mcpScript";

/** Does the MCP adapter register this tool? By its package where it is recorded, by the label it is filed under where it is not. */
function adapterTool(t: Pick<KnownTool, "source" | "package">): boolean {
  return typeof t.package === "string" ? packageLabel(t.package) === ADAPTER_LABEL : t.source === ADAPTER_LABEL;
}

/**
 * The MCP adapter's configuration and cache as they stand now, read once for a
 * pass over a list or over every running chat (see mcp-offer.ts):
 * - `offers`: what the adapter does with each tool, undefined for a tool that
 *   is not a server's;
 * - `catalogue`: every tool of the servers the configuration has on, from the
 *   cache, as the portal remembers a tool: filed under the adapter's package,
 *   which brings them, so they go with it when it is switched off;
 * - `serverTool`: whether a name is a tool the adapter reaches on a server now,
 *   which is what an MCP script could call;
 * - `servers` and `gone`: the servers configured, and those the portal removed
 *   that are not configured again.
 *
 * A configuration that cannot be read is taken as it last could be: the panel
 * offers the file to be fixed, and a typo in it must neither withdraw a tool
 * nor hand back one that was withdrawn — a running chat is told its tools
 * again on any change of a default, and would otherwise get them back.
 */
export interface McpView {
  offers: (tool: Pick<KnownTool, "name" | "source" | "package">) => McpOffer | undefined;
  /** Filed under the adapter by its label; `mcpCatalogueIn` files them under its package where a chat would load it. */
  catalogue: KnownTool[];
  serverTool: (name: string) => boolean;
  servers: string[];
  gone: string[];
  /** What the portal remembers of every tool, read when first asked for. */
  known: () => Map<string, KnownTool>;
}

/** Which file this is now: the adapter and the portal both put theirs in place by renaming, which makes a new one. */
function fileStamp(file: string): string {
  try {
    const s = statSync(file);
    return `${s.ino}:${s.mtimeMs}:${s.size}`;
  } catch {
    return "-";
  }
}

let lastView: { stamp: string; view: McpView } | undefined;

/**
 * Asked for on every call of the `mcp` tools (pi/guard.ts) and for every list,
 * so kept until one of the files it reads, or the settings, are written.
 */
export function mcpView(): McpView {
  const stamp = `${fileStamp(mcpConfigPath())}|${fileStamp(mcpCachePath())}|${settingsWrites}`;
  if (lastView?.stamp === stamp) return lastView.view;
  const view = readMcpView();
  lastView = { stamp, view };
  return view;
}

function readMcpView(): McpView {
  const config = readableMcpConfig();
  let known: Map<string, KnownTool> | undefined;
  const knownNow = () => (known ??= new Map(knownTools().map((t) => [t.name, t])));
  if (!config) {
    return { offers: () => undefined, catalogue: [], serverTool: () => false, servers: [], gone: [], known: knownNow };
  }
  const cache = readMcpCache();
  const offer = mcpOffer(config, cache);
  const catalogue: KnownTool[] = mcpCatalogue(config, cache).map((t) => ({
    name: t.name,
    source: ADAPTER_LABEL,
    ...(t.description ? { description: t.description } : {}),
  }));
  const offers = (tool: Pick<KnownTool, "name" | "source" | "package">) =>
    adapterTool(tool) && !noServerOf(tool.name) ? offer(tool.name) : undefined;
  let reachable: Set<string> | undefined;
  const serverTool = (name: string) => {
    if (!reachable) {
      reachable = new Set(catalogue.map((t) => t.name));
      for (const tool of knownNow().values()) {
        const state = offers(tool);
        if (state !== undefined && state !== "withdrawn") reachable.add(tool.name);
      }
    }
    return reachable.has(name);
  };
  const servers = Object.keys(config.mcpServers ?? {});
  const gone = removedMcpServers().filter((name) => !servers.includes(name));
  return { offers, catalogue, serverTool, servers, gone, known: knownNow };
}

/**
 * The servers' tools from the adapter's cache as a chat in this folder would
 * have them: filed under the adapter's package as pi's settings list it (the
 * user's, or the folder's project's), so a package switched off takes them
 * with it whatever it was installed from. None where the adapter is in
 * neither: nothing would register them.
 */
function mcpCatalogueIn(view: McpView, packages: unknown, projectPackages: unknown): KnownTool[] {
  if (!view.catalogue.length) return [];
  const adapter = mcpAdapter(packages) ?? mcpAdapter(projectPackages);
  if (!adapter) return [];
  return view.catalogue.map((t) => ({ ...t, package: adapter.source }));
}

// A server taken out of the file, whoever wrote it, takes its tools with it.
onMcpWritten((before) => {
  const after = Object.keys(readableMcpConfig()?.mcpServers ?? {});
  if (before.some((name) => !after.includes(name)) || after.some((name) => !before.includes(name))) mcpServersRemoved(before, after);
});

/**
 * The tools of these that the MCP adapter no longer registers, by name: what a
 * chat's pi is told to have off on top of its switches, so that one still
 * holding such a tool from before the configuration changed cannot use it.
 * Told by what the portal remembers of each, which is what says it is the
 * adapter's; a name it has never seen is not judged — unless a server the
 * portal removed claims it: removing a server forgets its tools, and a chat
 * still running with it would otherwise go on using the tools of a server that
 * is gone, where one merely switched off would have them off.
 */
export function withdrawnMcpTools(names: Iterable<string> = [], view: McpView = mcpView()): string[] {
  const known = view.known();
  const { servers, gone } = view;
  const withdrawn = new Set<string>();
  for (const name of new Set([...names, ...known.keys()])) {
    const tool = known.get(name);
    if (tool) {
      if (view.offers(tool) === "withdrawn") withdrawn.add(name);
    } else if (gone.length && !noServerOf(name) && gone.includes(mcpServerOf(name, [...servers, ...gone]) ?? "")) {
      withdrawn.add(name);
    }
  }
  return [...withdrawn].sort();
}

/**
 * The servers' tools from the adapter's cache that a chat in this folder would
 * have with its packages, each marked where it is listed from the cache: what a
 * running chat's list adds to what it registered one by one.
 */
export function mcpCatalogueFor(folder: string | undefined, view: McpView): (Omit<KnownTool, "package" | "inline"> & { cached?: true })[] {
  if (!view.catalogue.length) return [];
  const user = readPiSettings().packages;
  const project = folder ? readProjectPiSettings(folder).packages : undefined;
  const available = toolAvailability(user, project);
  return mcpCatalogueIn(view, user, project)
    .filter(available)
    .map(({ package: _package, ...tool }) => ({ ...tool, ...(view.offers(tool) === "cached" ? { cached: true as const } : {}) }));
}

/**
 * What a package that has been uninstalled leaves behind: its tools, and what
 * was kept aside for switching it back on, which has nothing left to go to —
 * dropped in turn with the switches, which read and write it too.
 */
export async function packageRemoved(source: string): Promise<void> {
  forgetPackageTools(source);
  // The file itself is not touched: pi has just taken the package out of it,
  // and one the portal cannot read must not fail the removal that is done.
  await inTurnWithSettings(() => {
    const stash = extensionStash();
    if (source in stash) {
      delete stash[source];
      setExtensionStash(stash);
    }
  });
}

/**
 * Take up what a session reported. Merged rather than replaced: another
 * session may have extensions this one does not, and an extension that is
 * merely not loaded today should not lose the default somebody set for it.
 */
export function rememberTools(reported: KnownTool[]): void {
  // A session that still has a package loaded which has since been uninstalled
  // would write its tools straight back; a package no longer listed is not
  // remembered. One switched off still is, for when it comes back.
  const listed = listedPackages();
  // Likewise a chat that is still running with an MCP server that the portal has
  // since removed: its tools are the adapter's, and would be written straight back.
  // Only the servers the portal removed count: the adapter also loads some from
  // a project's own files, which are not in the portal's mcp.json and are no
  // removed server's. The adapter's own tools and the portal's browser tools
  // are no server's.
  const configured = readMcpFile();
  const gone = removedMcpServers().filter((name) => !Object.hasOwn(configured.config.mcpServers, name));
  const noServer = (t: KnownTool) =>
    gone.length > 0 &&
    !configured.error &&
    adapterTool(t) &&
    !noServerOf(t.name) &&
    // Told apart from the configured servers too: `notes` removed leaves `notes_staging_read` to the server that is still there.
    gone.includes(mcpServerOf(t.name, [...Object.keys(configured.config.mcpServers), ...gone]) ?? "");
  const tools = reported.filter(
    (t) => (typeof t.package !== "string" || !listed || listed.has(packageKey(t.package))) && !noServer(t),
  );
  if (!tools.length) return;
  const merged = new Map(knownTools().map((t) => [t.name, t]));
  const fresh = tools.map((t) => t.name).filter((name) => !merged.has(name));
  for (const tool of tools) {
    const before = merged.get(tool.name);
    // Kept short: it is a hint beside a checkbox, and the catalogue is one settings row.
    const description = tool.description?.trim().slice(0, 300) || before?.description;
    // A project that brings a package of the user's in its own settings reports
    // its tools as no package of the user's. The user's package still brings
    // them everywhere else, so they stay its while it is listed. Not for the
    // portal's own inline tool: it comes from no package, and one of the same
    // name that has been switched off (still listed) must not take it with it.
    const pkg =
      tool.package === null && !tool.inline && typeof before?.package === "string" && listed?.has(packageKey(before.package))
        ? before.package
        : tool.package;
    merged.set(tool.name, {
      name: tool.name,
      source: tool.source,
      ...(description ? { description } : {}),
      ...(pkg !== undefined ? { package: pkg } : {}),
      ...(tool.inline !== undefined ? { inline: tool.inline } : {}),
    });
  }
  const sorted = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  putSetting("tools_seen", JSON.stringify(sorted));
  // The first moment the browser's tools can be told apart from the rest, and
  // every moment a new one turns up.
  adoptBrowserGrants(getDb(), fresh);
}

/**
 * Domains the browser may be pointed at, as globs. Empty means no restriction —
 * the on/off switch is the gate, and a list nobody filled in should not quietly
 * block everything.
 */
export function browserAllowlist(): string[] {
  const raw = getSetting("browser_allowlist") ?? "";
  return raw
    .split(/[\n,]/)
    .map((d) => d.trim())
    .filter(Boolean);
}

export function setBrowserAllowlist(domains: string): void {
  putSetting("browser_allowlist", domains.trim());
}

/**
 * The model a chat's subagents run on, where the chat says one: "provider/model",
 * or "auto" for the one the chat is on. Null follows the portal's default.
 */
export function sessionSubagentModel(sessionId: string): string | null {
  return getSetting(`subagent_model:${sessionId}`) ?? null;
}

export function setSessionSubagentModel(sessionId: string, model: string | null): void {
  putSetting(`subagent_model:${sessionId}`, model ?? "");
}

/** A background subagent's start or end, as written: kept in open_subagents while it runs. */
function noteOpenSubagent(sessionId: string, payload: unknown): void {
  const p = payload as { op?: unknown; id?: unknown; detached?: unknown } | null;
  if (!p || p.detached !== true || typeof p.id !== "string") return;
  if (p.op === "start") getDb().prepare("INSERT OR IGNORE INTO open_subagents (session_id, id) VALUES (?, ?)").run(sessionId, p.id);
  else if (p.op === "end") getDb().prepare("DELETE FROM open_subagents WHERE session_id = ? AND id = ?").run(sessionId, p.id);
}

/** The background subagents one chat has open. */
export function openSubagentsIn(sessionId: string): string[] {
  return (getDb().prepare("SELECT id FROM open_subagents WHERE session_id = ?").all(sessionId) as { id: string }[]).map((r) => r.id);
}

/**
 * Background subagents a chat started and whose end was never written: the
 * process that ran them went with the last server.
 */
export function openDetachedSubagents(): { sessionId: string; id: string }[] {
  return (getDb().prepare("SELECT session_id, id FROM open_subagents").all() as { session_id: string; id: string }[]).map((r) => ({
    sessionId: r.session_id,
    id: r.id,
  }));
}
