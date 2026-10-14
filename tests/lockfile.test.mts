import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const json = (file: string) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const lock = json('package-lock.json');
const workspaces: string[] = json('package.json').workspaces;

// `npm ci` fails on a lock that does not match package.json, and the image build and CI run it: a dependency added
// to package.json without the lock is a build that stops there, not one that quietly takes what the registry has today.
test('package-lock.json lists the dependencies each package.json does, with the same ranges', () => {
  for (const dir of ['', ...workspaces]) {
    const manifest = json(path.join(dir, 'package.json'));
    const entry = lock.packages[dir];
    assert.ok(entry, `${dir || 'the root'} is in the lock`);
    for (const kind of ['dependencies', 'devDependencies'] as const) {
      assert.deepEqual(entry[kind] ?? {}, manifest[kind] ?? {}, `${dir || 'the root'}: ${kind}`);
    }
  }
});

test('what the server needs to start is not recorded as a development dependency', () => {
  for (const name of Object.keys(json('core/server/package.json').dependencies)) {
    const entry = lock.packages[`node_modules/${name}`];
    assert.ok(entry, `${name} is in the lock`);
    assert.notEqual(entry.dev, true, `${name} is installed with --omit=dev`);
  }
});
