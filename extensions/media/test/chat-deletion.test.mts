import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setPortal } from '../src/server/host.ts';
import { deletePicture, forgetPicturesIn, keepChatPictures, listPictures, openListed, recordChatPicture } from '../src/server/image-gallery.ts';
import { closeStore, getDb, openStore } from '../src/server/store.ts';
import { deleteVideo, forgetVideosIn, keepChatVideos, listVideos, openListedVideo, recordChatVideo } from '../src/server/video-gallery.ts';
import { folderFiles } from '../../../core/server/src/folder-files.ts';
import { scratch } from '../../../tests/helpers.mts';
import { WEBM } from './video-fixtures.mts';

/**
 * What becomes of the pictures and clips of a chat that goes, and of a folder the portal deletes: a chat's stay as
 * pictures of the folder it worked in, the one it had when they were recorded, and a folder's go with it. Over a
 * stand-in for the portal whose chats work in scratch folders, with the portal's own `files`.
 */

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(56)]);

/** Media's data folder and store, two projects with files the tools made in them, and chats `a`, `b` and `c` that work in the first. */
function media() {
  const data = realpathSync(scratch('media-chats-'));
  const project = realpathSync(scratch('media-project-'));
  const other = realpathSync(scratch('media-other-'));
  for (const folder of [project, other]) {
    mkdirSync(path.join(folder, 'generated-images'));
    mkdirSync(path.join(folder, 'generated-videos'));
    for (const name of ['a.png', 'a-edited.png', 'lost.png', 'dup.png']) writeFileSync(path.join(folder, 'generated-images', name), PNG);
  }
  const chats = new Map(['a', 'b', 'c'].map((id) => [id, { id, title: `Chat ${id}`, workspace: project, status: 'idle' }]));
  setPortal({
    log: () => {},
    dataDir: () => data,
    files: folderFiles,
    chats: {
      get: (id: string) => chats.get(id),
      folder: (id: string) => {
        const chat = chats.get(id);
        if (!chat) throw new Error('No such chat');
        return realpathSync(chat.workspace);
      },
    },
    folders: {
      list: () => [{ path: project, name: 'project', kind: 'project' }],
      allowed: (folder: string) => [project, other].includes(folder),
      label: (folder: string) => ({ name: path.basename(folder) }),
    },
  } as any);
  openStore(path.join(data, 'media.db'));
  return { data, project, other, chats };
}

const picture = (sessionId: string, file: string, from?: string[]) =>
  recordChatPicture({ sessionId, path: `generated-images/${file}`, kind: from ? 'edited' : 'generated', prompt: `made ${file}`, params: { model: 'm' }, bytes: PNG.length, ...(from ? { from } : {}) });
const images = () => getDb().prepare('SELECT id, origin, session_id, folder, path, prompt, source_id, chat_folder FROM images ORDER BY path').all() as Record<string, any>[];
const videos = () => getDb().prepare('SELECT id, origin, session_id, folder, path, chat_folder FROM videos ORDER BY path').all() as Record<string, any>[];
const idOf = (rows: Record<string, any>[], file: string) => rows.find((row) => row.path.endsWith(`/${file}`))!.id as string;
/** A cache file of Media's for the row `id`: a small copy, a poster or a playable copy. */
const cached = (data: string, folder: string, id: string) => {
  mkdirSync(path.join(data, folder), { recursive: true });
  writeFileSync(path.join(data, folder, `${id}-1-1.webp`), 'cached');
};
const caches = (data: string, folder: string) => (existsSync(path.join(data, folder)) ? readdirSync(path.join(data, folder)).map((name) => name.split('-')[0]).sort() : []);

test("a chat that goes leaves its pictures as pictures of its folder, with what they were asked for, and what cannot be kept goes", () => {
  const { data, project } = media();
  try {
    picture('a', 'a.png');
    picture('a', 'a-edited.png', ['generated-images/a.png']);
    picture('b', 'dup.png');
    // A picture of chat a that no folder is known for (its chat was gone when the portal handed it over), and an edit made of it.
    getDb().prepare("INSERT INTO images (id, origin, session_id, path, kind, created_at) VALUES ('000000000001', 'chat', 'a', 'generated-images/lost.png', 'generated', 1)").run();
    getDb().prepare("UPDATE images SET source_id = '000000000001' WHERE path = 'generated-images/dup.png'").run();
    // The same file as a picture of the folder already, found there before chat a recorded it.
    getDb().prepare("INSERT INTO images (id, origin, folder, path, kind, created_at) VALUES ('000000000002', 'folder', ?, 'generated-images/twice.png', 'unknown', 2)").run(project);
    getDb().prepare("INSERT INTO images (id, origin, session_id, path, kind, created_at, chat_folder) VALUES ('000000000003', 'chat', 'a', 'generated-images/twice.png', 'generated', 3, ?)").run(project);
    for (const row of images()) cached(data, 'image-thumbs', row.id);
    const before = images();

    keepChatPictures('a');

    const after = images();
    const a = after.find((row) => row.path === 'generated-images/a.png')!;
    assert.deepEqual(a, { ...before.find((row) => row.path === 'generated-images/a.png'), origin: 'folder', session_id: null, folder: project, chat_folder: null });
    const edited = after.find((row) => row.path === 'generated-images/a-edited.png')!;
    assert.equal(edited.origin, 'folder');
    assert.equal(edited.source_id, a.id, 'the edit still names its original, which stayed');
    assert.deepEqual(after.filter((row) => row.path === 'generated-images/twice.png').map((row) => row.id), ['000000000002'], 'one picture of the file');
    assert.equal(after.some((row) => row.id === '000000000001'), false, 'no folder to keep it in');
    assert.equal(after.find((row) => row.path === 'generated-images/dup.png')!.source_id, null, 'what was made of one that went no longer names it');
    assert.equal(after.find((row) => row.path === 'generated-images/dup.png')!.session_id, 'b', 'another chat in the folder keeps its own');
    assert.deepEqual(caches(data, 'image-thumbs'), after.map((row) => row.id).sort(), 'the small copies of those that went go too');
  } finally {
    closeStore();
  }
});

test("a chat that goes leaves its clips as its folder's, and the posters and playable copies of those that cannot be kept go", () => {
  const { data, project } = media();
  try {
    recordChatVideo({ sessionId: 'a', path: 'generated-videos/v.webm', kind: 'generated', prompt: 'waves', params: {}, bytes: 4 });
    getDb().prepare("INSERT INTO videos (id, origin, session_id, path, kind, created_at) VALUES ('000000000001', 'chat', 'a', 'generated-videos/lost.webm', 'generated', 1)").run();
    for (const row of videos()) {
      cached(data, 'video-posters', row.id);
      cached(data, 'video-copies', row.id);
    }
    const kept = idOf(videos(), 'v.webm');

    keepChatVideos('a');

    assert.deepEqual(videos(), [{ id: kept, origin: 'folder', session_id: null, folder: project, path: 'generated-videos/v.webm', chat_folder: null }]);
    assert.deepEqual(caches(data, 'video-posters'), [kept]);
    assert.deepEqual(caches(data, 'video-copies'), [kept], 'copies as well as posters');
  } finally {
    closeStore();
  }
});

test('the pictures of a chat that went while Media did not hear of it are kept as its folder\'s when the gallery is looked at', () => {
  const { project, chats } = media();
  try {
    picture('c', 'a.png');
    const id = idOf(images(), 'a.png');
    chats.delete('c');
    const kept = listPictures().pictures.find((p) => p.id === id)!;
    assert.deepEqual([kept.origin, kept.chat, kept.folder, kept.prompt], ['folder', null, { name: path.basename(project), home: false }, 'made a.png']);
  } finally {
    closeStore();
  }
});

test('the clips of a chat that went while Media did not hear of it are kept as its folder\'s when the gallery is looked at', () => {
  const { project, chats } = media();
  try {
    writeFileSync(path.join(project, 'generated-videos', 'v.webm'), WEBM);
    recordChatVideo({ sessionId: 'c', path: 'generated-videos/v.webm', kind: 'generated', prompt: 'waves', params: {}, bytes: WEBM.length });
    const id = idOf(videos(), 'v.webm');
    chats.delete('c');
    const kept = listVideos().videos.find((v) => v.id === id)!;
    assert.deepEqual([kept.origin, kept.chat, kept.folder, kept.prompt], ['folder', null, { name: path.basename(project), home: false }, 'waves']);
  } finally {
    closeStore();
  }
});

test('a picture or clip of a chat that went while Media did not hear of it is its folder\'s before it is opened or deleted, as before the gallery is looked at', async () => {
  const { project, chats } = media();
  try {
    picture('c', 'a.png');
    picture('c', 'lost.png');
    for (const name of ['v.webm', 'w.webm']) {
      writeFileSync(path.join(project, 'generated-videos', name), WEBM);
      recordChatVideo({ sessionId: 'c', path: `generated-videos/${name}`, kind: 'generated', prompt: `made ${name}`, params: {}, bytes: WEBM.length });
    }
    chats.delete('c');

    // Opened: sent from its folder, and still what it was asked for.
    const pictureId = idOf(images(), 'a.png');
    closeSync(openListed(pictureId).fd);
    assert.deepEqual(images().find((row) => row.id === pictureId), { id: pictureId, origin: 'folder', session_id: null, folder: project, path: 'generated-images/a.png', prompt: 'made a.png', source_id: null, chat_folder: null });
    const clipId = idOf(videos(), 'v.webm');
    closeSync(openListedVideo(clipId).fd);
    assert.deepEqual(videos().find((row) => row.id === clipId), { id: clipId, origin: 'folder', session_id: null, folder: project, path: 'generated-videos/v.webm', chat_folder: null });

    // Deleted: its file goes from the folder, so that it is not found there again.
    await deletePicture(idOf(images(), 'lost.png'));
    assert.equal(existsSync(path.join(project, 'generated-images', 'lost.png')), false);
    await deleteVideo(idOf(videos(), 'w.webm'));
    assert.equal(existsSync(path.join(project, 'generated-videos', 'w.webm')), false);
    assert.deepEqual([images().map((row) => row.path), videos().map((row) => row.path)], [['generated-images/a.png'], ['generated-videos/v.webm']]);

    // One with no folder to be kept in goes from the list, and a delete of it is done: nothing is left of it to remove.
    getDb().prepare("INSERT INTO videos (id, origin, session_id, path, kind, created_at) VALUES ('000000000001', 'chat', 'b', 'generated-videos/lost.webm', 'generated', 1)").run();
    chats.delete('b');
    await deleteVideo('000000000001');
    assert.deepEqual(videos().map((row) => row.path), ['generated-videos/v.webm']);
  } finally {
    closeStore();
  }
});

test('a folder the portal deletes takes what was made in it: the pictures and clips found there, and those of the chats that worked in it', () => {
  const { data, project, other } = media();
  try {
    picture('a', 'a.png');
    getDb().prepare("INSERT INTO images (id, origin, folder, path, kind, created_at) VALUES ('000000000001', 'folder', ?, 'generated-images/lost.png', 'unknown', 1)").run(project);
    getDb().prepare("INSERT INTO images (id, origin, folder, path, kind, created_at) VALUES ('000000000002', 'folder', ?, 'generated-images/lost.png', 'unknown', 2)").run(other);
    // A chat that worked in a folder inside it.
    getDb().prepare("INSERT INTO images (id, origin, session_id, path, kind, created_at, chat_folder) VALUES ('000000000003', 'chat', 'x', 'generated-images/a.png', 'generated', 3, ?)").run(path.join(project, 'sub'));
    recordChatVideo({ sessionId: 'a', path: 'generated-videos/v.webm', kind: 'generated', prompt: 'waves', params: {}, bytes: 4 });
    getDb().prepare("INSERT INTO videos (id, origin, folder, path, kind, created_at) VALUES ('000000000004', 'folder', ?, 'generated-videos/w.webm', 'unknown', 4)").run(other);
    for (const row of images()) cached(data, 'image-thumbs', row.id);
    for (const row of videos()) {
      cached(data, 'video-posters', row.id);
      cached(data, 'video-copies', row.id);
    }

    assert.equal(forgetPicturesIn(project), 3);
    assert.equal(forgetVideosIn(project), 1);

    assert.deepEqual(images().map((row) => row.id), ['000000000002'], "another folder's stay");
    assert.deepEqual(videos().map((row) => row.id), ['000000000004']);
    assert.deepEqual(caches(data, 'image-thumbs'), ['000000000002']);
    assert.deepEqual(caches(data, 'video-posters'), ['000000000004']);
    assert.deepEqual(caches(data, 'video-copies'), ['000000000004']);
  } finally {
    closeStore();
  }
});
