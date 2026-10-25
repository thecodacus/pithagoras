import Database from "better-sqlite3";
import { inTurnWithSettings, piAgentDir, piSetting, readPiSettings, readProjectPiSettings, updatePiSettingsNow } from "./pi-settings.js";
import { packageIndex, packageKey, packageLabel, sourceOf, toolAvailability } from "./extension-switch.js";
import { isLocalSource, localPackagePath } from "./features.js";
import { GUARD_RULE_NAMES } from "./pi/guard-rule-names.js";
import { BUILT_IN_SET, PI_BUILT_IN_TOOLS, defaultsFor, lazyToolEntry, mcpServerOf, toolEnabled, toolSetOf } from "./tool-policy.js";
import { projectOf } from "./workspaces.js";
import { dropMcpCache, mcpAdapter, mcpCachePath, mcpConfigPath, mcpServerNames, mcpWritten, onMcpWritten, readMcpCache, readMcpFile, readableMcpConfig, serversAndBrowsers } from "./api/mcp.js";
import { mcpCatalogue, mcpDirect, mcpOffer, namingOf, unlisted, type McpOffer } from "./mcp-offer.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync } from "node:fs";
import path from "node:path";
import { isWithinText } from "./within.js";
import { baseDir, fitBytes, makeFolder, saveNewFile } from "./workspace-files.js";
import { agentHome, agentHomePath, homeAgentName } from "./agent-home.js";
import { DATA_DIR } from "./data-dir.js";
import { writeFileAtomic } from "./atomic-write.js";
import { handoffRoot, leaveHandoff, moveFolderTo, moveTo } from "./handoff.js";
import { RUNS_AS_PRIMARY } from "./pi/runs-as-primary.js";
import { CODEMODE_TOOL } from "./pi/codemode.js";
import { INLINE_EXTENSIONS } from "./pi/inline-extensions.js";
import { CORE_MODES, CUSTOM, providedModes, type ChatModeEntry } from "./chat-modes.js";
import { EXECUTOR_KIND } from "./executor-kind.js";
import { asksQuestions } from "./pi/ask-question.js";
import { freeSlug } from "./slug.js";
import { SCHEMA_VERSION, dbFile } from "./schema-version.js";
import { debugLog } from "./logs.js";
import { filesOnOldCalls } from "./old-call-files.js";

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
  /** Tools switched off for this conversation, newline separated. */
  tools_off: string;
  /** And switched on against a default that has them off. */
  tools_on: string;
  /** The mode it was started in (chat-modes.ts); null is Standard. */
  mode: string | null;
  /**
   * The chat this one is a child of (a sub-chat a server half made: `chats.create`), or null for a chat of its own.
   * One level only: a child has no children.
   */
  parent_id: string | null;
  /** 0 for a child kept out of the chat lists, found only by its id; 1 for every other chat. */
  listed: number;
  /** The package whose server half made this child, which alone may prompt, stop or remove it; null for any other chat. */
  creator: string | null;
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

/**
 * The chat whose people a chat's dialogs and questions are for: its own, and for a child chat its parent's. A child is
 * unlisted or out of the way, so where its parent has nobody to answer (a channel conversation, a routine run) a
 * question put on the child's page would wait for good, and with it the parent's work that waits on the child.
 */
export const dialogHost = (session: Pick<SessionRow, "kind" | "channel_slug"> & { parent_id?: string | null }): Pick<SessionRow, "kind" | "channel_slug"> =>
  (session.parent_id && getSession(session.parent_id)) || session;

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

    -- Which agent a project works with, and whether it does without the
    -- agent's memory where an extension holds it (memory_off).
    -- No row, or an empty agent, is a blank slate: the chats get the project's
    -- AGENTS.md and nothing else. Kept here and not as a file in the folder for
    -- the reason project_tools is: the agent works in the folder and can write
    -- to it, and whose soul and memory it gets is not for it to change. A project
    -- is only a folder, so it is known by its name; a row goes with the project.
    CREATE TABLE IF NOT EXISTS project_agent (
      project TEXT PRIMARY KEY,
      agent TEXT NOT NULL DEFAULT '',
      memory_off INTEGER NOT NULL DEFAULT 0
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

    -- The chat modes the person made (Settings → Modes): a chat in one stores "custom/<id>". Its tool layer is
    -- exceptions to what the layers under it leave, as a project's are; codemode 1 has its chats work through the
    -- code tool alone; instructions are said in its chats' system prompt; provider, model and thinking_level, where
    -- set, are written into a chat as it is put in the mode.
    CREATE TABLE IF NOT EXISTS chat_modes (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      tools_off TEXT NOT NULL DEFAULT '',
      tools_on TEXT NOT NULL DEFAULT '',
      codemode INTEGER NOT NULL DEFAULT 0,
      instructions TEXT NOT NULL DEFAULT '',
      provider TEXT,
      model TEXT,
      thinking_level TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Background subagents started and not yet ended, kept as their events
    -- are written: what a server that went left open is read from here at
    -- start, not dug out of every event there ever was.
    CREATE TABLE IF NOT EXISTS open_subagents (
      session_id TEXT NOT NULL,
      id TEXT NOT NULL,
      PRIMARY KEY (session_id, id)
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
      -- The voice it speaks with in voice mode: an id from the voices voice
      -- mode's source offers; NULL is the source's own choice.
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
 * Canvases are an extension's now (extensions/canvas), with a store of its own.
 * What a portal stored here before is written out as Markdown in its chat's
 * folder (`canvases/<title>.md`), where the person finds it among their files;
 * a chat whose folder is gone has its canvases written to the portal's data
 * folder instead (`canvases/` beside `backups/`). The table goes once it is
 * empty. The database was backed up before this ran (db-upgrade.ts).
 */
function writeOutCanvases(d: Database.Database): void {
  if (!d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'canvases'").get()) return;
  // Core filed its canvas tools as the set "canvases".
  setMoved(d, "canvases", "pithagoras-canvas");
  const rows = d.prepare("SELECT c.id, c.title, c.content, s.workspace FROM canvases c LEFT JOIN sessions s ON s.id = c.session_id").all() as { id: string; title: string; content: string; workspace: string | null }[];
  const gone = d.prepare("DELETE FROM canvases WHERE id = ?");
  const folderOf = (workspace: string | null) => {
    try {
      if (workspace !== null) return baseDir(workspace);
    } catch {
      // The chat's folder is gone: what it had goes to the data folder.
    }
    return baseDir(DATA_DIR);
  };
  for (const row of rows) {
    try {
      const base = folderOf(row.workspace);
      if (!existsSync(path.join(base, "canvases"))) makeFolder(base, "", "canvases");
      const name = fitBytes(row.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().replace(/^\.+/, "") || "canvas", 240);
      const kept = path.join(base, saveNewFile(base, "canvases", `${name}.md`, Buffer.from(row.content, "utf8")));
      console.log(`[portal] a stored canvas is now a Markdown file: ${kept}`);
      gone.run(row.id);
    } catch (e) {
      console.warn(`[portal] a stored canvas (${row.id}) could not be written out, and is kept for the next start: ${(e as Error).message}`);
    }
  }
  if (!(d.prepare("SELECT count(*) AS n FROM canvases").get() as { n: number }).n) d.exec("DROP TABLE canvases");
}

/**
 * Pictures and videos are an extension's now (extensions/media), with a store of
 * its own. What the Media page kept here is left for it in the data folder, as
 * it was (see handoff.ts), and the extension takes it up when it starts, which
 * may be long after this, or never: its rows, each with the folder of its chat
 * as it was then, its two settings, the page's own pictures and clips, and the
 * thumbnails, posters and playable copies it made, which are named by a row's
 * id and its file's size and time. The files are moved, not copied. The page's
 * pictures are only the files its rows name in the portal's images folder,
 * which also holds a folder of each chat's pictures sent with its messages:
 * those stay. The tables and settings go once it is left, and a try that fails
 * keeps them for the next start. The database was backed up before this ran
 * (db-upgrade.ts); docs/guide/upgrading.md says how the files are put back to
 * go back.
 */
function handOffMedia(d: Database.Database): void {
  if (!d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'images'").get()) return;
  const data = path.resolve(DATA_DIR);
  try {
    // A chat's folder, where it can be reached: the extension keeps the pictures of a chat that is deleted as pictures of that folder.
    const real = (workspace: string) => {
      try {
        return baseDir(workspace);
      } catch {
        return null;
      }
    };
    const rows = (table: string) =>
      (d.prepare(`SELECT t.*, s.workspace FROM ${table} t LEFT JOIN sessions s ON s.id = t.session_id`).all() as ({ origin: string; path: string; workspace: string | null } & Record<string, unknown>)[])
        .map(({ workspace, ...row }) => ({ ...row, chat: workspace === null ? null : { workspace, real: real(workspace) } }));
    const images = rows("images");
    // The clips came after the first release, and a database no build since has opened has none.
    const videos = d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'videos'").get() ? rows("videos") : [];
    const settings = { image_generation: settingIn(d, "image_generation") ?? null, video_generation: settingIn(d, "video_generation") ?? null };
    leaveHandoff("media", (dir) => {
      // What an earlier try moved is there already, and a file that is gone is gone: its row is left all the same, as the page would have kept it until it looked.
      const move = (from: string, to: string) => {
        if (existsSync(to) || !existsSync(from)) return;
        mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
        moveTo(from, to);
      };
      // A folder mounted on its own, or a link to one elsewhere, stays where it is: what is in it is moved. One that is
      // not there is moveFolderTo's to tell from one out of reach, of which an earlier try moved some.
      const moveFolder = (from: string, to: string) => {
        if (existsSync(to)) return;
        mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
        moveFolderTo(from, to);
      };
      for (const row of images) if (row.origin === "page") move(path.join(data, "images", row.path), path.join(dir, "files", "images", row.path));
      moveFolder(path.join(data, "videos"), path.join(dir, "files", "videos"));
      for (const cache of ["image-thumbs", "video-posters", "video-copies"]) moveFolder(path.join(data, cache), path.join(dir, "cache", cache));
      // Written last, and anew on each try, from the rows as they are.
      writeFileAtomic(path.join(dir, "images.json"), JSON.stringify({ rows: images }), 0o600);
      writeFileAtomic(path.join(dir, "videos.json"), JSON.stringify({ rows: videos }), 0o600);
      writeFileAtomic(path.join(dir, "settings.json"), JSON.stringify(settings), 0o600);
      writeFileAtomic(path.join(dir, "handoff.json"), JSON.stringify({ format: 1, name: "media", schema: 7, made: new Date().toISOString() }), 0o600);
    });
  } catch (e) {
    console.warn(`[portal] what the Media page kept could not be left for its extension, and is kept for the next start: ${(e as Error).message}`);
    return;
  }
  d.prepare("DELETE FROM settings WHERE key IN ('image_generation', 'video_generation')").run();
  d.exec("DROP TABLE images");
  d.exec("DROP TABLE IF EXISTS videos");
  // Core filed its picture and video tools as one set of their own: "<portal:media>", and in v0.1.0, before there were
  // videos, "<portal:images>". A name given to the newer one wins.
  setMoved(d, "<portal:media>", "pithagoras-media");
  setMoved(d, "<portal:images>", "pithagoras-media");
  mediaToolsSeenMoved(d);
  mediaToldOfRemovals(d);
}

/**
 * The extension takes up what was left whenever it first starts, which may be long after: it is told then of every
 * folder deleted since (see folderRemoved in extension-host.ts), as a server half that was not running is, for what it
 * takes up of a folder that went meanwhile to go too. A package seen for the first time is told of none, as what it
 * keeps is of no folder deleted before; this one keeps what the portal kept before.
 */
function mediaToldOfRemovals(d: Database.Database): void {
  let told: Record<string, number> = {};
  try {
    told = JSON.parse(settingIn(d, "folders_told") ?? "{}") ?? {};
  } catch {
    // Not JSON: the host reads it as nobody told yet, and so it is written anew.
  }
  if (told["pithagoras-media"] !== undefined) return;
  d.prepare("INSERT INTO settings (key, value) VALUES ('folders_told', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ ...told, "pithagoras-media": 0 }));
}

/**
 * The portal's picture and video tools as the tools lists remember them, each under a name of its own, filed under
 * the extension's package as its tools are. A chat says which tools it has when it next loads, and that would put
 * them right; until then they would be listed in boxes nothing fills any more, and a lazy mark on the set would not
 * reach them. An extension's tool of one of these names, which a chat reported as not inline, stays where it is.
 */
function mediaToolsSeenMoved(d: Database.Database): void {
  const sources: Record<string, string> = { show_image: "pictures", generate_image: "image-generation", edit_image: "image-editing", generate_video: "video-generation", show_video: "videos" };
  try {
    const seen = JSON.parse(settingIn(d, "tools_seen") ?? "[]");
    const portals = (tool: any) => typeof tool?.name === "string" && sources[tool.name] === tool.source && tool.inline !== false;
    if (!Array.isArray(seen) || !seen.some(portals)) return;
    d.prepare("UPDATE settings SET value = ? WHERE key = 'tools_seen'").run(JSON.stringify(seen.map((tool) => (portals(tool) ? { ...tool, source: "pithagoras-media", inline: true } : tool))));
  } catch {
    // Not JSON: knownTools reads it as nothing remembered, and so it stays.
  }
}

/** A setting as it is stored, for a step of the upgrade, which runs on the database before getDb gives it out. */
const settingIn = (d: Database.Database, key: string): string | undefined =>
  (d.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;

/** The settings the portal kept for its browser, which are the Browser extension's now. */
const BROWSER_SETTINGS = ["browser_user", "browser_password", "browser_port", "browser_https_port", "browser_cursor", "browser_tools"];

/** The tools the portal's browser registered, which the Browser extension registers under the same names. */
const BROWSER_TOOLS = [
  "browser_navigate",
  "browser_back",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_select",
  "browser_key",
  "browser_scroll",
  "browser_find",
  "browser_get_text",
  "browser_screenshot",
];

/** The tools the tools lists remember (`tools_seen`), as they are stored; nothing where that cannot be read. */
function toolsSeenIn(d: Database.Database): { name?: unknown; source?: unknown; inline?: unknown }[] {
  try {
    const seen = JSON.parse(settingIn(d, "tools_seen") ?? "[]");
    return Array.isArray(seen) ? seen : [];
  } catch {
    // Not JSON: knownTools reads it as nothing remembered.
    return [];
  }
}

/** One of the portal's browser tools as the tools lists remember it: filed under its own set, inline. */
const portalBrowserTool = (tool: { name?: unknown; source?: unknown; inline?: unknown }) =>
  typeof tool?.name === "string" && BROWSER_TOOLS.includes(tool.name) && tool.source === "browser" && tool.inline !== false;

/**
 * The agent's browser is an extension's now (extensions/browser), with settings of its own. What the portal kept for
 * it is left for it in the data folder (see handoff.ts), and the extension takes it up when it starts, which may be
 * long after this, or never: the browser's six settings as they were stored, its password among them, which the
 * container was made with, and the profile of the machine's own Chrome where it ran one, which is moved, not copied.
 * The settings go once it is left, and a try that fails keeps them for the next start. The container and its profile
 * volume stay where they are: the extension takes them over by their names. The allowlist stays, as the guard's.
 * The database was backed up before this ran (db-upgrade.ts); docs/guide/upgrading.md says how to go back.
 */
function handOffBrowser(d: Database.Database): void {
  const profile = path.join(path.resolve(DATA_DIR), "browser-profile");
  const settings = Object.fromEntries(BROWSER_SETTINGS.map((key) => [key, settingIn(d, key) ?? null]));
  if (Object.values(settings).every((value) => value === null) && !existsSync(profile) && !toolsSeenIn(d).some(portalBrowserTool)) return;
  try {
    leaveHandoff("browser", (dir) => {
      // A folder mounted on its own, or a link to one elsewhere, stays where it is: what is in it is moved.
      if (!existsSync(path.join(dir, "profile"))) moveFolderTo(profile, path.join(dir, "profile"));
      // Written last, and anew on each try, from the settings as they are.
      writeFileAtomic(path.join(dir, "settings.json"), JSON.stringify(settings), 0o600);
      writeFileAtomic(path.join(dir, "handoff.json"), JSON.stringify({ format: 1, name: "browser", schema: 8, made: new Date().toISOString() }), 0o600);
    });
  } catch (e) {
    console.warn(`[portal] what the browser kept could not be left for its extension, and is kept for the next start: ${(e as Error).message}`);
    return;
  }
  d.prepare(`DELETE FROM settings WHERE key IN (${BROWSER_SETTINGS.map(() => "?").join(", ")})`).run(...BROWSER_SETTINGS);
  // Core filed its browser tools as the set "browser"; the extension's are filed under its package.
  setMoved(d, "browser", "pithagoras-browser");
  // As the tools lists remember them: a chat says which tools it has when it next loads, and that would put them
  // right; until then they would be listed in a box nothing fills any more.
  const seen = toolsSeenIn(d);
  if (seen.some(portalBrowserTool)) {
    d.prepare("UPDATE settings SET value = ? WHERE key = 'tools_seen'").run(JSON.stringify(seen.map((tool) => (portalBrowserTool(tool) ? { ...tool, source: "pithagoras-browser", inline: true } : tool))));
  }
}

/**
 * Who may drive the browser was a switch of its own beside the tools' (`sessions.browser`, `routines.browser`, and
 * the carrying over of it as the portal's browser tools were first seen: `browser_tools_adopted`). It is the tools'
 * switches now, as for any tool: what each routine and chat had is written into its tools, once, as the database is
 * brought to schema 8. The columns stay, unread.
 *
 * The browser's tools were the portal's own and those seen of an MCP server that is a browser (serversAndBrowsers: a
 * Playwright server pointed at one): the switch and the grant answered for both. A routine's switch answered for each
 * of them its lists did not name, on or off: those are named now, as it said. The run of a routine that is gone was
 * refused them: off in it now, where it named none of them itself. A chat's grant was carried into the tools as they
 * were first seen, which made them off by default and on in the chats that had it: what was still to be carried,
 * where the portal waited for them, is carried now. An MCP server's tools not seen yet were never counted: they come
 * as any tool does.
 */
function browserGrantsToSwitches(d: Database.Database): void {
  const { servers, browsers } = serversAndBrowsers();
  const seen = new Set(toolsSeenIn(d).flatMap((tool) => (typeof tool?.name === "string" ? [tool.name] : [])));
  const ofBrowser = (name: string) => {
    const server = mcpServerOf(name, servers);
    return server !== undefined && browsers.includes(server);
  };
  const browser = clean([...BROWSER_TOOLS, ...[...seen].filter(ofBrowser)]);
  const unnamedIn = (lists: { tools_off: string; tools_on: string }) => {
    const off = parseToolsOff(lists.tools_off);
    const on = parseToolsOff(lists.tools_on);
    return { off, on, unnamed: browser.filter((name) => !off.includes(name) && !on.includes(name)) };
  };
  const routines = d.prepare("SELECT slug, browser, tools_off, tools_on FROM routines").all() as { slug: string; browser: number; tools_off: string; tools_on: string }[];
  const putRoutine = d.prepare("UPDATE routines SET tools_off = ?, tools_on = ? WHERE slug = ?");
  for (const routine of routines) {
    const { off, on, unnamed } = unnamedIn(routine);
    if (!unnamed.length) continue;
    (routine.browser === 1 ? on : off).push(...unnamed);
    putRoutine.run(clean(off).join("\n"), clean(on).join("\n"), routine.slug);
  }
  const gone = d.prepare("SELECT id, tools_off, tools_on FROM sessions WHERE kind = 'routine' AND routine_slug NOT IN (SELECT slug FROM routines)").all() as { id: string; tools_off: string; tools_on: string }[];
  const putRun = d.prepare("UPDATE sessions SET tools_off = ? WHERE id = ?");
  for (const run of gone) {
    const { off, unnamed } = unnamedIn(run);
    if (unnamed.length) putRun.run(clean([...off, ...unnamed]).join("\n"), run.id);
  }
  // Unmarked in a database no portal that carried grants has opened: one with no chat had nothing to carry, one with chats waited.
  const adopted = settingIn(d, "browser_tools_adopted") ?? (d.prepare("SELECT 1 FROM sessions LIMIT 1").get() ? "pending" : "1");
  if (adopted === "1") return;
  // Waiting, the grant answered for all of them; carrying, each was carried as it was first seen, and the rest are to be.
  const unseen = adopted === "pending" ? browser : browser.filter((name) => !seen.has(name));
  if (!unseen.length) return;
  d.prepare("INSERT INTO settings (key, value) VALUES ('tools_off_default', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    clean([...parseToolsOff(settingIn(d, "tools_off_default")), ...unseen]).join("\n"),
  );
  const granted = d.prepare("SELECT id, tools_on FROM sessions WHERE browser = 1 AND kind != 'routine'").all() as { id: string; tools_on: string }[];
  const putChat = d.prepare("UPDATE sessions SET tools_on = ? WHERE id = ?");
  for (const chat of granted) putChat.run(clean([...parseToolsOff(chat.tools_on), ...unseen]).join("\n"), chat.id);
}

/**
 * Where the voice service listened and spoke when it was the portal's, on the portal's loopback: the addresses connecting
 * it saved into voice mode's settings. Written out here, as an upgrade step does not change with the code after it.
 */
const VOICE_SERVICE_URLS = [
  "http://127.0.0.1:7862/v1/audio/speech",
  "http://127.0.0.1:7863/v1/audio/speech",
  "http://127.0.0.1:8188/inference",
  "http://127.0.0.1:7862/v1/audio/transcriptions",
  "http://127.0.0.1:7863/v1/audio/transcriptions",
];
/** An address of the voice service, as the portal told one: `localhost` is the same loopback, and a slash at the end is the same path. */
function voiceServiceUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) return false;
    return VOICE_SERVICE_URLS.includes(`http://127.0.0.1:${url.port}${url.pathname.replace(/\/+$/, "")}`);
  } catch {
    return false;
  }
}

/** The keys of voice mode's settings that stay the portal's: whether a spoken conversation is offered and how it goes, whatever listens and speaks for it. */
const VOICE_MODE_KEYS = ["vad", "responseInstructions", "skipThinkingProviders", "voiceModel", "conversation"];

/**
 * Voice mode listens and speaks through an extension now, the source, chosen on that extension's own page (`provider`
 * in the voice settings), and core keeps only how a spoken conversation goes. Everything the portal kept of the voice
 * service is the Voice extension's (pithagoras-voice), and the person's own speech servers are a small extension's
 * (pithagoras-voice-servers). What the portal kept for each is left for it in the data folder (see handoff.ts), and the
 * extension takes it up when it starts, which may be long after this, or never:
 *
 * - "voice-service": the voice library (each saved voice, a clone's recording as the bytes stored), the voice chosen,
 *   the designed voice's description, the engine settings and the input language, and the service's own settings: the
 *   GPU chosen on its page, a setup that had not come up yet, and whether its speech model was let go of once voice
 *   mode no longer used it. Left wherever any of it is there.
 * - "voice-addresses": the person's own addresses for recognition, speech and dictation, with their models, runtime,
 *   language and Kokoro voice. Where the service's addresses were in use, a side of the person's own is what connecting
 *   the service remembered of it (`voice_before_managed`), and a dictation address of their own beside the service's is
 *   theirs. Left wherever any address of theirs is there, whether voice mode was on or off, as their addresses are never
 *   overwritten.
 *
 * Leaving is not choosing. Voice mode that was on keeps the source chosen at version 8, or else takes the extension
 * that does what it did: the service where the service's addresses were in use, the person's own servers where theirs
 * were. Voice mode that was off has none. The voice settings then keep only `provider` and VOICE_MODE_KEYS.
 *
 * The step runs while the table of saved voices is there: it drops the table once all of it is left, so a database
 * that is done, or fresh, has nothing to do. While the table is there, a folder at either name is an earlier try's that
 * nothing has taken (a take moves it away first), and all of it is in the rows still: it is removed and left anew,
 * with any voices added since. A try that fails keeps everything for the next start. The spoken error line the portal
 * kept as a file goes, as voice mode asks the source for it as it starts. The container and its volume stay where they
 * are: Voice takes them over by their names. The database was backed up before this ran (db-upgrade.ts);
 * docs/guide/upgrading.md says how to go back.
 */
function handOffVoice(d: Database.Database): void {
  if (!d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'voice_presets'").get()) return;
  const stored = settingIn(d, "voice");
  let voice: any;
  let readable = stored !== undefined;
  try {
    voice = stored === undefined ? undefined : JSON.parse(stored);
  } catch {
    // Not JSON: voice mode could not read it either.
    readable = false;
  }
  const gpu = settingIn(d, "voice_gpu");
  const pending = settingIn(d, "voice_setup_pending");
  let kept: Record<string, any> = {};
  try {
    kept = JSON.parse(settingIn(d, "voice_before_managed") ?? "{}") ?? {};
  } catch {
    // Not JSON: nothing was kept of the person's own.
  }
  const voices = d.prepare("SELECT id, name, kind, instruction, transcript, audio FROM voice_presets ORDER BY rowid").all() as { id: string; name: string; kind: string; instruction: string; transcript: string; audio: Buffer | null }[];

  // Which source voice mode takes: the one chosen, else the one its addresses were, and none where it was off.
  const service = voiceServiceUrl(voice?.whisperUrl) || voiceServiceUrl(voice?.breezeUrl);
  const chosen = typeof voice?.provider === "string" ? voice.provider.trim() : "";
  const addresses = !service && typeof voice?.whisperUrl === "string" && voice.whisperUrl.trim() !== "";
  const provider = voice?.enabled !== true ? "" : chosen || (service ? "pithagoras-voice" : addresses ? "pithagoras-voice-servers" : "");

  // The person's own addresses, each side theirs: what connecting the service remembered where its addresses were in use.
  const listening = voiceServiceUrl(voice?.whisperUrl);
  // No speech address and the runtime none is the service's where a connect saved it. Where nothing says (a service connected by an older portal), it is when the recognition is.
  const speaking = voiceServiceUrl(voice?.breezeUrl) || (voice?.runtime === "none" && !voice?.breezeUrl && (typeof kept.noSpeech === "boolean" ? kept.noSpeech : listening));
  const dictation = voiceServiceUrl(voice?.dictationUrl);
  // A dictation address of the person's own beside the service's stays; one connecting the service remembered comes back; the service's own goes.
  const ownDictation = typeof voice?.dictationUrl === "string" && voice.dictationUrl.trim() !== "" && !dictation;
  const heard = listening ? kept.listening : voice;
  const spoken = speaking ? kept.speaking : voice;
  const dictated = ownDictation ? voice : listening ? kept.listening : dictation ? undefined : voice;
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  const number = (value: unknown) => (typeof value === "number" ? value : null);
  const own = {
    whisperUrl: text(heard?.whisperUrl),
    sttModel: text(heard?.sttModel),
    breezeUrl: text(spoken?.breezeUrl),
    runtime: text(spoken?.runtime),
    dictationUrl: text(dictated?.dictationUrl),
    dictationModel: text(dictated?.dictationModel),
    language: text(voice?.language),
    kokoroVoice: text(voice?.kokoroVoice),
  };
  const leaveAddresses = [own.whisperUrl, own.breezeUrl, own.dictationUrl].some((url) => !!url?.trim());
  const leaveService = readable || voices.length > 0 || gpu !== undefined || pending !== undefined;

  try {
    for (const name of ["voice-service", "voice-addresses"]) rmSync(path.join(handoffRoot(), name), { recursive: true, force: true });
    if (leaveService) {
      leaveHandoff("voice-service", (dir) => {
        // A clone's recording, as the bytes stored, named by its place in the list: no path is made of what is in the rows.
        const index = voices.map(({ audio, ...row }, n) => {
          if (!audio) return { ...row, audio: null };
          mkdirSync(path.join(dir, "voices"), { recursive: true, mode: 0o700 });
          writeFileAtomic(path.join(dir, "voices", `${n}.wav`), audio, 0o600);
          return { ...row, audio: `voices/${n}.wav` };
        });
        writeFileAtomic(path.join(dir, "voices.json"), JSON.stringify(index), 0o600);
        writeFileAtomic(
          path.join(dir, "settings.json"),
          JSON.stringify({
            gpu: gpu ?? null,
            setupPending: pending ?? null,
            lazyLoad: typeof voice?.lazyLoad === "boolean" ? voice.lazyLoad : null,
            voice: text(voice?.voice),
            instruction: text(voice?.instruction),
            cfgScale: number(voice?.cfgScale),
            exaggeration: number(voice?.exaggeration),
            kokoroVoice: text(voice?.kokoroVoice),
            speed: number(voice?.speed),
            language: text(voice?.language),
          }),
          0o600,
        );
        writeFileAtomic(path.join(dir, "handoff.json"), JSON.stringify({ format: 1, name: "voice-service", schema: 9, made: new Date().toISOString() }), 0o600);
      });
    }
    if (leaveAddresses) {
      leaveHandoff("voice-addresses", (dir) => {
        writeFileAtomic(path.join(dir, "settings.json"), JSON.stringify(own), 0o600);
        writeFileAtomic(path.join(dir, "handoff.json"), JSON.stringify({ format: 1, name: "voice-addresses", schema: 9, made: new Date().toISOString() }), 0o600);
      });
    }
  } catch (e) {
    console.warn(`[portal] what voice mode kept could not be left for its extensions, and is kept for the next start: ${(e as Error).message}`);
    return;
  }
  if (readable) {
    d.prepare("UPDATE settings SET value = ? WHERE key = 'voice'").run(
      JSON.stringify({ provider, ...Object.fromEntries(VOICE_MODE_KEYS.filter((key) => voice?.[key] !== undefined).map((key) => [key, voice[key]])) }),
    );
  } else if (stored !== undefined) {
    // Voice mode could not read it before either, and a save needs one it can read; the backup has it.
    d.prepare("DELETE FROM settings WHERE key = 'voice'").run();
  }
  d.prepare("DELETE FROM settings WHERE key IN ('voice_gpu', 'voice_setup_pending', 'voice_before_managed')").run();
  d.exec("DROP TABLE voice_presets");
  // The spoken error line, kept as a file of its own and as the file a write left half done: only those go, and the folder
  // where nothing else is in it. A cache: what is left of it does no harm, and nothing about it stops the upgrade.
  const lines = path.join(path.resolve(DATA_DIR), "voice");
  try {
    for (const name of readdirSync(lines)) if (/^\.?error-line-.+\.wav(\.[0-9a-f]{12}\.tmp)?$/.test(name)) rmSync(path.join(lines, name));
    rmdirSync(lines);
  } catch {
    // Not there, or not removed: left as it is.
  }
}

/** Understory's settings, when the portal ran it itself. Written out here, as an upgrade step does not change with the code after it. */
const UNDERSTORY_SETTINGS = ["understory_config", "understory_token", "understory_llm_token", "understory_last_dream"];

/**
 * The agent's memory in Understory is an extension's now (extensions/understory), with settings of its own. What the
 * portal kept for it is left for it in the data folder (see handoff.ts), and the extension takes it up when it starts,
 * which may be long after this, or never: its four settings as they were stored, among them the token its container
 * was made with, which the agent's MCP entry carries, and any key of the person's it was given. The settings go once
 * they are left, and a try that fails keeps them for the next start.
 *
 * The guard counted what Understory's server said as the person's own words while the person had not said which
 * servers are: from schema 10 it counts only those said. Where the person had said none, and Understory was in use (its
 * settings are there, or its server is in pi's mcp.json), it is said for them, once, as the database is brought to
 * schema 10, whatever comes of the rest.
 *
 * The MCP entry stays in pi's mcp.json, with its token, and its tools keep their names, switches and sets: they are
 * still the server `understory`'s. The container and its volume stay where they are: the extension takes them over by
 * their names. The database was backed up before this ran (db-upgrade.ts); docs/guide/upgrading.md says how to go back.
 */
function handOffUnderstory(d: Database.Database): void {
  const settings = Object.fromEntries(UNDERSTORY_SETTINGS.map((key) => [key, settingIn(d, key) ?? null]));
  const kept = Object.values(settings).some((value) => value !== null);
  const before10 = (d.pragma("user_version", { simple: true }) as number) < 10;
  if (before10 && settingIn(d, "guard_trusted_mcp_servers") === undefined && (kept || readMcpFile().config.mcpServers?.understory !== undefined)) {
    d.prepare("INSERT INTO settings (key, value) VALUES ('guard_trusted_mcp_servers', ?)").run(JSON.stringify(["understory"]));
  }
  if (!kept) return;
  try {
    leaveHandoff("understory", (dir) => {
      // Written last, and anew on each try, from the settings as they are.
      writeFileAtomic(path.join(dir, "settings.json"), JSON.stringify(settings), 0o600);
      writeFileAtomic(path.join(dir, "handoff.json"), JSON.stringify({ format: 1, name: "understory", schema: 10, made: new Date().toISOString() }), 0o600);
    });
  } catch (e) {
    console.warn(`[portal] what Understory kept could not be left for its extension, and is kept for the next start: ${(e as Error).message}`);
    return;
  }
  d.prepare(`DELETE FROM settings WHERE key IN (${UNDERSTORY_SETTINGS.map(() => "?").join(", ")})`).run(...UNDERSTORY_SETTINGS);
}

/** What the subagent tool read from pi's settings.json while it was a pi package alone. Written out here, as an upgrade step does not change with the code after it. */
const SUBAGENT_PI_KEYS = ["subagentMode", "subagentMaxParallel", "subagentModel"];

/**
 * A copy of the subagent tool that pi lists by its folder and that is no extension of the portal's: a clone from before
 * it was one, a package named `pithagoras-subagent` without a server half. pi still loads it, as a plain pi package,
 * and it reads the three keys from pi's settings.json, so those stay where it reads them.
 */
function plainSubagentCopy(pi: Record<string, unknown>): string | undefined {
  const agentDir = piAgentDir();
  for (const entry of Array.isArray(pi.packages) ? pi.packages : []) {
    const source = sourceOf(entry);
    if (!source || !isLocalSource(source)) continue;
    try {
      const dir = localPackagePath(source, agentDir);
      const meta = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
      if (meta?.name === "pithagoras-subagent" && typeof meta.pithagoras?.server !== "string") return dir;
    } catch {
      // Not a folder with a package, or not one that can be read: not a copy of the tool.
    }
  }
  return undefined;
}

/**
 * The subagent tool is an extension with a server half now (extensions/subagent), with settings of its own. What it
 * read from pi's settings.json is left for it in the data folder (see handoff.ts), and the extension takes it up when it
 * starts, which may be long after this, or never: the three keys as pi's settings held them, each null where they held
 * none. They leave pi's settings only once they are left, and a try that fails keeps them for the next start, as it does
 * a settings file that cannot be read. They were never in the database, so its backup does not hold them:
 * docs/guide/upgrading.md says how to put them back to go back.
 *
 * A hand-off that waits already (the upgrade of an earlier time, undone by going back) is written anew from the keys
 * as pi's settings hold them now, as the person may have changed them since. A copy of the tool that is no extension
 * keeps them, with a warning: nothing would take them up.
 */
function handOffSubagent(): void {
  const pi = readPiSettings();
  if (!SUBAGENT_PI_KEYS.some((key) => pi[key] !== undefined)) return;
  const copy = plainSubagentCopy(pi);
  if (copy) {
    console.warn(`[portal] the subagent settings stay in pi's settings.json: ${copy} is a copy of the subagent tool from before it was an extension, and still reads them there. Replace it with the one that comes with the portal (Settings → Extensions).`);
    return;
  }
  try {
    const kept = Object.fromEntries(SUBAGENT_PI_KEYS.map((key) => [key, pi[key] ?? null]));
    const fill = (dir: string) => {
      // Written last, and anew on each try, from the settings as they are.
      writeFileAtomic(path.join(dir, "settings.json"), JSON.stringify(kept), 0o600);
      writeFileAtomic(path.join(dir, "handoff.json"), JSON.stringify({ format: 1, name: "subagent", schema: 12, made: new Date().toISOString() }), 0o600);
    };
    if (leaveHandoff("subagent", fill) === "there") fill(path.join(handoffRoot(), "subagent"));
    updatePiSettingsNow((all) => {
      for (const key of SUBAGENT_PI_KEYS) delete all[key];
    });
  } catch (e) {
    console.warn(`[portal] the subagent settings in pi's settings.json could not be left for its extension, and are kept for the next start: ${(e as Error).message}`);
  }
}

/**
 * A set of the portal's own tools that are an extension's now, whose are filed
 * under its package's name: a lazy mark on the set, and a name somebody gave
 * its box, go with them.
 */
function setMoved(d: Database.Database, from: string, to: string): void {
  const put = d.prepare("UPDATE settings SET value = ? WHERE key = ?");
  const marks = parseToolsOff(settingIn(d, "tools_lazy"));
  if (marks.includes(from)) put.run([...new Set(marks.map((mark) => (mark === from ? to : mark)))].sort().join("\n"), "tools_lazy");
  try {
    const names = JSON.parse(settingIn(d, "tool_group_names") ?? "{}");
    if (names && typeof names === "object" && from in names && !(to in names)) {
      names[to] = names[from];
      delete names[from];
      put.run(JSON.stringify(names), "tool_group_names");
    }
  } catch {
    // Not JSON: toolGroupNames reads it as no names, and so it stays.
  }
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
  // Whether a chat could drive the browser, until schema 8 wrote it into the chat's tools (see
  // browserGrantsToSwitches). Kept, unread.
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
  // The mode a chat works in (chat-modes.ts): NULL is Standard, which every chat before schema 11 was.
  if (!names.includes("mode")) d.exec("ALTER TABLE sessions ADD COLUMN mode TEXT");
  // Child chats (schema 13): the chat a server half made one for, whether it is in the chat lists, and the package that
  // made it. Every chat before was one of its own, and listed.
  if (!names.includes("parent_id")) d.exec("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
  if (!names.includes("listed")) d.exec("ALTER TABLE sessions ADD COLUMN listed INTEGER NOT NULL DEFAULT 1");
  if (!names.includes("creator")) d.exec("ALTER TABLE sessions ADD COLUMN creator TEXT");
  // A chat's children are looked up as it is deleted, and as its pi asks whether one of them still works.
  d.exec("CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_id) WHERE parent_id IS NOT NULL");
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
  writeOutCanvases(d);
  handOffMedia(d);
  handOffBrowser(d);
  handOffVoice(d);
  handOffUnderstory(d);
  handOffSubagent();
  // Whether a project does without the agent's memory was named for what held it, Understory, until schema 10:
  // anything may hold it now (portal.memory.hold).
  const agentLinkCols = (d.prepare("PRAGMA table_info(project_agent)").all() as { name: string }[]).map((c) => c.name);
  if (agentLinkCols.includes("understory_off")) d.exec("ALTER TABLE project_agent RENAME COLUMN understory_off TO memory_off");
  if ((d.pragma("user_version", { simple: true }) as number) < 6) filesOnOldCalls(d);
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
  // Who may drive the browser, as a routine's switch, until schema 8 wrote it into the routine's tools (see
  // browserGrantsToSwitches). Kept, unread, as the sessions' column above is.
  if (routineCols.length && !routineCols.includes("browser")) {
    d.exec("ALTER TABLE routines ADD COLUMN browser INTEGER NOT NULL DEFAULT 0");
  }
  // A routine's exceptions to what its agent and project leave, as a chat keeps
  // them. Each on its own, as for sessions: a database with one of them is given the other.
  for (const col of ["tools_off", "tools_on"]) {
    if (routineCols.length && !routineCols.includes(col)) d.exec(`ALTER TABLE routines ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
  }
  d.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_routines_slug ON routines(slug)");
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
  // A rule for a tool that runs as the primary user never applies now, a heartbeat's included, and the API refuses to
  // make one. Those an older version made would stay listed as working: dropped.
  const asPrimary = Object.keys(RUNS_AS_PRIMARY);
  d.prepare(`DELETE FROM tool_rules WHERE tool IN (${asPrimary.map(() => "?").join(", ")})`).run(...asPrimary);
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
  seedCodemodeOff(d);
  // Last, because it reads the tables and settings above.
  if ((d.pragma("user_version", { simple: true }) as number) < 8) browserGrantsToSwitches(d);
}

/**
 * Code mode starts off: a chat has it when somebody switches it on there, or
 * for a project, an agent or every chat (see pi/codemode.ts). The tool is in
 * the portal-wide default as off, once, so that the operator can change that
 * default like any other, and a later start does not undo what they chose.
 */
function seedCodemodeOff(d: Database.Database): void {
  const flag = "codemode_off_seeded";
  if (d.prepare("SELECT 1 FROM settings WHERE key = ?").get(flag)) return;
  const row = d.prepare("SELECT value FROM settings WHERE key = 'tools_off_default'").get() as { value: string } | undefined;
  const off = clean([...parseToolsOff(row?.value), CODEMODE_TOOL]);
  const put = d.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  put.run("tools_off_default", off.join("\n"));
  put.run(flag, "1");
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
  /** A child chat's (see child-chats.ts): what it starts from, taken from its parent. */
  parent_id?: string | null;
  listed?: number;
  creator?: string | null;
  role?: SessionRow["role"];
  last_person_key?: string | null;
  mode?: string | null;
  provider?: string | null;
  model?: string | null;
  thinking_level?: string | null;
  tools_off?: string;
  tools_on?: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (id, title, workspace, executor, kind, channel_slug, channel_key, routine_slug, auto_title,
                             parent_id, listed, creator, role, last_person_key, mode, provider, model, thinking_level, tools_off, tools_on)
       VALUES (@id, @title, @workspace, @executor, @kind, @channel_slug, @channel_key, @routine_slug, @auto_title,
               @parent_id, @listed, @creator, @role, @last_person_key, @mode, @provider, @model, @thinking_level, @tools_off, @tools_on)`
    )
    .run({
      kind: "task",
      auto_title: 0,
      channel_slug: null,
      channel_key: null,
      routine_slug: null,
      parent_id: null,
      listed: 1,
      creator: null,
      role: "primary",
      last_person_key: null,
      mode: null,
      provider: null,
      model: null,
      thinking_level: null,
      tools_off: "",
      tools_on: "",
      ...row,
    });
}

/** A child chat that is kept out of the lists: it is found by its id alone. */
const UNLISTED = "parent_id IS NOT NULL AND listed = 0";

/** The sessions you create yourself, and the children of chats that are listed. Agent sessions have their own tab. */
export function listSessions(): SessionRow[] {
  // Pinned first, then most recently touched — the order the sidebar shows.
  return getDb()
    .prepare(`SELECT * FROM sessions WHERE kind = 'task' AND NOT (${UNLISTED}) ORDER BY pinned DESC, updated_at DESC`)
    .all() as SessionRow[];
}

/** The children of a chat, listed or not: see child-chats.ts. */
export function childSessions(parentId: string): SessionRow[] {
  return getDb().prepare("SELECT * FROM sessions WHERE parent_id = ? ORDER BY created_at, rowid").all(parentId) as SessionRow[];
}

/**
 * One session of every kind (tasks, routine runs, Agent-page and channel conversations, heartbeats) for each workspace they were made for, as stored.
 * Sessions are not pruned (a routine that makes a fresh session for each run keeps every one), but what an agent can reach depends on the workspace
 * and not on the session, so one of them stands for the rest. One query, and a row for each workspace, not for each session.
 */
export function sessionsByWorkspace(): SessionRow[] {
  return getDb().prepare("SELECT s.* FROM sessions s JOIN (SELECT MIN(id) AS id FROM sessions GROUP BY workspace) m ON s.id = m.id").all() as SessionRow[];
}

/**
 * The chats the sidebar lists: the tasks, and the conversations started on the
 * Agent page, which are chats with that agent like any other. Those that came
 * through a channel stay on the Agent page. A child chat is listed where it
 * was made to be (its parent named on it), and left out otherwise.
 */
export function listChatSessions(): SessionRow[] {
  return getDb()
    .prepare(`SELECT * FROM sessions WHERE (kind = 'task' OR (kind = 'agent' AND channel_slug = ?)) AND NOT (${UNLISTED}) ORDER BY pinned DESC, updated_at DESC`)
    .all(BROWSER_CHANNEL) as SessionRow[];
}

/** Whether any session has a turn running. */
export function anySessionRunning(): boolean {
  return Boolean(getDb().prepare("SELECT 1 FROM sessions WHERE status = 'running' LIMIT 1").get());
}

/** How many sessions have a turn running: chats, routine runs and agents' own looks alike. */
export function runningSessionCount(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM sessions WHERE status = 'running'").get() as { n: number }).n;
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
      | "mode"
      | "role"
      | "last_person_key"
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

// One transaction: the chat of a delete that failed stays, and it takes messages again, so it must still have its transcript.
// Inside the bulk routes' own transaction this is a savepoint, so they still remove all of their chats or none.
export const deleteSession = (id: string): void => getDb().transaction(() => removeSession(id))();

function removeSession(id: string): void {
  const d = getDb();
  // Its children go with it, in the same transaction: a child is the chat's own work, and has nothing to go on from
  // without it. One level only, so a child has none of its own.
  for (const child of childSessions(id)) removeSession(child.id);
  d.prepare("DELETE FROM events WHERE session_id = ?").run(id);
  d.prepare("DELETE FROM message_versions WHERE session_id = ?").run(id);
  d.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  setSessionSubagentModel(id, null);
  d.prepare("DELETE FROM open_subagents WHERE session_id = ?").run(id);
  d.prepare("DELETE FROM settings WHERE key = ?").run(trustedKey(id));
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

/** Whether a message or a command was ever sent in the chat: what fixes its mode. One whose messages were all removed has none again. */
export function chatSaid(sessionId: string): boolean {
  return Boolean(getDb().prepare("SELECT 1 FROM events WHERE session_id = ? AND type IN ('portal_prompt', 'portal_command') LIMIT 1").get(sessionId));
}

/** A mode the person made (Settings → Modes), as chat_modes keeps it: a chat in it stores "custom/<id>". */
export interface ChatModeRow {
  /** A slug of the label it was made with: a new label does not change it. */
  id: string;
  label: string;
  description: string;
  /** Its tool layer: exceptions to what the layers under it leave, one name a line, as a project's. */
  tools_off: string;
  tools_on: string;
  /** 1 where its chats work through the code tool alone. */
  codemode: number;
  /** Said in its chats' system prompt. */
  instructions: string;
  /** What a chat is put on as it is put in the mode, where set. */
  provider: string | null;
  model: string | null;
  thinking_level: string | null;
  created_at: string;
  updated_at: string;
}

/** The modes the person made, by their labels. */
export const customModes = (): ChatModeRow[] => getDb().prepare("SELECT * FROM chat_modes ORDER BY label COLLATE NOCASE").all() as ChatModeRow[];

export const customMode = (id: string): ChatModeRow | undefined => getDb().prepare("SELECT * FROM chat_modes WHERE id = ?").get(id) as ChatModeRow | undefined;

/**
 * Makes a mode, its id a slug of its label that no mode has, and no chat still stores: a chat keeps the mode of one
 * that was deleted, which a new mode of that name would take over. A slug and not a random id, so that such a chat
 * is said to be in "research", not in a code.
 */
export function createCustomMode(fields: { label: string; description: string }): ChatModeRow {
  const d = getDb();
  const made = d.prepare("SELECT id FROM chat_modes").all() as { id: string }[];
  const kept = d.prepare("SELECT DISTINCT substr(mode, ?) AS id FROM sessions WHERE mode LIKE ?").all(CUSTOM.length + 1, `${CUSTOM}%`) as { id: string }[];
  const id = freeSlug(fields.label, [...made, ...kept].map((row) => row.id), "mode");
  d.prepare("INSERT INTO chat_modes (id, label, description) VALUES (?, ?, ?)").run(id, fields.label, fields.description);
  return customMode(id)!;
}

/**
 * Changes what a mode says. Made to work through the code tool, it has that tool on in its layer too, where it had
 * it off: the mode works through it. Switched off in the mode's tools after that, it is the person's word, as in a chat.
 * Made not to, its layer no longer switches the tool on, which is then as the layers under the mode leave it.
 */
export function updateCustomMode(
  id: string,
  fields: Partial<Pick<ChatModeRow, "label" | "description" | "codemode" | "instructions" | "provider" | "model" | "thinking_level">>,
): ChatModeRow | undefined {
  const d = getDb();
  d.transaction(() => {
    const said = Object.entries(fields);
    d.prepare(`UPDATE chat_modes SET ${said.map(([name]) => `${name} = ?, `).join("")}updated_at = datetime('now') WHERE id = ?`).run(...said.map(([, value]) => value), id);
    if (fields.codemode !== undefined) {
      const tools = customModeTools(id);
      const on = tools.on.filter((name) => name !== CODEMODE_TOOL);
      setCustomModeTools(id, fields.codemode === 1 ? { off: tools.off.filter((name) => name !== CODEMODE_TOOL), on: [...on, CODEMODE_TOOL] } : { off: tools.off, on });
    }
  })();
  return customMode(id);
}

/** What a mode says about tools, as exceptions to what the layers under it leave. */
export function customModeTools(id: string): SessionTools {
  const row = getDb().prepare("SELECT tools_off, tools_on FROM chat_modes WHERE id = ?").get(id) as { tools_off: string; tools_on: string } | undefined;
  return { off: parseToolsOff(row?.tools_off), on: parseToolsOff(row?.tools_on) };
}

export function setCustomModeTools(id: string, tools: SessionTools): SessionTools {
  const stored = { off: clean(tools.off), on: clean(tools.on) };
  getDb()
    .prepare("UPDATE chat_modes SET tools_off = ?, tools_on = ?, updated_at = datetime('now') WHERE id = ?")
    .run(stored.off.join("\n"), stored.on.join("\n"), id);
  return stored;
}

/** Deletes a mode. The chats in it keep what they store, and are in a mode that is not there now. */
export function deleteCustomMode(id: string): boolean {
  return getDb().prepare("DELETE FROM chat_modes WHERE id = ?").run(id).changes > 0;
}

/** A mode the person made, as the modes are listed. */
export const customEntry = (row: ChatModeRow): ChatModeEntry => ({
  id: CUSTOM + row.id,
  label: row.label,
  description: row.description,
  tools: { off: parseToolsOff(row.tools_off), on: parseToolsOff(row.tools_on) },
  codemode: row.codemode === 1,
  ...(row.instructions ? { instructions: row.instructions } : {}),
  ...(row.provider ? { provider: row.provider } : {}),
  ...(row.model ? { model: row.model } : {}),
  ...(row.thinking_level ? { thinkingLevel: row.thinking_level } : {}),
});

/**
 * The modes a chat may be put in: none where it may not choose. A chat with the person on the portal's pages (a task
 * chat or an Agent-page chat, of the primary user: see asksQuestions), where pi runs in the portal's own process: a
 * mode is carried out where the portal starts a chat's pi, which a container's pi is not. The portal's own first,
 * then the ones the person made, by their names, then the extensions' in the order they were offered.
 */
export function modesFor(session: Pick<SessionRow, "kind" | "role" | "channel_slug"> & { parent_id?: string | null }): readonly ChatModeEntry[] {
  const host = dialogHost(session);
  return EXECUTOR_KIND === "host" && asksQuestions({ kind: host.kind, role: session.role }, onChannel(host))
    ? [...CORE_MODES, ...customModes().map(customEntry), ...providedModes()]
    : [];
}

/** A chat's mode, as it stores it: none for Standard, and none for one that is not there now. */
export function modeOf(stored: string | null | undefined): ChatModeEntry | undefined {
  if (!stored) return undefined;
  if (stored.startsWith(CUSTOM)) {
    const row = customMode(stored.slice(CUSTOM.length));
    return row && customEntry(row);
  }
  return CORE_MODES.find((mode) => mode.id === stored);
}

/**
 * Whether a chat in `mode` has the code tool held on: the mode's tools switch it on, whoever made the mode. The chat's
 * own switches cannot turn it off there (ownTools).
 */
export function modeHoldsCodemode(mode: string | null | undefined): boolean {
  return Boolean(modeOf(mode)?.tools?.on.includes(CODEMODE_TOOL));
}

/** The tools off for a chat in `mode`, given those off under it: the mode's layer folded in, as each layer is. */
const withMode = (off: string[], mode: string | null | undefined): string[] => {
  const layer = modeOf(mode)?.tools;
  return layer ? defaultsFor(off, layer) : off;
};

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

/** Takes a trusted result back. False when it was not trusted. */
export function untrustResult(sessionId: string, id: string): boolean {
  const had = trustedResults(sessionId);
  if (!had.has(id)) return false;
  const left = [...had].filter((one) => one !== id);
  putSetting(trustedKey(sessionId), left.length ? JSON.stringify(left) : "");
  return true;
}

/** Every conversation's trusted results, by the conversation: what the Guard page lists, to take back. */
export function allTrustedResults(): { sessionId: string; ids: string[] }[] {
  const prefix = trustedKey("");
  const rows = getDb().prepare("SELECT key, value FROM settings WHERE substr(key, 1, ?) = ?").all(prefix.length, prefix) as { key: string; value: string }[];
  return rows.flatMap(({ key, value }) => {
    try {
      const ids = JSON.parse(value);
      return Array.isArray(ids) && ids.length ? [{ sessionId: key.slice(prefix.length), ids: ids.filter((id): id is string => typeof id === "string") }] : [];
    } catch {
      return [];
    }
  });
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

/** The model spoken turns run on, as saved in the voice settings; undefined where they use the chat's own. */
export function getVoiceModel(): { provider: string; modelId: string } | undefined {
  try {
    const saved = JSON.parse(getSetting("voice") ?? "{}").voiceModel;
    const at = typeof saved === "string" ? saved.indexOf("/") : -1;
    return at > 0 && at < saved.length - 1 ? { provider: saved.slice(0, at), modelId: saved.slice(at + 1) } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether voice mode can speak: voice mode has a source, and it can speak now (not recognition alone). Set by the voice
 * routes, which know the source, and which this module cannot import.
 */
let speaks: () => boolean = () => false;
export function setVoiceSpeaks(read: typeof speaks): void {
  speaks = read;
}
export function voiceSpeaks(): boolean {
  return speaks();
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
 * much else — passwords, tokens and keys the portal keeps — and
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

/**
 * Writes a chat's model to its row when nothing names one for it, not even the
 * defaults. pi reopens such a chat on the model of its last answer, and after a
 * spoken turn on the voice model that would be the voice model.
 */
export function keepChatModel(sessionId: string, provider: string, model: string): void {
  const row = getSession(sessionId);
  if (row && !chatModel(row).model) updateSession(sessionId, { provider, model });
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

/** An approval that is still good: not spent, not run out. */
export interface OpenGrant {
  id: string;
  session_id: string;
  tool: string;
  subject: string;
  created_at: string;
  expires_at: string;
}

/** The approvals that are still good, the newest first: what the Guard page lists, to revoke. */
export function openGrants(): OpenGrant[] {
  return getDb()
    .prepare("SELECT id, session_id, tool, subject, created_at, expires_at FROM grants WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC")
    .all(new Date().toISOString()) as OpenGrant[];
}

/** Takes an approval back before it is spent: it is marked used, as one that was, so it never is. What it was; undefined when there was none to take. */
export function revokeGrant(id: string): OpenGrant | undefined {
  const open = openGrants().find((grant) => grant.id === id);
  if (!open) return undefined;
  getDb().prepare("UPDATE grants SET used_at = ? WHERE id = ? AND used_at IS NULL").run(new Date().toISOString(), id);
  return open;
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
  // What was decided and for which tool, not on what: the subject and the reason can hold a command, a path or a URL.
  debugLog("audit", entry.kind, { tool: entry.tool, session: entry.sessionId });
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

/** Where a routine's exemptions from the guard's rules are kept, by its id (a slug can be renamed): see routineExemptions. */
const exemptionsKey = (routineId: string) => `routine_guard_off:${routineId}`;

/**
 * The guard's rules (GUARD_RULE_NAMES) a routine's runs are exempt from: what the person switched off for it on the
 * Guard page, read at each call so that a change holds for a run that is going. A routine from before that page,
 * whose one switch was off, is exempt from all of them. An unknown routine, and every other session, from none.
 */
export function routineExemptions(slug: string | null | undefined): Set<string> {
  if (!slug) return new Set();
  const row = getDb().prepare("SELECT id, guard FROM routines WHERE slug = ?").get(slug) as { id: string; guard: number } | undefined;
  if (!row) return new Set();
  const stored = getSetting(exemptionsKey(row.id));
  if (stored === undefined) return new Set(row.guard === 1 ? [] : GUARD_RULE_NAMES);
  try {
    const names = JSON.parse(stored);
    return new Set(Array.isArray(names) ? names.filter((name): name is string => (GUARD_RULE_NAMES as readonly string[]).includes(name)) : []);
  } catch {
    // Not readable is not a reason to let anything through.
    return new Set();
  }
}

/**
 * Sets the rules a routine is exempt from, by name, and its one old switch with them: on (1) while it is exempt from
 * none, so that what reads only that sees the routine as it is. Names that are no rule are dropped.
 */
export function setRoutineExemptions(routineId: string, names: readonly string[]): void {
  const exempt = GUARD_RULE_NAMES.filter((name) => names.includes(name));
  getDb().transaction(() => {
    getDb().prepare("UPDATE routines SET guard = ? WHERE id = ?").run(exempt.length ? 0 : 1, routineId);
    putSetting(exemptionsKey(routineId), JSON.stringify(exempt));
  })();
}

/** Forgets a routine's exemptions, with the routine. */
export function forgetRoutineExemptions(routineId: string): void {
  putSetting(exemptionsKey(routineId), "");
}

/**
 * What the answer for some tools is worked out from apart from the conversation
 * asked about: the tools, and the defaults. A pass over many conversations asks
 * for it once.
 */
export interface ToolsPolicy {
  names: string[];
  defaultsOff: string[];
  /** What a place starts with, by agent, project and routine, worked out the first time a conversation there is asked about. */
  projects: Map<string, string[]>;
  /** The agents' homes, read the first time a conversation is asked about. */
  homes?: AgentHome[];
}

/** The policy of some tools, by name, whether or not a session has registered them: a tool nobody switched off is on. */
function toolPolicy(names: string[]): ToolsPolicy {
  return { names: [...new Set(names)], defaultsOff: toolDefaultsOff(), projects: new Map() };
}

/** Whether any of the policy's tools is on for a session; `exceptions` are the conversation's own, where the caller has them already. */
export function toolsOnWith(session: Pick<SessionRow, "id" | "kind" | "routine_slug" | "workspace" | "mode">, policy: ToolsPolicy, exceptions?: SessionTools): boolean {
  const routine = routineOf(session);
  // Every layer under the conversation's own: its agent, its project, its routine (none where the routine is gone), its mode.
  // By what decides it, not by folder: the chats in one project's subfolders share it.
  const homes = (policy.homes ??= agentHomes());
  const key = `${agentIdOf(session.workspace, homes) ?? ""}\u0000${projectOf(session.workspace) ?? ""}\u0000${routine ?? ""}\u0000${session.mode ?? ""}`;
  let defaults = policy.projects.get(key);
  if (!defaults) policy.projects.set(key, (defaults = withMode(toolDefaultsFor(session.workspace, routine, undefined, policy.defaultsOff, homes), session.mode)));
  const own = exceptions ?? sessionTools(session.id);
  return policy.names.some((name) => toolEnabled(name, defaults, own));
}

/**
 * Where some tools are not what the default says: whether a conversation that has never said anything about them
 * has any of them on, the chats that have them otherwise, and the routines whose own settings give their runs
 * another answer than a routine that sets nothing would have, each with that answer. What `portal.tools.exceptions`
 * answers.
 */
export interface ToolsDiffer {
  byDefault: boolean;
  /** Newest first. Each has the other answer to `byDefault`. */
  chats: SessionRow[];
  /** By name. */
  routines: { slug: string; name: string; allowed: boolean }[];
}

/** Where these tools are not what the default says (see ToolsDiffer). None named: none is on anywhere. */
export function toolExceptions(names: string[]): ToolsDiffer {
  if (!names.length) return { byDefault: false, chats: [], routines: [] };
  const policy = toolPolicy(names);
  const off = new Set(policy.defaultsOff);
  const byDefault = policy.names.some((name) => !off.has(name));
  return { byDefault, chats: chatsDifferingWith(policy, byDefault), routines: routinesDifferingWith(policy) };
}

/**
 * The conversations whose answer for the policy's tools is not `byDefault`.
 *
 * Every one that says anything about tools is asked — not those whose switches
 * happen to mention one of the names, which misses the ones that differ through
 * their project or their agent. And every one in a mode, which can differ through
 * its mode's layer without having said anything itself.
 */
function chatsDifferingWith(policy: ToolsPolicy, byDefault: boolean): SessionRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM sessions
       WHERE COALESCE(tools_off, '') != '' OR COALESCE(tools_on, '') != '' OR mode IS NOT NULL
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
  return rows.filter((row) => toolsOnWith(row, policy, ownTools(row)) !== byDefault);
}

/**
 * The routines whose own lists give their runs another answer for the policy's tools than a routine that says
 * nothing would have in the same place: a run as it starts, with what its agent and its project say, and nothing of a
 * chat's own. Each with its runs' answer.
 */
function routinesDifferingWith(policy: ToolsPolicy): { slug: string; name: string; allowed: boolean }[] {
  const rows = getDb().prepare("SELECT slug, name, workspace FROM routines ORDER BY name COLLATE NOCASE").all() as { slug: string; name: string; workspace: string | null }[];
  const homes = (policy.homes ??= agentHomes());
  return rows.flatMap((row) => {
    // Where its runs work: its project's folder, or Home.
    const workspace = row.workspace ?? agentHomePath();
    const allowed = toolsOnWith({ id: "", kind: "routine", routine_slug: row.slug, workspace, mode: null }, policy, { off: [], on: [] });
    const unsaidOff = toolDefaultsFor(workspace, null, undefined, policy.defaultsOff, homes);
    const otherwise = policy.names.some((name) => toolEnabled(name, unsaidOff, { off: [], on: [] }));
    return allowed === otherwise ? [] : [{ slug: row.slug, name: row.name, allowed }];
  });
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
  const row = getDb().prepare("SELECT tools_off, tools_on, mode FROM sessions WHERE id = ?").get(
    sessionId
  ) as Pick<SessionRow, "tools_off" | "tools_on" | "mode"> | undefined;
  return ownTools(row);
}

/**
 * What a chat's own switches say, from its row. Where its mode holds the code tool on (modeHoldsCodemode), an off of
 * the chat's own for it does not count: it stays stored, and counts again once the mode no longer holds it.
 */
function ownTools(row: Pick<SessionRow, "tools_off" | "tools_on" | "mode"> | undefined): SessionTools {
  const off = parseToolsOff(row?.tools_off);
  return { off: modeHoldsCodemode(row?.mode) ? off.filter((name) => name !== CODEMODE_TOOL) : off, on: parseToolsOff(row?.tools_on) };
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

/** What a project says about the agent it works with: see the table. A project that never said anything is a blank slate. */
export interface ProjectAgent {
  /** The agent's id; "" for none. */
  agent: string;
  /** Whether this project does without the agent's memory, where an extension holds it (memory-holder.ts). */
  memoryOff: boolean;
}

export function projectAgent(project: string): ProjectAgent {
  const row = getDb().prepare("SELECT agent, memory_off FROM project_agent WHERE project = ?").get(project) as
    | { agent: string; memory_off: number }
    | undefined;
  return { agent: row?.agent ?? "", memoryOff: !!row?.memory_off };
}

export function setProjectAgent(project: string, say: ProjectAgent): ProjectAgent {
  if (!say.agent && !say.memoryOff) clearProjectAgent(project);
  else
    getDb()
      .prepare(
        `INSERT INTO project_agent (project, agent, memory_off) VALUES (?, ?, ?)
         ON CONFLICT(project) DO UPDATE SET agent = excluded.agent, memory_off = excluded.memory_off`
      )
      .run(project, say.agent, say.memoryOff ? 1 : 0);
  return { agent: say.agent, memoryOff: say.memoryOff };
}

/** Forgets what a project said about its agent, as when it is deleted or made again. */
export function clearProjectAgent(project: string): void {
  getDb().prepare("DELETE FROM project_agent WHERE project = ?").run(project);
}

/**
 * Lets go of an agent that is deleted: the projects that worked with it are
 * blank slates again, and keep what they said about the agent's memory.
 */
export function releaseProjectsOf(agent: string): void {
  getDb().transaction(() => {
    getDb().prepare("UPDATE project_agent SET agent = '' WHERE agent = ?").run(agent);
    getDb().prepare("DELETE FROM project_agent WHERE agent = '' AND memory_off = 0").run();
  })();
}

/** What every project that says something about its agent says, by name. */
export function projectAgents(): Map<string, ProjectAgent> {
  const rows = getDb().prepare("SELECT project, agent, memory_off FROM project_agent").all() as {
    project: string;
    agent: string;
    memory_off: number;
  }[];
  return new Map(rows.map((r) => [r.project, { agent: r.agent, memoryOff: !!r.memory_off }]));
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
 */
export function routineTools(slug: string): SessionTools {
  const row = getDb().prepare("SELECT tools_off, tools_on FROM routines WHERE slug = ?").get(slug) as
    | { tools_off: string; tools_on: string }
    | undefined;
  return { off: parseToolsOff(row?.tools_off), on: parseToolsOff(row?.tools_on) };
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
 * 4. the routine, for its runs;
 * 5. the chat's mode, for a chat (toolDefaultsForSession): a run has none.
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
export function toolDefaultsForSession(session: Pick<SessionRow, "kind" | "routine_slug" | "workspace" | "mode"> | undefined, homes?: AgentHome[]): string[] {
  return withMode(toolDefaultsFor(session?.workspace, routineOf(session), undefined, undefined, homes), session?.mode);
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

/** What an extension said of a package it installed from its data folder (`extensions.install`), and when: by the package's spec. */
export type InstallNote = { note?: string; at: string };

export function installNotes(): Record<string, InstallNote> {
  try {
    const raw = JSON.parse(getSetting("extension_install_notes") || "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

/** Keeps what was said of the package `spec`, or with nothing, forgets it. */
export function setInstallNote(spec: string, record: InstallNote | undefined): void {
  const notes = installNotes();
  if (record) notes[spec] = record;
  else delete notes[spec];
  putSetting("extension_install_notes", Object.keys(notes).length ? JSON.stringify(notes) : "");
}

/** The minutes ask_question waits for an answer; 0, the default, is until it is answered. */
export const QUESTION_WAIT_MINUTES = [0, 5, 15, 30, 60] as const;

export function questionWaitMinutes(): number {
  const saved = Number(getSetting("ask_question_wait_minutes"));
  return (QUESTION_WAIT_MINUTES as readonly number[]).includes(saved) ? saved : 0;
}

/** Stores one of QUESTION_WAIT_MINUTES; returns undefined for anything else. */
export function setQuestionWaitMinutes(minutes: unknown): number | undefined {
  if (typeof minutes !== "number" || !(QUESTION_WAIT_MINUTES as readonly number[]).includes(minutes)) return undefined;
  putSetting("ask_question_wait_minutes", String(minutes));
  return minutes;
}

/** The wait for a question in milliseconds, read when it is asked. */
export function questionWaitMs(): number {
  return questionWaitMinutes() * 60_000;
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
 * What somebody marked lazy: tool sets, as the boxes of the tools list name them, and single tools
 * (lazyToolEntry). Opt-in: the portal marks nothing on its own, so an install has no lazy tool until
 * somebody says so.
 *
 * A lazy tool is not in the model's prompt — schema, description and guidelines — which is what a
 * large set such as the browser's costs otherwise in every request. The model finds it with `tools`
 * (search, describe, call) instead, so nothing is lost to it. It is a property of the tool and no
 * switch: a lazy tool is on or off like any other, by the portal-wide default and the agent, project,
 * routine and chat switches above it, and only a tool that is on is lazy. One that is off is off for
 * good and no way leads to it.
 */
export function lazyToolSets(): string[] {
  return parseToolsOff(getSetting("tools_lazy"));
}

/**
 * Can this tool be marked lazy, and have the portal's `tools` tool reach it? Any tool can but pi's own
 * (read, bash, edit and the rest are what a conversation works with at all), the MCP adapter's `mcp`
 * tool, the portal's code mode, a tool that is offered to scripts only, and an MCP server's. An MCP server's tool is lazy too, but not by a mark of the portal's: the
 * adapter has a way of its own to keep a server's tools out of the prompt, through its `mcp` tool, and
 * that is the server's setting "Register tools directly" (see lazyOfServer), the one switch for it. The
 * built-in tools are told by their names: the set they are filed in is the extension's that registers
 * them again, such as the sandbox's.
 */
export function lazyAllowed(
  tool: Pick<KnownTool, "name" | "source"> & { package?: string | null; inline?: boolean; cached?: boolean; scriptsOnly?: boolean },
  servers: string[] = mcpServerNames(),
): boolean {
  // Never in what the model is offered, so a mark would keep nothing out of the prompt: it is code mode's description that carries it.
  if (tool.scriptsOnly) return false;
  if (tool.cached || adapterTool({ source: tool.source, package: tool.package })) return false;
  if (!noServerOf(tool) && mcpServerOf(tool.name, servers) !== undefined) return false;
  if (PI_BUILT_IN_TOOLS.includes(tool.name)) return false;
  // Code mode is the way to make many calls in one: reached through another tool it would be one more step to it, and the
  // box the lists show it in has no set of its own on the server to mark.
  if (tool.inline && tool.name === CODEMODE_TOOL) return false;
  return toolSetOf(tool, servers) !== BUILT_IN_SET;
}

/** Does this mark name this tool: as a set it is filed in, or on its own? */
const marksTool = (mark: string, tool: KnownTool, servers: string[]): boolean =>
  mark === lazyToolEntry(tool.name) || mark === toolSetOf(tool, servers);

/** The names of the tools the portal has seen that are marked lazy, as a set or on their own, and may be. */
export function lazyToolNames(): Set<string> {
  const marks = lazyToolSets();
  if (!marks.length) return new Set();
  const servers = mcpServerNames();
  return new Set(
    knownTools()
      .filter((tool) => lazyAllowed(tool, servers) && marks.some((mark) => marksTool(mark, tool, servers)))
      .map((tool) => tool.name),
  );
}

/**
 * How a list of tools says which are lazy: not offered to the model one by one. Those the portal's `tools`
 * tool reaches are the ones marked (lazyToolNames). An MCP server's tool is lazy when the adapter leaves it
 * to its `mcp` tool, which is the server's setting "Register tools directly" turned off, and not by any
 * mark: `mcp` names that server, for the page to say where the one switch for it is.
 */
export function lazyMarks(view: McpView = mcpView()): (tool: Pick<KnownTool, "name" | "source" | "package">) => { lazy?: true; mcp?: string } {
  const portal = lazyToolNames();
  return (tool) => {
    const direct = view.direct(tool);
    if (direct === undefined) return portal.has(tool.name) ? { lazy: true as const } : {};
    const server = mcpServerOf(tool.name, view.servers);
    return { ...(direct ? {} : { lazy: true as const }), ...(server !== undefined ? { mcp: server } : {}) };
  };
}

/**
 * Of these marks, the ones that cannot be lazy: a set or a tool of an MCP server or of pi's own. Judged
 * by the tools the portal has seen of it; before it has seen one, by the name of the set. Any other mark is
 * let through, as it holds for the tools that turn up.
 */
export function lazyRefused(marks: string[]): string[] {
  const servers = mcpServerNames();
  const tools = knownTools();
  return clean(marks).filter((mark) => {
    const named = tools.filter((tool) => marksTool(mark, tool, servers));
    if (named.length) return named.every((tool) => !lazyAllowed(tool, servers));
    return mark === BUILT_IN_SET || servers.includes(mark) || PI_BUILT_IN_TOOLS.some((name) => mark === lazyToolEntry(name));
  });
}

/**
 * What the lazy tools among `names` are called as sets, for the line that tells the model they exist:
 * the name the settings page gives the box, once for each.
 */
export function lazySetLabels(names: Iterable<string>): string[] {
  const wanted = new Set(names);
  if (!wanted.size) return [];
  const servers = mcpServerNames();
  const given = toolGroupNames();
  const labels = new Set<string>();
  for (const tool of knownTools()) {
    if (!wanted.has(tool.name)) continue;
    const set = toolSetOf(tool, servers);
    labels.add(given[set] ?? set);
  }
  return [...labels].sort();
}

/** Make exactly these the lazy marks: sets and single tools, as lazyToolSets lists them. */
export function setLazyToolSets(marks: string[]): string[] {
  const lazy = clean(marks);
  putSetting("tools_lazy", lazy.join("\n"));
  return lazy;
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
  /**
   * Offered to scripts only: pi never activates it, so the model is not offered it, and code mode's description
   * carries it. Set only where it is so; a later report without it takes it back.
   */
  scriptsOnly?: true;
  /** Said by the tool: off until somebody switches it on. Read the first time the tool is seen, and not kept. */
  offByDefault?: true;
  /** The parameters that hold the files it is approved for, as its definition declares them: what an approval of it is written as, answered when no chat of it is running. */
  approvalFiles?: string[];
}

/** The parameters that hold the files a tool is approved for, as it last declared them: see declaredFiles in guard.ts. */
export function approvalFilesOf(toolName: string): string[] | undefined {
  return knownTools().find((t) => t.name === toolName)?.approvalFiles;
}

/** A tool a session reported, as it is remembered. */
export const remembered = (t: { name: string; source: string; description?: string; package?: string; inline?: true; scriptsOnly?: true; offByDefault?: true; approvalFiles?: string[] }): KnownTool => ({
  name: t.name,
  source: t.source,
  description: t.description,
  package: t.package ?? null,
  inline: t.inline === true,
  ...(t.scriptsOnly ? { scriptsOnly: true } : {}),
  ...(t.offByDefault ? { offByDefault: true } : {}),
  ...(t.approvalFiles?.length ? { approvalFiles: t.approvalFiles } : {}),
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
        ...(t.scriptsOnly === true ? { scriptsOnly: true } : {}),
        ...(Array.isArray(t.approvalFiles) && t.approvalFiles.length && t.approvalFiles.every((n: unknown) => typeof n === "string") ? { approvalFiles: t.approvalFiles as string[] } : {}),
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
/**
 * What each running server half that follows its settings offers now, by its name (`portal.tools.offer`): set by the
 * extension host, which this module cannot import.
 */
let serverHalfOffers: () => Map<string, { name: string; description?: string }[]> = () => new Map();
export function setServerHalfOffers(read: typeof serverHalfOffers): void {
  serverHalfOffers = read;
}

/**
 * The names of the server halves the extension host was last asked to run (askedHalves): of the installed packages,
 * those switched on that have one, running or not. Undefined until it has been asked once. Set by the extension host,
 * which this module cannot import.
 */
let serverHalvesAsked: () => ReadonlySet<string> | undefined = () => undefined;
export function setServerHalvesAsked(read: typeof serverHalvesAsked): void {
  serverHalvesAsked = read;
}

export function shownTools(folder?: string, view: McpView = mcpView()): (Omit<KnownTool, "package" | "inline"> & { inline?: true; cached?: true })[] {
  const user = readPiSettings().packages;
  const project = folder ? readProjectPiSettings(folder).packages : undefined;
  // An MCP server's tool that the adapter's configuration no longer registers
  // is not there to be switched: listing it was the list saying otherwise.
  const { offers } = view;
  const catalogue = mcpCatalogueIn(view, user, project);
  const known = [...view.known().values()];
  // Every MCP server's tools, from the adapter's cache, whether a chat has had them one by one or not: a server is a
  // group like any other, whole or tool by tool. A tool a chat reported is listed as it reported it.
  const seen = new Set(known.map((t) => t.name));
  // A server half that says what its pi extension registers now (portal.tools.offer): of its tools that are remembered,
  // only those are listed, and those are listed before a chat has reported them. Its tools are known by its name, which
  // the portal files them under as an inline extension's.
  const halves = serverHalfOffers();
  const offered = (tool: KnownTool) => !(tool.inline === true && halves.has(tool.source)) || halves.get(tool.source)!.some((t) => t.name === tool.name);
  // A server half's tool, which is an inline extension's that is not the portal's own, is listed while its package is
  // installed and switched on, whether the half runs, crashed or failed to start: one switched off or uninstalled
  // registers none, as a package's own tools are not listed then (toolAvailability). What was switched for it is kept,
  // for when it is switched on again. Before the halves have been asked for once, as the portal starts, nothing is
  // judged: hiding a tool on a guess is worse than showing a dead one.
  const asked = serverHalvesAsked();
  const halfOn = (tool: KnownTool) => !asked || tool.inline !== true || INLINE_EXTENSIONS.includes(tool.source) || asked.has(tool.source);
  const remembered = [...known, ...catalogue.filter((t) => !seen.has(t.name))].filter(toolAvailability(user, project)).filter(halfOn).filter(offered);
  const listed = new Set(remembered.map((t) => t.name));
  const fromHalves: KnownTool[] = [...halves].flatMap(([source, tools]) =>
    tools.filter((t) => !listed.has(t.name)).map((t) => ({ name: t.name, source, package: null, inline: true, ...(t.description ? { description: t.description } : {}) })),
  );
  return [...remembered, ...fromHalves].flatMap((known) => {
    const offer = offers(known);
    if (unlisted(offer)) return [];
    const { package: _package, inline, ...tool } = known;
    return [{
      ...tool,
      ...(inline ? { inline: true as const } : {}),
      ...(offer === "cached" ? { cached: true as const } : {}),
    }];
  });
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
 * server is configured apart from the package and comes back with it.
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
 * adapter's own tools and those of the portal's inline extensions are the ones
 * a server's name can claim without being its, and they stay. The defaults and
 * exceptions somebody set for the tools are kept, as for any tool that is not
 * loaded: a server that comes back gets them back.
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
    if (!adapterTool(t) || noServerOf(t)) return true;
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

/**
 * The servers of the portal's mcp.json as the portal last saw them, by name:
 * what an edit made outside the portal is judged against (noticeMcpEdits).
 * Kept in the settings, so one made while the portal was not running is
 * noticed when it starts again. Undefined until the portal first looks at the
 * file, which on an install from before this was kept is after whatever was
 * taken out of it by hand until then.
 */
function configuredMcpServers(): string[] | undefined {
  const value = getSetting("mcp_configured");
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : undefined;
  } catch {
    return undefined;
  }
}

function setConfiguredMcpServers(names: string[]): void {
  const unique = [...new Set(names)].sort();
  if (JSON.stringify(unique) !== JSON.stringify(configuredMcpServers())) putSetting("mcp_configured", JSON.stringify(unique));
}

const ADAPTER_LABEL = "pi-mcp-adapter";

/**
 * The tools that are no server's, though a server's name can start theirs: the adapter's own, by their names, and
 * every tool the portal's inline extensions register (its own, and each server half's under its package's name),
 * which no MCP server brings. Told by what is known of the tool, not by a list of names: a package's `browser_open`
 * is not the tool of a server called `browser`.
 */
const noServerOf = (tool: { name: string; inline?: boolean }): boolean =>
  tool.inline === true || tool.name === "mcp" || tool.name === "mcp_script" || tool.name === "mcpScript";

/** Does the MCP adapter register this tool? By its package where it is recorded, by the label it is filed under where it is not. */
export function adapterTool(t: Pick<KnownTool, "source" | "package">): boolean {
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
  /** Whether the adapter registers the tool one by one (`directTools`) and not through its `mcp` tool; undefined for a tool that is not a server's. */
  direct: (tool: Pick<KnownTool, "name" | "source" | "package">) => boolean | undefined;
  /** Filed under the adapter by its label; `mcpCatalogueIn` files them under its package where a chat would load it. */
  catalogue: KnownTool[];
  serverTool: (name: string) => boolean;
  servers: string[];
  /** The naming the adapter gives each configured server's tools (`toolPrefix`, see mcpPrefixAs). */
  naming: (server: string) => string;
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

/** The mcp.json that was last compared with the servers the portal last saw in it, by fileStamp. */
let noticedMcpFile: string | undefined;

/**
 * An edit made to the portal's mcp.json outside the portal — by hand, by a
 * script — taken in as a write of its own: the listeners are told
 * (onMcpWritten), with the servers the portal last saw in the file as the ones
 * it had before. A server the edit took out is removed as one taken out
 * through the panel is (its tools forgotten, its cache entry dropped, and it
 * recorded: see mcpServersRemoved), and a chat still running with it has its
 * tools off.
 * Asked for before the tools are listed or a chat's are worked out (mcpView),
 * and as the portal starts, so an edit made while it was not running is
 * noticed then. The file is read again only when it changed, and the
 * listeners are told only when its servers did.
 *
 * Only the servers of this file are judged: the adapter also loads some from a
 * project's own files, from `~/.config/mcp/mcp.json` and from what a file
 * imports, which are in no file the portal writes. Their tools are left as
 * they are, except where one of them has the name of a server taken out of
 * this file, or a name that starts with it and an underscore: its tools are
 * then taken for that server's, as for a removal through the panel. The first
 * time there is nothing to compare with, the servers there are now are
 * remembered and nothing is judged: a tool that a server taken out before then
 * left behind cannot be told from one of a project's own servers.
 * A file that cannot be read takes nothing out, as a typo in it withdraws
 * nothing (readableMcpConfig): it is compared again once it can be read. Nor
 * does one that is not there, as for a moment while an editor or a script puts
 * a new one in its place (`mv mcp.json mcp.json.bak` and then a new one
 * written): the file that is there next is compared with the servers last
 * seen, and a write of the portal's is judged against them too (onMcpWritten).
 */
export function noticeMcpEdits(): void {
  const stamp = fileStamp(mcpConfigPath());
  if (stamp === noticedMcpFile) return;
  // Before the listeners are told: what they do lists the tools again (mcpView), which must not compare the file again.
  noticedMcpFile = stamp;
  // Not there: fileStamp has "-" for a file it cannot look at.
  if (stamp === "-") return;
  const { config, error } = readMcpFile();
  if (error) return;
  const now = Object.keys(config.mcpServers);
  const seen = configuredMcpServers();
  if (seen === undefined) {
    setConfiguredMcpServers(now);
    return;
  }
  if (seen.length !== now.length || seen.some((name) => !now.includes(name))) mcpWritten(seen);
}

let lastView: { stamp: string; view: McpView } | undefined;

/**
 * Asked for on every call of the `mcp` tools (pi/guard.ts) and for every list,
 * so kept until one of the files it reads, or the settings, are written.
 */
export function mcpView(): McpView {
  // An edit made outside the portal first: taking it in forgets tools and writes the cache, and the view is of what is left.
  noticeMcpEdits();
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
    return { offers: () => undefined, direct: () => undefined, catalogue: [], serverTool: () => false, servers: [], naming: () => "server", gone: [], known: knownNow };
  }
  const cache = readMcpCache();
  const offer = mcpOffer(config, cache);
  const catalogue: KnownTool[] = mcpCatalogue(config, cache).map((t) => ({
    name: t.name,
    source: ADAPTER_LABEL,
    ...(t.description ? { description: t.description } : {}),
  }));
  const offers = (tool: Pick<KnownTool, "name" | "source" | "package">) =>
    adapterTool(tool) && !noServerOf(tool) ? offer(tool.name) : undefined;
  const directly = mcpDirect(config, cache);
  const direct = (tool: Pick<KnownTool, "name" | "source" | "package">) =>
    adapterTool(tool) && !noServerOf(tool) ? directly(tool.name) : undefined;
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
  return { offers, direct, catalogue, serverTool, servers, naming: (server: string) => namingOf(config, server), gone, known: knownNow };
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

// A server taken out of the file, whoever wrote it, takes its tools with it. Judged against the servers the file had
// and those the portal last saw in it: an edit made outside the portal that has not been noticed yet (noticeMcpEdits)
// may have taken one out, and a write of the portal's right after it must not make that one forgotten unjudged.
onMcpWritten((before) => {
  const after = Object.keys(readableMcpConfig()?.mcpServers ?? {});
  const was = [...new Set([...(configuredMcpServers() ?? []), ...before])];
  setConfiguredMcpServers(after);
  if (was.some((name) => !after.includes(name)) || after.some((name) => !was.includes(name))) mcpServersRemoved(was, after);
});

/**
 * The tools of these, as a chat reported them, and of those the portal
 * remembers, that the MCP adapter no longer registers, by name: what a chat's
 * pi is told to have off on top of its switches, so that one still holding
 * such a tool from before the configuration changed cannot use it. Told by
 * what the portal remembers of each, which is what says it is the adapter's;
 * a name it has never seen is not judged — unless a server the portal removed
 * claims it and the chat's report does not make it one of no server's
 * (noServerOf): removing a server forgets its tools, and a chat still running
 * with it would otherwise go on using the tools of a server that is gone,
 * where one merely switched off would have them off.
 */
export function withdrawnMcpTools(reported: Iterable<{ name: string; inline?: boolean }> = [], view: McpView = mcpView()): string[] {
  const known = view.known();
  const { servers, gone } = view;
  const asReported = new Map<string, { name: string; inline?: boolean }>();
  for (const tool of reported) if (!asReported.has(tool.name)) asReported.set(tool.name, tool);
  const withdrawn = new Set<string>();
  for (const name of new Set([...asReported.keys(), ...known.keys()])) {
    const tool = known.get(name);
    if (tool) {
      if (view.offers(tool) === "withdrawn") withdrawn.add(name);
    } else if (gone.length && !noServerOf(asReported.get(name) ?? { name }) && gone.includes(mcpServerOf(name, [...servers, ...gone]) ?? "")) {
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
 * What a package that has been uninstalled leaves behind: its tools, what was
 * kept aside for switching it back on, which has nothing left to go to, and what
 * an extension that installed it said of it — dropped in turn with the switches,
 * which read and write the first too.
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
    if (source in installNotes()) setInstallNote(source, undefined);
  });
}

/**
 * Take up what a session reported. Merged rather than replaced: another
 * session may have extensions this one does not, and an extension that is
 * merely not loaded today should not lose the default somebody set for it.
 *
 * A tool that arrives saying it is off until switched on (`offByDefault`) is switched off by default here, once:
 * from then on it is a default like any other, and somebody who switches it on by default has it on.
 *
 * Returns the tools that arrived just now and are lazy or off by default, for a caller that has conversations
 * running which were started without knowing them: they offer the tool, or offer it one by one, until they are told.
 */
export function rememberTools(reported: KnownTool[]): string[] {
  // A session that still has a package loaded which has since been uninstalled
  // would write its tools straight back; a package no longer listed is not
  // remembered. One switched off still is, for when it comes back.
  const listed = listedPackages();
  // Likewise a chat that is still running with an MCP server that the portal has
  // since removed: its tools are the adapter's, and would be written straight back.
  // Only the servers the portal removed count: the adapter also loads some from
  // a project's own files, which are not in the portal's mcp.json and are no
  // removed server's. The adapter's own tools and those of the portal's inline
  // extensions are no server's.
  const configured = readMcpFile();
  const gone = removedMcpServers().filter((name) => !Object.hasOwn(configured.config.mcpServers, name));
  const noServer = (t: KnownTool) =>
    gone.length > 0 &&
    !configured.error &&
    adapterTool(t) &&
    !noServerOf(t) &&
    // Told apart from the configured servers too: `notes` removed leaves `notes_staging_read` to the server that is still there.
    gone.includes(mcpServerOf(t.name, [...Object.keys(configured.config.mcpServers), ...gone]) ?? "");
  const tools = reported.filter(
    (t) => (typeof t.package !== "string" || !listed || listed.has(packageKey(t.package))) && !noServer(t),
  );
  if (!tools.length) return [];
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
      ...(tool.scriptsOnly ? { scriptsOnly: true } : {}),
      // As its latest report says: a tool that stopped declaring its files is approved whole again.
      ...(tool.approvalFiles?.length ? { approvalFiles: tool.approvalFiles } : {}),
    });
  }
  const sorted = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  putSetting("tools_seen", JSON.stringify(sorted));
  const off = tools.filter((t) => t.offByDefault && fresh.includes(t.name)).map((t) => t.name);
  if (off.length) setToolDefaultsOff([...new Set([...toolDefaultsOff(), ...off])]);
  const lazy = lazyToolNames();
  return fresh.filter((name) => lazy.has(name) || off.includes(name));
}

/**
 * The sites the agent's tools may reach, as globs (Settings → Guard). Empty
 * means no restriction — the tools' switches are the gate, and a list nobody
 * filled in should not quietly block everything.
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
 * The MCP servers whose tools' output the person counts as their own and not outside content, by the names they are
 * configured under: the guard neither wraps nor scans it (see untrustedResult in pi/guard.ts). Every other server's is
 * somebody else's words, and so is the browser's, trusted or not. Read at each result, so a change holds at once.
 */
export function trustedMcpServers(): Set<string> {
  // Until the person, or an extension on their word (`portal.mcp.set` with `trusted`), says one is, none.
  const set = getSetting("guard_trusted_mcp_servers");
  if (set === undefined) return new Set();
  try {
    const names = JSON.parse(set);
    return new Set(Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : []);
  } catch {
    return new Set();
  }
}

export function setTrustedMcpServers(names: readonly string[]): void {
  putSetting("guard_trusted_mcp_servers", JSON.stringify([...new Set(names.map((name) => name.trim()).filter(Boolean))]));
}

/** One server no longer counted as the person's own. */
export function untrustMcpServer(name: string): void {
  const trusted = trustedMcpServers();
  if (trusted.delete(name)) setTrustedMcpServers([...trusted]);
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
