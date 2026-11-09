import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { OFFICIAL_REPOSITORIES, extensionsRouter, officialExtensions } from '../core/server/src/api/extensions.ts';

/**
 * Settings → Extensions → Discover lists the official extensions that do not ship with the portal from
 * extensions/official.json. A list nobody fetches is only as right as its entries, so they are checked here.
 */
const ROOT = path.resolve(import.meta.dirname, '../extensions');
const listed: any[] = JSON.parse(readFileSync(path.join(ROOT, 'official.json'), 'utf8'));

test('every official extension names one of the two repositories and is installed by its npm name', () => {
  assert.ok(listed.length >= 6);
  for (const entry of listed) {
    assert.ok((OFFICIAL_REPOSITORIES as readonly string[]).includes(entry.repository), `${entry.name}: ${entry.repository} is not an official repository`);
    // Not a git spec: pi installs a git repository from its root, and these are folders of one (the root is an empty package).
    assert.equal(entry.spec, `npm:${entry.name}`);
    assert.match(entry.name, /^@pithagoras\/[a-z][a-z0-9-]*$/);
    assert.ok(entry.description.trim().length > 20, `${entry.name} has a description`);
    assert.ok(Array.isArray(entry.kinds) && entry.kinds.length > 0);
  }
});

test('the names are unique, and none is the name of an extension that ships with the portal', () => {
  const names = listed.map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length);
  const shipped = readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => JSON.parse(readFileSync(path.join(ROOT, entry.name, 'package.json'), 'utf8')).name);
  for (const name of names) assert.ok(!shipped.includes(name), `${name} ships with the portal`);
});

test('the portal reads every entry of the list, and leaves out one that is not whole', () => {
  assert.deepEqual(officialExtensions(ROOT).map((e) => e.name), listed.map((e) => e.name));
  const broken = { ...listed[0], repository: 'someone/else' };
  const dir = path.join(process.env.TMPDIR ?? '/var/tmp', `official-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(path.join(dir, 'official.json'), JSON.stringify([broken, listed[1], { name: 'x' }]));
    assert.deepEqual(officialExtensions(dir).map((e) => e.name), [listed[1].name]);
    writeFileSync(path.join(dir, 'official.json'), 'not json');
    assert.deepEqual(officialExtensions(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /extensions/official answers with the list', () => {
  const route = (extensionsRouter() as any).stack.find((l: any) => l.route?.path === '/extensions/official' && l.route.methods.get);
  assert.ok(route, 'the route is registered');
  let body: any;
  route.route.stack[0].handle({}, { json: (b: unknown) => (body = b) });
  assert.deepEqual(body.extensions.map((e: any) => e.name), listed.map((e) => e.name));
});
