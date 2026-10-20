import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { realpathSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import express from 'express';
import media from '../src/server.ts';
import { getDb } from '../src/server/store.ts';
import { folderFiles } from '../../../core/server/src/folder-files.ts';
import { scratch } from '../../../tests/helpers.mts';

/**
 * Media's server half as the portal starts it, over a stand-in for the portal: the tools it offers and registers as
 * the settings change, the routes of its settings, what it does when a chat or a folder goes, and a stop that ends
 * its jobs and closes its store, after which it starts again.
 */

/** The portal a start is given, its routes served at `base`. */
async function start(data: string) {
  const life = new EventEmitter();
  const removed: ((folder: string) => void)[] = [];
  const factories: ((pi: any, chat: any) => void)[] = [];
  let offered: () => { name: string; description?: string }[] = () => [];
  let reloads = 0;
  const router = express.Router();
  const stop = media({
    extension: 'pithagoras-media',
    log: () => {},
    dataDir: () => data,
    handoffs: { take: () => undefined, done: () => {} },
    tools: { offer: (fn: typeof offered) => void (offered = fn) },
    router,
    http: { json: express.json, raw: express.raw, text: express.text },
    files: folderFiles,
    chats: {
      get: () => undefined,
      on: (event: string, handler: (chat: string) => void) => void life.on(event, handler),
      extend: (factory: (pi: any, chat: any) => void) => void factories.push(factory),
      reload: async () => ({ reloaded: ++reloads, waiting: 0 }),
    },
    folders: { on: (_event: string, handler: (folder: string) => void) => void removed.push(handler) },
  } as any) as () => void;
  const app = express().use('/api/x/pithagoras-media', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/x/pithagoras-media`;
  return {
    base,
    life,
    removed: (folder: string) => removed.forEach((handler) => handler(folder)),
    offered: () => offered().map((tool) => tool.name),
    reloads: () => reloads,
    /** The tools a chat's pi is given as it loads. */
    registered: () => {
      const tools: Record<string, any> = {};
      for (const factory of factories) factory({ registerTool: (tool: any) => (tools[tool.name] = tool) }, { id: 'chat', title: 'Chat', workspace: data, status: 'idle' });
      return tools;
    },
    stop: async () => {
      stop();
      server.close();
      await once(server, 'close');
    },
  };
}

const json = async (url: string, init?: { method: string; body: unknown }) => {
  const res = await fetch(url, init ? { method: init.method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) } : undefined);
  return { status: res.status, body: await res.json() };
};

/** An image endpoint that takes a request and never answers it, and says when one is let go. */
async function silentEndpoint() {
  const asked: string[] = [];
  const dropped = new EventEmitter();
  const server = createServer((socket) => {
    socket.once('data', (chunk) => asked.push(chunk.toString('latin1').split('\r\n')[0]));
    socket.on('close', () => dropped.emit('dropped'));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, asked, dropped, close: () => server.close() };
}

test('the tools follow the settings: offered and registered alike, with their voice lines, and a change in them reloads the chats', async () => {
  const p = await start(realpathSync(scratch('media-half-')));
  try {
    assert.deepEqual(await json(`${p.base}/state`), { status: 200, body: { images: { enabled: false }, videos: { enabled: false } } });
    assert.deepEqual(p.offered(), ['show_image'], 'show_image is always there');
    assert.deepEqual(Object.keys(p.registered()), ['show_image']);
    assert.deepEqual(p.registered().show_image.voiceGuidelines, ['To show the user a picture, chart, diagram or screenshot, save it as a PNG, JPEG, GIF or WebP in the chat folder and call show_image.']);

    const images = await json(`${p.base}/settings/images`, { method: 'PUT', body: { enabled: true, baseUrl: 'http://127.0.0.1:9/v1', editEnabled: true, editMultiple: true, apiKey: 'sk-secret' } });
    assert.equal(images.status, 200);
    assert.deepEqual([images.body.changed, images.body.reloaded, images.body.images.ready, images.body.images.editReady, images.body.images.keySet], [true, 1, true, true, true]);
    assert.equal(JSON.stringify(images.body).includes('sk-secret'), false, 'never the key');
    assert.deepEqual(p.offered(), ['show_image', 'generate_image', 'edit_image']);
    const tools = p.registered();
    assert.deepEqual(Object.keys(tools), p.offered());
    assert.match(tools.generate_image.voiceGuidelines[0], /^To make a new picture from a description, call generate_image/);
    assert.match(tools.edit_image.voiceGuidelines[0], /^To change a picture in the chat folder, call edit_image/);
    assert.deepEqual(tools.edit_image.approvalFiles, ['path', 'paths']);
    assert.deepEqual(tools.edit_image.parameters.required, ['paths', 'prompt'], 'several pictures, as the endpoint takes them');
    assert.deepEqual((await json(`${p.base}/state`)).body.images, { enabled: true });

    // What is read at each call needs no reload.
    const model = await json(`${p.base}/settings/images`, { method: 'PUT', body: { model: 'flux' } });
    assert.deepEqual([model.body.changed, model.body.images.model, p.reloads()], [false, 'flux', 1]);
    assert.deepEqual((await json(`${p.base}/settings/images`, { method: 'PUT', body: { editMultiple: false } })).body.changed, true, 'the shape of edit_image is a change');
    assert.deepEqual(p.registered().edit_image.parameters.required, ['path', 'prompt']);
    assert.deepEqual((await json(`${p.base}/settings/images`, { method: 'PUT', body: { enabled: 'yes' } })).status, 400);

    const videos = await json(`${p.base}/settings/videos`, { method: 'PUT', body: { enabled: true, baseUrl: 'http://127.0.0.1:9' } });
    assert.deepEqual([videos.status, videos.body.changed, videos.body.videos.ready, p.reloads()], [200, true, true, 3]);
    assert.deepEqual(p.offered(), ['show_image', 'generate_image', 'edit_image', 'generate_video', 'show_video']);
    assert.match(p.registered().generate_video.voiceGuidelines[0], /^A video made with generate_video is not shown in a spoken conversation/);
    assert.equal((await json(`${p.base}/settings/videos`)).body.videos.enabled, true);
  } finally {
    await p.stop();
  }
});

test('a chat that goes keeps its pictures in its folder, and a folder that goes takes them', async () => {
  const data = realpathSync(scratch('media-half-'));
  const project = realpathSync(scratch('media-project-'));
  const p = await start(data);
  try {
    const add = getDb().prepare("INSERT INTO images (id, origin, session_id, path, kind, created_at, chat_folder) VALUES (?, 'chat', ?, ?, 'generated', 1, ?)");
    add.run('000000000001', 'gone', 'generated-images/a.png', project);
    add.run('000000000002', 'other', 'generated-images/b.png', '/w/elsewhere');
    getDb().prepare("INSERT INTO videos (id, origin, session_id, path, kind, created_at, chat_folder) VALUES ('000000000003', 'chat', 'gone', 'generated-videos/v.webm', 'generated', 1, ?)").run(project);
    p.life.emit('deleted', 'gone');
    const where = (table: string) => getDb().prepare(`SELECT id, origin, folder FROM ${table} ORDER BY id`).all();
    assert.deepEqual(where('images'), [{ id: '000000000001', origin: 'folder', folder: project }, { id: '000000000002', origin: 'chat', folder: null }]);
    assert.deepEqual(where('videos'), [{ id: '000000000003', origin: 'folder', folder: project }]);
    p.removed(project);
    assert.deepEqual(where('images'), [{ id: '000000000002', origin: 'chat', folder: null }]);
    assert.deepEqual(where('videos'), []);
  } finally {
    await p.stop();
  }
});

test('a stop ends the jobs that are running and closes the store, and a start after it has what was saved', async () => {
  const data = realpathSync(scratch('media-half-'));
  const endpoint = await silentEndpoint();
  try {
    const first = await start(data);
    await json(`${first.base}/settings/images`, { method: 'PUT', body: { enabled: true, baseUrl: endpoint.url } });
    const made = await json(`${first.base}/images/generate`, { method: 'POST', body: { prompt: 'a lighthouse' } });
    assert.deepEqual([made.status, made.body.jobs.map((job: any) => job.state)], [202, ['running']]);
    while (!endpoint.asked.length) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(endpoint.asked[0], 'POST /v1/images/generations HTTP/1.1');
    const dropped = once(endpoint.dropped, 'dropped');
    await first.stop();
    await dropped;
    assert.throws(() => getDb(), /not open/);

    const again = await start(data);
    try {
      assert.deepEqual(await json(`${again.base}/images/jobs`), { status: 200, body: { jobs: [], limit: 4 } });
      assert.equal((await json(`${again.base}/settings/images`)).body.images.baseUrl, endpoint.url);
      assert.deepEqual(again.offered(), ['show_image', 'generate_image']);
    } finally {
      await again.stop();
    }
  } finally {
    endpoint.close();
  }
});
