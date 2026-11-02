import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Locator, type Page } from '@playwright/test';
import { test, expect, mockPortal, reply, DONE } from '../../../../tests/browser/portal-mock';
import { clickIntoText } from './caret';

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

/** `panel`: the document is opened in the panel beside a chat, not on the Documents page. */
async function open(page: Page, store: Store, { editor = true, panel = false }: { editor?: boolean; panel?: boolean } = {}) {
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
    if (p === `${API}/chats/a/documents`) return { folder: { id: FOLDER, name: 'site', path: '/w/site' }, documents: folders[0].documents };
    if (p === '/api/sessions') return { sessions, executor: 'host' };
    if (p === '/api/models') return { models: [], providers: {} };
    if (/^\/api\/sessions\/\w+$/.test(p)) return sessions[0];
    if (/^\/api\/sessions\/\w+\/(config|models)$/.test(p)) return { live: false, state: { model: null, thinkingLevel: 'medium' }, stats: null, thinking: { levels: ['off', 'medium'] }, models: { models: [] }, named: { provider: null, model: null } };
  });
  if (!panel) return void (await page.goto(`/x/${NAME}/documents?folder=${FOLDER}&doc=${ID}`));
  await page.goto('/s/a');
  await page.locator('.panel-toggle[aria-label="Documents"]').click();
  await page.getByRole('complementary', { name: 'Panels' }).getByRole('button', { name: /The plan/ }).click();
}

const editorOf = (page: Page) => page.locator('.pd-editor .ProseMirror');
const state = (page: Page) => page.locator('.pd-state');
/** Restore on the revision chosen in the panel, and the yes to the question that comes first. */
const restoreThis = async (page: Page, history: Locator) => {
  await history.getByRole('button', { name: 'Restore this revision' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Restore', exact: true }).click();
};
/** Types at the end of the document's last line. */
async function typeAtEnd(page: Page, text: string) {
  await clickIntoText(editorOf(page));
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
  const history = page.getByRole('complementary', { name: 'History' });
  const rows = history.getByRole('listitem');
  await expect(rows).toHaveText([/^Revision 3Current\s*You · /, /^Revision 2\s*The agent · /, /^Revision 1\s*You · Created · /]);

  await history.getByRole('button', { name: /^Revision 2/ }).click();
  // The old text is on the page, in the text's place, marked as an earlier revision that cannot be edited; the document is where it was.
  await expect(page.locator('.pd-old')).toContainText('Ship it soon.');
  await expect(page.locator('.pd-old-note')).toContainText('You are reading revision 2');
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  await expect(editorOf(page)).toBeHidden();
  await expect(page.getByRole('combobox', { name: 'Text style' })).toBeDisabled();
  // The way back is on the page, and the panel stays open.
  await page.getByRole('button', { name: 'Back to the current text' }).click();
  await expect(page.locator('.pd-old')).toHaveCount(0);
  await expect(editorOf(page)).toBeVisible();
  await expect(history).toBeVisible();
  await history.getByRole('button', { name: /^Revision 2/ }).click();
  await expect(page.locator('.pd-old')).toContainText('Ship it soon.');
  await restoreThis(page, history);

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

test('restoring asks first; Cancel keeps the text and the focus on the button', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  await sideBar(page, 'History').click();
  const history = sidePanel(page, 'History');
  await history.getByRole('button', { name: /^Revision 2/ }).click();
  // The earlier revision is on the page in the text's place: this is the restore from there.
  await expect(page.locator('.pd-old')).toContainText('Ship it soon.');
  const restore = history.getByRole('button', { name: 'Restore this revision' });
  await restore.click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Restore revision 2?');
  await expect(dialog).toContainText('The current text is replaced by revision 2. The current version stays in the history, so you can go back to it.');
  await expect(dialog.getByRole('button', { name: 'Restore', exact: true })).toBeFocused();
  expect(store.restores).toEqual([]);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(restore).toBeFocused();
  // Nothing happened: the revision is still only looked at, and the text is the document's.
  await expect(page.locator('.pd-old')).toContainText('Ship it soon.');
  await expect(state(page)).toHaveText('Saved · Revision 3');
  expect(store.restores).toEqual([]);
  expect(store.markdown).toBe(PLAN);
  // Escape answers no as well.
  await restore.click();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(store.restores).toEqual([]);
});

test('confirming the question restores the revision and puts the focus in the text', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  await sideBar(page, 'History').click();
  const history = sidePanel(page, 'History');
  await history.getByRole('button', { name: /^Revision 2/ }).click();
  await history.getByRole('button', { name: 'Restore this revision' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(state(page)).toHaveText('Saved · Revision 4');
  expect(store.restores).toEqual([{ revision: 2, base: 3 }]);
  expect(store.markdown).toBe('# The plan\n\nShip it soon.\n');
  await expect(editorOf(page)).toContainText('Ship it soon.');
  await expect(editorOf(page)).toBeFocused();
});

test('with the question switched off in Settings, restoring restores at once', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('confirmDeletes', 'off'));
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  await sideBar(page, 'History').click();
  const history = sidePanel(page, 'History');
  await history.getByRole('button', { name: /^Revision 2/ }).click();
  await history.getByRole('button', { name: 'Restore this revision' }).click();
  await expect(state(page)).toHaveText('Saved · Revision 4');
  expect(store.restores).toEqual([{ revision: 2, base: 3 }]);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(editorOf(page)).toBeFocused();
});

test('the question before a restore is in German in a German portal', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pithagoras.language', 'de'));
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  await page.getByRole('button', { name: 'Verlauf' }).click();
  const history = page.getByRole('complementary', { name: 'Verlauf' });
  await history.getByRole('button', { name: /^Revision 2/ }).click();
  await history.getByRole('button', { name: 'Diese Revision wiederherstellen' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Revision 2 wiederherstellen?');
  await expect(dialog).toContainText('Der aktuelle Text wird durch Revision 2 ersetzt. Die aktuelle Version bleibt im Verlauf, du kannst also zu ihr zurückkehren.');
  await dialog.getByRole('button', { name: 'Abbrechen' }).click();
  expect(store.restores).toEqual([]);
});

test('restoring saves what was typed first, as a revision to go back to', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  await page.getByRole('button', { name: 'History' }).click();
  await typeAtEnd(page, ' Unsaved words.');
  const history = page.getByRole('complementary', { name: 'History' });
  await history.getByRole('button', { name: /^Revision 1/ }).click();
  await restoreThis(page, history);
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
  const history = page.getByRole('complementary', { name: 'History' });
  await history.getByRole('button', { name: /^Revision 1/ }).click();
  await restoreThis(page, history);
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
  const history = page.getByRole('complementary', { name: 'History' });
  await history.getByRole('button', { name: /^Revision 1/ }).click();
  store.elsewhere('# The plan\n\nTheirs.\n');
  await restoreThis(page, history);
  await expect(page.locator('.pd-note')).toContainText('The document changed in the meantime and is now at revision 4. Restore revision 1 again if you still want it.');
  await expect(editorOf(page)).toContainText('Theirs.');
  await expect(page.locator('.pd-old')).toHaveCount(0);
  await expect(state(page)).toHaveText('Saved · Revision 4');
  expect(store.markdown).toBe('# The plan\n\nTheirs.\n');
});

test('an older page of the history is asked for when wanted', async ({ page }) => {
  const store = new Store();
  for (let n = 4; n <= 60; n++) store.elsewhere(`# The plan\n\nVersion ${n}.\n`);
  await open(page, store);
  await page.getByRole('button', { name: 'History' }).click();
  const history = page.getByRole('complementary', { name: 'History' });
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
  const history = page.getByRole('complementary', { name: 'History' });
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
  await expect(page.getByRole('complementary', { name: 'Verlauf' }).getByRole('listitem').first()).toContainText('Revision 4Aktuell');
  await expect(page.getByRole('complementary', { name: 'Verlauf' }).getByRole('listitem').last()).toContainText('Du · Erstellt · ');
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

/* The history is a panel at the side like the comments: the same place, size and way of closing, and one of the two at a time. */
const sideBar = (page: Page, name: 'History' | 'Comments') => page.getByRole('button', { name: new RegExp(`^${name}( \\d+)?$`) });
const sidePanel = (page: Page, name: 'History' | 'Comments') => page.getByRole('complementary', { name });

/** Where the panel stands against the page's area below the bars, and the text's scroll box beside it. */
async function sideGeometry(page: Page, name: 'History' | 'Comments') {
  const [side, area, scroll] = await Promise.all([sidePanel(page, name).boundingBox(), page.locator('.pd-desk').boundingBox(), page.locator('.pd-scroll').boundingBox()]);
  return { side: side!, area: area!, scroll: scroll! };
}

for (const where of ['the Documents page', 'the panel beside a chat'] as const) {
  test(`the history opens at the side, as the comments do, in a wide and in a narrow page, on ${where}`, async ({ page }) => {
    const panel = where !== 'the Documents page';
    const store = new Store();
    await page.setViewportSize({ width: 1400, height: 900 });
    await open(page, store, { panel });
    await expect(editorOf(page)).toContainText('Ship it on Friday.');
    // The panel beside a chat is narrow in itself; the Documents page is wide at 1400 and narrow at 700.
    const sizes = panel ? ([[1400, 'narrow'], [700, 'narrow']] as const) : ([[1400, 'wide'], [700, 'narrow']] as const);
    for (const [width, layout] of sizes) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator('.pd-doc')).toHaveAttribute('data-layout', layout);
      // The comments are where the history is to be, whatever the page.
      await sideBar(page, 'Comments').click();
      const comments = await sideGeometry(page, 'Comments');
      await sideBar(page, 'Comments').click();
      await expect(sidePanel(page, 'Comments')).toHaveCount(0);

      await sideBar(page, 'History').click();
      const { side, area, scroll } = await sideGeometry(page, 'History');
      await expect(sidePanel(page, 'History').getByRole('listitem')).toHaveCount(3);
      expect(side).toEqual(comments.side);
      expect(Math.round(side.x + side.width)).toBe(Math.round(area.x + area.width));
      expect(Math.round(side.y)).toBe(Math.round(area.y));
      expect(Math.round(side.y + side.height)).toBe(Math.round(area.y + area.height));
      expect(side.width).toBeLessThanOrEqual(320);
      // Beside the text it pushes the page narrower; over it, the page keeps all its width.
      if (layout === 'wide') expect(Math.round(scroll.x + scroll.width)).toBe(Math.round(side.x));
      else expect(Math.round(scroll.x + scroll.width)).toBe(Math.round(area.x + area.width));
      await sidePanel(page, 'History').getByRole('button', { name: 'Close' }).click();
      await expect(sidePanel(page, 'History')).toHaveCount(0);
      // The button it was opened from has the focus again.
      await expect(sideBar(page, 'History')).toBeFocused();
    }
  });
}

test('the comments and the history replace each other, and the bar says which one is open', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  const [comments, history] = [sideBar(page, 'Comments'), sideBar(page, 'History')];
  await expect(comments).toHaveAttribute('aria-expanded', 'false');
  await expect(history).toHaveAttribute('aria-expanded', 'false');
  await history.click();
  await expect(sidePanel(page, 'History')).toBeVisible();
  await expect(history).toHaveAttribute('aria-expanded', 'true');
  // The comments in its place: the history is gone, not under it.
  await comments.click();
  await expect(sidePanel(page, 'Comments')).toBeVisible();
  await expect(sidePanel(page, 'History')).toHaveCount(0);
  await expect(comments).toHaveAttribute('aria-expanded', 'true');
  await expect(history).toHaveAttribute('aria-expanded', 'false');
  await history.click();
  await expect(sidePanel(page, 'History')).toBeVisible();
  await expect(sidePanel(page, 'Comments')).toHaveCount(0);
  await expect(page.locator('.pd-side')).toHaveCount(1);
  await expect(comments).toHaveAttribute('aria-expanded', 'false');
  // The button that is open closes it.
  await history.click();
  await expect(page.locator('.pd-side')).toHaveCount(0);
  await expect(history).toHaveAttribute('aria-expanded', 'false');
});

test('an earlier revision looked at is on the page, read-only and marked, with the panel open; closing the panel goes back to the text', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  await sideBar(page, 'History').click();
  const history = sidePanel(page, 'History');
  await history.getByRole('button', { name: /^Revision 2/ }).click();
  await expect(page.locator('.pd-old')).toContainText('Ship it soon.');
  await expect(page.locator('.pd-old-note')).toContainText('You are reading revision 2, an earlier text');
  await expect(history).toBeVisible();
  // The chosen one is chosen again to be let go of.
  await history.getByRole('button', { name: /^Revision 2/ }).click();
  await expect(page.locator('.pd-old')).toHaveCount(0);
  await expect(page.locator('.pd-old-note')).toHaveCount(0);
  await history.getByRole('button', { name: /^Revision 2/ }).click();
  await expect(page.locator('.pd-old')).toBeVisible();
  // Closing the panel (or taking the comments in its place) leaves the old text, not the page showing something nobody can reach.
  await history.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('.pd-old')).toHaveCount(0);
  await expect(page.locator('.pd-old-note')).toHaveCount(0);
  await expect(editorOf(page)).toBeVisible();
  await sideBar(page, 'History').click();
  await history.getByRole('button', { name: /^Revision 1/ }).click();
  await expect(page.locator('.pd-old')).toBeVisible();
  await sideBar(page, 'Comments').click();
  await expect(page.locator('.pd-old')).toHaveCount(0);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
});

test('a revision is restored from the side panel in a narrow page too, and the page is the text again', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 });
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  await sideBar(page, 'History').click();
  const history = sidePanel(page, 'History');
  await history.getByRole('button', { name: /^Revision 2/ }).click();
  await expect(page.locator('.pd-old')).toContainText('Ship it soon.');
  // The note with the way back is above the panel, which covers the right of the page.
  await expect(page.getByRole('button', { name: 'Back to the current text' })).toBeVisible();
  await restoreThis(page, history);
  await expect(state(page)).toHaveText('Saved · Revision 4');
  expect(store.restores).toEqual([{ revision: 2, base: 3 }]);
  expect(store.markdown).toBe('# The plan\n\nShip it soon.\n');
  await expect(page.locator('.pd-old')).toHaveCount(0);
  await expect(editorOf(page)).toContainText('Ship it soon.');
  await expect(history).toBeVisible();
});

for (const name of ['History', 'Comments'] as const) {
  test(`Escape in the ${name.toLowerCase()} panel closes it and the focus goes back to its button`, async ({ page }) => {
    const store = new Store();
    await open(page, store);
    await expect(editorOf(page)).toContainText('Ship it on Friday.');
    await sideBar(page, name).click();
    const panel = sidePanel(page, name);
    await expect(panel).toBeVisible();
    // With the focus in the text, Escape is the text's: the panel stays.
    await editorOf(page).click();
    await page.keyboard.press('Escape');
    await expect(panel).toBeVisible();
    // With it inside the panel, it closes the panel.
    await panel.getByRole('button', { name: 'Close' }).focus();
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(sideBar(page, name)).toBeFocused();
  });
}

/* The document as plain Markdown, for those who prefer to write it: the same document, saved the same way. */
const modeSwitch = (page: Page) => page.getByRole('group', { name: 'Editing mode' });
const modeButton = (page: Page, name: 'Visual' | 'Markdown') => modeSwitch(page).getByRole('button', { name, exact: true });
const sourceOf = (page: Page) => page.getByRole('textbox', { name: 'Markdown source' });
const inMarkdown = (page: Page) => page.addInitScript(() => localStorage.getItem('pithagoras-docs/mode') === null && localStorage.setItem('pithagoras-docs/mode', 'markdown'));

test('the document is written in the visual editor, or as Markdown with the switch in the bar, and the browser remembers which', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  // Visual to begin with: the editor and its toolbar; no source.
  await expect(modeButton(page, 'Visual')).toHaveAttribute('aria-pressed', 'true');
  await expect(modeButton(page, 'Markdown')).toHaveAttribute('aria-pressed', 'false');
  await expect(sourceOf(page)).toBeHidden();
  await expect(page.getByRole('toolbar', { name: 'Formatting' })).toBeVisible();

  await modeButton(page, 'Markdown').click();
  await expect(modeButton(page, 'Markdown')).toHaveAttribute('aria-pressed', 'true');
  await expect(modeButton(page, 'Visual')).toHaveAttribute('aria-pressed', 'false');
  // The file as it is, in the same column, in a monospace face and without a box; the formatting toolbar is not there (it has nothing to do in the source).
  await expect(sourceOf(page)).toHaveValue(PLAN);
  await expect(editorOf(page)).toBeHidden();
  await expect(page.getByRole('toolbar', { name: 'Formatting' })).toHaveCount(0);
  const look = await sourceOf(page).evaluate((el) => {
    const style = getComputedStyle(el);
    const sheet = document.querySelector('.pd-sheet')!.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return { family: style.fontFamily, border: style.borderTopWidth, background: style.backgroundColor, centred: Math.abs(box.left - sheet.left - (sheet.right - box.right)) < 2, narrower: box.width < sheet.width };
  });
  expect(look.family).toMatch(/mono|Menlo|Consolas/i);
  expect(look.border).toBe('0px');
  expect(look.background).toBe('rgba(0, 0, 0, 0)');
  expect(look.centred).toBe(true);
  expect(look.narrower).toBe(true);

  // Kept by the browser: a new page opens as it was left.
  await page.reload();
  await expect(modeButton(page, 'Markdown')).toHaveAttribute('aria-pressed', 'true');
  await expect(sourceOf(page)).toHaveValue(PLAN);
  await modeButton(page, 'Visual').click();
  await expect(editorOf(page)).toBeVisible();
  await expect(sourceOf(page)).toBeHidden();
  await page.reload();
  await expect(modeButton(page, 'Visual')).toHaveAttribute('aria-pressed', 'true');
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  expect(store.puts).toEqual([]);
});

test('a browser that keeps nothing still lets the mode be chosen for the page', async ({ page }) => {
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key: string) { if (key === 'pithagoras-docs/mode') throw new Error('denied'); return get.call(this, key); };
    Storage.prototype.setItem = function (key: string, value: string) { if (key === 'pithagoras-docs/mode') throw new Error('denied'); return set.call(this, key, value); };
  });
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  await expect(modeButton(page, 'Visual')).toHaveAttribute('aria-pressed', 'true');
  await modeButton(page, 'Markdown').click();
  await expect(sourceOf(page)).toHaveValue(PLAN);
});

test('typing in the source saves like the editor does: after a second, at once with Ctrl+S, and when the focus leaves; as it was typed', async ({ page }) => {
  await inMarkdown(page);
  const store = new Store();
  await open(page, store);
  await expect(sourceOf(page)).toHaveValue(PLAN);
  await sourceOf(page).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('* Not a dash.');
  await expect(state(page)).toHaveText('Unsaved changes · Revision 3');
  await expect(state(page)).toHaveText('Saved · Revision 4');
  // The text as typed, not as the editor would write it (it would have a dash for the star).
  expect(store.puts).toEqual([{ markdown: `${PLAN}* Not a dash.`, base: 3 }]);

  await page.keyboard.type('\n* Again.');
  await page.keyboard.press('Control+s');
  await expect(state(page)).toHaveText('Saved · Revision 5');
  expect(store.puts.map((put) => put.base)).toEqual([3, 4]);
  expect(store.markdown).toBe(`${PLAN}* Not a dash.\n* Again.`);

  // The focus leaving the text saves what is typed.
  await page.keyboard.type(' More.');
  await page.getByRole('button', { name: 'History' }).focus();
  await expect(state(page)).toHaveText('Saved · Revision 6');
  expect(store.markdown).toBe(`${PLAN}* Not a dash.\n* Again. More.`);

  // The browser's own undo takes the words back.
  await sourceOf(page).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' Oops.');
  await page.keyboard.press('Control+z');
  await expect(sourceOf(page)).toHaveValue(`${PLAN}* Not a dash.\n* Again. More.`);
});

test('a document written in another style is the same document in both: looking at it, or going from one to the other, saves nothing', async ({ page }) => {
  const raw = '* One\n* Two\n\nText  \nmore\n';
  const store = new Store(raw);
  await open(page, store);
  await expect(editorOf(page)).toContainText('One');
  await modeButton(page, 'Markdown').click();
  // The file as it is, in its own style.
  await expect(sourceOf(page)).toHaveValue(raw);
  await sourceOf(page).click();
  await page.keyboard.press('Control+End');
  await page.waitForTimeout(1300);
  await modeButton(page, 'Visual').click();
  await expect(editorOf(page)).toContainText('One');
  await page.waitForTimeout(1300);
  expect(store.puts).toEqual([]);
  await expect(state(page)).toHaveText('Saved · Revision 3');
  // A change in the source keeps the style it was written in; going back to the editor then writes nothing more.
  await modeButton(page, 'Markdown').click();
  await sourceOf(page).fill('* One\n* Two\n* Three\n\nText  \nmore\n');
  await expect(state(page)).toHaveText('Saved · Revision 4');
  expect(store.puts).toEqual([{ markdown: '* One\n* Two\n* Three\n\nText  \nmore\n', base: 3 }]);
  await modeButton(page, 'Visual').click();
  await expect(editorOf(page)).toContainText('Three');
  await page.waitForTimeout(1300);
  expect(store.puts).toHaveLength(1);
  await expect(state(page)).toHaveText('Saved · Revision 4');
});

test('text that is not saved yet goes with the switch, in both directions', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  await typeAtEnd(page, ' Typed in the editor.');
  // Switched before the autosave: the words are in the source.
  await modeButton(page, 'Markdown').click();
  await expect(sourceOf(page)).toHaveValue('# The plan\n\nShip it on Friday. Typed in the editor.\n');
  await sourceOf(page).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('Typed in the source.');
  await modeButton(page, 'Visual').click();
  await expect(editorOf(page)).toContainText('Typed in the editor.');
  await expect(editorOf(page)).toContainText('Typed in the source.');
  await expect.poll(() => store.markdown).toContain('Typed in the source.');
  expect(store.markdown).toContain('Typed in the editor.');
  await expect(state(page)).toHaveText(/^Saved · Revision \d+$/);
});

test('a conflict keeps the text typed in the source, and the choice is made there as in the editor', async ({ page }) => {
  await inMarkdown(page);
  const store = new Store();
  await open(page, store);
  await expect(sourceOf(page)).toHaveValue(PLAN);
  store.elsewhere('# The plan\n\nShip it on Monday.\n');
  await sourceOf(page).fill('# The plan\n\nShip it on Tuesday.\n');
  await expect(page.locator('.pd-conflict')).toBeVisible();
  await expect(sourceOf(page)).toHaveValue('# The plan\n\nShip it on Tuesday.\n');
  await page.getByRole('button', { name: 'Keep mine as a new revision' }).click();
  await expect(state(page)).toHaveText('Saved · Revision 5');
  expect(store.markdown).toBe('# The plan\n\nShip it on Tuesday.\n');
  // Going to the editor shows the same text.
  await modeButton(page, 'Visual').click();
  await expect(editorOf(page)).toContainText('Ship it on Tuesday.');
});

test('restoring a revision shows it in the source too', async ({ page }) => {
  await inMarkdown(page);
  const store = new Store();
  await open(page, store);
  await expect(sourceOf(page)).toHaveValue(PLAN);
  await page.getByRole('button', { name: 'History' }).click();
  const history = page.getByRole('complementary', { name: 'History' });
  await history.getByRole('button', { name: /^Revision 2/ }).click();
  await restoreThis(page, history);
  await expect(state(page)).toHaveText('Saved · Revision 4');
  await expect(sourceOf(page)).toHaveValue('# The plan\n\nShip it soon.\n');
  expect(store.markdown).toBe('# The plan\n\nShip it soon.\n');
});

/* The page under and beside the text is the text's, as on a word processor's page: but a selection is the person's. */
const paragraphs = (n: number) => `# The plan\n\n${Array.from({ length: n }, (_, i) => `Paragraph ${i + 1} of the text.`).join('\n\n')}\n`;
const scrollTopOf = (page: Page) => page.evaluate(() => document.querySelector('.pd-scroll')!.scrollTop);

test('a selection made by dragging and let go of beside its line stays selected, the page stays where it is, and it can be commented on', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  const store = new Store(paragraphs(60));
  await open(page, store);
  await expect(editorOf(page)).toContainText('Paragraph 60 of the text.');
  const line = editorOf(page).getByText('Paragraph 30 of the text.', { exact: true });
  await line.scrollIntoViewIfNeeded();
  const before = await scrollTopOf(page);
  const box = (await line.boundingBox())!;
  const sheet = (await page.locator('.pd-sheet').boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(sheet.x + sheet.width - 60, y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => getSelection()!.toString().trim())).toBe('Paragraph 30 of the text.');
  expect(Math.abs((await scrollTopOf(page)) - before)).toBeLessThan(4);
  await expect(page.getByRole('button', { name: 'Comment', exact: true })).toBeEnabled();
});

test('a click beside a line puts the caret on that line, and the page stays where it is', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  const store = new Store(paragraphs(60));
  await open(page, store);
  await expect(editorOf(page)).toContainText('Paragraph 60 of the text.');
  const line = editorOf(page).getByText('Paragraph 30 of the text.', { exact: true });
  await line.scrollIntoViewIfNeeded();
  const before = await scrollTopOf(page);
  const box = (await line.boundingBox())!;
  const sheet = (await page.locator('.pd-sheet').boundingBox())!;
  await page.mouse.click(sheet.x + sheet.width - 40, box.y + box.height / 2);
  await page.keyboard.type('X');
  await expect(editorOf(page).getByText('Paragraph 30 of the text.X', { exact: true })).toBeVisible();
  expect(Math.abs((await scrollTopOf(page)) - before)).toBeLessThan(40);
  // The left margin too: the start of the line.
  await page.mouse.click(sheet.x + 10, box.y + box.height / 2);
  await page.keyboard.type('Y');
  await expect(editorOf(page).getByText('YParagraph 30 of the text.X', { exact: true })).toBeVisible();
});

test('a click on the page below the text puts the caret at its end', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  const sheet = (await page.locator('.pd-sheet').boundingBox())!;
  const area = (await page.locator('.pd-scroll').boundingBox())!;
  await page.mouse.click(sheet.x + sheet.width / 2, area.y + area.height - 30);
  await page.keyboard.type(' The end.');
  await expect(editorOf(page)).toContainText('Ship it on Friday. The end.');
  await page.mouse.click(sheet.x + 10, area.y + area.height - 30);
  await page.keyboard.type(' More.');
  await expect(editorOf(page)).toContainText('Ship it on Friday. The end. More.');
});

test('Markdown that is only written another way is saved as it was typed, and the bar says Saved only when it is', async ({ page }) => {
  await inMarkdown(page);
  const store = new Store('# The plan\n\n- One\n- Two\n\nText.\n');
  await open(page, store);
  await expect(sourceOf(page)).toHaveValue('# The plan\n\n- One\n- Two\n\nText.\n');
  // The bullets written with a star: the editor writes them the same, and it is still a change to the file.
  await sourceOf(page).fill('# The plan\n\n* One\n* Two\n\nText.\n');
  await page.keyboard.press('Control+s');
  await expect(state(page)).toHaveText('Saved · Revision 4');
  expect(store.puts).toEqual([{ markdown: '# The plan\n\n* One\n* Two\n\nText.\n', base: 3 }]);
  // The heading in the other style, and more blank lines.
  await sourceOf(page).fill('The plan\n========\n\n\n* One\n* Two\n\nText.\n');
  await expect(state(page)).toHaveText('Unsaved changes · Revision 4');
  await page.keyboard.press('Control+s');
  await expect(state(page)).toHaveText('Saved · Revision 5');
  expect(store.markdown).toBe('The plan\n========\n\n\n* One\n* Two\n\nText.\n');
  await page.reload();
  await expect(sourceOf(page)).toHaveValue('The plan\n========\n\n\n* One\n* Two\n\nText.\n');
});

test('text typed in the Markdown that could not be saved comes back as it was typed, and is saved so', async ({ page }) => {
  await inMarkdown(page);
  const raw = '# The plan\n\n* One\n* Two\n\nText.\n';
  const store = new Store(raw);
  await open(page, store);
  await expect(sourceOf(page)).toHaveValue(raw);
  let fail = true;
  await page.route(`**${DOCUMENT}`, (route) => (fail && route.request().method() === 'PUT' ? route.fulfill({ status: 500, json: { error: 'The documents store could not do that' } }) : route.fallback()));
  await sourceOf(page).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('* Three\n');
  await expect(state(page)).toHaveText('Not saved · Revision 3');
  await page.reload();
  // Not the editor's way of writing it (a dash, a blank line before the item).
  await expect(sourceOf(page)).toHaveValue(`${raw}* Three\n`);
  await expect(page.locator('.pd-note')).toContainText('Text you had not saved was brought back.');
  fail = false;
  await expect(state(page)).toHaveText('Saved · Revision 4');
  expect(store.markdown).toBe(`${raw}* Three\n`);
});

test('the bar keeps the room for the name of the document at a window of 1060 pixels with the sidebar open: the switch is two icons there', async ({ page }) => {
  await page.setViewportSize({ width: 1060, height: 800 });
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  const name = page.locator('.pd-doctitle');
  await expect(name).toHaveText('The plan');
  const fits = await name.evaluate((el) => ({ cut: el.scrollWidth > el.clientWidth, width: el.getBoundingClientRect().width }));
  expect(fits.cut).toBe(false);
  expect(fits.width).toBeGreaterThan(50);
  // The switch is still there and named, with icons for words.
  await expect(modeButton(page, 'Visual')).toBeVisible();
  await expect(modeButton(page, 'Markdown')).toBeVisible();
  await expect(modeSwitch(page).locator('.pd-modelabel').first()).toBeHidden();
  await expect(modeButton(page, 'Markdown')).toHaveAttribute('title', 'Markdown');
  // A wide window has the words.
  await page.setViewportSize({ width: 1700, height: 800 });
  await expect(modeSwitch(page).locator('.pd-modelabel').first()).toBeVisible();
});

/**
 * What the bar says of the text, in each language, as the page would: the four states with the revision after them (a revision of one digit and of
 * two). A wide face (DejaVu Sans, where nothing else is installed) is stood for by letter spacing, which makes the text of any face wider.
 */
const SAYS = {
  en: ['Saved', 'Saving…', 'Unsaved changes', 'Not saved'],
  de: ['Gespeichert', 'Wird gespeichert…', 'Nicht gespeicherte Änderungen', 'Nicht gespeichert'],
};
for (const [language, labels] of Object.entries(SAYS)) {
  test(`[${language}] the bar keeps its height whatever it says of the text, at every window from 1060 to 1600 pixels with the sidebar open and a face that is wider than the usual: a bar that wraps moves its buttons between the press and the release of a click`, async ({ page }) => {
    await page.addInitScript((lang) => {
      localStorage.setItem('pithagoras.language', lang);
      document.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.textContent = '*, *::before, *::after { letter-spacing: 0.6px !important; }';
        document.head.append(style);
      });
    }, language);
    const store = new Store();
    await open(page, store);
    await expect(editorOf(page)).toContainText('Ship it on Friday.');
    // A text that does not fit is cut, and has the whole of it in its tooltip.
    await expect(state(page)).toHaveAttribute('title', `${labels[0]} · Revision 3`);
    const texts = labels.flatMap((label) => [`${label} · Revision 3`, `${label} · Revision 12`]);
    const moving: string[] = [];
    for (let width = 1060; width <= 1600; width += 50) {
      await page.setViewportSize({ width, height: 800 });
      // What the bar says changes while it is typed in, and with it the room it needs: each of the texts is told here, as the page would.
      const heights = await page.locator('.pd-titlebar').evaluate((bar, told) => {
        const say = bar.querySelector('.pd-state') as HTMLElement;
        const own = say.textContent;
        const found: Record<string, number> = {};
        for (const text of told) {
          say.textContent = text;
          found[text] = Math.round(bar.getBoundingClientRect().height);
        }
        say.textContent = own;
        return found;
      }, texts);
      if (new Set(Object.values(heights)).size !== 1) moving.push(`${width}px: ${JSON.stringify(heights)}`);
    }
    expect(moving).toEqual([]);
  });
}
