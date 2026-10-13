import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/**
 * Installing and removing the agent's browser, from the Browser page and from
 * Settings → Add-ons: the same controls in both. Over canned answers; `calls`
 * is every request that changes something, and an install does not end until
 * it is let go.
 */
async function portal(page: Page, start: { container?: string; mode?: string; running?: boolean; hasPassword?: boolean; image?: boolean } = {}) {
  const calls: string[] = [];
  const state = {
    container: start.container ?? 'absent',
    mode: start.mode ?? 'docker',
    running: start.running ?? false,
    pulling: { active: false, line: '', error: undefined as string | undefined },
  };
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  await mockPortal(page, async ({ path: p, method }) => {
    if (p === '/api/browser' && method === 'GET') {
      return {
        running: state.running, unprotected: false, connectedAs: null, version: null, pages: [], uiPort: '3011', uiExposed: false, uiOutdated: false, cursor: true, allowlist: '', configured: false, byDefault: true, sessions: [], routines: [],
        install: { available: true, mode: state.mode, image: start.image ?? false, container: state.container, binary: '/usr/bin/chromium', pulling: state.pulling },
        config: { user: 'abc', hasPassword: start.hasPassword ?? true },
      };
    }
    if (p.startsWith('/api/browser') && method !== 'GET') {
      calls.push(`${method} ${p}`);
      if (p === '/api/browser/install' && method === 'POST') {
        await held;
        state.container = 'running';
        state.running = true;
      } else if (p === '/api/browser/install' && method === 'DELETE') {
        state.container = 'absent';
        state.running = false;
      }
      return { ok: true };
    }
  }, { settings: true });
  return { calls, state, release };
}

const addons = async (page: Page) => {
  await page.goto('/settings/add-ons');
  return page.getByRole('dialog', { name: 'Settings' });
};

test('a second click on Install while it runs is not a second install, and the download is followed', async ({ page }) => {
  const { calls, state, release } = await portal(page);
  const dialog = await addons(page);
  const install = dialog.getByRole('button', { name: /^Install/ });
  await install.click();
  await expect(install).toBeDisabled();
  await install.click({ force: true });
  // The portal tells what it is pulling: shown here without being asked for.
  state.pulling = { active: true, line: 'Pulling fs layer: 3 of 12', error: undefined };
  await expect(dialog.getByText('Pulling fs layer: 3 of 12')).toBeVisible({ timeout: 8000 });
  expect(calls).toEqual(['POST /api/browser/install']);
  release();
  await expect(dialog.getByText('running', { exact: true })).toBeVisible();
});

test('what went wrong with the download is said in Add-ons', async ({ page }) => {
  const { state } = await portal(page);
  state.pulling = { active: false, line: '', error: 'pull access denied' };
  const dialog = await addons(page);
  await expect(dialog.getByRole('alert').filter({ hasText: 'pull access denied' })).toBeVisible();
});

test('installing from Add-ons or from the Browser page asks for an install and nothing else: the portal wires the agent up', async ({ page }) => {
  const { calls, release } = await portal(page);
  release();
  const dialog = await addons(page);
  await dialog.getByRole('button', { name: /^Install/ }).click();
  await expect(dialog.getByText('running', { exact: true })).toBeVisible();
  expect(calls).toEqual(['POST /api/browser/install']);

  const other = await portal(page);
  other.release();
  await page.goto('/browser');
  await page.getByRole('button', { name: /^Install/ }).click();
  await expect.poll(() => other.calls).toEqual(['POST /api/browser/install']);
});

test('removing a browser from Add-ons or from the Browser page asks for the removal and nothing else', async ({ page }) => {
  const { calls } = await portal(page, { container: 'running', running: true });
  const dialog = await addons(page);
  await dialog.getByRole('button', { name: 'Remove' }).click();
  await expect(dialog.getByRole('button', { name: /^Install/ })).toBeVisible();
  expect(calls).toEqual(['DELETE /api/browser/install']);

  const other = await portal(page, { container: 'stopped' });
  await page.goto('/browser');
  await page.getByRole('button', { name: 'Remove' }).click();
  await expect.poll(() => other.calls).toEqual(['DELETE /api/browser/install']);
});

const NOT_ANSWERING = /The browser container is not answering/;

test('"not answering" is said of a container that is up and does not answer, and not of one that was stopped, is not installed, or is the machine\'s Chrome', async ({ page }) => {
  await portal(page, { container: 'running', running: false });
  await page.goto('/browser');
  await expect(page.getByText(NOT_ANSWERING)).toBeVisible();

  for (const start of [{ container: 'stopped' }, { container: 'absent' }, { container: 'stopped', mode: 'local' }, { container: 'running', mode: 'local' }]) {
    await page.unrouteAll();
    await portal(page, start);
    await page.goto('/browser');
    await expect(page.getByRole('heading', { name: 'Browser' })).toBeVisible();
    await expect(page.getByText(NOT_ANSWERING), JSON.stringify(start)).toHaveCount(0);
  }
});
