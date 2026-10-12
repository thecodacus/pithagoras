import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const json = (file: string) => JSON.parse(read(file));

/** Every package.json of the repository, not those of installed dependencies. */
function packageFiles(dir = '', found: string[] = []): string[] {
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (!entry.isDirectory() && entry.name === 'package.json') found.push(path.join(dir, entry.name));
    else if (entry.isDirectory() && !['node_modules', '.git', '.local-data', 'dist'].includes(entry.name)) packageFiles(path.join(dir, entry.name), found);
  }
  return found;
}

test('every package of the repository says it is Apache-2.0, as LICENSE is', () => {
  assert.match(read('LICENSE'), /Apache License\s+Version 2\.0/);
  const files = packageFiles();
  // The channels and the subagent extension are published on their own, so each carries the field.
  for (const expected of ['package.json', 'server/package.json', 'web/package.json', 'docs/package.json', 'extensions/subagent/package.json', 'channels/discord/package.json', 'channels/signal/package.json', 'channels/slack/package.json', 'channels/telegram/package.json', 'channels/webhook/package.json']) {
    assert.ok(files.includes(expected), `${expected} is looked at`);
  }
  for (const file of files) assert.equal(json(file).license, 'Apache-2.0', file);
});

const require = createRequire(path.join(root, 'web/package.json'));
/** The package.json of an installed dependency, found through a file it exports or its main. */
function installed(name: string): { version: string; license: string } {
  let dir = path.dirname(require.resolve(name));
  while (!existsSync(path.join(dir, 'package.json')) || json(path.relative(root, path.join(dir, 'package.json'))).name !== name) dir = path.dirname(dir);
  return json(path.relative(root, path.join(dir, 'package.json')));
}

test('the notices give the licence of every file the web build copies into voice-assets, at the version that is installed', () => {
  const notices = read('THIRD_PARTY_NOTICES.md');
  const copied = read('web/scripts/copy-vad-assets.mjs');
  for (const [name, licence, file] of [
    ['@ricky0123/vad-web', 'ISC', 'silero_vad_v5.onnx'],
    ['@ricky0123/vad-web', 'ISC', 'vad.worklet.bundle.min.js'],
    ['onnxruntime-web', 'MIT', 'ort-wasm-simd-threaded.wasm'],
    ['onnxruntime-web', 'MIT', 'ort-wasm-simd-threaded.mjs'],
  ] as const) {
    assert.ok(copied.includes(file), `${file} is still what the build copies`);
    assert.ok(notices.includes(`\`${file}\``), `${file} is named in the notices`);
    const { version, license } = installed(name);
    assert.equal(license, licence, `${name} changed its licence: the notices have to be read again`);
    assert.ok(notices.includes(`\`${name}\` ${version}`), `${name} ${version} is the version the notices describe`);
  }
  // The Silero model is MIT, the package that carries it ISC: both texts are there, with their holders.
  assert.match(notices, /ISC License\s+Copyright \(c\) 2022-present ricky0123/);
  assert.match(notices, /MIT License\s+Copyright \(c\) 2020-present Silero Team/);
  assert.match(notices, /MIT License\s+Copyright \(c\) Microsoft Corporation/);
});

test('the notices name sharp at the version that is installed, and libvips, which comes with it under the LGPL', () => {
  const notices = read('THIRD_PARTY_NOTICES.md');
  const { version, license } = installed('sharp');
  assert.equal(license, 'Apache-2.0', 'sharp changed its licence: the notices have to be read again');
  assert.ok(notices.includes(`\`sharp\` ${version}`), `sharp ${version} is the version the notices describe`);
  assert.match(notices, /libvips[^\n]*LGPL-3\.0-or-later/);
  assert.ok(notices.includes('https://www.gnu.org/licenses/lgpl-3.0.txt'), 'the LGPL text is linked');
});

test('the web build puts the notices next to the voice files', () => {
  const out = path.join(root, 'web/public/voice-assets/THIRD_PARTY_NOTICES.md');
  rmSync(out, { force: true });
  execFileSync(process.execPath, [path.join(root, 'web/scripts/copy-vad-assets.mjs')], { stdio: 'pipe' });
  assert.equal(readFileSync(out, 'utf8'), read('THIRD_PARTY_NOTICES.md'));
});

test('the README names the licence and points at the notices', () => {
  const readme = read('README.md');
  assert.match(readme, /## License\n+Pithagoras is licensed under the \[Apache License 2\.0\]\(LICENSE\)/);
  assert.ok(readme.includes('(THIRD_PARTY_NOTICES.md)'));
});
