import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fakeDocker } from "./fake-docker.mts";
import { inProcessHome } from "./helpers.mts";

// How Understory starts, stops and removes its container and downloads its image, against a fake Docker daemon (the
// browser's and the voice service's are their extensions', through Docker's, now). Nothing of this machine's Docker is touched.
const dir = inProcessHome('docker-lifecycle-');
process.env.DOCKER_SOCKET = path.join(dir, 'docker.sock');
process.env.PORTAL_CONTAINER_NAME = 'portal-test';

type Box = { running: boolean; labels: Record<string, string> };
let boxes = new Map<string, Box>();
let images = new Set<string>();
// A verb Docker refuses, with what it says, or nothing to say.
let refuse: Record<string, { status: number; message?: string }> = {};
// While set, a download does not end, after it has said its first line: an image that is on its way.
let pullGate: Promise<void> | null = null;
let pullError: string | null = null;
// A container that is gone by the time it is removed: the removal is answered "no such container".
let wentMeanwhile: string | null = null;
const noSuch = (name: string) => JSON.stringify({ message: `No such container: ${name}` });

const docker = await fakeDocker(process.env.DOCKER_SOCKET!, async ({ method, url, body, res }) => {
  const verb = url.match(/^\/containers\/([^/?]+)\/(start|stop)/);
  const refused = verb && refuse[verb[2]] || method === 'DELETE' && url.startsWith('/containers/') && refuse.remove;
  if (method === 'DELETE' && wentMeanwhile) { boxes.delete(wentMeanwhile); return { status: 404, text: noSuch(wentMeanwhile) }; }
  if (refused) return { status: refused.status, text: refused.message ? JSON.stringify({ message: refused.message }) : '' };
  if (url === '/containers/portal-test/json') return { json: { Id: 'portal-one', State: { Running: true } } };
  if (url.startsWith('/images/create')) {
    const q = new URL(url, 'http://docker').searchParams;
    res.write('{"status":"Pulling fs layer"}\n');
    await pullGate;
    if (pullError) { res.end(`{"error":${JSON.stringify(pullError)}}\n`); return 'handled'; }
    images.add(`${q.get('fromImage')}:${q.get('tag')}`);
    res.end('{"status":"Download complete"}\n');
    return 'handled';
  }
  if (url.startsWith('/images/')) return { status: images.has(decodeURIComponent(url.slice('/images/'.length, -'/json'.length))) ? 200 : 404 };
  if (url === '/volumes/create') return {};
  if (url.startsWith('/volumes/')) return { status: 204, text: '' };
  if (url === '/_ping') return { text: 'OK' };
  const create = url.match(/^\/containers\/create\?name=(.+)$/);
  if (create) { boxes.set(create[1], { running: false, labels: body.Labels ?? {} }); return { status: 201, json: { Id: 'new-one' } }; }
  const named = url.match(/^\/containers\/([^/?]+)(?:\/(json|start|stop|logs))?/);
  const name = named?.[1] ?? '', box = boxes.get(name);
  if (!named || !box) return { status: 404, text: noSuch(name) };
  if (method === 'DELETE') { boxes.delete(name); return { status: 204, text: '' }; }
  if (named[2] === 'json') return { json: { Id: `${name}-id`, State: { Running: box.running }, Config: { Labels: box.labels }, HostConfig: { NetworkMode: 'container:portal-one' } } };
  if (named[2] === 'logs') return { text: '""' };
  if (named[2] === 'start' || named[2] === 'stop') {
    const on = named[2] === 'start';
    // What Docker answers when it is as asked already.
    if (box.running === on) return { status: 304, text: '' };
    box.running = on;
    return { status: 204, text: '' };
  }
  return undefined;
});
const understory = await import('../core/server/src/extensions/understory-service.js');
const { getDb } = await import('../core/server/src/db.js');
after(() => getDb().close());

const reset = () => { boxes = new Map(); images = new Set(); docker.reset(); refuse = {}; pullGate = null; pullError = null; };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (done: () => boolean | Promise<boolean>) => { for (let n = 0; n < 300 && !(await done()); n++) await sleep(10); };
// A container as Understory makes it: the label it checks for.
const seed = (name: string, running: boolean) => boxes.set(name, { running, labels: { 'pithagoras.addon': 'understory' } });
const gate = () => { let open!: () => void; pullGate = new Promise<void>(r => (open = r)); return open; };

const UNDERSTORY = understory.CONTAINER;
test('stopping a container that was removed by hand is as good as stopped', async () => {
  reset();
  await understory.stop();
  assert.deepEqual(docker.asked().filter(c => c.startsWith('POST')), [`POST /containers/${UNDERSTORY}/stop?t=10`], 'asked once, and not an error');
});

test('stopping one that is stopped already, and starting one that is running already, is as asked', async () => {
  reset(); seed(UNDERSTORY, false);
  await understory.stop();
  assert.equal(boxes.get(UNDERSTORY)!.running, false, 'stopped one stays stopped');
  reset(); seed(UNDERSTORY, true);
  await understory.start();
  assert.equal(boxes.get(UNDERSTORY)!.running, true);
});

test('a running container is stopped, then it is as stopped', async () => {
  reset(); seed(UNDERSTORY, true);
  await understory.stop();
  assert.equal(boxes.get(UNDERSTORY)!.running, false);
});

test('what Docker refuses is an error in its own words, or in the verb\'s where it has none', async () => {
  reset(); seed(UNDERSTORY, true);
  refuse = { stop: { status: 500, message: 'the daemon is busy' } };
  await assert.rejects(understory.stop(), /the daemon is busy/);
  reset(); seed(UNDERSTORY, true); refuse = { stop: { status: 500 } };
  await assert.rejects(understory.stop(), /Stop failed \(500\)/);
  reset(); seed(UNDERSTORY, false); refuse = { start: { status: 500 } };
  await assert.rejects(understory.start(), /Start failed \(500\)/);
  reset(); seed(UNDERSTORY, false); refuse = { start: { status: 500, message: 'no space left' } };
  await assert.rejects(understory.start(), /no space left/);
  reset(); seed(UNDERSTORY, true); refuse = { remove: { status: 500, message: 'removal is in progress' } };
  await assert.rejects(understory.remove(), /removal is in progress/);
  reset(); seed(UNDERSTORY, true); refuse = { remove: { status: 409 } };
  await assert.rejects(understory.remove(), /Remove failed \(409\)/);
});

test('removing a container: a running one is stopped first, one that is stopped or gone is not an error', async () => {
  const removers: [string, string, () => Promise<void>][] = [['understory', UNDERSTORY, () => understory.remove()]];
  for (const [what, name, remove] of removers) {
    reset(); seed(name, true);
    await remove();
    assert.deepEqual(docker.asked().filter(c => c.startsWith('POST') || c.startsWith('DELETE')), [`POST /containers/${name}/stop?t=10`, `DELETE /containers/${name}?force=true`], `${what}: running`);
    assert.equal(boxes.has(name), false);
    reset(); seed(name, false);
    await remove();
    assert.deepEqual(docker.asked().filter(c => c.startsWith('POST') || c.startsWith('DELETE')), [`DELETE /containers/${name}?force=true`], `${what}: stopped`);
    reset();
    await remove();
    assert.equal(boxes.size, 0, `${what}: gone`);
  }
  // Docker answering "no such container" to the removal, because it went in the meantime, is a removal.
  reset(); seed(UNDERSTORY, true);
  wentMeanwhile = UNDERSTORY;
  try { await understory.remove(); } finally { wentMeanwhile = null; }
});

test('an image that is not there is downloaded with the daemon\'s lines shown, then done, by Understory', async () => {
  reset();
  // The gate is opened whatever the checks say, so that a failing one is reported and not waited on.
  const open = gate();
  try {
    const installing = understory.install();
    await until(async () => (await understory.status()).pulling.line === 'Pulling fs layer');
    assert.deepEqual((await understory.status()).pulling, { active: true, line: 'Pulling fs layer' });
    open(); await installing;
  } finally { open(); }
  assert.deepEqual((await understory.status()).pulling, { active: false, line: 'done' });
  assert.equal(boxes.get(UNDERSTORY)?.running, true);

  // An image that is there is not downloaded again, and what was said of the last download is left as it was.
  docker.reset();
  await understory.install();
  assert.equal(docker.asked().some(c => c.startsWith('POST /images/create')), false);
  assert.deepEqual((await understory.status()).pulling, { active: false, line: 'done' });
});

test('a download that fails is said, and the install does not go on, by Understory', async () => {
  reset();
  pullError = 'pull access denied';
  const open = gate(); open();
  await assert.rejects(understory.install(), /pull access denied/);
  assert.deepEqual((await understory.status()).pulling, { active: false, line: '', error: 'pull access denied' });
  assert.equal(boxes.size, 0);
});
