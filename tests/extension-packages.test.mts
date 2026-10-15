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
