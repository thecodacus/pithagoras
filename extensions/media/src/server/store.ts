import { closeSync, openSync } from "node:fs";
import Database from "better-sqlite3";

/**
 * What Media keeps for itself: `media.db` in its own folder in the portal's data folder (`portal.dataDir()`), which
 * nobody but the portal can read. It holds the lists of the galleries and the settings of the endpoints, keys
 * included, which is why it is no file of a chat's folder, where an agent writes.
 *
 * The galleries' tables are the ones the portal had for them when Media was part of it, column for column, so that
 * the rows it handed over (see handoff.ts) are kept as they were, ids and paths included: the small copies, posters
 * and playable copies are named by the ids. They have one column more, `chat_folder`: the real folder of the chat a
 * chat's row was recorded for, kept for when the chat is deleted. The portal tells of that once the chat is gone, when
 * its folder cannot be asked for any more, and the chat's pictures stay as pictures of that folder (see keepChatPictures).
 */

const SCHEMA = `
  -- The pictures of the Media page: the ones it made itself, which are files in its own images folder, the ones the
  -- agent made in a chat with generate_image or edit_image, which are files in that chat's folder, and those found
  -- lying in a folder the tools write into that nobody listed (see image-gallery.ts). A row names the file, never
  -- holds it; one whose file is gone is dropped when the page next looks, and a chat's stay with its folder when the
  -- chat goes, as pictures found there. "path" is a file name in the images folder for the page's, and a path from
  -- the folder for the agent's: from the chat's, or, for one that was found, from "folder", the real path of the
  -- folder it was found in. "chat_folder" is the real folder of a chat's when it was recorded. "params" is what
  -- the request was made with, as JSON.
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
    created_at INTEGER NOT NULL,
    chat_folder TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_images_created ON images(created_at DESC, id DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_images_chat_file ON images(session_id, path) WHERE session_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_images_folder_file ON images(folder, path) WHERE folder IS NOT NULL;
  -- What was made of a picture, looked for whenever a picture is forgotten: without it each of them is a pass over the whole gallery.
  CREATE INDEX IF NOT EXISTS idx_images_source ON images(source_id) WHERE source_id IS NOT NULL;

  -- The clips of the Media page, as the pictures are listed above (see video-gallery.ts).
  CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    origin TEXT NOT NULL,
    session_id TEXT,
    folder TEXT,
    path TEXT NOT NULL,
    kind TEXT NOT NULL,
    prompt TEXT NOT NULL DEFAULT '',
    params TEXT NOT NULL DEFAULT '{}',
    bytes INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    chat_folder TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_videos_created ON videos(created_at DESC, id DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_videos_chat_file ON videos(session_id, path) WHERE session_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_videos_folder_file ON videos(folder, path) WHERE folder IS NOT NULL;

  -- The settings of the endpoints, as JSON, under the keys the portal kept them by: image_generation and video_generation.
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

let db: Database.Database | undefined;

/** Opens the store at `file`, making it where it is not there yet: what the half does as it starts. */
export function openStore(file: string): Database.Database {
  // Made before SQLite opens it, for the portal alone: it holds the keys, and SQLite gives its journal the database's mode.
  closeSync(openSync(file, "a", 0o600));
  const opened = new Database(file);
  opened.pragma("journal_mode = WAL");
  opened.exec(SCHEMA);
  db = opened;
  return opened;
}

/** Closes the store, as the half stops: what is still under way after that fails, and writes nothing. */
export function closeStore(): void {
  db?.close();
  db = undefined;
}

export function getDb(): Database.Database {
  if (!db) throw new Error("Media's store is not open");
  return db;
}

export function getSetting(key: string): string | undefined {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value || undefined;
}

/** Saves a setting; "" takes it away. */
export function putSetting(key: string, value: string): void {
  if (value) getDb().prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  else getDb().prepare("DELETE FROM settings WHERE key = ?").run(key);
}
