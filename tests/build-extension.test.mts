import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildExtension, installPackages, missingPackages } from '../packages/extension-api/build.mjs';
import { scratch } from './helpers.mts';

/**
 * What `buildExtension` makes of an extension written in TypeScript: with `tailwind`, the utilities its code uses in
 * its own stylesheet, in the portal's colours and without Tailwind's reset of the page; with `server`, its server
 * half bundled into one module beside its package.json; with `install`, its packages first, if they are not there.
 */
test('an extension is built with the utilities it uses in its own stylesheet, and its server half into server.js', async () => {
  const dir = scratch('build-extension-');
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@me/panel', type: 'module' }));
  writeFileSync(path.join(dir, 'src', 'client.tsx'), `import "./client.css";
export default function (portal: any) {
  portal.slots.register("chat.panel", { id: "p", title: "P", component: () => <div className="bg-surface text-fg-muted p-2 shadow-pop">hello</div> });
}
`);
  writeFileSync(path.join(dir, 'src', 'client.css'), '.mine { color: red; }\n');
  writeFileSync(path.join(dir, 'src', 'answer.ts'), 'export const answer = (n: number): number => n * 2;\n');
  writeFileSync(path.join(dir, 'src', 'server.ts'), `import { answer } from "./answer";
import { readFileSync } from "node:fs";
export default function (portal: { log(text: string): void }) {
  portal.log(String(answer(21)) + typeof readFileSync);
}
`);
  await buildExtension({ dir, minify: false, tailwind: true, server: 'src/server.ts' });

  const css = readFileSync(path.join(dir, 'web', 'client.css'), 'utf8');
  // Its own rules first, then the utilities its code names, in the portal's colours.
  assert.ok(css.indexOf('.mine') < css.indexOf('.bg-surface'), css);
  assert.match(css, /\.bg-surface\s*\{[^}]*var\(--surface\)/);
  assert.match(css, /\.text-fg-muted\s*\{[^}]*var\(--fg-muted\)/);
  assert.match(css, /\.shadow-pop/);
  // Each for the extension's own parts only, weighing what the portal's own does: the portal's utilities go by the
  // same names, and the page's are not the extension's to restyle.
  assert.match(css, /:where\(\[data-extension="@me\/panel"\]\) \.bg-surface/);
  assert.doesNotMatch(css, /^\.bg-surface/m);
  // Only what it uses, and no reset of the page.
  assert.doesNotMatch(css, /\.bg-raised|\.text-danger/);
  assert.doesNotMatch(css, /box-sizing:\s*border-box/);

  // The server half: its own modules in it, the runtime's left to import.
  const said: string[] = [];
  const server = await import(pathToFileURL(path.join(dir, 'server.js')).href);
  server.default({ log: (text: string) => said.push(text) });
  assert.deepEqual(said, ['42function']);
  assert.match(readFileSync(path.join(dir, 'server.js'), 'utf8'), /from "node:fs"/);
});

/** `version` of the package at `where` in the package folder `dir`, as npm leaves it there. */
function installed(dir: string, where: string, version: string) {
  mkdirSync(path.join(dir, where), { recursive: true });
  writeFileSync(path.join(dir, where, 'package.json'), JSON.stringify({ version }));
}

/**
 * A package folder that depends on `a` (which brings `d`) and `b` to run and on `c` to be built, as its lock file says; `npm` is on PATH
 * as a script that records what it was asked and runs `npmSays`.
 */
function packageNeeding(npmSays: string) {
  const dir = scratch('build-install-');
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'needs', type: 'module', dependencies: { a: '^1.0.0', b: '^1.0.0' }, devDependencies: { c: '1.0.0' } }));
  writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({
    name: 'needs', lockfileVersion: 3, packages: {
      '': { name: 'needs' },
      'node_modules/a': { version: '1.2.0' },
      'node_modules/a/node_modules/d': { version: '2.0.0' },
      'node_modules/b': { version: '1.0.0' },
      'node_modules/c': { version: '1.0.0', dev: true },
      // Only where it fits: left out by npm elsewhere.
      'node_modules/e': { version: '1.0.0', optional: true },
    },
  }));
  writeFileSync(path.join(dir, 'src', 'client.tsx'), 'export default function () {}\n');
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\necho "$PWD: $@" >> "${dir}/asked"\n${npmSays}\n`);
  chmodSync(path.join(bin, 'npm'), 0o755);
  return { dir, bin, asked: () => readFileSync(path.join(dir, 'asked'), 'utf8').trim().split('\n').map((line) => line.replace(`${dir}: `, '')) };
}

/** Runs `work` with `bin` first on PATH, where npm is looked for. */
async function withNpm<T>(bin: string, work: () => T | Promise<T>): Promise<T> {
  const was = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${was}`;
  try {
    return await work();
  } finally {
    process.env.PATH = was;
  }
}

const INSTALLS = [['node_modules/a', '1.2.0'], ['node_modules/a/node_modules/d', '2.0.0'], ['node_modules/b', '1.0.0'], ['node_modules/c', '1.0.0']]
  .map(([where, version]) => `mkdir -p ${where} && echo '{"version":"${version}"}' > ${where}/package.json`).join(' && ');

test('what a package needs and does not have, or has at another version than its lock names, is found: to run, or also to be built', () => {
  const { dir } = packageNeeding('');
  assert.deepEqual(missingPackages(dir), ['a', 'd', 'b', 'c']);
  assert.deepEqual(missingPackages(dir, { dev: false }), ['a', 'd', 'b'], 'what it is built with is not asked for to run');
  installed(dir, 'node_modules/a', '1.2.0');
  installed(dir, 'node_modules/a/node_modules/d', '2.0.0');
  installed(dir, 'node_modules/b', '1.0.0');
  assert.deepEqual(missingPackages(dir, { dev: false }), []);
  assert.deepEqual(missingPackages(dir), ['c']);
  // A later commit moved `a` on, and `a` brings another `d`: both are found, and an optional package that is there is checked like the rest.
  installed(dir, 'node_modules/a', '1.0.0');
  installed(dir, 'node_modules/a/node_modules/d', '1.0.0');
  installed(dir, 'node_modules/e', '0.1.0');
  assert.deepEqual(missingPackages(dir, { dev: false }), ['a', 'd', 'e']);
  // Without a lock file, what the package names is what is checked.
  rmSync(path.join(dir, 'package-lock.json'));
  assert.deepEqual(missingPackages(dir, { dev: false }), []);
  rmSync(path.join(dir, 'node_modules', 'b'), { recursive: true });
  assert.deepEqual(missingPackages(dir, { dev: false }), ['b']);
  assert.deepEqual(missingPackages(dir), ['b', 'c']);
});

test('with install, an extension\'s packages are installed first as its lock says, once, and not when they are there', async () => {
  const { dir, bin, asked } = packageNeeding(INSTALLS);
  const logged: string[] = [];
  const log = console.log;
  console.log = (line: string) => void logged.push(line);
  try {
    await withNpm(bin, () => buildExtension({ dir, minify: false, install: true }));
    assert.deepEqual(asked(), ['ci --ignore-scripts --no-audit --no-fund --prefer-offline']);
    assert.deepEqual(missingPackages(dir), []);
    assert.match(logged[0], /^needs: installing its packages \(a, d, b, c\)$/);
    // Everything there: npm is not asked again, and a build without `install` asks for nothing.
    await withNpm(bin, () => buildExtension({ dir, minify: false, install: true }));
    rmSync(path.join(dir, 'node_modules', 'b'), { recursive: true });
    await withNpm(bin, () => buildExtension({ dir, minify: false }));
    assert.equal(asked().length, 1);
    // Only to run: without what it is built with.
    rmSync(path.join(dir, 'node_modules'), { recursive: true });
    await withNpm(bin, () => installPackages({ dir, dev: false }));
    assert.deepEqual(asked().at(-1), 'ci --omit=dev --ignore-scripts --no-audit --no-fund --prefer-offline');
  } finally {
    console.log = log;
  }
});

test('an install that fails fails the build, with what npm said', async () => {
  const { dir, bin } = packageNeeding('echo "npm error network unreachable" >&2; exit 1');
  await withNpm(bin, async () => {
    await assert.rejects(buildExtension({ dir, minify: false, install: true }), /npm/);
  });
});
