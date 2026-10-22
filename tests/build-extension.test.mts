import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildExtension } from '../packages/extension-api/build.mjs';
import { scratch } from './helpers.mts';

/**
 * What `buildExtension` makes of an extension written in TypeScript: with `tailwind`, the utilities its code uses in
 * its own stylesheet, in the portal's colours and without Tailwind's reset of the page; with `server`, its server
 * half bundled into one module beside its package.json.
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

test('an extension whose code imports no stylesheet is built again with the same utilities, not with them twice', async () => {
  const dir = scratch('build-extension-');
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'panel', type: 'module' }));
  writeFileSync(path.join(dir, 'src', 'client.tsx'), `export default function (portal: any) {
  portal.slots.register("chat.panel", { id: "p", title: "P", component: () => <div className="bg-surface">hello</div> });
}
`);
  await buildExtension({ dir, tailwind: true });
  const first = readFileSync(path.join(dir, 'web', 'client.css'), 'utf8');
  await buildExtension({ dir, tailwind: true });
  assert.equal(readFileSync(path.join(dir, 'web', 'client.css'), 'utf8'), first);
});
