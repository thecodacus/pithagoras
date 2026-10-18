import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply, DONE } from '../../../../tests/browser/portal-mock';

/**
 * A document edited on the Documents page: the extension's browser half
 * (extensions/docs/web) with the editor `npm run build` builds, against a
 * document store that answers as the server half does (extensions/docs/server.js):
 * a save names the revision it started from, and is refused (409) with the
 * document as it is when that is not where it stands.
 */
const NAME = 'pithagoras-docs';
const FOLDER = '0123456789abcdef';
const ID = '1111111111111111';
const web = (file: string) => readFileSync(new URL(`../../web/${file}`, import.meta.url), 'utf8');
const address = (file: string) => `/api/extension-ui/${NAME}/${file}`;
const API = `/api/x/${NAME}`;
const DOCUMENT = `${API}/folders/${FOLDER}/documents/${ID}`;

test.beforeAll(() => {
  execFileSync(process.execPath, [fileURLToPath(new URL('../../build.mjs', import.meta.url))], { stdio: 'ignore' });
});

const PLAN = '# The plan\n\nShip it on Friday.\n';

interface Revision { revision: number; author: string; kind: string; at: string; markdown: string; restoredFrom?: number }

/** One document, with its history, as the server half keeps it. */
class Store {
  revision = 3;
  markdown = PLAN;
  revisions: Revision[] = [
    { revision: 1, author: 'user', kind: 'create', at: '2026-10-01T09:00:00.000Z', markdown: '# The plan\n' },
    { revision: 2, author: 'agent', kind: 'save', at: '2026-10-01T10:00:00.000Z', markdown: '# The plan\n\nShip it soon.\n' },
    { revision: 3, author: 'user', kind: 'save', at: '2026-10-01T11:00:00.000Z', markdown: PLAN },
  ];
  /** What the page saved: the text, and the revision it said it started from. */
  puts: { markdown: string; base: number }[] = [];
  restores: { revision: number; base?: number }[] = [];
  /** Set to answer the next save with this body instead (a secret in the text, say). */
  next: Record<string, unknown> = {};

  constructor(markdown?: string) {
    if (markdown !== undefined) {
      this.markdown = markdown;
      this.revisions[2].markdown = markdown;
    }
  }

  private describe() {
    return { id: ID, name: 'plan.md', scope: 'project', chat: null, revision: this.revision, size: this.markdown.length, modified: '2026-10-01T11:00:00.000Z' };
  }

  /** A save from somewhere else (the agent, Files): the next revision. */
  elsewhere(markdown: string, author = 'agent') {
    this.write(markdown, author, 'save');
  }

  private write(markdown: string, author: string, kind: string, restoredFrom?: number) {
    this.revision += 1;
    this.markdown = markdown;
    this.revisions.push({ revision: this.revision, author, kind, at: new Date(Date.UTC(2026, 9, 2, this.revision)).toISOString(), markdown, restoredFrom });
  }

  read() {
    return { ...this.describe(), title: 'The plan', markdown: this.markdown };
  }

  save(markdown: string, base: number) {
    this.puts.push({ markdown, base });
    if (base !== this.revision) return reply(409, { error: `The document changed: it is at revision ${this.revision}, not ${base}`, revision: this.revision, markdown: this.markdown });
    const changed = markdown !== this.markdown;
    if (changed) this.write(markdown, 'user', 'save');
    const next = this.next;
    this.next = {};
    return { ...this.describe(), changed, ...next };
  }

  history(before?: number, limit = 200) {
    const list = this.revisions.filter((r) => r.revision < (before ?? Infinity)).sort((a, b) => b.revision - a.revision);
    return { revision: this.revision, revisions: list.slice(0, limit).map(({ markdown, ...r }) => r), more: list.length > limit };
  }

  restore(revision: number, base?: number) {
    this.restores.push({ revision, base });
    if (base !== undefined && base !== this.revision) return reply(409, { error: 'The document changed', revision: this.revision, markdown: this.markdown });
    const found = this.revisions.find((r) => r.revision === revision);
    if (!found) return reply(404, { error: 'There is no such revision' });
    const changed = found.markdown !== this.markdown;
    if (changed) this.write(found.markdown, 'user', 'restore', revision);
    return { ...this.describe(), changed, restoredFrom: revision };
  }
}

async function open(page: Page, store: Store, { editor = true }: { editor?: boolean } = {}) {
  const sessions = [{ id: 'a', title: 'First chat', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: new Date().toISOString(), provider: null, model: null, thinking_level: null }];
  const folders = [{ id: FOLDER, name: 'site', path: '/w/site', chats: [{ id: 'a', title: 'First chat' }], documents: [{ id: ID, name: 'plan.md', title: 'The plan', revision: store.revision, size: 40, modified: '2026-10-01T11:00:00.000Z' }] }];
  await mockPortal(page, async ({ path: p, method, url, route, json }) => {
    if (p === '/api/extension-ui') return { extensions: [{ name: NAME, version: '0.1.0', entry: address('client.js') + '?v=1', style: address('client.css') + '?v=1', server: API }] };
    if (p.startsWith(address(''))) {
      if (!editor && p.endsWith('/editor.js')) return reply(404, { error: 'There is no editor' });
      await route.fulfill({ contentType: p.endsWith('.css') ? 'text/css' : 'text/javascript', body: web(p.slice(address('').length)) });
      return DONE;
    }
    if (p === `${API}/folders`) return { folders };
    if (p === DOCUMENT && method === 'GET') return store.read();
    if (p === DOCUMENT && method === 'PUT') { const { markdown, base } = json(); return store.save(markdown, base); }
    if (p === `${DOCUMENT}/threads`) return { revision: store.revision, threads: [] };
    if (p === `${DOCUMENT}/history`) return store.history(url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined, Number(url.searchParams.get('limit') ?? 200));
    if (p === `${DOCUMENT}/restore`) { const { revision, base } = json(); return store.restore(revision, base); }
    const revision = /\/revisions\/(\d+)$/.exec(p);
    if (revision && p.startsWith(`${DOCUMENT}/`)) { const found = store.revisions.find((r) => r.revision === Number(revision[1])); return found ? { ...found, markdown: found.markdown } : reply(404, { error: 'There is no such revision' }); }
    if (p === '/api/sessions') return { sessions, executor: 'host' };
    if (p === '/api/models') return { models: [], providers: {} };
  });
  await page.goto(`/x/${NAME}/documents?folder=${FOLDER}&doc=${ID}`);
}

const editorOf = (page: Page) => page.locator('.pd-editor .ProseMirror');
const state = (page: Page) => page.locator('.pd-state');
/** Types at the end of the document's last line. */
async function typeAtEnd(page: Page, text: string) {
  await editorOf(page).click();
  await page.keyboard.press('Control+End');
  // The editor learns where the caret went a moment after the browser moved it; keys that act on its own idea of it (Enter) must not come first.
  await page.waitForTimeout(100);
  await page.keyboard.type(text);
}

test('a save carries the revision the text started from, and the next one the revision that came back', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  await expect(state(page)).toHaveText('Saved · Revision 3');

  await typeAtEnd(page, ' Or Monday.');
  await expect(state(page)).toHaveText('Unsaved changes · Revision 3');
  // After a second of nothing typed, with no button pressed.
  await expect(state(page)).toHaveText('Saved · Revision 4');
  expect(store.puts).toEqual([{ markdown: '# The plan\n\nShip it on Friday. Or Monday.\n', base: 3 }]);

  await page.keyboard.type(' Maybe Tuesday.');
  await expect(state(page)).toHaveText('Saved · Revision 5');
  expect(store.puts.map((put) => put.base)).toEqual([3, 4]);
  expect(store.markdown).toBe('# The plan\n\nShip it on Friday. Or Monday. Maybe Tuesday.\n');
});

test('the usual Markdown shortcuts work as one types, and Ctrl+S saves at once', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  await typeAtEnd(page, '\n## Next\n- one\n');
  await page.keyboard.type('two');
  await page.keyboard.press('Control+b');
  await page.keyboard.type('bold');
  await page.keyboard.press('Control+b');
  // Well before the second is out.
  await page.keyboard.press('Control+s');
  await expect.poll(() => store.puts.length, { timeout: 800 }).toBe(1);
  expect(store.puts[0].markdown).toBe('# The plan\n\nShip it on Friday.\n\n## Next\n\n- one\n- two**bold**\n');
  await expect(state(page)).toHaveText('Saved · Revision 4');
});

test('text typed in quick succession is saved once, after it stops, and what is typed while a save is on its way is saved after it', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await typeAtEnd(page, ' One');
  await page.keyboard.type(' two three four five six');
  await expect(state(page)).toHaveText('Saved · Revision 4');
  expect(store.puts).toHaveLength(1);

  // A save that takes its time: what is typed meanwhile is not lost, and not sent in the same request.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**${DOCUMENT}`, async (route) => {
    if (route.request().method() === 'PUT') await held;
    await route.fallback();
  });
  await page.keyboard.type(' seven');
  await expect(state(page)).toHaveText('Saving… · Revision 4');
  await page.keyboard.type(' eight');
  release();
  await expect(state(page)).toHaveText('Saved · Revision 6');
  expect(store.puts.map((put) => put.base)).toEqual([3, 4, 5]);
  expect(store.markdown).toBe('# The plan\n\nShip it on Friday. One two three four five six seven eight\n');
});

test('a document that was only opened is not saved, even one the editor would write in another style', async ({ page }) => {
  const store = new Store('* One\n* Two\n\nText  \nmore\n');
  await open(page, store);
  await expect(editorOf(page)).toContainText('One');
  // Focus in and out writes nothing: what the editor holds is the same document.
  await editorOf(page).click();
  // (The editor takes a moment to register where the click put the caret, before focus may leave.)
  await page.waitForTimeout(150);
  await page.getByRole('button', { name: 'History' }).focus();
  await page.waitForTimeout(1500);
  expect(store.puts).toEqual([]);
  await expect(state(page)).toHaveText('Saved · Revision 3');
  // A change writes what the editor holds, in its own style.
  await typeAtEnd(page, ' end');
  await expect(state(page)).toHaveText('Saved · Revision 4');
  expect(store.puts).toEqual([{ markdown: '- One\n- Two\n\nText\\\nmore end\n', base: 3 }]);
});

test('text typed and then given back is not saved either', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await typeAtEnd(page, 'x');
  await expect(state(page)).toHaveText('Unsaved changes · Revision 3');
  await page.keyboard.press('Backspace');
  await expect(state(page)).toHaveText('Saved · Revision 3');
  await page.waitForTimeout(1300);
  expect(store.puts).toEqual([]);
});

test('a front matter block and the line endings of a document come back as they were', async ({ page }) => {
  const original = '---\ntitle: Plan\ntags: [a, b]\n---\n\n# The plan\r\n\r\nShip it.\r\n';
  const store = new Store(original);
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it.');
  // The front matter is not the page's to show as Markdown.
  await expect(editorOf(page)).not.toContainText('tags');
  await typeAtEnd(page, ' Now.');
  await expect(state(page)).toHaveText('Saved · Revision 4');
  expect(store.puts).toEqual([{ markdown: '---\ntitle: Plan\ntags: [a, b]\n---\n\n# The plan\r\n\r\nShip it. Now.\r\n', base: 3 }]);
});

test('a picture in a document is drawn as its text and fetched from nowhere, and is written back as it was', async ({ page }) => {
  const original = '# The plan\n\n![Remote chart](https://tracker.test/pixel.png)\n\n![Local chart](images/chart.png "A title")\n\nText.\n';
  const store = new Store(original);
  const fetched: string[] = [];
  page.on('request', (request) => void (/pixel|chart\.png/.test(request.url()) && fetched.push(request.url())));
  await open(page, store);
  await expect(editorOf(page)).toContainText('Remote chart');
  await expect(editorOf(page)).toContainText('Local chart');
  // (ProseMirror puts bare separator images of its own after a line that ends in a picture.)
  await expect(editorOf(page).locator('img:not(.ProseMirror-separator)')).toHaveCount(0);
  await typeAtEnd(page, ' More.');
  await expect(state(page)).toHaveText('Saved · Revision 4');
  expect(store.puts).toEqual([{ markdown: original.replace('Text.', 'Text. More.'), base: 3 }]);
  expect(fetched).toEqual([]);
});

test('a save refused because the document changed keeps what was typed, and nothing more is sent', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  // The agent saves while the page has it open.
  store.elsewhere('# The plan\n\nShip it on Friday, said the agent.\n');
  await typeAtEnd(page, ' My own words.');

  const banner = page.locator('.pd-conflict');
  await expect(banner).toContainText('This document changed while you were editing it, and is now at revision 4. Your text is kept here and has not been saved.');
  await expect(state(page)).toHaveText('Not saved · Revision 3');
  // The text is where it was, not replaced by theirs.
  await expect(editorOf(page)).toContainText('Ship it on Friday. My own words.');
  await expect(editorOf(page)).not.toContainText('said the agent');
  expect(store.puts).toEqual([{ markdown: '# The plan\n\nShip it on Friday. My own words.\n', base: 3 }]);
  // Typing on does not send it again: the person has not chosen yet.
  await page.keyboard.type(' More.');
  await page.waitForTimeout(1500);
  expect(store.puts).toHaveLength(1);
  expect(store.revision).toBe(4);
  // The other version is there to read before choosing.
  await banner.getByText('Show the other version').click();
  await expect(banner).toContainText('Ship it on Friday, said the agent.');
});

test('keeping my text after a conflict saves it as the revision after theirs', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  store.elsewhere('# The plan\n\nTheirs.\n');
  await typeAtEnd(page, ' Mine.');
  await expect(page.locator('.pd-conflict')).toBeVisible();

  await page.getByRole('button', { name: 'Keep mine as a new revision' }).click();
  await expect(page.locator('.pd-conflict')).toHaveCount(0);
  await expect(state(page)).toHaveText('Saved · Revision 5');
  expect(store.puts.at(-1)).toEqual({ markdown: '# The plan\n\nShip it on Friday. Mine.\n', base: 4 });
  // Theirs is in the history, not lost.
  expect(store.revisions.find((r) => r.revision === 4)?.markdown).toBe('# The plan\n\nTheirs.\n');
  await expect(editorOf(page)).toContainText('Ship it on Friday. Mine.');
});

test('taking theirs after a conflict asks first, then shows their version and sends nothing', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  store.elsewhere('# The plan\n\nTheirs.\n');
  await typeAtEnd(page, ' Mine.');
  await expect(page.locator('.pd-conflict')).toBeVisible();

  await page.getByRole('button', { name: 'Take theirs' }).click();
  // Declined: the text stays.
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(editorOf(page)).toContainText('Mine.');
  await expect(page.locator('.pd-conflict')).toBeVisible();

  await page.getByRole('button', { name: 'Take theirs' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Take theirs' }).click();
  await expect(page.locator('.pd-conflict')).toHaveCount(0);
  await expect(editorOf(page)).toContainText('Theirs.');
  await expect(editorOf(page)).not.toContainText('Mine.');
  await expect(state(page)).toHaveText('Saved · Revision 4');
  // The next change is saved on top of theirs.
  await typeAtEnd(page, ' Again.');
  await expect(state(page)).toHaveText('Saved · Revision 5');
  expect(store.puts.map((put) => put.base)).toEqual([3, 4]);
});

test('text that could not be saved is still there after the page is reloaded, and is again a choice', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  store.elsewhere('# The plan\n\nTheirs.\n');
  await typeAtEnd(page, ' Mine.');
  await expect(page.locator('.pd-conflict')).toBeVisible();

  await page.reload();
  await expect(editorOf(page)).toContainText('Ship it on Friday. Mine.');
  await expect(page.locator('.pd-conflict')).toContainText('is now at revision 4');
  await expect(page.locator('.pd-note')).toContainText('Text you had not saved was brought back.');
  // Nothing was written by the reload.
  expect(store.puts).toHaveLength(1);
  await page.getByRole('button', { name: 'Keep mine as a new revision' }).click();
  await expect(state(page)).toHaveText('Saved · Revision 5');
  // Saved: nothing is kept for the next visit.
  await page.reload();
  await expect(editorOf(page)).toContainText('Ship it on Friday. Mine.');
  await expect(page.locator('.pd-note')).toHaveCount(0);
  await expect(page.locator('.pd-conflict')).toHaveCount(0);
});

test('text typed after a conflict is kept when the page is left through the portal, and is there when the document is opened again', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Destinations' }).getByRole('button', { name: 'Documents' }).click();
  await page.getByRole('button', { name: /The plan/ }).click();
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  store.elsewhere('# The plan\n\nTheirs.\n');
  await typeAtEnd(page, ' Mine.');
  await expect(page.locator('.pd-conflict')).toBeVisible();
  // More text on top of what was kept when the conflict came up: no state changes with it.
  await typeAtEnd(page, ' Typed after the conflict.');
  await page.waitForTimeout(400);
  await page.goBack();
  await expect(editorOf(page)).toHaveCount(0);
  expect(store.puts).toHaveLength(1);
  await page.getByRole('navigation', { name: 'Destinations' }).getByRole('button', { name: 'Documents' }).click();
  await page.getByRole('button', { name: /The plan/ }).click();
  await expect(editorOf(page)).toContainText('Ship it on Friday. Mine. Typed after the conflict.');
  await expect(page.locator('.pd-conflict')).toContainText('is now at revision 4');
  await expect(page.locator('.pd-note')).toContainText('Text you had not saved was brought back.');
  expect(store.puts).toHaveLength(1);
});

test('a save that failed is said, kept, and tried again by the button', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  let fail = true;
  await page.route(`**${DOCUMENT}`, (route) => (fail && route.request().method() === 'PUT' ? route.fulfill({ status: 500, json: { error: 'The documents store could not do that' } }) : route.fallback()));
  await typeAtEnd(page, ' More.');
  await expect(page.getByRole('alert')).toContainText('Could not save: The documents store could not do that');
  await expect(state(page)).toHaveText('Not saved · Revision 3');
  await expect(editorOf(page)).toContainText('More.');
  fail = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(state(page)).toHaveText('Saved · Revision 4');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(store.markdown).toBe('# The plan\n\nShip it on Friday. More.\n');
});

test('going back to the list saves what was typed first, and stays when it cannot be saved', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  await typeAtEnd(page, ' Quick.');
  // At once, without waiting out the second.
  await page.getByRole('button', { name: /All documents/ }).click();
  await expect(page.getByRole('region', { name: 'site' })).toBeVisible();
  expect(store.markdown).toBe('# The plan\n\nShip it on Friday. Quick.\n');

  await page.getByRole('button', { name: /The plan/ }).click();
  await expect(editorOf(page)).toContainText('Quick.');
  store.elsewhere('# The plan\n\nTheirs.\n');
  await typeAtEnd(page, ' Mine.');
  await page.getByRole('button', { name: /All documents/ }).click();
  // The text has nowhere to go: the page stays, with the choice.
  await expect(page.locator('.pd-conflict')).toBeVisible();
  await expect(page.getByRole('region', { name: 'site' })).toHaveCount(0);
  await expect(editorOf(page)).toContainText('Mine.');
});

test('moving out of the text saves it at once, without waiting out the second', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  await typeAtEnd(page, ' Out.');
  // Straight away: the editor says it changed a moment after it did, and what is saved is its text now.
  await page.locator('.pd-meta').click();
  await expect.poll(() => store.puts.length, { timeout: 700 }).toBe(1);
  expect(store.puts[0]).toEqual({ markdown: '# The plan\n\nShip it on Friday. Out.\n', base: 3 });
});

test('leaving the page with text not saved yet saves it, and keeps nothing once it is', async ({ page }) => {
  // The autosave's second never runs here: what saves the text is the page being left, and nothing else.
  await page.addInitScript(() => {
    const set = window.setTimeout.bind(window);
    window.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => (ms === 1000 ? 0 : set(fn, ms, ...args))) as typeof window.setTimeout;
  });
  const store = new Store();
  await open(page, store);
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Destinations' }).getByRole('button', { name: 'Documents' }).click();
  await page.getByRole('button', { name: /The plan/ }).click();
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  await typeAtEnd(page, ' On the way out.');
  // Back to the page before: the editor is taken down with the focus still in it and the text not saved.
  await page.goBack();
  await expect(editorOf(page)).toHaveCount(0);
  await expect.poll(() => store.puts.length).toBe(1);
  expect(store.markdown).toBe('# The plan\n\nShip it on Friday. On the way out.\n');
  expect(store.puts).toEqual([{ markdown: '# The plan\n\nShip it on Friday. On the way out.\n', base: 3 }]);
  // It was saved: no draft is left to be brought back.
  await page.goto(`/x/${NAME}/documents?folder=${FOLDER}&doc=${ID}`);
  await expect(editorOf(page)).toContainText('On the way out.');
  await expect(page.locator('.pd-note')).toHaveCount(0);
});

test('a page that is closed sends the text on its way out, and keeps it until it is saved', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**${DOCUMENT}`, async (route) => {
    if (route.request().method() === 'PUT') await held;
    await route.fallback();
  });
  await typeAtEnd(page, ' Last words.');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect.poll(() => store.puts.length).toBe(0);
  const kept = () => page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith('pithagoras-docs/draft/')).map(([, value]) => JSON.parse(value)));
  // Until the server has it, it is also in the tab's storage.
  expect(await kept()).toEqual([{ base: 3, markdown: '# The plan\n\nShip it on Friday. Last words.\n' }]);
  release();
  await expect(state(page)).toHaveText('Saved · Revision 4');
  expect(store.puts).toEqual([{ markdown: '# The plan\n\nShip it on Friday. Last words.\n', base: 3 }]);
  expect(await kept()).toEqual([]);
});

test('closing the page with text that cannot be saved asks first, and with text on its way to being saved does not', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  const asks = () => page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; });
  await typeAtEnd(page, ' One.');
  expect(await asks()).toBe(false);
  await expect(state(page)).toHaveText('Saved · Revision 4');
  store.elsewhere('# The plan\n\nTheirs.\n');
  await typeAtEnd(page, ' Two.');
  await expect(page.locator('.pd-conflict')).toBeVisible();
  expect(await asks()).toBe(true);
});

test('closing the page asks first when the unsaved text is too large to be sent on the way out', async ({ page }) => {
  const paragraphs = Array.from({ length: 1100 }, (_, i) => `Paragraph ${i + 1} of a long document, with some words in it to make it long.`);
  const store = new Store(`# Long\n\n${paragraphs.join('\n\n')}\n`);
  await open(page, store);
  await expect(editorOf(page)).toContainText('Paragraph 1100');
  const asks = () => page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; });
  // Saved: nothing to ask about, however large.
  expect(await asks()).toBe(false);
  await typeAtEnd(page, ' Last words.');
  // A browser does not send a request this large once the page is gone (64 KiB): the person is asked, within the second before autosave.
  expect(await asks()).toBe(true);
  await expect(state(page)).toHaveText('Saved · Revision 4');
  expect(await asks()).toBe(false);
});

test('a front matter block with nothing after it is closed when the first line is typed after it', async ({ page }) => {
  const store = new Store('---\ntitle: x\n---');
  await open(page, store);
  await editorOf(page).click();
  await page.waitForTimeout(150);
  await page.keyboard.type('Hello');
  await expect(state(page)).toHaveText('Saved · Revision 4');
  expect(store.puts).toEqual([{ markdown: '---\ntitle: x\n---\nHello\n', base: 3 }]);
});

test('a secret the server warns about is said once, and not again while it stays in the text', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  store.next = { warning: 'This text looks like it holds a secret.' };
  await typeAtEnd(page, ' One.');
  await expect(page.getByRole('status').filter({ hasText: 'looks like it holds a secret' })).toBeVisible();
  await page.getByRole('status').filter({ hasText: 'looks like it holds a secret' }).getByRole('button', { name: 'Dismiss' }).click();
  store.next = { warning: 'This text looks like it holds a secret.' };
  await typeAtEnd(page, ' Two.');
  await expect(state(page)).toHaveText('Saved · Revision 5');
  await expect(page.getByText('looks like it holds a secret')).toHaveCount(0);
});

test('a save that made the document\'s file again, because it was deleted or renamed, says so', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  store.next = { recreated: true };
  await typeAtEnd(page, ' One.');
  await expect(state(page)).toHaveText('Saved · Revision 4');
  await expect(page.getByRole('status').filter({ hasText: 'file had been deleted or renamed' })).toHaveText("This document's file had been deleted or renamed. It was made again from your text, and is now at revision 4.Close");
  // An ordinary save after it says nothing more of it.
  await page.getByRole('button', { name: 'Close' }).click();
  await typeAtEnd(page, ' Two.');
  await expect(state(page)).toHaveText('Saved · Revision 5');
  await expect(page.getByText('file had been deleted or renamed')).toHaveCount(0);
});

test('the note that the file was made again, and the warning of a secret, are in German in a German portal, whatever the server half wrote them in', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pithagoras.language', 'de'));
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  store.next = { recreated: true, warning: 'This document looks like it holds a secret.', warningCode: 'secret' };
  await typeAtEnd(page, ' Eins.');
  await expect(state(page)).toHaveText('Gespeichert · Revision 4');
  await expect(page.getByRole('status').filter({ hasText: 'Die Datei dieses Dokuments' })).toContainText('Die Datei dieses Dokuments war gelöscht oder umbenannt worden. Sie wurde aus deinem Text neu angelegt, und das Dokument steht jetzt bei Revision 4.');
  await expect(page.getByRole('status').filter({ hasText: 'Zugangsdaten' })).toContainText('Dieses Dokument enthält offenbar Zugangsdaten (einen privaten Schlüssel oder ein Token).');
  await expect(page.getByText('looks like it holds a secret')).toHaveCount(0);
});

test('the history lists the revisions, shows one, and brings it back as a new revision', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  await page.getByRole('button', { name: 'History' }).click();
  const history = page.getByRole('region', { name: 'History' });
  const rows = history.getByRole('listitem');
  await expect(rows).toHaveText([/^Revision 3Current\s*You · /, /^Revision 2\s*The agent · /, /^Revision 1\s*You · Created · /]);

  await history.getByRole('button', { name: /^Revision 2/ }).click();
  await expect(history.locator('.pd-preview')).toContainText('Ship it soon.');
  // What is shown is a look; the document is where it was.
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  await history.getByRole('button', { name: 'Restore this revision' }).click();

  await expect(editorOf(page)).toContainText('Ship it soon.');
  await expect(state(page)).toHaveText('Saved · Revision 4');
  expect(store.restores).toEqual([{ revision: 2, base: 3 }]);
  expect(store.markdown).toBe('# The plan\n\nShip it soon.\n');
  await expect(page.locator('.pd-note')).toContainText('Revision 2 is back, as revision 4.');
  // The new revision is in the list, as a restore, and the old ones are still there.
  await expect(rows).toHaveText([/^Revision 4Current\s*You · Restored from revision 2 · /, /^Revision 3/, /^Revision 2/, /^Revision 1/]);
  // The preview closed with it; the current revision has nothing to restore.
  await expect(history.locator('.pd-preview')).toHaveCount(0);
  await history.getByRole('button', { name: /^Revision 4/ }).click();
  await expect(history.getByText('This is the current revision.')).toBeVisible();
  await expect(history.getByRole('button', { name: 'Restore this revision' })).toHaveCount(0);
});

test('restoring saves what was typed first, as a revision to go back to', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  await page.getByRole('button', { name: 'History' }).click();
  await typeAtEnd(page, ' Unsaved words.');
  const history = page.getByRole('region', { name: 'History' });
  await history.getByRole('button', { name: /^Revision 1/ }).click();
  await history.getByRole('button', { name: 'Restore this revision' }).click();
  await expect(state(page)).toHaveText('Saved · Revision 5');
  // The typed text went in as revision 4, and revision 1 came back on top of it.
  expect(store.puts).toEqual([{ markdown: '# The plan\n\nShip it on Friday. Unsaved words.\n', base: 3 }]);
  expect(store.restores).toEqual([{ revision: 1, base: 4 }]);
  expect(store.revisions.find((r) => r.revision === 4)?.markdown).toBe('# The plan\n\nShip it on Friday. Unsaved words.\n');
  await expect(editorOf(page)).not.toContainText('Unsaved words.');
});

test('restoring waits for the choice when the text cannot be saved', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  await page.getByRole('button', { name: 'History' }).click();
  store.elsewhere('# The plan\n\nTheirs.\n');
  await typeAtEnd(page, ' Mine.');
  await expect(page.locator('.pd-conflict')).toBeVisible();
  const history = page.getByRole('region', { name: 'History' });
  await history.getByRole('button', { name: /^Revision 1/ }).click();
  await history.getByRole('button', { name: 'Restore this revision' }).click();
  // Nothing was restored, and the text is still there.
  await expect(page.locator('.pd-conflict')).toBeVisible();
  await expect(editorOf(page)).toContainText('Mine.');
  expect(store.restores).toEqual([]);
});

test('restoring a revision when the document has moved on shows the document as it is and says so', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  await page.getByRole('button', { name: 'History' }).click();
  const history = page.getByRole('region', { name: 'History' });
  await history.getByRole('button', { name: /^Revision 1/ }).click();
  store.elsewhere('# The plan\n\nTheirs.\n');
  await history.getByRole('button', { name: 'Restore this revision' }).click();
  await expect(page.locator('.pd-note')).toContainText('The document changed in the meantime and is now at revision 4. Restore revision 1 again if you still want it.');
  await expect(editorOf(page)).toContainText('Theirs.');
  await expect(state(page)).toHaveText('Saved · Revision 4');
  expect(store.markdown).toBe('# The plan\n\nTheirs.\n');
});

test('an older page of the history is asked for when wanted', async ({ page }) => {
  const store = new Store();
  for (let n = 4; n <= 60; n++) store.elsewhere(`# The plan\n\nVersion ${n}.\n`);
  await open(page, store);
  await page.getByRole('button', { name: 'History' }).click();
  const history = page.getByRole('region', { name: 'History' });
  await expect(history.getByRole('listitem')).toHaveCount(50);
  await expect(history.getByRole('listitem').first()).toContainText('Revision 60');
  await history.getByRole('button', { name: 'Show older revisions' }).click();
  await expect(history.getByRole('listitem')).toHaveCount(60);
  await expect(history.getByRole('listitem').last()).toContainText('Revision 1');
  await expect(history.getByRole('button', { name: 'Show older revisions' })).toHaveCount(0);
});

test('a revision that cannot be read says so, and the history that cannot be listed can be asked for again', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  let broken = true;
  await page.route(`**${DOCUMENT}/history*`, (route) => (broken ? route.fulfill({ status: 500, json: { error: 'The documents store could not do that' } }) : route.fallback()));
  await page.getByRole('button', { name: 'History' }).click();
  const history = page.getByRole('region', { name: 'History' });
  await expect(history.getByRole('alert')).toContainText('The documents store could not do that');
  broken = false;
  await history.getByRole('button', { name: 'Try again' }).click();
  await expect(history.getByRole('listitem')).toHaveCount(3);
  await page.route(`**${DOCUMENT}/revisions/2`, (route) => route.fulfill({ status: 404, json: { error: 'There is no such revision' } }));
  await history.getByRole('button', { name: /^Revision 2/ }).click();
  await expect(history.locator('.pd-preview').getByRole('alert')).toContainText('There is no such revision');
  await expect(history.getByRole('button', { name: 'Restore this revision' })).toBeDisabled();
});

test('a document is read as the portal draws Markdown when the editor cannot be loaded', async ({ page }) => {
  const store = new Store();
  await open(page, store, { editor: false });
  await expect(page.getByRole('alert')).toContainText('The editor could not be loaded');
  await expect(page.getByText('Ship it on Friday.', { exact: true })).toBeVisible();
  await expect(page.locator('.pd-editor')).toHaveCount(0);
  expect(store.puts).toEqual([]);
});

test('the editor page speaks German in a German portal', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pithagoras.language', 'de'));
  const store = new Store();
  await open(page, store);
  await expect(state(page)).toHaveText('Gespeichert · Revision 3');
  await typeAtEnd(page, ' Mehr.');
  await expect(state(page)).toHaveText('Nicht gespeicherte Änderungen · Revision 3');
  await expect(state(page)).toHaveText('Gespeichert · Revision 4');
  await page.getByRole('button', { name: 'Verlauf' }).click();
  await expect(page.getByRole('region', { name: 'Verlauf' }).getByRole('listitem').first()).toContainText('Revision 4Aktuell');
  await expect(page.getByRole('region', { name: 'Verlauf' }).getByRole('listitem').last()).toContainText('Du · Erstellt · ');
  store.elsewhere('# Der Plan\n');
  await typeAtEnd(page, ' Noch mehr.');
  await expect(page.locator('.pd-conflict')).toContainText('Dieses Dokument wurde geändert, während du es bearbeitet hast, und steht jetzt bei Revision 5.');
  await expect(page.getByRole('button', { name: 'Meinen Text als neue Revision behalten' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Die andere Version übernehmen' })).toBeVisible();
});

test('a document of the largest size opens in the editor, takes what is typed at once, and is saved in one request', async ({ page }) => {
  const paragraphs = Array.from({ length: 12_000 }, (_, i) => `Paragraph ${i} ${'word '.repeat(10)}`.trim());
  let text = `# Big\n\n${paragraphs.join('\n\n')}\n`;
  while (Buffer.byteLength(text) > 1024 * 1024) text = text.slice(0, -1000).replace(/[^\n]*$/, '');
  expect(Buffer.byteLength(text)).toBeGreaterThan(700_000);
  const store = new Store(text);
  await open(page, store);
  await expect(editorOf(page)).toContainText('Paragraph 5', { timeout: 60_000 });
  const typing = Date.now();
  await typeAtEnd(page, ' Last words.');
  // The editor keeps up with a person typing: a document this size is not one they wait for key by key.
  expect(Date.now() - typing).toBeLessThan(10_000);
  await expect(state(page)).toHaveText('Saved · Revision 4', { timeout: 60_000 });
  expect(store.puts.length).toBe(1);
  expect(store.puts[0].markdown).toBe(text.replace(/\n$/, ' Last words.\n'));
});

/** Selects the words `text` in the editor's text, within one block, as a person would by dragging over them. */
async function selectWords(page: Page, text: string) {
  await editorOf(page).getByText(text, { exact: false }).first().click();
  await page.evaluate((text) => {
    const walker = document.createTreeWalker(document.querySelector('.pd-editor .ProseMirror')!, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent!.indexOf(text);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + text.length);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      return;
    }
    throw new Error(`${text} is not in the editor`);
  }, text);
}

const tool = (page: Page, name: string) => page.getByRole('toolbar', { name: 'Formatting' }).getByRole('button', { name, exact: true });
/** What the page saves at once (Ctrl+S), once the editor has the change. */
async function saved(page: Page, store: Store) {
  const before = store.puts.length;
  await editorOf(page).press('Control+s');
  await expect.poll(() => store.puts.length).toBeGreaterThan(before);
  return store.puts.at(-1)!.markdown;
}

test('the toolbar makes the selected words bold or a link, a paragraph a heading or a list, and says what is on where the selection is', async ({ page }) => {
  const store = new Store('# The plan\n\nShip it on Friday.\n\nThe build is green.\n');
  await open(page, store);
  await expect(editorOf(page)).toContainText('The build is green.');
  // Nothing to undo yet, and nothing selected to comment on.
  await expect(tool(page, 'Undo')).toBeDisabled();
  await expect(tool(page, 'Comment')).toBeDisabled();

  await selectWords(page, 'Friday');
  await expect(tool(page, 'Bold')).toHaveAttribute('aria-pressed', 'false');
  await expect(tool(page, 'Comment')).toBeEnabled();
  await tool(page, 'Bold').click();
  await expect(tool(page, 'Bold')).toHaveAttribute('aria-pressed', 'true');
  await tool(page, 'Italic').click();
  expect(await saved(page, store)).toBe('# The plan\n\nShip it on ***Friday***.\n\nThe build is green.\n');
  await expect(tool(page, 'Undo')).toBeEnabled();

  // The kind of paragraph, from the list of styles; it says the kind where the caret is.
  const style = page.getByRole('combobox', { name: 'Text style' });
  await expect(style).toHaveText('Normal text');
  await style.click();
  await page.getByRole('option', { name: 'Heading 2' }).click();
  await expect(style).toHaveText('Heading 2');
  // Choosing gives the text the focus back (not the list's button), so that typing goes on in it.
  await expect(editorOf(page)).toBeFocused();
  // (The list taking the focus out of the text and the text taking it back saves it, so there is nothing more for Ctrl+S to write.)
  await expect.poll(() => store.markdown).toBe('# The plan\n\n## Ship it on ***Friday***.\n\nThe build is green.\n');
  await editorOf(page).getByText('The plan').click();
  await expect(style).toHaveText('Heading 1');

  // Lists, one kind for another, and off again.
  await editorOf(page).getByText('The build is green.').click();
  await tool(page, 'Bulleted list').click();
  await expect(tool(page, 'Bulleted list')).toHaveAttribute('aria-pressed', 'true');
  expect(await saved(page, store)).toMatch(/\n- The build is green\.\n$/);
  await tool(page, 'Checklist').click();
  await expect(tool(page, 'Checklist')).toHaveAttribute('aria-pressed', 'true');
  expect(await saved(page, store)).toMatch(/\n- \[ \] The build is green\.\n$/);
  // A box is ticked with a click before its item.
  const item = editorOf(page).locator('li[data-item-type="task"]');
  const box = (await item.boundingBox())!;
  await page.mouse.click(box.x - 10, box.y + box.height / 2);
  await expect(item).toHaveAttribute('data-checked', 'true');
  expect(await saved(page, store)).toMatch(/\n- \[x\] The build is green\.\n$/);
  await tool(page, 'Numbered list').click();
  expect(await saved(page, store)).toMatch(/\n1\. The build is green\.\n$/);
  await tool(page, 'Numbered list').click();
  expect(await saved(page, store)).toMatch(/\n\nThe build is green\.\n$/);

  // A link: its address is asked for in the toolbar, and it is taken off again with the same button.
  await selectWords(page, 'green');
  await tool(page, 'Link').click();
  const address = page.getByRole('textbox', { name: 'Address of the link' });
  await address.fill('https://example.com/ci');
  await address.press('Enter');
  expect(await saved(page, store)).toMatch(/The build is \[green\]\(https:\/\/example\.com\/ci\)\.\n$/);
  await editorOf(page).getByRole('link', { name: 'green' }).click();
  await tool(page, 'Remove link').click();
  expect(await saved(page, store)).toMatch(/\n\nThe build is green\.\n$/);

  // Undo takes back the last change.
  await tool(page, 'Undo').click();
  expect(await saved(page, store)).toMatch(/\[green\]\(https:\/\/example\.com\/ci\)/);
});

test('a table and a rule are put in from the toolbar, and a quote is made and taken off', async ({ page }) => {
  const store = new Store('# The plan\n\nShip it on Friday.\n');
  await open(page, store);
  await editorOf(page).getByText('Ship it on Friday.').click();
  await tool(page, 'Quote').click();
  await expect(tool(page, 'Quote')).toHaveAttribute('aria-pressed', 'true');
  expect(await saved(page, store)).toBe('# The plan\n\n> Ship it on Friday.\n');
  await tool(page, 'Quote').click();
  expect(await saved(page, store)).toBe('# The plan\n\nShip it on Friday.\n');
  await tool(page, 'Horizontal line').click();
  await tool(page, 'Insert table').click();
  await expect(editorOf(page).locator('table tr')).toHaveCount(3);
  // The caret is in the table: another one is not put in it.
  await expect(tool(page, 'Insert table')).toBeDisabled();
  expect(await saved(page, store)).toMatch(/^# The plan\n\nShip it on Friday\.\n\n---\n\n\| +\| +\| +\|\n\| :?-+ \| :?-+ \| :?-+ \|\n/);
});

test('a document is downloaded as its Markdown file, or printed on its own to be saved as a PDF', async ({ page }) => {
  // What is printed: the frame the page prints is read as it is printed.
  await page.addInitScript(() => {
    (window as any).printed = [];
    new MutationObserver((changes) => {
      for (const change of changes) for (const node of change.addedNodes) if (node instanceof HTMLIFrameElement) setTimeout(() => (window as any).printed.push({ title: node.contentDocument?.title, text: node.contentDocument?.querySelector('article')?.textContent, sandbox: node.getAttribute('sandbox') }));
    }).observe(document, { childList: true, subtree: true });
  });
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  await page.getByRole('button', { name: 'Download' }).click();
  const markdown = page.getByRole('menuitem', { name: 'Markdown (.md)' });
  await expect(markdown).toHaveAttribute('href', `${DOCUMENT}/download`);
  await expect(markdown).toHaveAttribute('download', 'plan.md');
  await page.getByRole('menuitem', { name: 'PDF (print)' }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).printed)).toEqual([{ title: 'The plan', text: 'The planShip it on Friday.', sandbox: 'allow-same-origin allow-modals' }]);
  // Escape closes the menu, as a click elsewhere does.
  await page.getByRole('button', { name: 'Download' }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('a document opened on the page is the whole page: its bar, the toolbar and the text on the rest of it, with no list above it', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toHaveCount(0);
  await expect(page.locator('.pd-titlebar')).toContainText('The plan');
  await expect(page.locator('.pd-titlebar')).toContainText('documents/plan.md');
  await expect(page.getByRole('toolbar', { name: 'Formatting' })).toBeVisible();
  // The text is on the whole of the area under the toolbar, in a column of a readable width in the middle of it.
  const [area, text] = await Promise.all([page.locator('.pd-scroll').boundingBox(), editorOf(page).boundingBox()]);
  expect(text!.width).toBeLessThanOrEqual(46 * 16 + 1);
  expect(Math.abs(text!.x - area!.x - (area!.x + area!.width - text!.x - text!.width))).toBeLessThan(2);
  // A page's own document has no button to open it on a page of its own.
  await expect(page.getByRole('button', { name: /Full page|Open on its own page/ })).toHaveCount(0);
  // Back to the list, which has its heading again.
  await page.getByRole('button', { name: /All documents/ }).click();
  await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();
});
