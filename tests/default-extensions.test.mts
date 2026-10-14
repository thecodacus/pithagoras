import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The packages a portal installs by itself (extensions/defaults.json) are pi
 * packages, and pi reads each as it starts a chat. A folder whose package.json
 * has no `pi` key, and none of the folders pi looks in, is loaded by pi as an
 * extension itself: a module it cannot find, and pi does not start. A package
 * that brings pi nothing says so with `"pi": {}`.
 */
const ROOT = path.resolve(import.meta.dirname, '../extensions');
const PI_FOLDERS = ['extensions', 'skills', 'prompts', 'themes'];

test('each package a portal starts with tells pi what it brings, and is not loaded by pi as a module', () => {
  const defaults: string[] = JSON.parse(readFileSync(path.join(ROOT, 'defaults.json'), 'utf8'));
  assert.ok(defaults.includes('terminal'));
  for (const folder of defaults) {
    const dir = path.join(ROOT, folder);
    const meta = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const declared = typeof meta.pi === 'object' && meta.pi !== null && !Array.isArray(meta.pi);
    assert.ok(declared || PI_FOLDERS.some((name) => existsSync(path.join(dir, name))), `${folder} has no "pi" key and none of ${PI_FOLDERS.join(', ')}`);
  }
});
