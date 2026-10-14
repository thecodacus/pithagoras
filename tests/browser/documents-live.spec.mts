import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Page } from '@playwright/test';
import { merge3 } from '../../extensions/docs/web/merge.js';
import { test, expect, mockPortal, reply, DONE } from './portal-mock';

/**
 * A document changed while it is open on the Documents page: the extension's browser half (extensions/docs/web)
 * with the editor `npm run build` builds, against a store that answers as the server half does
 * (extensions/docs/server.js): a save that started from an earlier revision is put together with what was saved
 * since where the changes do not meet, and the stream that tells the page of each revision is the page's own
 * EventSource, which the test drives by hand.
 */
const NAME = 'pithagoras-docs';
const FOLDER = '0123456789abcdef';
const ID = '1111111111111111';
const web = (file: string) => readFileSync(new URL(`../../extensions/docs/web/${file}`, import.meta.url), 'utf8');
const address = (file: string) => `/api/extension-ui/${NAME}/${file}`;
const API = `/api/x/${NAME}`;
const DOCUMENT = `${API}/folders/${FOLDER}/documents/${ID}`;

test.beforeAll(() => {
  execFileSync(process.execPath, [fileURLToPath(new URL('../../extensions/docs/build.mjs', import.meta.url))], { stdio: 'ignore' });
});

const PLAN = '# The plan\n\nShip it on Friday.\n\nThe build is green.\n\nSign-off is on Monday.\n';

/** One document, as the server half keeps it: each revision's text, and what the page asked of it. */
class Store {
  revision = 3;
  texts = new Map<number, string>([[1, '# The plan\n'], [2, '# The plan\n\nShip it soon.\n'], [3, PLAN]]);
  puts: { markdown: string; base: number }[] = [];
  loads = 0;

  get markdown() {
    return this.texts.get(this.revision)!;
  }

  private describe() {
    return { id: ID, name: 'plan.md', scope: 'project', chat: null, revision: this.revision, size: this.markdown.length, modified: '2026-10-01T11:00:00.000Z' };
  }

  /** A save from somewhere else (the agent): the next revision. */
  elsewhere(markdown: string) {
    this.revision += 1;
    this.texts.set(this.revision, markdown);
  }

  read() {
    this.loads++;
    return { ...this.describe(), title: 'The plan', markdown: this.markdown };
  }

  save(markdown: string, base: number) {
    this.puts.push({ markdown, base });
    if (base !== this.revision) {
      const together = this.texts.has(base) && base < this.revision ? merge3(this.texts.get(base)!, markdown, this.markdown) : null;
      if (together === null) return reply(409, { error: `The document changed: it is at revision ${this.revision}, not ${base}`, revision: this.revision, markdown: this.markdown });
      const changed = together !== this.markdown;
      if (changed) this.elsewhere(together);
      return { ...this.describe(), changed, merged: true, markdown: together };
    }
    const changed = markdown !== this.markdown;
    if (changed) this.elsewhere(markdown);
    return { ...this.describe(), changed };
  }
}

async function open(page: Page, store: Store) {
  const sessions = [{ id: 'a', title: 'First chat', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: new Date().toISOString(), provider: null, model: null, thinking_level: null }];
  const folders = [{ id: FOLDER, name: 'site', path: '/w/site', chats: [{ id: 'a', title: 'First chat' }], documents: [{ id: ID, name: 'plan.md', title: 'The plan', revision: store.revision, size: 40, modified: '2026-10-01T11:00:00.000Z' }] }];
  await mockPortal(page, async ({ path: p, method, json, route }) => {
    if (p === '/api/extension-ui') return { extensions: [{ name: NAME, version: '0.1.0', entry: address('client.js') + '?v=1', style: address('client.css') + '?v=1', server: API }] };
    if (p.startsWith(address(''))) {
      await route.fulfill({ contentType: p.endsWith('.css') ? 'text/css' : 'text/javascript', body: web(p.slice(address('').length)) });
      return DONE;
    }
    if (p === `${API}/folders`) return { folders };
    if (p === DOCUMENT && method === 'GET') return store.read();
    if (p === DOCUMENT && method === 'PUT') { const { markdown, base } = json(); return store.save(markdown, base); }
    if (p === '/api/sessions') return { sessions, executor: 'host' };
    if (p === '/api/models') return { models: [], providers: {} };
  }, { streams: 'open' });
  await page.goto(`/x/${NAME}/documents?folder=${FOLDER}&doc=${ID}`);
}

const editorOf = (page: Page) => page.locator('.pd-editor .ProseMirror');
const state = (page: Page) => page.locator('.pd-state');
const note = (page: Page) => page.locator('.pd-note');

/** What the stream of the open document says, as the server half would: the revision, who made it. */
const tell = (page: Page, revision: number, author = 'agent') =>
  page.evaluate(([revision, author]) => {
    const stream = (window as any).streams.find((s: any) => s.url.endsWith('/events'));
    stream.emit('revision', { revision, author, at: '2026-10-02T10:00:00.000Z' });
  }, [revision, author] as const);

/** Puts the caret at the end of the paragraph or heading that holds `text`, and types there. */
async function typeAfter(page: Page, text: string, typed: string) {
  await editorOf(page).getByText(text).click();
  await page.keyboard.press('End');
  // The editor learns where the caret went a moment after the browser moved it.
  await page.waitForTimeout(100);
  if (typed) await page.keyboard.type(typed);
}

const agents = (plan = PLAN) => plan.replace('on Monday', 'on Tuesday');

test('the page listens to the document it has open, at the address of its own stream', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  const streams = await page.evaluate(() => (window as any).streams.map((s: any) => s.url));
  expect(streams).toEqual([DOCUMENT + '/events']);
});

test('what the agent changed is in a document that is open and untouched at once, the caret is where it was, and the change is marked for a moment', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  // The caret is in the first paragraph; the agent changes the last one.
  await typeAfter(page, 'Ship it on Friday.', '');
  const loads = store.loads;
  store.elsewhere(agents());
  await tell(page, 4);
  // Only the paragraph that changed is marked, for a moment.
  await expect(editorOf(page).locator('.pd-changed')).toHaveText('Sign-off is on Tuesday.');
  await expect(editorOf(page)).toContainText('Sign-off is on Tuesday.');
  await expect(editorOf(page)).not.toContainText('on Monday');
  await expect(state(page)).toHaveText('Saved · Revision 4');
  await expect(note(page)).toContainText('The agent changed this document. It is now at revision 4.');
  expect(store.loads).toBe(loads + 1);
  await expect(editorOf(page).locator('.pd-changed')).toHaveCount(0, { timeout: 5000 });
  // The caret stayed in the first paragraph: what is typed goes there.
  await page.keyboard.type(' Or Monday.');
  await expect(state(page)).toHaveText('Saved · Revision 5');
  expect(store.puts).toEqual([{ markdown: agents().replace('Friday.', 'Friday. Or Monday.'), base: 4 }]);
});

test('the change that came from outside is not something Ctrl+Z takes back, while what was typed still is', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  await typeAfter(page, 'Ship it on Friday.', ' Typed.');
  await expect(state(page)).toHaveText('Saved · Revision 4');
  store.elsewhere(agents(store.markdown));
  await tell(page, 5);
  await expect(editorOf(page)).toContainText('Sign-off is on Tuesday.');
  await page.keyboard.press('Control+z');
  await expect(editorOf(page)).not.toContainText('Typed.');
  await expect(editorOf(page)).toContainText('Sign-off is on Tuesday.');
  await page.keyboard.press('Control+z');
  await expect(editorOf(page)).toContainText('Sign-off is on Tuesday.');
});

test('a change to another paragraph than the one being typed in is merged into the text, which is then saved on the new revision', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  await typeAfter(page, 'Ship it on Friday.', ' Or Monday.');
  await expect(state(page)).toHaveText('Unsaved changes · Revision 3');
  store.elsewhere(agents());
  await tell(page, 4);
  // Both are in the editor, at once: the person's text was not saved yet, and was not refused.
  await expect(editorOf(page)).toContainText('Ship it on Friday. Or Monday.');
  await expect(editorOf(page)).toContainText('Sign-off is on Tuesday.');
  await expect(note(page)).toContainText('The document changed meanwhile and is now at revision 4. Its changes were merged into your text.');
  await expect(page.locator('.pd-conflict')).toHaveCount(0);
  await expect(state(page)).toHaveText('Saved · Revision 5');
  // One save, made on revision 4: the page never sent the text on revision 3.
  expect(store.puts).toEqual([{ markdown: agents().replace('Friday.', 'Friday. Or Monday.'), base: 4 }]);
  expect(store.markdown).toBe(agents().replace('Friday.', 'Friday. Or Monday.'));
});

test('a change that meets what is being typed is a conflict, as before: the text is kept and nothing is sent', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  await typeAfter(page, 'Sign-off is on Monday.', ' Maybe.');
  store.elsewhere(PLAN.replace('on Monday', 'on Wednesday'));
  await tell(page, 4);
  await expect(page.locator('.pd-conflict')).toContainText('is now at revision 4');
  await expect(editorOf(page)).toContainText('Sign-off is on Monday. Maybe.');
  await expect(state(page)).toHaveText('Not saved · Revision 3');
  await page.waitForTimeout(1500);
  expect(store.puts).toEqual([]);
  // The other version is the one the agent made.
  await page.locator('.pd-conflict').getByText('Show the other version').click();
  await expect(page.locator('.pd-conflict')).toContainText('Sign-off is on Wednesday.');
  // And the choice is the same as it was: mine on top of theirs.
  await page.getByRole('button', { name: 'Keep mine as a new revision' }).click();
  await expect(state(page)).toHaveText('Saved · Revision 5');
  expect(store.puts).toEqual([{ markdown: PLAN.replace('Monday.', 'Monday. Maybe.'), base: 4 }]);
});

test('a save that started from an earlier revision, when the page was not told of the change, comes back as the merged text, which the editor takes up', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  // The agent saves; the page is not told (a stream that was down).
  store.elsewhere(agents());
  await typeAfter(page, 'Ship it on Friday.', ' Or Monday.');
  await expect(editorOf(page)).toContainText('Sign-off is on Tuesday.');
  await expect(editorOf(page)).toContainText('Ship it on Friday. Or Monday.');
  await expect(state(page)).toHaveText('Saved · Revision 5');
  expect(store.puts).toEqual([{ markdown: PLAN.replace('Friday.', 'Friday. Or Monday.'), base: 3 }]);
  expect(store.markdown).toBe(agents().replace('Friday.', 'Friday. Or Monday.'));
  await expect(note(page)).toContainText('Its changes were merged into your text.');
  // The next save is on the merged revision, and keeps the agent's change.
  await page.keyboard.type(' Again.');
  await expect(state(page)).toHaveText('Saved · Revision 6');
  expect(store.puts.at(-1)).toEqual({ markdown: agents().replace('Friday.', 'Friday. Or Monday. Again.'), base: 5 });
});

test('what is typed while a save that is put together is on its way is kept on top of the merged text', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  store.elsewhere(PLAN.replace('on Friday', 'on Thursday'));
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**${DOCUMENT}`, async (route) => {
    if (route.request().method() === 'PUT') await held;
    await route.fallback();
  });
  await typeAfter(page, 'The build is green.', ' Red now.');
  await expect(state(page)).toHaveText('Saving… · Revision 3');
  // In the third paragraph, while the first save is on its way.
  await typeAfter(page, 'Sign-off is on Monday.', ' Or later.');
  release();
  await expect(state(page)).toHaveText('Saved · Revision 6');
  const all = PLAN.replace('on Friday', 'on Thursday').replace('is green.', 'is green. Red now.').replace('Monday.', 'Monday. Or later.');
  await expect(editorOf(page)).toContainText('Ship it on Thursday.');
  await expect(editorOf(page)).toContainText('Sign-off is on Monday. Or later.');
  expect(store.markdown).toBe(all);
  expect(store.puts.map((put) => put.base)).toEqual([3, 5]);
});

test('a revision the page is at already is not fetched again, and one it missed is found when the stream says where the document stands', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  const loads = store.loads;
  // The first message of a stream that opens: where the document stands.
  await tell(page, 3, 'user');
  await page.waitForTimeout(200);
  expect(store.loads).toBe(loads);
  // The stream was away for two revisions: the one it says is the one the page goes to.
  store.elsewhere(agents());
  store.elsewhere(agents().replace('Friday', 'Wednesday'));
  await tell(page, 5);
  await expect(editorOf(page)).toContainText('Ship it on Wednesday.');
  await expect(state(page)).toHaveText('Saved · Revision 5');
  expect(store.loads).toBe(loads + 1);
});

test('a stream that dropped is asked for again, and what the new one says is taken up', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  // The connection fails (a proxy answering while the portal restarts): the page lets go of it and asks again.
  await page.evaluate(() => (window as any).streams[0].emit('error', null));
  await expect.poll(() => page.evaluate(() => (window as any).streams.length), { timeout: 6000 }).toBe(2);
  expect(await page.evaluate(() => (window as any).streams.map((s: any) => s.closed))).toEqual([true, false]);
  // The document changed while it was down: the new stream's first message says so.
  store.elsewhere(agents());
  await page.evaluate(() => (window as any).streams[1].emit('revision', { revision: 4, author: 'agent', at: '2026-10-02T10:00:00.000Z' }));
  await expect(editorOf(page)).toContainText('Sign-off is on Tuesday.');
  await expect(state(page)).toHaveText('Saved · Revision 4');
});

test('the stream is let go of when the document is left', async ({ page }) => {
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  await page.getByRole('button', { name: /All documents/ }).click();
  await expect(page.getByText('The plan').first()).toBeVisible();
  expect(await page.evaluate(() => (window as any).streams.map((s: any) => s.closed))).toEqual([true]);
});

test('the notes about a change that came from outside are in German in a German portal', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pithagoras.language', 'de'));
  const store = new Store();
  await open(page, store);
  await expect(editorOf(page)).toContainText('Ship it on Friday.');
  store.elsewhere(agents());
  await tell(page, 4);
  await expect(note(page)).toContainText('Der Agent hat dieses Dokument geändert. Es steht jetzt bei Revision 4.');
  // Another window of the same person is no agent.
  store.elsewhere(agents().replace('Friday', 'Wednesday'));
  await tell(page, 5, 'user');
  await expect(note(page)).toContainText('Dieses Dokument wurde anderswo geändert. Es steht jetzt bei Revision 5.');
  await typeAfter(page, 'Sign-off is on Tuesday.', ' Spät.');
  store.elsewhere(agents().replace('Friday', 'Wednesday').replace('is green', 'is red'));
  await tell(page, 6);
  await expect(note(page)).toContainText('Das Dokument hat sich in der Zwischenzeit geändert und steht jetzt bei Revision 6. Die Änderungen wurden in deinen Text übernommen.');
});
