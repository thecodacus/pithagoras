import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A Pithagoras extension is a pi package, and pi reads each installed package
 * as it starts. One whose package.json has no `pi` key, and none of the
 * folders pi looks in, is loaded by pi as an extension itself: a module it
 * cannot find, and pi does not start. So every package the portal ships has
 * the key, empty when it brings pi nothing (`"pi": {}`).
 */
const ROOT = path.resolve(import.meta.dirname, '../extensions');

test('every package the portal ships says with a "pi" key what it brings pi, if only nothing', () => {
  const packages = readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((folder) => readdirSync(path.join(ROOT, folder)).includes('package.json'));
  // What a fresh portal installs is among them.
  const defaults: string[] = JSON.parse(readFileSync(path.join(ROOT, 'defaults.json'), 'utf8'));
  assert.ok(defaults.length > 0 && defaults.every((folder) => packages.includes(folder)));
  for (const folder of packages) {
    const pi = JSON.parse(readFileSync(path.join(ROOT, folder, 'package.json'), 'utf8')).pi;
    assert.ok(typeof pi === 'object' && pi !== null && !Array.isArray(pi), `extensions/${folder}/package.json has no "pi" key`);
  }
});

/**
 * What a fresh portal installs on its first start, and an upgraded one with it: the upgrading guide lists these
 * packages under "The extensions a portal starts with", as a portal at 0.1.0 finds them under Installed afterwards.
 * Changing the list means changing the guide.
 */
test('the extensions a portal starts with are the six the upgrading guide lists, by their package names', () => {
  const defaults: string[] = JSON.parse(readFileSync(path.join(ROOT, 'defaults.json'), 'utf8'));
  assert.deepEqual(defaults, ['terminal', 'git', 'files', 'themes', 'canvas', 'media']);
  const guide = readFileSync(path.resolve(import.meta.dirname, '../docs/guide/upgrading.md'), 'utf8');
  const from = guide.indexOf('## The extensions a portal starts with');
  assert.ok(from >= 0, 'the guide has the section');
  const section = guide.slice(from, guide.indexOf('\n## ', from + 1));
  const listed = [...section.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1]).sort();
  const names = defaults.map((folder) => JSON.parse(readFileSync(path.join(ROOT, folder, 'package.json'), 'utf8')).name).sort();
  assert.deepEqual(listed, names);
});
