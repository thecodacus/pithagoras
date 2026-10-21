import { readFileSync } from 'node:fs';
import { type Page } from '@playwright/test';
import { test, expect, mockPortal, DONE } from './portal-mock';

/**
 * A page follows what is installed, wherever it was installed: the Notes test extension
 * (tests/fixtures/extensions/notes) installed, changed or removed through the API, not from the page, comes into the
 * page, is swapped or goes within one poll of the list of chats, which says what is installed as a revision. And what
 * fails of a browser half in a page is told to the portal, which Settings → Extensions says in every page.
 */
const NAME = 'pithagoras-notes';
const web = (file: string) => readFileSync(new URL(`../fixtures/extensions/notes/web/${file}`, import.meta.url), 'utf8');
const address = (file: string) => `/api/extension-ui/${NAME}/${file}`;

/** The portal as its server answers, with the Notes extension installed as `state` says, and what a page told it failed. */
async function portal(page: Page, module = web('client.js')) {
  const state = { installed: true, rev: 'r1', module, css: web('client.css') };
  const told: { name: string; rev: string; error: string }[] = [];
  await mockPortal(page, async ({ path, method, route, json }) => {
    // What is installed, as the server says it with the chats: a revision that changes whenever it does.
    if (path === '/api/sessions' && method === 'GET') return { sessions: [], executor: 'host', extensions: JSON.stringify([state.installed, state.rev]) };
    if (path === '/api/extension-ui' && method === 'GET') {
      const failed = told.findLast((failure) => failure.name === NAME);
      const listing = {
        name: NAME, version: '0.2.0', rev: state.rev, entry: `${address('client.js')}?v=${state.rev}`, style: `${address('client.css')}?v=${state.rev}`, server: `/api/x/${NAME}`,
        // Said until another revision is installed.
        ...(failed?.rev === state.rev ? { clientError: failed.error } : {}),
      };
      return { extensions: state.installed ? [listing] : [] };
    }
    if (path === '/api/extension-ui/failures' && method === 'POST') {
      told.push(json());
      return { ok: true };
    }
    if (path === address('client.js')) { await route.fulfill({ contentType: 'text/javascript', body: state.module }); return DONE; }
    if (path === address('client.css')) { await route.fulfill({ contentType: 'text/css', body: state.css }); return DONE; }
    if (path === `/api/x/${NAME}/notes`) return { chats: [] };
    if (path === '/api/extensions' && method === 'GET') {
      return { settingsPath: '/a/settings.json', extensions: state.installed ? [{ spec: '/srv/notes', name: NAME, version: '0.2.0', kinds: ['pi', 'pithagoras'], settings: [], enabled: true, scope: 'user' }] : [] };
    }
    return undefined;
  }, { settings: true });
  return { state, told };
}

const cards = (page: Page) => page.getByRole('tabpanel', { name: /Installed/ }).getByRole('listitem');
const stylesheets = (page: Page) => page.locator(`link[rel="stylesheet"][data-extension="${NAME}"]`);

test('an extension installed elsewhere comes into the page within one poll, and Settings lists it without being opened again', async ({ page }) => {
  const { state } = await portal(page);
  state.installed = false;
  await page.clock.install();
  await page.goto('/settings/extensions');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.getByText('Nothing installed yet.')).toBeVisible();

  // Installed through the API, by another tab or an agent: this page did nothing.
  state.installed = true;
  await page.clock.runFor(5500);
  await expect(cards(page).filter({ hasText: NAME })).toBeVisible();
  await expect(stylesheets(page)).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('navigation', { name: 'Destinations' }).getByRole('button', { name: 'Notes' })).toBeVisible();

  // And removed the same way.
  state.installed = false;
  await page.clock.runFor(5500);
  await expect(page.getByRole('navigation', { name: 'Destinations' }).getByRole('button', { name: 'Notes' })).toHaveCount(0);
  await expect(stylesheets(page)).toHaveCount(0);
});

test('a change to its stylesheet alone is another revision, and the page swaps it in', async ({ page }) => {
  const { state } = await portal(page);
  await page.clock.install();
  await page.goto(`/x/${NAME}/notes`);
  const spacing = () => page.locator('.pn-page').evaluate((el) => getComputedStyle(el).letterSpacing);
  await expect(page.getByText('No chat has notes yet.')).toBeVisible();
  expect(await spacing()).toBe('normal');

  // The module is as it was: the revision the server gives covers its stylesheet too.
  state.css += '\n.pn-page { letter-spacing: 3px; }\n';
  state.rev = 'r2';
  await page.clock.runFor(5500);
  await expect.poll(spacing).toBe('3px');
  await expect(stylesheets(page)).toHaveCount(1);
  await expect(stylesheets(page)).toHaveAttribute('href', /\?v=r2$/);
});

test('what fails of a browser half, to load or to draw, is told to the portal, and Settings says it in every page', async ({ page }) => {
  const { state, told } = await portal(page, 'export default function () { throw new Error("notes is not defined"); }');
  await page.goto('/settings/extensions');
  const card = cards(page).filter({ hasText: NAME });
  await expect(card.getByRole('alert')).toHaveText('Its interface could not be loaded: notes is not defined');
  await expect.poll(() => told).toEqual([{ name: NAME, rev: 'r1', error: 'notes is not defined' }]);

  // Another revision, which loads and fails to draw its page.
  state.module = 'export default function (portal) { portal.slots.register("nav.page", { id: "notes", title: "Notes", component: () => { throw new Error("drew badly"); } }); }';
  state.rev = 'r2';
  await page.goto(`/x/${NAME}/notes`);
  await expect(page.getByRole('alert')).toContainText('drew badly');
  await expect.poll(() => told.at(-1)).toEqual({ name: NAME, rev: 'r2', error: 'drew badly' });
  // Said in this page at once.
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('navigation').getByRole('button', { name: 'Extensions', exact: true }).click();
  await expect(card.getByRole('alert')).toHaveText('Its interface failed in a page: drew badly');

  // A page that loaded it and drew nothing of it says it all the same, as the portal was told; told once, by the page it failed in.
  await page.goto('/settings/extensions');
  await expect(card.getByRole('alert')).toHaveText('Its interface failed in a page: drew badly');
  expect(told).toHaveLength(2);
});

test('?extensions=off loads no browser half, and Settings still lists it to switch it off', async ({ page }) => {
  await portal(page, 'export default function () { throw new Error("breaks the page"); }');
  const asked: string[] = [];
  page.on('request', (request) => { if (new URL(request.url()).pathname.startsWith('/api/extension-ui')) asked.push(request.url()); });
  await page.goto('/settings/extensions?extensions=off');
  const card = cards(page).filter({ hasText: NAME });
  await expect(card.getByRole('switch', { name: `Switch off ${NAME}` })).toBeVisible();
  await expect(card.getByRole('alert')).toHaveCount(0);
  await expect(stylesheets(page)).toHaveCount(0);
  expect(asked).toEqual([]);
});
