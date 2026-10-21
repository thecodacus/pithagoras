import { type Page } from '@playwright/test';
import { test, expect, reply } from '../../../../tests/browser/portal-mock';
import { unnamed } from '../../../../tests/browser/a11y';
import { BASE, browserState, withBrowser } from './state';

test.use({ installed: ['extensions/docker', 'extensions/browser'] });

/**
 * The Browser page (src/web/BrowserPage.tsx): what it says when its server half did not answer, for as long as that is
 * true, and the words it shows in the page's language.
 */

test('the page forgets a failed poll when the next one works, and keeps what a button said until the next press', async ({ page }) => {
  let down = false;
  const status = browserState({ byDefault: false, install: { available: true, mode: 'docker', image: true, container: 'stopped', pulling: { active: false, line: '' } } });
  await withBrowser(page, () => status, ({ path, method }) => {
    if (path === `${BASE}/state` && method === 'GET' && down) return reply(500, { error: 'The browser did not answer' });
    if (path === `${BASE}/start`) return reply(500, { error: 'No room to start it' });
  });
  await page.clock.install();
  await page.goto('/x/pithagoras-browser/browser');
  await expect(page.getByRole('heading', { name: 'Browser', exact: true })).toBeVisible();
  down = true;
  await page.clock.runFor(8500);
  await expect(page.getByRole('alert')).toContainText('The browser did not answer');
  down = false;
  await page.clock.runFor(8500);
  await expect(page.getByRole('alert')).toHaveCount(0);
  // A refused start is said, and a poll that works does not take it back before it was read.
  await page.getByRole('button', { name: /^Start/ }).first().click();
  await expect(page.getByRole('alert')).toContainText('No room to start it');
  await page.clock.runFor(8500);
  await expect(page.getByRole('alert')).toContainText('No room to start it');
});

test('the page that could not read how the browser stands at all says so, with Try again', async ({ page }) => {
  let down = true;
  await withBrowser(page, () => browserState(), ({ path, method }) => {
    if (path === `${BASE}/state` && method === 'GET' && down) return reply(500, { error: 'The browser did not answer' });
  });
  await page.goto('/x/pithagoras-browser/browser');
  await expect(page.getByRole('alert')).toContainText('The browser did not answer');
  down = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'Browser', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('every field and button on the page, and on its page in Settings, has a name', async ({ page }) => {
  await withBrowser(page, () =>
    browserState({
      connected: true, pages: [{ title: 'Example', url: 'https://example.com/' }], chats: [{ id: 'demo', title: 'A chat', kind: 'task', allowed: false }],
      install: { available: true, mode: 'docker', image: false, container: 'absent', pulling: { active: false, line: '' } },
      config: { user: 'agent', hasPassword: false },
    }),
  );
  await page.goto('/x/pithagoras-browser/browser');
  await expect(page.getByRole('link', { name: 'Settings → Guard' })).toBeVisible();
  expect(await unnamed(page)).toEqual([]);
  await page.goto('/settings/x/pithagoras-browser');
  await expect(page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Suggest one' })).toBeVisible();
  expect(await unnamed(page)).toEqual([]);
});

/** The page that lists who may drive the browser: chats that have said so, of the kinds the portal names, and one it does not know. */
async function whoMayDrive(page: Page) {
  await withBrowser(page, () =>
    browserState({
      running: true, connected: true, version: '1', byDefault: false,
      chats: [{ id: 'demo', title: 'A chat', kind: 'task', allowed: true }, { id: 'beat', title: 'Its rounds', kind: 'heartbeat', allowed: true }, { id: 'new', title: 'From a newer portal', kind: 'future-kind', allowed: true }],
      install: { available: true, mode: 'docker', image: true, container: 'running', binary: null, pulling: { active: false, line: '' } },
    }),
  );
  await page.goto('/x/pithagoras-browser/browser');
}

test('the page names the kind of chat in English, and one it does not know as it is', async ({ page }) => {
  await whoMayDrive(page);
  await expect(page.getByRole('button', { name: /A chat/ })).toContainText('task');
  await expect(page.getByRole('button', { name: /From a newer portal/ })).toContainText('future-kind');
});

test.describe('in a browser set to German', () => {
  test.use({ locale: 'de-DE' });

  test('the page says its words in German, and the kind of chat too', async ({ page }) => {
    await whoMayDrive(page);
    await expect(page.getByRole('heading', { name: 'Wer ihn steuern darf' })).toBeVisible();
    await expect(page.getByRole('button', { name: /A chat/ })).toContainText('Aufgabe');
    await expect(page.getByRole('button', { name: /Its rounds/ })).toContainText('Herzschlag');
    // A kind the table does not know is shown as the server half sent it.
    await expect(page.getByRole('button', { name: /From a newer portal/ })).toContainText('future-kind');
    await expect(page.getByRole('link', { name: 'Einstellungen → Wächter' })).toBeVisible();
  });
});
