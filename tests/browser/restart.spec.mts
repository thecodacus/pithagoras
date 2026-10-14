import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply } from './portal-mock';

/** Settings → About → Restart, over a portal whose restart the test controls. */
interface World {
  status: Record<string, unknown>;
  posted: unknown[];
  /** What the health check answers, one answer for each look; the last one stays. `down` is a portal that does not answer. */
  health: (string | 'down')[];
  extensions: string[];
  looked: number;
}

const world = (over: Partial<World> = {}): World => ({
  status: { possible: true, by: 'systemd', running: 0 },
  posted: [],
  health: ['boot-a'],
  extensions: ['web-search'],
  looked: 0,
  ...over,
});

async function portal(page: Page, w: World) {
  await mockPortal(page, ({ path, method, json }) => {
    if (path === '/api/restart' && method === 'GET') return w.status;
    if (path === '/api/restart' && method === 'POST') {
      w.posted.push(json());
      return reply(202, { restarting: true, boot: 'boot-a' });
    }
    if (path === '/api/health') {
      const now = w.health[Math.min(w.looked++, w.health.length - 1)];
      return now === 'down' ? reply(502, { error: 'Bad gateway' }) : { ok: true, boot: now };
    }
    if (path === '/api/extensions' && method === 'GET') return { settingsPath: '/a/settings.json', extensions: w.extensions.map((name) => ({ spec: name, name, settings: [] })) };
    return undefined;
  }, { settings: true });
}

const section = (page: Page) => page.locator('section[data-setting="Restart"]');

test('Restart says what it will do and asks first; cancelling stops nothing', async ({ page }) => {
  const w = world({ status: { possible: true, by: 'systemd', running: 2 } });
  await portal(page, w);
  await page.goto('/settings/about');
  await section(page).getByRole('button', { name: 'Restart', exact: true }).click();

  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Restart the portal?');
  await expect(dialog).toContainText('open chats reconnect on their own');
  await expect(dialog).toContainText('2 chats or routines are running. The restart stops them');
  expect(w.posted).toEqual([]);

  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(w.posted).toEqual([]);
  await expect(page.getByRole('status').filter({ hasText: 'The portal is restarting.' })).toHaveCount(0);
});

test('after the confirmation the page waits for another start of the portal, loads again, and says what changed', async ({ page }) => {
  // The old portal still answers for a moment with the start that is ending; then nothing; then a new start.
  const w = world({ health: ['boot-a', 'down', 'down', 'boot-b'] });
  await portal(page, w);
  await page.goto('/settings/about');
  await page.evaluate(() => { (window as any).sameDocument = true; });

  await section(page).getByRole('button', { name: 'Restart', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Restart the portal' }).click();
  await expect.poll(() => w.posted).toEqual([{ confirm: true }]);
  await expect(section(page).getByRole('status')).toContainText('The portal is restarting. This page loads again when it is back.');
  await expect(section(page).getByRole('button', { name: 'Restart', exact: true })).toBeDisabled();

  // The extension that came with the restart.
  w.extensions = ['web-search', 'deep-research'];
  // Loaded again: the document is a new one, and the section tells what the restart brought.
  await expect(section(page).getByRole('status')).toContainText('The portal restarted. Extensions added: deep-research', { timeout: 15_000 });
  expect(await page.evaluate(() => (window as any).sameDocument)).toBeUndefined();
  expect(w.looked).toBeGreaterThanOrEqual(4);
  // Said once.
  await page.reload();
  await expect(section(page).getByRole('button', { name: 'Restart', exact: true })).toBeEnabled();
  await expect(section(page)).not.toContainText('The portal restarted.');
});

test('a portal that nothing would start again says so, and cannot be asked to restart', async ({ page }) => {
  const w = world({ status: { possible: false, code: 'unsupervised', reason: 'Nothing would start this portal again here.', running: 0 } });
  await portal(page, w);
  await page.goto('/settings/about');
  await expect(section(page)).toContainText('Nothing would start this portal again here: it was not started by systemd or in a container.');
  await expect(section(page).getByRole('button', { name: 'Restart', exact: true })).toBeDisabled();
  expect(w.posted).toEqual([]);
});

test('a portal that does not come back says so after three minutes', async ({ page }) => {
  const w = world({ health: ['down'] });
  await page.clock.install();
  await portal(page, w);
  await page.goto('/settings/about');
  await section(page).getByRole('button', { name: 'Restart', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Restart the portal' }).click();
  await expect(section(page).getByRole('status')).toBeVisible();
  for (let i = 0; i < 20; i++) await page.clock.runFor(10_000);
  await expect(section(page).getByRole('alert')).toContainText('The portal has not come back after three minutes.');
  await expect(section(page).getByRole('status')).toHaveCount(0);
});
