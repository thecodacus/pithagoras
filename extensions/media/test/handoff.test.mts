import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { takeHandoff } from '../src/server/handoff.ts';
import { setPortal } from '../src/server/host.ts';
import { closeStore, getDb, getSetting, openStore, putSetting } from '../src/server/store.ts';
import { scratch } from '../../../tests/helpers.mts';

/**
 * Taking up what the portal kept of Media when Media became an extension: the rows of its galleries, its settings
 * and its files, from a hand-off folder as the upgrade leaves it, over a stand-in for the portal whose `handoffs`
 * give the folder from where Media's data folder has it.
 */

/** Media's data folder, its store open, and the portal it is given. `take` gives what is in <data>/handoff/<name>. */
function media() {
  const data = realpathSync(scratch('media-handoff-'));
  const logged: string[] = [];
  const kept = (name: string) => path.join(data, 'handoff', name);
  setPortal({
    log: (line: string) => logged.push(line),
    dataDir: () => data,
    handoffs: {
      take: (name: string) => (existsSync(kept(name)) ? kept(name) : undefined),
      done: (name: string) => rmSync(kept(name), { recursive: true, force: true }),
    },
  } as any);
  openStore(path.join(data, 'media.db'));
  return { data, logged, handoff: kept('media') };
}

const chatRow = { session_id: 'chat1', folder: null, kind: 'generated', prompt: 'a lighthouse', params: '{"model":"m"}', bytes: 120, chat: { workspace: '/named/project', real: '/real/project' } };
const IMAGES = [
  { id: 'aaaaaaaaaaaa', origin: 'page', session_id: null, folder: null, path: 'aaaaaaaaaaaa.png', kind: 'generated', prompt: 'a cat', params: '{"size":"1024x1024"}', source_id: null, bytes: 3, created_at: 1000, chat: null },
  { id: 'bbbbbbbbbbbb', origin: 'page', session_id: null, folder: null, path: 'bbbbbbbbbbbb.png', kind: 'edited', prompt: 'a cat, blue', params: '{"sources":["aaaaaaaaaaaa"]}', source_id: 'aaaaaaaaaaaa', bytes: 3, created_at: 2000, chat: null },
  { id: 'cccccccccccc', origin: 'chat', path: 'generated-images/c.png', source_id: null, created_at: 3000, ...chatRow },
  { id: 'dddddddddddd', origin: 'folder', session_id: null, folder: '/real/other', path: 'generated-images/d.png', kind: 'unknown', prompt: '', params: '{}', source_id: null, bytes: 9, created_at: 4000, chat: null },
  // A chat that was gone when the portal handed it over: no folder is known for it.
  { id: 'eeeeeeeeeeee', origin: 'chat', session_id: 'gone', folder: null, path: 'generated-images/e.png', kind: 'generated', prompt: 'x', params: '{}', source_id: null, bytes: 1, created_at: 5000, chat: null },
];
const VIDEOS = [
  { id: 'ffffffffffff', origin: 'page', session_id: null, folder: null, path: 'ffffffffffff.webm', kind: 'generated', prompt: 'waves', params: '{"fps":16}', bytes: 4, created_at: 6000, chat: null },
  { id: '111111111111', origin: 'chat', path: 'generated-videos/v.mp4', created_at: 7000, ...chatRow },
];
const SETTINGS = { image_generation: '{"enabled":true,"baseUrl":"http://images.example/v1","apiKey":"sk-1"}', video_generation: '{"enabled":true,"baseUrl":"http://videos.example"}' };

/** A hand-off as the upgrade leaves it, with `files` (path → text) beside its JSON. */
function leave(dir: string, files: Record<string, string>, settings: Record<string, string | null> = SETTINGS, format = 1) {
  const put = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  };
  for (const [rel, text] of Object.entries(files)) put(rel, text);
  put('handoff.json', JSON.stringify({ format, name: 'media', schema: 7, made: new Date().toISOString() }));
  put('settings.json', JSON.stringify(settings));
  put('images.json', JSON.stringify({ rows: IMAGES }));
  put('videos.json', JSON.stringify({ rows: VIDEOS }));
}

const FILES = {
  'files/images/aaaaaaaaaaaa.png': 'one',
  'files/images/bbbbbbbbbbbb.png': 'two',
  'files/videos/ffffffffffff.webm': 'clip',
  'cache/image-thumbs/aaaaaaaaaaaa-3-1.webp': 'thumb',
  'cache/video-posters/ffffffffffff-4-1.webp': 'poster',
  'cache/video-copies/ffffffffffff-4-1.webm': 'copy',
};

const rows = (table: string) => getDb().prepare(`SELECT * FROM ${table} ORDER BY created_at`).all() as Record<string, unknown>[];
const read = (file: string) => readFileSync(file, 'utf8');

test('what the portal kept is taken up: the rows as they were, a chat\'s with its real folder, the settings, and the files in Media\'s folder', () => {
  const { data, logged, handoff } = media();
  try {
    leave(handoff, FILES);
    takeHandoff();
    const images = rows('images');
    assert.deepEqual(images.map(({ chat_folder: _folder, ...row }) => row), IMAGES.map(({ chat: _chat, ...row }) => row), 'ids, paths and params as the portal had them');
    assert.deepEqual(images.map((row) => row.chat_folder), [null, null, '/real/project', null, null], "a chat's row keeps the real folder of its chat");
    const videos = rows('videos');
    assert.deepEqual(videos.map(({ chat_folder: _folder, ...row }) => row), VIDEOS.map(({ chat: _chat, ...row }) => row));
    assert.deepEqual(videos.map((row) => row.chat_folder), [null, '/real/project']);
    assert.equal(getSetting('image_generation'), SETTINGS.image_generation, 'the settings as they were stored, key and all');
    assert.equal(getSetting('video_generation'), SETTINGS.video_generation);
    assert.equal(read(path.join(data, 'images', 'aaaaaaaaaaaa.png')), 'one');
    assert.equal(read(path.join(data, 'images', 'bbbbbbbbbbbb.png')), 'two');
    assert.equal(read(path.join(data, 'videos', 'ffffffffffff.webm')), 'clip');
    assert.equal(read(path.join(data, 'image-thumbs', 'aaaaaaaaaaaa-3-1.webp')), 'thumb');
    assert.equal(read(path.join(data, 'video-posters', 'ffffffffffff-4-1.webp')), 'poster');
    assert.equal(read(path.join(data, 'video-copies', 'ffffffffffff-4-1.webm')), 'copy');
    assert.equal(existsSync(handoff), false, 'done with');
    assert.deepEqual(logged, ['took up what the portal kept of Media: 5 pictures and 2 videos, and the settings image_generation and video_generation']);
  } finally {
    closeStore();
  }
});

test('a setting saved in Media since is kept, and one the portal had none of is none', () => {
  const { handoff } = media();
  try {
    putSetting('image_generation', '{"enabled":false}');
    leave(handoff, {}, { image_generation: SETTINGS.image_generation, video_generation: null });
    takeHandoff();
    assert.equal(getSetting('image_generation'), '{"enabled":false}');
    assert.equal(getSetting('video_generation'), undefined);
    assert.equal(rows('images').length, IMAGES.length, 'with no files, the rows are taken up all the same');
  } finally {
    closeStore();
  }
});

test('taken up again, after a start that stopped half way, it does no harm: no row twice, no file over one that is there', () => {
  const { data, logged, handoff } = media();
  try {
    leave(handoff, FILES);
    takeHandoff();
    // What a start that stopped before it was done would find: the rows again, a file whose name Media has, one it has not.
    leave(handoff, { 'files/images/aaaaaaaaaaaa.png': 'other', 'cache/image-thumbs/bbbbbbbbbbbb-3-1.webp': 'thumb two' });
    takeHandoff();
    assert.equal(rows('images').length, IMAGES.length);
    assert.equal(rows('videos').length, VIDEOS.length);
    assert.equal(read(path.join(data, 'images', 'aaaaaaaaaaaa.png')), 'one', 'not over the file that is there');
    assert.deepEqual(readdirSync(path.join(data, 'image-thumbs')).sort(), ['aaaaaaaaaaaa-3-1.webp', 'bbbbbbbbbbbb-3-1.webp'], 'into the folder that is there, one by one');
    assert.equal(existsSync(handoff), false);
    assert.equal(logged.length, 2);
  } finally {
    closeStore();
  }
});

test('with nothing kept, nothing is done', () => {
  const { data, logged } = media();
  try {
    takeHandoff();
    assert.deepEqual([rows('images'), rows('videos')], [[], []]);
    assert.equal(getSetting('image_generation'), undefined);
    assert.deepEqual(readdirSync(data).sort(), ['media.db', 'media.db-shm', 'media.db-wal']);
    assert.deepEqual(logged, []);
  } finally {
    closeStore();
  }
});

test('a hand-off in a format this version does not read is left for one that does, and nothing of it is taken', () => {
  const { data, logged, handoff } = media();
  try {
    leave(handoff, FILES, SETTINGS, 2);
    takeHandoff();
    assert.deepEqual([rows('images'), rows('videos')], [[], []]);
    assert.equal(existsSync(path.join(data, 'images')), false);
    assert.equal(read(path.join(handoff, 'files', 'images', 'aaaaaaaaaaaa.png')), 'one', 'kept where it is');
    assert.match(logged[0], /kept for the next start: it is in a format this version of Media does not read \(2\)/);
  } finally {
    closeStore();
  }
});
