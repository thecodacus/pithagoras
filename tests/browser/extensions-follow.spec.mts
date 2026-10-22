import { readFileSync } from 'node:fs';
import { type Page } from '@playwright/test';
import { test, expect, mockPortal, DONE } from './portal-mock';

/**
 * A page follows what is installed, wherever it was installed: the Notes test extension
 * (tests/fixtures/extensions/notes) installed, changed or removed through the API, not from the page, comes into the
 * page, is swapped or goes within one poll of the list of chats, which says what is installed as a revision, and so
 * does a crash of its server half. And what fails of a browser half in a page (to load, to draw, or in what it runs of
 * its own) is told to the portal, which Settings → Extensions says in the pages that go through what is installed after
 * that. A page that could not take an old version out cleanly says so, with a Reload.
 */
const NAME = 'pithagoras-notes';
const web = (file: string) => readFileSync(new URL(`../fixtures/extensions/notes/web/${file}`, import.meta.url), 'utf8');
const address = (file: string) => `/api/extension-ui/${NAME}/${file}`;

/** How its server half crashed, as the portal lists it. */
type Crash = { name: string; rev: string; at: string; error: string; lines: string[] };

/**
 * The portal as its server answers, with the Notes extension installed as `state` says, its server half crashed where
 * `state.crash` says, and what a page told it failed (`told`), and where (`stacks`). `state.listed` is called as each
 * list of what the pages load is answered.
 */
async function portal(page: Page, module = web('client.js')) {
  const state = { installed: true, rev: 'r1', module, css: web('client.css'), crash: undefined as Crash | undefined, listed: undefined as (() => void) | undefined };
  const told: { name: string; rev: string; error: string }[] = [];
  const stacks: (string | undefined)[] = [];
  // What is installed, and where its server half stands, as the server says it: a revision that changes whenever either does.
  const revision = () => JSON.stringify([state.installed, state.rev, state.crash?.at ?? null]);
  await mockPortal(page, async ({ path, method, route, json }) => {
    if (path === '/api/sessions' && method === 'GET') return { sessions: [], executor: 'host', extensions: revision() };
    if (path === '/api/extension-ui' && method === 'GET') {
      const failed = told.findLast((failure) => failure.name === NAME);
      const listing = {
        name: NAME, version: '0.2.0', rev: state.rev, entry: `${address('client.js')}?v=${state.rev}`, style: `${address('client.css')}?v=${state.rev}`,
        // Its routes are gone with a crash, which says why.
        ...(state.crash ? { serverError: `It crashed at ${state.crash.at}: ${state.crash.error}. It stays off until another revision of it is installed, or it is switched off and on.`, crash: state.crash } : { server: `/api/x/${NAME}` }),
        // Said until another revision is installed.
        ...(failed?.rev === state.rev ? { clientError: failed.error } : {}),
      };
      const answer = { revision: revision(), extensions: state.installed ? [listing] : [] };
      state.listed?.();
      return answer;
    }
    if (path === '/api/extension-ui/failures' && method === 'POST') {
      const { stack, ...failure } = json();
      told.push(failure);
      stacks.push(stack);
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
  return { state, told, stacks };
}

const cards = (page: Page) => page.getByRole('tabpanel', { name: /Installed/ }).getByRole('listitem');
const stylesheets = (page: Page) => page.locator(`link[rel="stylesheet"][data-extension="${NAME}"]`);
/** The line that says the page could not take an old version out cleanly. */
const leftBehind = (page: Page) => page.getByRole('status').filter({ hasText: 'could not take out the old version' });
const destinations = (page: Page) => page.getByRole('navigation', { name: 'Destinations' });

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
  // It went in cleanly: nothing to say.
  await expect(leftBehind(page)).toHaveCount(0);
});

test('a file the module imports, changed and installed again, reaches the open page under the new revision', async ({ page }) => {
  // As the portal serves a browser half: every file under the revision, the one its module imports by a relative address too.
  const state = { rev: 'r1', part: 'export const said = "First";' };
  await mockPortal(page, async ({ path, method, route }) => {
    if (path === '/api/sessions' && method === 'GET') return { sessions: [], executor: 'host', extensions: state.rev };
    if (path === '/api/extension-ui' && method === 'GET') return { revision: state.rev, extensions: [{ name: NAME, version: '0.2.0', rev: state.rev, entry: `/api/extension-ui/${NAME}/~${state.rev}/client.js` }] };
    const file = path.startsWith(`/api/extension-ui/${NAME}/~`) ? path.split('/').slice(5).join('/') : undefined;
    if (file === 'client.js') {
      await route.fulfill({ contentType: 'text/javascript', body: 'import { said } from "./part.js";\nexport default function (portal) { portal.slots.register("nav.page", { id: "notes", title: said, component: () => said }); }' });
      return DONE;
    }
    if (file === 'part.js') {
      await route.fulfill({ contentType: 'text/javascript', body: state.part });
      return DONE;
    }
    return undefined;
  });
  await page.clock.install();
  await page.goto('/sessions');
  await expect(destinations(page).getByRole('button', { name: 'First' })).toBeVisible();

  // Only that file changed, and the portal said another revision of the half.
  state.part = 'export const said = "Second";';
  state.rev = 'r2';
  await page.clock.runFor(5500);
  await expect(destinations(page).getByRole('button', { name: 'Second' })).toBeVisible();
  await expect(destinations(page).getByRole('button', { name: 'First' })).toHaveCount(0);
  await expect(leftBehind(page)).toHaveCount(0);
});

test('an old version that cannot be taken out cleanly as another comes in says so, once, and Reload loads what is installed', async ({ page }) => {
  // What its module gave back to be called as it goes throws.
  const { state } = await portal(page, 'export default function (portal) { portal.slots.register("nav.page", { id: "notes", title: "Notes", component: () => "first" }); return () => { throw new Error("could not stop its timer"); }; }');
  await page.clock.install();
  await page.goto('/sessions');
  await expect(destinations(page).getByRole('button', { name: 'Notes' })).toBeVisible();
  await expect(leftBehind(page)).toHaveCount(0);

  // Its second version cannot be taken out cleanly either.
  state.module = 'export default function (portal) { portal.slots.register("nav.page", { id: "notes", title: "Notes again", component: () => "second" }); return () => { throw new Error("could not stop its timer either"); }; }';
  state.rev = 'r2';
  await page.clock.runFor(5500);
  // The new one is in all the same, and the page says what it could not do.
  await expect(destinations(page).getByRole('button', { name: 'Notes again' })).toBeVisible();
  const said = `This page could not take out the old version of ${NAME} cleanly. Reload it to run what is installed now.`;
  await expect(leftBehind(page)).toHaveCount(1);
  await expect(leftBehind(page).getByText(said, { exact: true })).toBeVisible();

  // The same extension again: still one line, that names it once.
  state.module = 'export default function (portal) { portal.slots.register("nav.page", { id: "notes", title: "Notes third", component: () => "third" }); }';
  state.rev = 'r3';
  await page.clock.runFor(5500);
  await expect(destinations(page).getByRole('button', { name: 'Notes third' })).toBeVisible();
  await expect(leftBehind(page)).toHaveCount(1);
  await expect(leftBehind(page).getByText(said, { exact: true })).toBeVisible();

  // Another change that goes in cleanly adds nothing to it.
  state.rev = 'r4';
  await page.clock.runFor(5500);
  await expect(leftBehind(page)).toHaveCount(1);
  await expect(leftBehind(page).getByText(said, { exact: true })).toBeVisible();

  await leftBehind(page).getByRole('button', { name: 'Reload' }).click();
  await expect(destinations(page).getByRole('button', { name: 'Notes third' })).toBeVisible();
  await expect(leftBehind(page)).toHaveCount(0);
});

test('what fails of a browser half, to load or to draw, is told to the portal, and Settings says it in every page', async ({ page }) => {
  const { state, told, stacks } = await portal(page, 'export default function () { throw new Error("notes is not defined"); }');
  await page.goto('/settings/extensions');
  const card = cards(page).filter({ hasText: NAME });
  await expect(card.getByRole('alert')).toHaveText('Its interface could not be loaded: notes is not defined');
  await expect.poll(() => told).toEqual([{ name: NAME, rev: 'r1', error: 'notes is not defined' }]);
  // With where: its module, for whoever looks at it to find the line.
  expect(stacks[0]).toContain(address('client.js'));
  // Loaded again, it fails again: said once, as this page's own, not again as what another page said.
  await page.reload();
  await expect(card.getByRole('alert')).toHaveText('Its interface could not be loaded: notes is not defined');
  await expect(card.getByRole('alert')).toHaveCount(1);

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
  // The reload told it once more: by another page.
  expect(told).toHaveLength(3);
});

test('?extensions=off loads no browser half, and Settings still lists it to switch it off', async ({ page }) => {
  const { state } = await portal(page, 'export default function () { throw new Error("breaks the page"); }');
  const asked: string[] = [];
  page.on('request', (request) => { if (new URL(request.url()).pathname.startsWith('/api/extension-ui')) asked.push(request.url()); });
  await page.clock.install();
  await page.goto('/settings/extensions?extensions=off');
  const card = cards(page).filter({ hasText: NAME });
  await expect(card.getByRole('switch', { name: `Switch off ${NAME}` })).toBeVisible();
  await expect(card.getByRole('alert')).toHaveCount(0);

  // Nor when the list of chats says that something changed: its server half crashed, and the list is read again.
  state.crash = { name: NAME, rev: 's1', at: '2026-10-22T10:00:01.000Z', error: 'Error: boom', lines: [] };
  const listed = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/extensions');
  await page.clock.runFor(5500);
  await listed;
  await expect(stylesheets(page)).toHaveCount(0);
  expect(asked).toEqual([]);
});

test("a crash of its server half comes into Settings → Extensions within one poll, and reads beside what failed of its browser half", async ({ page }) => {
  const { state, told } = await portal(page, 'export default function () { void Promise.reject(new Error("rejected later")); }');
  await page.clock.install();
  await page.goto('/settings/extensions');
  const card = cards(page).filter({ hasText: NAME });
  await expect.poll(() => told).toEqual([{ name: NAME, rev: 'r1', error: 'rejected later' }]);
  await expect(card.getByRole('alert')).toHaveText('Its interface failed in a page: rejected later');

  // It crashed: nothing was installed, and this page did nothing.
  state.crash = { name: NAME, rev: 's1', at: '2026-10-22T10:00:01.000Z', error: 'Error: boom', lines: ['2026-10-22T10:00:00.000Z INFO  [extension pithagoras-notes] about to fail'] };
  await page.clock.runFor(5500);
  const alerts = card.getByRole('alert');
  await expect(alerts).toHaveCount(2);
  await expect(alerts.first()).toHaveText('Its interface failed in a page: rejected later');
  await expect(alerts.last()).toContainText('Its server half crashed at ');
  await expect(alerts.last()).toContainText('is off until another version of it is installed, or it is switched off and on: Error: boom');
  await expect(alerts.last()).not.toContainText('could not be started');
  await expect(alerts.last().getByText('What it said last')).toBeVisible();
});

test('an install made between the page asking what to load and its first list of chats is not missed', async ({ page }) => {
  const { state } = await portal(page);
  state.installed = false;
  // Installed as soon as the page has its list: the list of chats, asked for later, says so.
  state.listed = () => { state.installed = true; };
  // No poll after the first: the first list of chats is the one that says it.
  await page.clock.install();
  await page.goto('/sessions');
  await expect(page.getByRole('navigation', { name: 'Destinations' }).getByRole('button', { name: 'Notes' })).toBeVisible();
});

test('a part that fails in two places of one page is told once', async ({ page }) => {
  // Its page's entry in the sidebar asks whether it is shown, and its page is drawn: both fail alike.
  const { told } = await portal(page, 'export default function (portal) { const bad = () => { throw new Error("drew badly"); }; portal.slots.register("nav.page", { id: "notes", title: "Notes", useShown: bad, component: bad }); }');
  await page.goto(`/x/${NAME}/notes`);
  await expect(page.getByRole('alert')).toContainText('drew badly');
  await expect.poll(() => told).toEqual([{ name: NAME, rev: 'r1', error: 'drew badly' }]);
  await page.waitForTimeout(500);
  expect(told).toEqual([{ name: NAME, rev: 'r1', error: 'drew badly' }]);
});

test("what a browser half runs of its own and nothing caught is told as its failure, and what came from no extension is not", async ({ page }) => {
  const { state, told, stacks } = await portal(page, 'export default function () { setTimeout(() => { throw new Error("thrown later"); }); }');
  await page.goto('/settings/extensions');
  await expect.poll(() => told).toEqual([{ name: NAME, rev: 'r1', error: 'thrown later' }]);
  expect(stacks[0]).toContain(address('client.js'));
  await expect(cards(page).filter({ hasText: NAME }).getByRole('alert')).toHaveText('Its interface failed in a page: thrown later');

  state.module = 'export default function () { Promise.reject(new Error("rejected later")); }';
  state.rev = 'r2';
  await page.goto('/settings/extensions');
  await expect.poll(() => told.at(-1)).toEqual({ name: NAME, rev: 'r2', error: 'rejected later' });

  await page.evaluate(() => {
    setTimeout(() => { throw new Error("the page's own"); });
    void Promise.reject(new Error("the page's own, rejected"));
  });
  await page.waitForTimeout(500);
  expect(told).toHaveLength(2);
});

test('?extensions=off on the address of an extension\'s page says that it loads none', async ({ page }) => {
  await portal(page);
  await page.goto(`/x/${NAME}/notes?extensions=off`);
  await expect(page.getByRole('status').filter({ hasText: 'extensions=off' })).toHaveText('This page was opened with ?extensions=off: no extension is loaded into it.');
});
