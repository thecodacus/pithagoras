import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dir = path.join(root, 'packages/extension-api');

/**
 * What `npm publish` puts in @pithagoras/extension-api, which extensions outside this repository install from npm:
 * the files its exports name, its readme and its licence, and nothing else.
 */
test('the published extension API has the files its exports name, its readme and its licence, and nothing else', () => {
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '-w', 'packages/extension-api'], { cwd: root, encoding: 'utf8' }));
  const files: string[] = packed.files.map((file: { path: string }) => file.path).sort();
  assert.deepEqual(files, ['LICENSE', 'README.md', 'build.mjs', 'index.d.ts', 'package.json', 'server.d.ts', 'tailwind.mjs']);

  const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const named = [manifest.types, ...Object.values(manifest.exports).flatMap((target) => (typeof target === 'string' ? [target] : Object.values(target as Record<string, string>)))];
  for (const file of named) assert.ok(files.includes(path.posix.normalize(file)), `${file} is named by package.json and published`);

  assert.equal(readFileSync(path.join(dir, 'LICENSE'), 'utf8'), readFileSync(path.join(root, 'LICENSE'), 'utf8'), "the package's licence is the repository's");
});
