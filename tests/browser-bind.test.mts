import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { fakeDocker } from './fake-docker.mts';
import { inProcessHome } from './helpers.mts';

// Where the agent's browser answers. Its container shares the host's network, and the web server in the image listens
// on every interface, so the portal has to keep it to one address itself; the portal's own use (its proxy, the
// debugging port, the live view) is all on 127.0.0.1. Against a fake Docker daemon: nothing of this machine's Docker
// is touched.
const dir = inProcessHome('browser-bind-');
process.env.DOCKER_SOCKET = path.join(dir, 'docker.sock');
process.env.BROWSER_CDP_URL = 'http://127.0.0.1:1';
delete process.env.BROWSER_BIND;
delete process.env.BROWSER_EXTERNAL;

// The container as the daemon has it, once it is created: what it was created with, and whether it carries a label.
let box: { labels: Record<string, string> } | null = null;
let created: any;

const docker = await fakeDocker(process.env.DOCKER_SOCKET!, ({ method, url, body }) => {
  if (url.startsWith('/images/')) return { status: 200 };
  if (url === '/volumes/create') return {};
  const create = url.match(/^\/containers\/create\?name=(.+)$/);
  if (create) { created = body; box = { labels: body.Labels ?? {} }; return { status: 201, json: { Id: 'new-one' } }; }
  if (!url.startsWith('/containers/pithagoras-browser')) return undefined;
  if (method === 'DELETE') { box = null; return { status: 204, text: '' }; }
  if (url.endsWith('/start')) return { status: 204, text: '' };
  if (url.endsWith('/stop?t=10')) return { status: 204, text: '' };
  if (!box) return { status: 404, text: JSON.stringify({ message: 'No such container: pithagoras-browser' }) };
  return { json: { Id: 'browser-id', State: { Running: true }, Config: { Labels: box.labels } } };
});
const browser = await import('../server/src/extensions/browser-service.js');
const { getDb } = await import('../server/src/db.js');
const { browserRouter } = await import('../server/src/api/browser.js');
after(() => getDb().close());

browser.saveConfig({ password: 'secret' });
const reset = () => { box = null; created = undefined; docker.reset(); delete process.env.BROWSER_BIND; delete process.env.BROWSER_EXTERNAL; };

test('a new browser is created to listen on this machine only, and says so', async () => {
  reset();
  await browser.install();
  assert.ok(created.Env.includes('PITHAGORAS_UI_BIND=127.0.0.1'));
  assert.deepEqual(created.Labels, { 'pithagoras.browser-bind': '127.0.0.1' });
  // The web server is started through the script that holds it to that address, not by the image on its own.
  assert.deepEqual(created.Entrypoint.slice(0, 2), ['/bin/sh', '-c']);
  assert.match(created.Entrypoint[2], /exec \/init$/);
  // What the portal reaches it by is untouched: the host's network, with the ports the proxy and the live view use.
  assert.equal(created.HostConfig.NetworkMode, 'host');
  assert.ok(created.Env.includes('CUSTOM_HTTPS_PORT=3011'));
});

test('BROWSER_BIND chooses the address, and anything but an IPv4 address is the safe one', async () => {
  const bound = async (value: string | undefined) => {
    reset();
    if (value !== undefined) process.env.BROWSER_BIND = value;
    await browser.install();
    return [created.Labels['pithagoras.browser-bind'], created.Env.find((e: string) => e.startsWith('PITHAGORAS_UI_BIND='))];
  };
  assert.deepEqual(await bound('0.0.0.0'), ['0.0.0.0', 'PITHAGORAS_UI_BIND=0.0.0.0']);
  assert.deepEqual(await bound(' 192.168.1.5 '), ['192.168.1.5', 'PITHAGORAS_UI_BIND=192.168.1.5']);
  // It is handed to a shell script, so a value that is not an address never gets that far.
  for (const bad of ['all', '::', '127.0.0.1; reboot', '$(id)', '256.1.1.1']) {
    assert.deepEqual(await bound(bad), ['127.0.0.1', 'PITHAGORAS_UI_BIND=127.0.0.1'], bad);
  }
  assert.deepEqual(await bound(''), ['127.0.0.1', 'PITHAGORAS_UI_BIND=127.0.0.1']);
});

// The listen lines of the image's /defaults/default.conf (lscr.io/linuxserver/chromium): one server for each port, each
// with an IPv4 and an IPv6 listen, which the image's own start then gives the ports CUSTOM_PORT and CUSTOM_HTTPS_PORT.
const IMAGE_CONF = `server {
  listen 3000 default_server;
  listen [::]:3000 default_server;
  location / { }
}

server {
  listen 3001 ssl;
  listen [::]:3001 ssl;
  location / { }
}
`;

/**
 * What the container's start does with the image's configuration, run on a copy of it: the script, then the image's own port step.
 * `starts` is how often the container is started on that one file, as a stopped container is: its files stay as they were left.
 */
async function started(conf: string, bind: string, starts = 1) {
  await browser.install();
  const script: string = created.Entrypoint[2];
  const folder = mkdtempSync(path.join(dir, 'conf-'));
  const file = path.join(folder, 'default.conf');
  writeFileSync(file, conf);
  const here = script.replace('/defaults/default.conf', file).replace('exec /init', 'echo image-started');
  assert.notEqual(here, script, 'the script names the image\'s configuration and its start');
  const all: { run: SpawnSyncReturns<string>; listens: string[] }[] = [];
  for (let i = 0; i < starts; i++) {
    const run = spawnSync('/bin/sh', ['-c', here], { env: { PITHAGORAS_UI_BIND: bind, PATH: process.env.PATH }, encoding: 'utf8' });
    // The image's own start, which writes the ports the portal was configured with (init-nginx). It reads /defaults/default.conf and
    // writes the copy nginx uses, so the file itself is not changed by it.
    const ports = readFileSync(file, 'utf8').replaceAll('3000', '3010').replaceAll('3001', '3011');
    all.push({ run, listens: ports.split('\n').filter((l) => l.includes('listen')).map((l) => l.trim()) });
  }
  return { ...all[all.length - 1], all };
}

test('the start script gives the image\'s web server the loopback address and nothing on IPv6', async () => {
  reset();
  const { run, listens } = await started(IMAGE_CONF, '127.0.0.1');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /image-started/);
  assert.deepEqual(listens, ['listen 127.0.0.1:3010 default_server;', 'listen 127.0.0.1:3011 ssl;']);
});

test('a container stopped and started again listens as it did the first time', async () => {
  // The container keeps its files when it is stopped, and the script runs again on every start: an edit made on top of the last
  // one would give "listen 127.0.0.1:127.0.0.1:3000", which nginx refuses, with the container still showing as running.
  for (const bind of ['127.0.0.1', '192.168.1.5']) {
    reset();
    const { all } = await started(IMAGE_CONF, bind, 3);
    for (const { run } of all) assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(all[1].listens, all[0].listens, bind);
    assert.deepEqual(all[2].listens, all[0].listens, bind);
    assert.ok(all[2].listens.every((l) => /^listen (\d{1,3}\.){3}\d{1,3}:\d+ /.test(l)), `${bind}: ${all[2].listens.join(' | ')}`);
  }
});

test('an address other than the loopback one is listened on beside it, because the portal\'s proxy connects to 127.0.0.1', async () => {
  reset();
  const { run, listens } = await started(IMAGE_CONF, '192.168.1.5');
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(listens, [
    'listen 192.168.1.5:3010 default_server;',
    'listen 127.0.0.1:3010 default_server;',
    'listen 192.168.1.5:3011 ssl;',
    'listen 127.0.0.1:3011 ssl;',
  ]);
});

test('0.0.0.0 leaves the image as it is, and an image that changed is not started open', async () => {
  reset();
  const open = await started(IMAGE_CONF, '0.0.0.0', 2);
  assert.equal(open.run.status, 0, open.run.stderr);
  assert.deepEqual(open.listens, ['listen 3010 default_server;', 'listen [::]:3010 default_server;', 'listen 3011 ssl;', 'listen [::]:3011 ssl;']);

  // No listen the script knows how to hold: it stops before the image starts, with the reason in the container's log.
  reset();
  const changed = await started('server {\n  bind 3000;\n}\n', '127.0.0.1');
  assert.notEqual(changed.run.status, 0);
  assert.doesNotMatch(changed.run.stdout, /image-started/);
  assert.match(changed.run.stderr, /could not be bound to 127\.0\.0\.1/);
});

test('a container made before this has no label: the portal says its port is open and outdated, and reinstalling closes it', async () => {
  reset();
  assert.deepEqual(await browser.uiState(), { exposed: false, outdated: false }, 'none yet: what it will be made with');
  box = { labels: { build_version: 'linuxserver' } };
  assert.deepEqual(await browser.uiState(), { exposed: true, outdated: true });

  await browser.install();
  assert.deepEqual(await browser.uiState(), { exposed: false, outdated: false });
  process.env.BROWSER_BIND = '0.0.0.0';
  await browser.install();
  assert.deepEqual(await browser.uiState(), { exposed: true, outdated: false }, 'chosen, so not outdated');

  // A browser the portal does not run is not one it can say anything of: the page keeps its link.
  process.env.BROWSER_EXTERNAL = 'true';
  assert.deepEqual(await browser.uiState(), { exposed: true, outdated: false });
});

test('the Browser page is told, with the port it would link to', async () => {
  reset();
  const app = express();
  app.use('/api', browserRouter());
  const web = await new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const ask = async () => (await fetch(`http://127.0.0.1:${(web.address() as AddressInfo).port}/api/browser`)).json() as Promise<{ uiPort: string; uiExposed: boolean; uiOutdated: boolean }>;
    box = { labels: {} };
    assert.deepEqual(pick(await ask()), { uiPort: '3011', uiExposed: true, uiOutdated: true });
    await browser.install();
    assert.deepEqual(pick(await ask()), { uiPort: '3011', uiExposed: false, uiOutdated: false });
  } finally { await new Promise<void>((r) => web.close(() => r())); }
});
const pick = ({ uiPort, uiExposed, uiOutdated }: { uiPort: string; uiExposed: boolean; uiOutdated: boolean }) => ({ uiPort, uiExposed, uiOutdated });
