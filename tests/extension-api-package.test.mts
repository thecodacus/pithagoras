import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dir = path.join(root, 'packages/extension-api');

/**
 * What `npm publish` puts in @pithagoras/extension-api, which extensions outside this repository install from npm:
 * the files its exports name, its readme, its licence and the repository's NOTICE, and nothing else.
 */
test('the published extension API has the files its exports name, its readme, its licence and its NOTICE, and nothing else', () => {
  // npm up to 11 prints an array with one entry per package, npm 12 an object keyed by the package's name.
  const printed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '-w', 'packages/extension-api'], { cwd: root, encoding: 'utf8' }));
  const packed = Array.isArray(printed) ? printed[0] : printed['@pithagoras/extension-api'];
  const files: string[] = packed.files.map((file: { path: string }) => file.path).sort();
  assert.deepEqual(files, ['LICENSE', 'NOTICE', 'README.md', 'build.mjs', 'index.d.ts', 'package.json', 'server.d.ts', 'tailwind.mjs']);

  const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const named = [manifest.types, ...Object.values(manifest.exports).flatMap((target) => (typeof target === 'string' ? [target] : Object.values(target as Record<string, string>)))];
  for (const file of named) assert.ok(files.includes(path.posix.normalize(file)), `${file} is named by package.json and published`);

  assert.equal(readFileSync(path.join(dir, 'LICENSE'), 'utf8'), readFileSync(path.join(root, 'LICENSE'), 'utf8'), "the package's licence is the repository's");
  assert.equal(readFileSync(path.join(dir, 'NOTICE'), 'utf8'), readFileSync(path.join(root, 'NOTICE'), 'utf8'), "the package's NOTICE is the repository's");
});

/**
 * The package is released with the portal, from the portal's tag v<version>, and has the portal's version: a release
 * raises both, and the lock's entries with them, or the workflow that publishes it stops at the tag.
 */
test("the extension API's version is the portal's, in package.json and in the lock", () => {
  const version = (file: string) => JSON.parse(readFileSync(path.join(root, file), 'utf8')).version;
  const portal = version('package.json');
  assert.equal(version('packages/extension-api/package.json'), portal, "packages/extension-api/package.json has the root package.json's version");

  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, portal, "the lock's version is the root package.json's");
  assert.equal(lock.packages[''].version, portal, "the lock's root entry has the root package.json's version");
  assert.equal(lock.packages['packages/extension-api'].version, portal, "the lock's packages/extension-api entry has the root package.json's version");
});
