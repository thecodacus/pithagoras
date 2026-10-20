import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import path from 'node:path';
import { closeStore, getDb, getSetting, openStore, putSetting } from '../src/server/store.ts';
import { scratch } from '../../../tests/helpers.mts';

/** The store Media keeps in its own folder: its tables, its settings, and that it is the portal's alone. */

const columns = (table: string) => (getDb().prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
const indexes = (table: string) => (getDb().prepare(`PRAGMA index_list(${table})`).all() as { name: string; unique: number; partial: number }[])
  .filter((i) => !i.name.startsWith('sqlite_autoindex'))
  .map((i) => `${i.name}${i.unique ? ' unique' : ''}${i.partial ? ' partial' : ''}`)
  .sort();

test('the store has the tables the portal kept Media in, with the folder of a chat, and is closed to everyone but the portal', () => {
  const file = path.join(scratch('media-store-'), 'media.db');
  openStore(file);
  try {
    assert.deepEqual(columns('images'), ['id', 'origin', 'session_id', 'folder', 'path', 'kind', 'prompt', 'params', 'source_id', 'bytes', 'created_at', 'chat_folder']);
    assert.deepEqual(columns('videos'), ['id', 'origin', 'session_id', 'folder', 'path', 'kind', 'prompt', 'params', 'bytes', 'created_at', 'chat_folder']);
    assert.deepEqual(columns('settings'), ['key', 'value']);
    assert.deepEqual(indexes('images'), ['idx_images_chat_file unique partial', 'idx_images_created', 'idx_images_folder_file unique partial', 'idx_images_source partial']);
    assert.deepEqual(indexes('videos'), ['idx_videos_chat_file unique partial', 'idx_videos_created', 'idx_videos_folder_file unique partial']);
    assert.equal(getDb().pragma('journal_mode', { simple: true }), 'wal');
    putSetting('image_generation', '{"enabled":true}');
    // It holds the keys: the database and its journal are the portal's alone.
    for (const name of ['media.db', 'media.db-wal']) assert.equal(statSync(path.join(path.dirname(file), name)).mode & 0o777, 0o600, name);
  } finally {
    closeStore();
  }
});

test('a setting is kept as it is given, "" takes it away, and the store opened again has what was saved', () => {
  const file = path.join(scratch('media-store-'), 'media.db');
  openStore(file);
  putSetting('image_generation', '{"enabled":true,"baseUrl":"http://localhost:8080/v1"}');
  putSetting('video_generation', '{"enabled":false}');
  putSetting('video_generation', '');
  assert.equal(getSetting('video_generation'), undefined);
  closeStore();
  assert.throws(() => getDb(), /not open/, 'closed: what is still under way writes nothing');
  openStore(file);
  try {
    assert.equal(getSetting('image_generation'), '{"enabled":true,"baseUrl":"http://localhost:8080/v1"}');
    assert.equal(getSetting('video_generation'), undefined);
  } finally {
    closeStore();
  }
});
