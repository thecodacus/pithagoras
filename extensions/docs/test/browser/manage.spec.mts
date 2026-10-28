import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply, DONE } from '../../../../tests/browser/portal-mock';
import { clickIntoText } from './caret';

/**
 * A document renamed and deleted from the Documents page: from a row of the list (on the page and in the panel beside a chat) and from the
 * bar of a document that is open, with the keyboard; and what a page that has the document open does when that is done from elsewhere. The
 * extension's browser half (extensions/docs/web), with the editor `npm run build` builds, against a store that answers as the server half does
 * (extensions/docs/server.js).
 */
const NAME = 'pithagoras-docs';
const FOLDER = '0123456789abcdef';
const API = `/api/x/${NAME}`;
const web = (file: string) => readFileSync(new URL(`../../web/${file}`, import.meta.url), 'utf8');
const address = (file: string) => `/api/extension-ui/${NAME}/${file}`;

test.beforeAll(() => {
  execFileSync(process.execPath, [fileURLToPath(new URL('../../build.mjs', import.meta.url))], { stdio: 'ignore' });
});

interface Doc { id: string; name: string; title: string; revision: number; markdown: string; /** No heading: it is called by its file's name. */ headless?: boolean }

const PLAN: Doc = { id: '1111111111111111', name: 'plan.md', title: 'The plan', revision: 3, markdown: '# The plan\n\nShip it on Friday.\n\nThe build is green.\n' };
const NOTES: Doc = { id: '2222222222222222', name: 'release.md', title: 'Release notes', revision: 1, markdown: '# Release notes\n\nNothing yet.\n' };
const SETUP: Doc = { id: '3333333333333333', name: 'setup.md', title: 'Setting up', revision: 1, markdown: '# Setting up\n' };

/** The documents of one folder as the server half keeps them, and what the page asked of it. */
class Shelf {
  docs: Doc[];
  /** What the page sent that changes something: `METHOD address body`. */
  requests: string[] = [];
  /** An answer to the next rename or delete, in place of doing it. */
  refuse: { status: number; body: unknown } | null = null;
  /** The version of the list: another each time something is changed. */
  version = 1;
  loads = 0;
  /** The server half is not running (the portal started, or the extension is being updated): its routes are the portal's own 404, which says nothing of any document. */
  away = false;
  /** What was asked of the document's routes while the half was away. */
  awayCalls: string[] = [];

  constructor(docs: Doc[] = [PLAN, NOTES, SETUP]) {
    this.docs = docs.map((d) => ({ ...d }));
  }

  find(id: string) {
    return this.docs.find((d) => d.id === id);
  }

  describe(d: Doc) {
    return { id: d.id, name: d.name, scope: 'project', chat: null, revision: d.revision, size: d.markdown.length, modified: '2026-10-01T11:00:00.000Z' };
  }

  /** What a document is called: its first heading, or its file's name where it has none. */
  titleOf(d: Doc) {
    return d.headless ? d.name.replace(/\.md$/i, '') : d.title;
  }

  listed() {
    return this.docs.map((d) => ({ ...this.describe(d), title: this.titleOf(d) }));
  }

  /** Done by someone else (another window, the agent): the next revision. */
  renameElsewhere(id: string, name: string) {
    const d = this.find(id)!;
    d.name = name;
    d.revision += 1;
    this.version++;
    return d.revision;
  }

  deleteElsewhere(id: string) {
    this.docs = this.docs.filter((d) => d.id !== id);
    this.version++;
  }

  /** The answer to a request about a document. */
  document(method: string, id: string, tail: string, body: () => any) {
    if (this.away) {
      this.awayCalls.push(`${method} ${tail || '/'}`);
      return reply(404, { error: `No such API route: ${method} ${API}/folders/${FOLDER}/documents/${id}${tail}` });
    }
    const d = this.find(id);
    // The half's own answer to a document it has no more: it says so (`code`), as a 404 of the portal's does not.
    if (!d) return reply(404, { error: 'There is no such document', code: 'deleted' });
    if (tail === '' && method === 'GET') return { ...this.describe(d), title: this.titleOf(d), markdown: d.markdown };
    if (tail === '/threads') return { revision: d.revision, threads: [] };
    if (tail === '/history') return { revision: d.revision, revisions: [], more: false };
    if (tail === '' && method === 'PUT') {
      const { markdown, base } = body();
      this.requests.push(`PUT ${d.id} base=${base} ${JSON.stringify(markdown)}`);
      if (base !== d.revision) return reply(409, { error: 'The document changed', revision: d.revision, markdown: d.markdown });
      const changed = markdown !== d.markdown;
      if (changed) {
        d.markdown = markdown;
        d.revision++;
      }
      return { ...this.describe(d), changed };
    }
    if (tail === '/rename' && method === 'POST') {
      const { name } = body();
      this.requests.push(`POST ${d.id}/rename ${JSON.stringify({ name })}`);
      if (this.refuse) return reply(this.refuse.status, this.refuse.body);
      const taken = this.docs.find((o) => o.name === name && o.id !== d.id);
      if (taken) return reply(409, { error: `A document called ${name} exists already`, exists: taken.id });
      if (name === d.name) return { ...this.describe(d), changed: false };
      d.name = name;
      d.revision++;
      this.version++;
      return { ...this.describe(d), changed: true };
    }
    if (tail === '' && method === 'DELETE') {
      this.requests.push(`DELETE ${d.id}`);
      if (this.refuse) return reply(this.refuse.status, this.refuse.body);
      this.docs = this.docs.filter((o) => o !== d);
      this.version++;
      return { deleted: true };
    }
    return undefined;
  }
}

async function portal(page: Page, shelf: Shelf, { streams = 'open' }: { streams?: 'open' | 'idle' } = {}) {
  const sessions = [{ id: 'a', title: 'First chat', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: new Date().toISOString(), provider: null, model: null, thinking_level: null }];
  const folder = { id: FOLDER, name: 'site', path: '/w/site', chats: [{ id: 'a', title: 'First chat' }] };
  /** The documents made from the page: the text they were made from. */
  const made: { title: string; markdown: string; scope?: string }[] = [];
  await mockPortal(page, async ({ path: p, method, route, json }) => {
    if (p === '/api/extension-ui') return { extensions: [{ name: NAME, version: '0.1.0', entry: address('client.js') + '?v=1', style: address('client.css') + '?v=1', server: API }] };
    if (p.startsWith(address(''))) {
      await route.fulfill({ contentType: p.endsWith('.css') ? 'text/css' : 'text/javascript', body: web(p.slice(address('').length)) });
      return DONE;
    }
    if (p === `${API}/folders`) {
      shelf.loads++;
      return { folders: shelf.docs.length ? [{ ...folder, documents: shelf.listed() }] : [], version: `v${shelf.version}` };
    }
    if (p === `${API}/chats/a/documents`) return { folder: { id: FOLDER, name: 'site', path: '/w/site' }, documents: shelf.listed() };
    if (p === `${API}/folders/${FOLDER}/documents` && method === 'POST') {
      const body = json() as { title: string; markdown: string; scope?: string };
      made.push(body);
      const d: Doc = { id: '4444444444444444', name: 'saved.md', title: body.title, revision: 1, markdown: body.markdown };
      shelf.docs.push(d);
      shelf.version++;
      return reply(201, { ...shelf.describe(d), title: d.title });
    }
    const match = p.match(new RegExp(`^${API}/folders/${FOLDER}/documents/([0-9a-f]{16})(/[a-z]+)?$`));
    if (match) return shelf.document(method, match[1], match[2] ?? '', () => json());
    if (p === '/api/sessions') return { sessions, executor: 'host' };
    if (p === '/api/models') return { models: [], providers: {} };
    if (/^\/api\/sessions\/\w+$/.test(p)) return sessions[0];
    if (/^\/api\/sessions\/\w+\/(config|models)$/.test(p)) return { live: false, state: { model: null, thinkingLevel: 'medium' }, stats: null, thinking: { levels: ['off', 'medium'] }, models: { models: [] }, named: { provider: null, model: null } };
  }, { streams });
  return { made };
}

const site = (page: Page) => page.getByRole('region', { name: 'site' });
const dialog = (page: Page) => page.getByRole('alertdialog');
const editorOf = (page: Page) => page.locator('.pd-editor .ProseMirror');
const asksNot = (page: Page) => page.addInitScript(() => localStorage.setItem('confirmDeletes', 'off'));

/** What a stream of the page says, as the server half would. */
const say = (page: Page, suffix: string, event: string, data: unknown) =>
  page.evaluate(([suffix, event, data]) => (window as any).streams.find((s: any) => !s.closed && s.url.endsWith(suffix)).emit(event, data), [suffix, event, data] as const);
const tell = (page: Page, id: string, revision: number, author = 'user') => say(page, `/documents/${id}/events`, 'revision', { revision, author, at: '2026-10-02T10:00:00.000Z' });

test('a document is renamed from its row with the keyboard alone: the name without .md is selected, Enter renames, and the focus goes back to the row', async ({ page }) => {
  const shelf = new Shelf();
  await portal(page, shelf);
  await page.goto(`/x/${NAME}/documents`);
  await expect(site(page).getByRole('listitem')).toHaveCount(3);
  // From the row's own button, one Tab to the next: what can be done with a document is in the order of the page, and shown when it has the focus.
  await site(page).getByRole('button', { name: /The plan/ }).focus();
  await page.keyboard.press('Tab');
  const rename = site(page).getByRole('button', { name: 'Rename plan.md' });
  await expect(rename).toBeFocused();
  await expect(rename.locator('xpath=..')).toHaveCSS('opacity', '1');
  await page.keyboard.press('Enter');
  const field = page.getByRole('textbox', { name: 'New file name for plan.md' });
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('plan');
  expect(await field.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 4]);
  // What the person sees is the title and the file: the form says which of them it changes.
  await expect(site(page).getByText('This renames the file. The title is the document\'s first heading: change it in the text.')).toBeVisible();
  await page.keyboard.type('roadmap');
  await page.keyboard.press('Enter');
  expect(shelf.requests).toEqual(['POST 1111111111111111/rename {"name":"roadmap.md"}']);
  await expect(page.getByRole('textbox', { name: /New file name/ })).toHaveCount(0);
  await expect(site(page).getByRole('listitem').first()).toContainText('roadmap.md');
  await expect(site(page).getByRole('button', { name: 'Rename roadmap.md' })).toBeFocused();
  await expect(site(page).getByRole('button', { name: 'Rename plan.md' })).toHaveCount(0);
});

test('a name written with its .md, or with spaces around it, is the same name; Escape and Cancel leave the row as it was; a name with nothing in it is not sent', async ({ page }) => {
  const shelf = new Shelf();
  await portal(page, shelf);
  await page.goto(`/x/${NAME}/documents`);
  const row = site(page).getByRole('listitem').first();
  await row.getByRole('button', { name: 'Rename plan.md' }).click();
  const field = page.getByRole('textbox', { name: 'New file name for plan.md' });
  const send = row.getByRole('button', { name: 'Rename', exact: true });
  await field.fill('   ');
  await expect(send).toBeDisabled();
  await field.fill('.MD');
  await expect(send).toBeDisabled();
  // The same name asks for nothing: no request.
  await field.fill('  plan.md ');
  await expect(send).toBeEnabled();
  await field.press('Enter');
  await expect(field).toHaveCount(0);
  expect(shelf.requests).toEqual([]);
  // Escape gives the form up with the focus on the button that opened it; Cancel does too.
  await row.getByRole('button', { name: 'Rename plan.md' }).click();
  await field.fill('somewhere else');
  await field.press('Escape');
  await expect(field).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Rename plan.md' })).toBeFocused();
  await row.getByRole('button', { name: 'Rename plan.md' }).click();
  await row.getByRole('button', { name: 'Cancel' }).click();
  await expect(field).toHaveCount(0);
  await expect(row).toContainText('plan.md');
  expect(shelf.requests).toEqual([]);
  // Written as a person would: an extension of their own is not doubled.
  await row.getByRole('button', { name: 'Rename plan.md' }).click();
  await field.fill('  Q3 plan.md  ');
  await field.press('Enter');
  expect(shelf.requests).toEqual(['POST 1111111111111111/rename {"name":"Q3 plan.md"}']);
});

test('a rename form that was not changed asks for nothing, also for a file whose extension is in capitals, and a name that is changed keeps that extension', async ({ page }) => {
  const shelf = new Shelf([{ id: '6666666666666666', name: 'README.MD', title: 'Readme', revision: 1, markdown: '# Readme\n' }]);
  await portal(page, shelf);
  await page.goto(`/x/${NAME}/documents`);
  const row = site(page).getByRole('listitem').first();
  await row.getByRole('button', { name: 'Rename README.MD' }).click();
  const field = page.getByRole('textbox', { name: 'New file name for README.MD' });
  await expect(field).toHaveValue('README');
  // The extension is the file's own, said after the field.
  await expect(row.locator('.pd-rename-field .pd-meta').nth(1)).toHaveText('.MD');
  // Enter with nothing changed: the form closes, and nothing is sent (`README.md` would be another name than `README.MD`, and on a file system that does not tell them apart, the same file).
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: /New file name/ })).toHaveCount(0);
  expect(shelf.requests).toEqual([]);
  await row.getByRole('button', { name: 'Rename README.MD' }).click();
  await field.fill('Guide');
  await page.keyboard.press('Enter');
  await expect(site(page).getByRole('listitem').first()).toContainText('Guide.MD');
  expect(shelf.requests).toEqual(['POST 6666666666666666/rename {"name":"Guide.MD"}']);
});

test('a file whose name ends in .md twice is opened as plan.md, and a form that was not changed asks for nothing; a name written with its .md has that one taken off, and no second', async ({ page }) => {
  const shelf = new Shelf([{ id: '7777777777777777', name: 'plan.md.md', title: 'The plan', revision: 1, markdown: '# The plan\n' }]);
  await portal(page, shelf);
  await page.goto(`/x/${NAME}/documents`);
  const row = site(page).getByRole('listitem').first();
  await row.getByRole('button', { name: 'Rename plan.md.md' }).click();
  const field = page.getByRole('textbox', { name: 'New file name for plan.md.md' });
  // The file's own extension is said after the field; the field has the rest, `.md` of its own included.
  await expect(field).toHaveValue('plan.md');
  await expect(row.locator('.pd-rename-field .pd-meta').nth(1)).toHaveText('.md');
  // Enter with nothing changed: the form closes and nothing is sent (it was a rename to `plan.md`, another file's name).
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: /New file name/ })).toHaveCount(0);
  expect(shelf.requests).toEqual([]);
  // Nor is the field written again as it was (spaces around it).
  await row.getByRole('button', { name: 'Rename plan.md.md' }).click();
  await field.fill('  plan.md ');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: /New file name/ })).toHaveCount(0);
  expect(shelf.requests).toEqual([]);
  // A name that is written with its extension has that one taken off, and the file's own is put back: one, not two.
  await row.getByRole('button', { name: 'Rename plan.md.md' }).click();
  await field.fill('draft.md');
  await page.keyboard.press('Enter');
  await expect(row).toContainText('draft.md');
  expect(shelf.requests).toEqual(['POST 7777777777777777/rename {"name":"draft.md"}']);
  await row.getByRole('button', { name: 'Rename draft.md' }).click();
  await page.getByRole('textbox', { name: 'New file name for draft.md' }).fill('final.md.md');
  await page.keyboard.press('Enter');
  await expect(row).toContainText('final.md.md');
  expect(shelf.requests.at(-1)).toEqual('POST 7777777777777777/rename {"name":"final.md.md"}');
});

test('a name that is refused is said under the field, which stays with what was typed, and is tried again', async ({ page }) => {
  const shelf = new Shelf();
  await portal(page, shelf);
  await page.goto(`/x/${NAME}/documents`);
  const row = site(page).getByRole('listitem').first();
  await row.getByRole('button', { name: 'Rename plan.md' }).click();
  const field = page.getByRole('textbox', { name: 'New file name for plan.md' });
  await field.fill('release');
  await field.press('Enter');
  await expect(row.getByRole('alert')).toHaveText('A document called release.md exists already');
  await expect(field).toHaveValue('release');
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  // Typing again takes the message back, and another name goes through.
  await field.fill('plans');
  await expect(row.getByRole('alert')).toHaveCount(0);
  await field.press('Enter');
  await expect(row).toContainText('plans.md');
  expect(shelf.requests).toEqual(['POST 1111111111111111/rename {"name":"release.md"}', 'POST 1111111111111111/rename {"name":"plans.md"}']);
  // A refusal for a name that is not a document's says why, whatever it is.
  shelf.refuse = { status: 400, body: { error: 'A document\'s file name ends in .md, does not start with a dot, and has no / or \\ or control character in it' } };
  await row.getByRole('button', { name: 'Rename plans.md' }).click();
  const again = page.getByRole('textbox', { name: 'New file name for plans.md' });
  await again.fill('a/b');
  await again.press('Enter');
  await expect(row.getByRole('alert')).toContainText('has no / or \\');
});

test('a document is deleted from its row after the portal\'s question: Cancel keeps it, Delete removes it and the focus goes to the next row', async ({ page }) => {
  const shelf = new Shelf();
  await portal(page, shelf);
  await page.goto(`/x/${NAME}/documents`);
  const remove = site(page).getByRole('button', { name: 'Delete plan.md' });
  await remove.focus();
  await page.keyboard.press('Enter');
  // It says what is lost, in plain words.
  await expect(dialog(page)).toContainText('Delete “The plan”?');
  await expect(dialog(page)).toContainText('This deletes the file plan.md, the comments on it and its history. It cannot be undone.');
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(remove).toBeFocused();
  expect(shelf.requests).toEqual([]);
  await expect(site(page).getByRole('listitem')).toHaveCount(3);

  await page.keyboard.press('Enter');
  await dialog(page).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(site(page).getByRole('listitem')).toHaveCount(2);
  expect(shelf.requests).toEqual(['DELETE 1111111111111111']);
  await expect(site(page).getByRole('button', { name: /Release notes/ })).toBeFocused();
  // The last of them: the focus goes to the one before.
  await site(page).getByRole('button', { name: 'Delete setup.md' }).click();
  await dialog(page).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(site(page).getByRole('listitem')).toHaveCount(1);
  await expect(site(page).getByRole('button', { name: /Release notes/ })).toBeFocused();
});

test('with the question switched off in Settings a document is deleted at once, and one that fails to be says why and stays', async ({ page }) => {
  await asksNot(page);
  const shelf = new Shelf();
  await portal(page, shelf);
  await page.goto(`/x/${NAME}/documents`);
  shelf.refuse = { status: 409, body: { error: 'plan.md is not the document\'s file now (a link, a folder or a file with another name): it was not deleted' } };
  await site(page).getByRole('button', { name: 'Delete plan.md' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('The document could not be deleted: plan.md is not the document\'s file now');
  await expect(site(page).getByRole('listitem')).toHaveCount(3);
  shelf.refuse = null;
  await site(page).getByRole('button', { name: 'Delete plan.md' }).click();
  await expect(site(page).getByRole('listitem')).toHaveCount(2);
  expect(shelf.requests).toEqual(['DELETE 1111111111111111', 'DELETE 1111111111111111']);
});

test('the panel beside a chat renames and deletes as the page does', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  const shelf = new Shelf();
  await portal(page, shelf);
  await page.goto('/s/a');
  await page.locator('.panel-toggle[aria-label="Documents"]').click();
  const panels = page.getByRole('complementary', { name: 'Panels' });
  await expect(panels.getByRole('listitem')).toHaveCount(3);
  await panels.getByRole('button', { name: 'Rename release.md' }).click();
  await page.getByRole('textbox', { name: 'New file name for release.md' }).fill('changelog');
  await page.keyboard.press('Enter');
  await expect(panels.getByRole('listitem').nth(1)).toContainText('changelog.md');
  await panels.getByRole('button', { name: 'Delete setup.md' }).click();
  await dialog(page).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(panels.getByRole('listitem')).toHaveCount(2);
  expect(shelf.requests).toEqual(['POST 2222222222222222/rename {"name":"changelog.md"}', 'DELETE 3333333333333333']);
});

test('the actions are in German in a German portal', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pithagoras.language', 'de'));
  const shelf = new Shelf();
  await portal(page, shelf);
  await page.goto(`/x/${NAME}/documents`);
  await site(page).getByRole('button', { name: 'plan.md umbenennen' }).click();
  await expect(page.getByRole('textbox', { name: 'Neuer Dateiname für plan.md' })).toBeFocused();
  await expect(site(page).getByText('Das benennt die Datei um. Der Titel ist die erste Überschrift des Dokuments: Ändere ihn im Text.')).toBeVisible();
  await page.getByRole('button', { name: 'Abbrechen' }).click();
  await site(page).getByRole('button', { name: 'plan.md löschen' }).click();
  await expect(dialog(page)).toContainText('„The plan“ löschen?');
  await expect(dialog(page)).toContainText('Das löscht die Datei plan.md, die Kommentare dazu und den Verlauf. Das lässt sich nicht rückgängig machen.');
});

/* A document open: its bar. */

async function openDocument(page: Page, shelf: Shelf, id = PLAN.id) {
  await portal(page, shelf);
  await page.goto(`/x/${NAME}/documents?folder=${FOLDER}&doc=${id}`);
  await expect(page.locator('.pd-state')).toHaveAttribute('data-status', 'saved');
}
const bar = (page: Page) => page.locator('.pd-titlebar');
const actions = (page: Page) => bar(page).getByRole('button', { name: 'Document actions' });

test('the bar has a menu next to Download with Rename and Delete: it opens with the focus in it, the arrows move in it and Escape closes it and gives the focus back', async ({ page }) => {
  const shelf = new Shelf();
  await openDocument(page, shelf);
  await expect(bar(page)).toContainText('documents/plan.md');
  await expect(actions(page)).toBeEnabled();
  await actions(page).focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem')).toHaveText(['Rename', 'Delete']);
  await expect(menu.getByRole('menuitem', { name: 'Rename' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Delete' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Rename' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem', { name: 'Delete' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(actions(page)).toBeFocused();
  // The Download menu has the same keys.
  await bar(page).getByRole('button', { name: 'Download' }).click();
  await expect(page.getByRole('menuitem', { name: 'Markdown (.md)' })).toBeFocused();
  await page.keyboard.press('Escape');
});

test('a document is renamed from its bar: what was typed is saved first, the name in the bar is the new one, and the page is not told of its own rename', async ({ page }) => {
  const shelf = new Shelf();
  await openDocument(page, shelf);
  await clickIntoText(editorOf(page).getByText('The build is green.'));
  await page.keyboard.press('End');
  await page.keyboard.type(' Really.');
  await actions(page).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const field = page.getByRole('textbox', { name: 'New file name for plan.md' });
  await expect(field).toBeFocused();
  await field.fill('roadmap');
  await page.keyboard.press('Enter');
  // The text went first, on the revision the page was at, and the rename after it.
  await expect.poll(() => shelf.requests.length).toBe(2);
  expect(shelf.requests[0]).toMatch(/^PUT 1111111111111111 base=3 .*Really\./);
  expect(shelf.requests[1]).toBe('POST 1111111111111111/rename {"name":"roadmap.md"}');
  await expect(field).toHaveCount(0);
  await expect(actions(page)).toBeFocused();
  // The revision the rename made comes by the stream, as any revision does: the page takes it, and the name with it.
  await tell(page, PLAN.id, shelf.find(PLAN.id)!.revision);
  await expect(bar(page)).toContainText('documents/roadmap.md');
  await expect(page.locator('.pd-state')).toContainText('Revision 5');
  await expect(page.locator('.pd-state')).toContainText('Saved');
  await expect(page.locator('.pd-note')).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Markdown (.md)' })).toHaveCount(0);
  await bar(page).getByRole('button', { name: 'Download' }).click();
  await expect(page.getByRole('menuitem', { name: 'Markdown (.md)' })).toHaveAttribute('download', 'roadmap.md');
  await page.keyboard.press('Escape');
  // And the page still saves, on the new revision.
  await clickIntoText(editorOf(page).getByText('Really.'));
  await page.keyboard.press('End');
  await page.keyboard.type(' More.');
  await expect.poll(() => shelf.requests.filter((r) => r.startsWith('PUT')).length).toBe(2);
  expect(shelf.requests[2]).toMatch(/^PUT 1111111111111111 base=5 .*More\./);
});

test('a rename from the bar that is refused is said under the field and leaves the bar as it was; Escape closes the form and gives the focus back', async ({ page }) => {
  const shelf = new Shelf();
  await openDocument(page, shelf);
  await actions(page).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const field = page.getByRole('textbox', { name: 'New file name for plan.md' });
  await field.fill('release');
  await field.press('Enter');
  await expect(page.getByRole('alert')).toHaveText('A document called release.md exists already');
  await expect(bar(page)).toContainText('documents/plan.md');
  await field.press('Escape');
  await expect(field).toHaveCount(0);
  await expect(actions(page)).toBeFocused();
  expect(shelf.requests).toEqual(['POST 1111111111111111/rename {"name":"release.md"}']);
});

test('a document is deleted from its bar after the portal\'s question, and the page goes back to the list without saving what was typed', async ({ page }) => {
  const shelf = new Shelf();
  await openDocument(page, shelf);
  await clickIntoText(editorOf(page).getByText('The build is green.'));
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed.');
  await actions(page).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(dialog(page)).toContainText('Delete “The plan”?');
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(bar(page)).toBeVisible();
  expect(shelf.requests.filter((r) => r.startsWith('DELETE'))).toEqual([]);
  await actions(page).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await dialog(page).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(site(page)).toBeVisible();
  await expect(site(page).getByRole('listitem')).toHaveCount(2);
  await expect(site(page)).not.toContainText('plan.md');
  // What was typed is not written back after the document is gone, nor kept for it.
  await page.waitForTimeout(1500);
  expect(shelf.requests.filter((r) => r.startsWith('PUT')).length).toBeLessThanOrEqual(1);
  expect(shelf.requests[shelf.requests.length - 1]).toBe('DELETE 1111111111111111');
});

test('with the question switched off a document is deleted from the bar at once', async ({ page }) => {
  await asksNot(page);
  const shelf = new Shelf();
  await openDocument(page, shelf);
  await actions(page).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(site(page)).toBeVisible();
  expect(shelf.requests).toEqual(['DELETE 1111111111111111']);
});

test('a document that is renamed from elsewhere has its new name on the page that has it open, and what is typed there is kept and saved on the new revision', async ({ page }) => {
  const shelf = new Shelf();
  await openDocument(page, shelf);
  await clickIntoText(editorOf(page).getByText('The build is green.'));
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed.');
  const revision = shelf.renameElsewhere(PLAN.id, 'elsewhere.md');
  await tell(page, PLAN.id, revision);
  await expect(bar(page)).toContainText('documents/elsewhere.md');
  await expect(page.locator('.pd-note')).toContainText('This document was renamed to elsewhere.md.');
  await expect(editorOf(page)).toContainText('The build is green. Typed.');
  // Saved on top of the rename, not refused for it.
  await expect.poll(() => shelf.requests.filter((r) => r.startsWith('PUT')).length).toBe(1);
  expect(shelf.requests[0]).toMatch(new RegExp(`^PUT 1111111111111111 base=${revision} .*Typed\\.`));
  await expect(page.locator('.pd-state')).toContainText('Saved');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a document that is deleted from elsewhere says so on the page that has it open, which keeps the text and sends nothing more', async ({ page }) => {
  const shelf = new Shelf();
  await openDocument(page, shelf);
  await clickIntoText(editorOf(page).getByText('The build is green.'));
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed.');
  shelf.deleteElsewhere(PLAN.id);
  await say(page, `/documents/${PLAN.id}/events`, 'deleted', { at: '2026-10-02T10:00:00.000Z' });
  await expect(page.getByRole('alert')).toContainText('This document was deleted. Your text is kept here and is not saved.');
  await expect(editorOf(page)).toContainText('The build is green. Typed.');
  // The text goes on being the person's: it is not sent, and nothing says it could not be saved.
  await page.keyboard.type(' More.');
  await page.waitForTimeout(1600);
  expect(shelf.requests).toEqual([]);
  await expect(page.getByRole('alert')).toHaveCount(1);
  await expect(actions(page)).toBeDisabled();
  // It can be saved again as a document of its own, which is then the one that is open.
  await page.getByRole('button', { name: 'Save as a new document' }).click();
  await expect(bar(page)).toContainText('documents/saved.md');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('the text of a document deleted from elsewhere is saved as a new document with the text that is on the page, and Close goes back to the list', async ({ page }) => {
  const shelf = new Shelf();
  const { made } = await portal(page, shelf);
  await page.goto(`/x/${NAME}/documents?folder=${FOLDER}&doc=${PLAN.id}`);
  await expect(page.locator('.pd-state')).toContainText('Saved');
  await clickIntoText(editorOf(page).getByText('The build is green.'));
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed.');
  shelf.deleteElsewhere(PLAN.id);
  await say(page, `/documents/${PLAN.id}/events`, 'deleted', { at: '2026-10-02T10:00:00.000Z' });
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Save as a new document' }).click();
  await expect(bar(page)).toContainText('documents/saved.md');
  const sent = made[0];
  expect(sent.title).toBe('The plan');
  expect(sent.markdown).toContain('The build is green. Typed.');
  expect(sent.scope).toBe('project');
});

test('a save that finds the document gone says so as a deletion does, and Close goes back to the list', async ({ page }) => {
  const shelf = new Shelf();
  await openDocument(page, shelf);
  // The stream was down: the page was not told. Its next save finds out.
  shelf.deleteElsewhere(PLAN.id);
  await clickIntoText(editorOf(page).getByText('The build is green.'));
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed.');
  await expect(page.getByRole('alert')).toContainText('This document was deleted. Your text is kept here and is not saved.');
  await expect(page.getByRole('alert')).toHaveCount(1);
  await expect(editorOf(page)).toContainText('Typed.');
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(site(page)).toBeVisible();
});

test('a stream that dropped on a document that was deleted meanwhile finds that out and stops asking', async ({ page }) => {
  const shelf = new Shelf();
  await openDocument(page, shelf);
  shelf.deleteElsewhere(PLAN.id);
  await page.evaluate(() => (window as any).streams.find((s: any) => s.url.endsWith('/events') && !s.closed).emit('error', {}));
  await expect(page.getByRole('alert')).toContainText('This document was deleted.', { timeout: 10_000 });
  const streams = () => page.evaluate(() => (window as any).streams.filter((s: any) => s.url.includes('/documents/') && !s.closed).length);
  expect(await streams()).toBe(0);
});

test('a 404 that is not the server half\'s own, as the portal answers while the half starts, does not make the page say the document was deleted: the text is kept, and saved once the half is back', async ({ page }) => {
  const shelf = new Shelf();
  await openDocument(page, shelf);
  shelf.away = true;
  await clickIntoText(editorOf(page).getByText('The build is green.'));
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed while it was away.');
  // The save fails as any failed save does: said, the text kept, tried again at the next change. Not the words for a deleted document.
  await expect(page.locator('.pd-state')).toContainText('Not saved');
  await expect(page.getByText(/Could not save/)).toBeVisible();
  await expect(page.getByText('This document was deleted')).toHaveCount(0);
  // The stream dropped with the half: the page asks after the document again (its comments), and the answer is the portal's 404 again.
  await page.evaluate(() => (window as any).streams.find((s: any) => s.url.endsWith('/events') && !s.closed).emit('error', {}));
  await expect.poll(() => shelf.awayCalls.filter((c) => c === 'GET /threads').length, { timeout: 10_000 }).toBeGreaterThan(0);
  await expect(page.getByText('This document was deleted')).toHaveCount(0);
  await expect(editorOf(page)).toContainText('The build is green. Typed while it was away.');
  // The half is back: the page goes on, and the text typed while it was away is saved with what comes after it.
  shelf.away = false;
  await page.keyboard.type(' And after.');
  await expect(page.locator('.pd-state')).toContainText('Saved');
  expect(shelf.requests.at(-1)).toContain('The build is green. Typed while it was away. And after.');
  expect(shelf.find(PLAN.id)!.markdown).toContain('Typed while it was away. And after.');
  await expect(actions(page)).toBeEnabled();
  // The stream is open again: the page takes a change from elsewhere, as before.
  await expect.poll(() => page.evaluate(() => (window as any).streams.filter((s: any) => s.url.endsWith('/events') && !s.closed).length), { timeout: 10_000 }).toBe(1);
});

test('a 404 on a deletion that is not the server half\'s own is a failure, said on the page, which stays: the document is not taken for deleted', async ({ page }) => {
  await asksNot(page);
  const shelf = new Shelf();
  await openDocument(page, shelf);
  await clickIntoText(editorOf(page).getByText('The build is green.'));
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed.');
  shelf.away = true;
  await actions(page).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(page.getByText(/The document could not be deleted/)).toBeVisible();
  await expect(bar(page)).toBeVisible();
  await expect(editorOf(page)).toContainText('The build is green. Typed.');
  expect(shelf.find(PLAN.id)).toBeDefined();
  // Where the half answers that there is no such document, it is gone, and the page goes back to the list.
  shelf.away = false;
  shelf.deleteElsewhere(PLAN.id);
  await actions(page).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(site(page)).toBeVisible();
});

test('a document with no heading is called by its file name, which a rename changes in the bar, and the question before it is deleted says the new one', async ({ page }) => {
  const shelf = new Shelf([{ id: '5555555555555555', name: 'scratch.md', title: '', revision: 1, markdown: 'Just words.\n', headless: true }]);
  await openDocument(page, shelf, '5555555555555555');
  await expect(bar(page).locator('.pd-doctitle')).toHaveText('scratch');
  const revision = shelf.renameElsewhere('5555555555555555', 'notes.md');
  await tell(page, '5555555555555555', revision);
  await expect(bar(page)).toContainText('documents/notes.md');
  await expect(bar(page).locator('.pd-doctitle')).toHaveText('notes');
  await actions(page).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(dialog(page)).toContainText('Delete “notes”?');
  await expect(dialog(page)).toContainText('This deletes the file notes.md');
});

test('the bar and the history say what a rename is in German, and the note that a document was renamed too', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pithagoras.language', 'de'));
  const shelf = new Shelf();
  await openDocument(page, shelf);
  const menu = bar(page).getByRole('button', { name: 'Aktionen für das Dokument' });
  await expect(menu).toBeVisible();
  await menu.click();
  await expect(page.getByRole('menuitem')).toHaveText(['Umbenennen', 'Löschen']);
  await page.keyboard.press('Escape');
  const revision = shelf.renameElsewhere(PLAN.id, 'neu.md');
  await tell(page, PLAN.id, revision);
  await expect(page.locator('.pd-note')).toContainText('Dieses Dokument wurde in neu.md umbenannt.');
});
