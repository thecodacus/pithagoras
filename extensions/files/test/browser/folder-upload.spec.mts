import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type Page } from '@playwright/test';
import { test, expect } from '../../../../tests/browser/portal-mock';

// Files, as a portal that ships it has it.
test.use({ installed: ['extensions/files'] });

type Node = { dir: true; kids: Map<string, Node> } | { dir: false; body: string };
const folder = (): Node => ({ dir: true, kids: new Map() });

/** What a drop is made of: a name for a file, or a folder with what is in it. */
type Spec = string | { dir: string; kids: Spec[] } | { broken: string };

/**
 * The chat page with its Files panel over a folder in memory, answered the way the portal answers the three calls an upload makes: the
 * list, the folder route (a taken name is refused with code "exists") and the upload route (a taken name gets a number). `disk` is the
 * whole tree, `calls` every request that changed it, in order, `failing` names the files whose upload is refused, and `hold` makes
 * every upload wait until what it returns is called.
 */
async function files(page: Page, { failing = [] as string[], taken = [] as string[] } = {}) {
  const root = folder();
  const at = (p: string): Node | undefined => {
    let node: Node | undefined = root;
    for (const part of p.split('/').filter(Boolean)) node = node && node.dir ? node.kids.get(part) : undefined;
    return node;
  };
  const make = (p: string, body?: string) => {
    const parts = p.split('/');
    const parent = at(parts.slice(0, -1).join('/'));
    if (!parent || !parent.dir) throw new Error(`no folder ${p}`);
    parent.kids.set(parts.at(-1)!, body === undefined ? folder() : { dir: false, body });
  };
  for (const p of taken) p.endsWith('/') ? make(p.slice(0, -1)) : make(p, 'old');
  const calls: string[] = [];
  let held: Promise<void> | null = null;
  const uploaded: string[] = [];
  await page.route('**/api/x/pithagoras-files/chats/*/files*', (route) => {
    const dir = new URL(route.request().url()).searchParams.get('path') ?? '';
    const node = at(dir);
    if (!node || !node.dir) return route.fulfill({ status: 404, json: { error: 'There is no such folder' } });
    const entries = [...node.kids].map(([name, n]) => ({ name, type: n.dir ? 'dir' : 'file', size: n.dir ? 0 : n.body.length, mtime: 1 }));
    entries.sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name));
    return route.fulfill({ json: { path: dir, entries, truncated: false } });
  });
  await page.route('**/api/x/pithagoras-files/chats/*/folder*', (route) => {
    const dir = new URL(route.request().url()).searchParams.get('path') ?? '';
    const { name } = JSON.parse(route.request().postData() ?? '{}');
    const where = [dir, name].filter(Boolean).join('/');
    calls.push(`folder ${where}`);
    if (at(where)) return route.fulfill({ status: 409, json: { error: `There is already something called "${name}" here`, code: 'exists' } });
    make(where);
    return route.fulfill({ json: { ok: true, path: where } });
  });
  await page.route('**/api/sessions/*/upload*', async (route) => {
    const url = new URL(route.request().url());
    const dir = url.searchParams.get('path') ?? '';
    const name = url.searchParams.get('name')!;
    calls.push(`file ${[dir, name].filter(Boolean).join('/')}`);
    if (held) await held;
    if (failing.includes(name)) return route.fulfill({ status: 500, json: { error: `The file ${name} could not be uploaded` } });
    let final = name;
    for (let n = 2; at([dir, final].filter(Boolean).join('/')); n++) final = name.replace(/(\.[^.]*)?$/, ` (${n})$1`);
    make([dir, final].filter(Boolean).join('/'), route.request().postData() ?? '');
    uploaded.push([dir, final].filter(Boolean).join('/'));
    return route.fulfill({ json: { path: [dir, final].filter(Boolean).join('/'), size: 1 } });
  });
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.goto('/tests/chat.html?phase=switch');
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(page.getByTestId('files-list')).toBeVisible();
  const tree = (node: Node = root, prefix = ''): string[] =>
    node.dir ? [...node.kids].flatMap(([name, n]) => (n.dir ? [`${prefix}${name}/`, ...tree(n, `${prefix}${name}/`)] : [`${prefix}${name}`])) : [];
  const hold = () => {
    let release!: () => void;
    held = new Promise((r) => (release = r));
    return () => {
      held = null;
      release();
    };
  };
  return { calls, uploaded, hold, tree: () => tree().sort() };
}

/**
 * A drop on the list, with the browser's entries for what is dropped (`webkitGetAsEntry`, a folder read in batches of two) or without
 * them, as a browser that lacks them gives it. The page has no way to drag a real folder, so the event carries a DataTransfer whose
 * items and files are these.
 */
async function drop(page: Page, specs: Spec[], { entries = true } = {}) {
  await page.getByTestId('files-list').evaluate(
    (list, { specs, entries }) => {
      const fileOf = (name: string) => new File(['x'], name);
      const entryOf = (spec: any): any =>
        typeof spec === 'string'
          ? { isFile: true, isDirectory: false, name: spec, file: (ok: (f: File) => void) => ok(fileOf(spec)) }
          : spec.broken
            ? { isFile: true, isDirectory: false, name: spec.broken, file: (_ok: unknown, fail: (e: Error) => void) => fail(new Error('gone')) }
            : {
              isFile: false,
              isDirectory: true,
              name: spec.dir,
              createReader() {
                let at = 0;
                return {
                  readEntries(ok: (e: any[]) => void) {
                    const batch = spec.kids.slice(at, at + 2).map(entryOf);
                    at += 2;
                    setTimeout(() => ok(batch));
                  },
                };
              },
            };
      const dt = new DataTransfer();
      // What the browser shows for a dropped folder as well: one empty "file" with its name.
      Object.defineProperty(dt, 'files', { value: specs.map((s: any) => fileOf(typeof s === 'string' ? s : (s.dir ?? s.broken))) });
      if (entries) Object.defineProperty(dt, 'items', { value: specs.map((s: any) => ({ kind: 'file', webkitGetAsEntry: () => entryOf(s) })) });
      list.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    },
    { specs, entries },
  );
}

test('a dropped folder is made with its subfolders, an empty one too, and every file lands at its path', async ({ page }) => {
  const server = await files(page);
  await drop(page, [
    'loose.txt',
    { dir: 'proj', kids: ['a.txt', 'b.txt', { dir: 'src', kids: ['c.txt', 'd.txt', { dir: 'deep', kids: ['e.txt'] }] }, { dir: 'empty', kids: [] }] },
  ]);
  await expect(page.getByRole('button', { name: /^proj$/ })).toBeVisible();
  expect(server.tree()).toEqual(['loose.txt', 'proj/', 'proj/a.txt', 'proj/b.txt', 'proj/empty/', 'proj/src/', 'proj/src/c.txt', 'proj/src/d.txt', 'proj/src/deep/', 'proj/src/deep/e.txt']);
  await page.getByRole('button', { name: /^proj$/ }).click();
  await page.getByRole('button', { name: /^src$/ }).click();
  await expect(page.getByRole('button', { name: /^deep$/ })).toBeVisible();
});

test('the progress counts every file of the tree, not the folders', async ({ page }) => {
  const server = await files(page);
  const release = server.hold();
  await drop(page, [{ dir: 'proj', kids: ['a.txt', { dir: 'src', kids: ['b.txt', 'c.txt'] }] }, 'd.txt']);
  await expect(page.getByText('Uploading 4 files…')).toBeVisible();
  release();
  await expect(page.getByText(/^Uploading \d+ files?…$/)).toHaveCount(0);
  expect(server.uploaded.sort()).toEqual(['d.txt', 'proj/a.txt', 'proj/src/b.txt', 'proj/src/c.txt']);
});

test('plain files are uploaded as before, with entries or without them', async ({ page }) => {
  const server = await files(page);
  await drop(page, ['one.txt', 'two.txt'], { entries: false });
  await expect(page.getByRole('button', { name: /^one\.txt/ })).toBeVisible();
  await drop(page, ['three.txt'], { entries: true });
  await expect(page.getByRole('button', { name: /^three\.txt/ })).toBeVisible();
  expect(server.tree()).toEqual(['one.txt', 'three.txt', 'two.txt']);
});

test('a name that is taken gets a number in a subfolder: for the folder dropped and for a file beside it', async ({ page }) => {
  const server = await files(page, { taken: ['inbox/', 'inbox/proj/', 'inbox/proj/a.txt', 'inbox/a.txt'] });
  await page.getByRole('button', { name: /^inbox$/ }).click();
  await expect(page.getByRole('button', { name: /^proj$/ })).toBeVisible();
  await drop(page, ['a.txt', { dir: 'proj', kids: ['a.txt', { dir: 'sub', kids: ['b.txt'] }] }]);
  await expect(page.getByRole('button', { name: /^proj \(2\)$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^a \(2\)\.txt/ })).toBeVisible();
  expect(server.tree()).toEqual([
    'inbox/',
    'inbox/a (2).txt',
    'inbox/a.txt',
    'inbox/proj (2)/',
    'inbox/proj (2)/a.txt',
    'inbox/proj (2)/sub/',
    'inbox/proj (2)/sub/b.txt',
    'inbox/proj/',
    'inbox/proj/a.txt',
  ]);
  // The old folder is not touched, and nothing was sent into it.
  expect(server.calls.filter((c) => c.startsWith('file inbox/proj/'))).toEqual([]);
});

test('one file that fails does not stop the rest, and says which', async ({ page }) => {
  const server = await files(page, { failing: ['bad.txt'] });
  await drop(page, [{ dir: 'proj', kids: ['a.txt', 'bad.txt', { dir: 'src', kids: ['b.txt'] }] }, 'z.txt']);
  // By its path: the words of the server do not say which of a few hundred files it was.
  await expect(page.getByRole('alert')).toContainText('proj/bad.txt: The file bad.txt could not be uploaded');
  expect(server.tree()).toEqual(['proj/', 'proj/a.txt', 'proj/src/', 'proj/src/b.txt', 'z.txt']);
  await expect(page.getByText(/^Uploading \d+ files?…$/)).toHaveCount(0);
});

test('a hostile name in a dropped folder is skipped and never sent, the rest goes up', async ({ page }) => {
  const server = await files(page);
  await drop(page, [{ dir: 'proj', kids: ['ok.txt', '..', { dir: '..', kids: ['evil.txt'] }, 'a\\b.txt'] }]);
  await expect(page.getByRole('alert')).toContainText('Skipped proj/..: it is not a path inside the folder.');
  expect(server.tree()).toEqual(['proj/', 'proj/ok.txt']);
  expect(server.calls).toEqual(['folder proj', 'file proj/ok.txt']);
});

test('an entry the browser cannot read is said so, not taken for a bad path, and the rest goes up', async ({ page }) => {
  const server = await files(page);
  await drop(page, [{ dir: 'proj', kids: ['ok.txt', { broken: 'gone.txt' }] }]);
  await expect(page.getByRole('alert')).toContainText('Skipped proj/gone.txt: it could not be read.');
  await expect(page.getByRole('alert')).not.toContainText('not a path');
  expect(server.tree()).toEqual(['proj/', 'proj/ok.txt']);
});

test('the folder button picks a folder and uploads its whole tree', async ({ page }) => {
  const server = await files(page);
  const base = mkdtempSync(path.join(tmpdir(), 'files-folder-pick-'));
  try {
    const top = path.join(base, 'picked');
    mkdirSync(path.join(top, 'src', 'deep'), { recursive: true });
    writeFileSync(path.join(top, 'a.txt'), 'a');
    writeFileSync(path.join(top, 'src', 'b.txt'), 'b');
    writeFileSync(path.join(top, 'src', 'deep', 'c.txt'), 'c');
    await expect(page.getByRole('button', { name: 'Upload a folder', exact: true })).toBeVisible();
    await page.getByTestId('files-folder-input').setInputFiles(top);
    await expect(page.getByRole('button', { name: /^picked$/ })).toBeVisible();
    expect(server.tree()).toEqual(['picked/', 'picked/a.txt', 'picked/src/', 'picked/src/b.txt', 'picked/src/deep/', 'picked/src/deep/c.txt']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('the file button still takes plain files, and a folder button is next to it', async ({ page }) => {
  const server = await files(page);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Upload files', exact: true }).click();
  const picker = await chooser;
  expect(picker.isMultiple()).toBe(true);
  await picker.setFiles([{ name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('x') }]);
  await expect(page.getByRole('button', { name: /^x\.txt/ })).toBeVisible();
  expect(server.tree()).toEqual(['x.txt']);
});
