import { type Page } from '@playwright/test';
import { test, expect } from '../../../../tests/browser/portal-mock';
import { BASE, browserState, withBrowser } from './state';

test.use({ installed: ['extensions/docker', 'extensions/browser'] });

/**
 * Installing and removing the agent's browser, from the Browser page and from
 * its page in Settings: the same controls in both. Over canned answers;
 * `calls` is every request that changes something, and an install does not end
 * until it is let go.
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
  await withBrowser(
    page,
    () =>
      browserState({
        running: state.running,
        install: { available: true, mode: state.mode, image: start.image ?? false, container: state.container, binary: '/usr/bin/chromium', pulling: state.pulling },
        config: { user: 'abc', hasPassword: start.hasPassword ?? true },
      }),
    async ({ path: p, method }) => {
      if (!p.startsWith(`${BASE}/`) || method === 'GET') return undefined;
      const route = p.slice(BASE.length);
      calls.push(`${method} ${route}`);
      if (route === '/install' && method === 'POST') {
        await held;
        state.container = 'running';
        state.running = true;
      } else if (route === '/install' && method === 'DELETE') {
        state.container = 'absent';
        state.running = false;
      }
      return { ok: true };
    },
  );
  return { calls, state, release };
}

const settings = async (page: Page) => {
  await page.goto('/settings/x/pithagoras-browser');
  return page.getByRole('dialog', { name: 'Settings' });
};

test('a second click on Install while it runs is not a second install, and the download is followed', async ({ page }) => {
  const { calls, state, release } = await portal(page);
  const dialog = await settings(page);
  const install = dialog.getByRole('button', { name: /^Install/ });
  await expect(install).toHaveText('Install (downloads a few GB)');
  await install.click();
  await expect(install).toBeDisabled();
  await install.click({ force: true });
  // The server half tells what it is pulling: shown here without being asked for.
  state.pulling = { active: true, line: 'Pulling fs layer: 3 of 12', error: undefined };
  await expect(dialog.getByText('Pulling fs layer: 3 of 12')).toBeVisible({ timeout: 8000 });
  expect(calls).toEqual(['POST /install']);
  release();
  await expect(dialog.getByText('running', { exact: true })).toBeVisible();
});

test('what went wrong with the download is said in Settings', async ({ page }) => {
  const { state } = await portal(page);
  state.pulling = { active: false, line: '', error: 'pull access denied' };
  const dialog = await settings(page);
  await expect(dialog.getByRole('alert').filter({ hasText: 'pull access denied' })).toBeVisible();
});

test('installing from Settings or from the Browser page asks for an install and nothing else: the server half wires the agent up', async ({ page }) => {
  const { calls, state, release } = await portal(page);
  release();
  const dialog = await settings(page);
  await dialog.getByRole('button', { name: /^Install/ }).click();
  await expect(dialog.getByText('running', { exact: true })).toBeVisible();
  expect(calls).toEqual(['POST /install']);

  Object.assign(state, { container: 'absent', running: false });
  calls.length = 0;
  await page.goto('/x/pithagoras-browser/browser');
  await page.getByRole('button', { name: /^Install/ }).click();
  await expect.poll(() => calls).toEqual(['POST /install']);
});

test('without a password, one is asked for before installing, and Suggest one fills it in; it is set before the install', async ({ page }) => {
  const { calls, release } = await portal(page, { hasPassword: false });
  release();
  await page.route(`**${BASE}/suggest-password`, (route) => route.fulfill({ json: { password: '0123456789abcdef01234567' } }));
  const dialog = await settings(page);
  const install = dialog.getByRole('button', { name: /^Install/ });
  await expect(install).toBeDisabled();
  await dialog.getByRole('button', { name: 'Suggest one' }).click();
  await expect(dialog.getByLabel('a password for its web UI')).toHaveValue('0123456789abcdef01234567');
  await install.click();
  await expect.poll(() => calls).toEqual(['PUT /config', 'POST /install']);
});

test('removing a browser from Settings or from the Browser page asks for the removal and nothing else', async ({ page }) => {
  const { calls, state } = await portal(page, { container: 'running', running: true });
  const dialog = await settings(page);
  await dialog.getByRole('button', { name: 'Remove' }).click();
  await expect(dialog.getByRole('button', { name: /^Install/ })).toBeVisible();
  expect(calls).toEqual(['DELETE /install']);

  state.container = 'stopped';
  calls.length = 0;
  await page.goto('/x/pithagoras-browser/browser');
  await page.getByRole('button', { name: 'Remove' }).click();
  await expect.poll(() => calls).toEqual(['DELETE /install']);
});

const NOT_ANSWERING = /is not answering/;

test('"not answering" is said of a container that is up and does not answer, and of a browser run outside the portal; not of one that was stopped, is not installed, or is the machine\'s Chrome', async ({ page }) => {
  const { state } = await portal(page, { container: 'running', running: false });
  await page.goto('/x/pithagoras-browser/browser');
  await expect(page.getByText(/^The browser's container is running, but the browser in it is not answering\./)).toBeVisible();

  state.mode = 'external';
  await page.goto('/x/pithagoras-browser/browser');
  await expect(page.getByText(/^The browser is not answering\. It is run outside the portal/)).toBeVisible();

  for (const start of [{ container: 'stopped', mode: 'docker' }, { container: 'absent', mode: 'docker' }, { container: 'stopped', mode: 'local' }, { container: 'running', mode: 'local' }]) {
    Object.assign(state, start);
    await page.goto('/x/pithagoras-browser/browser');
    await expect(page.getByRole('heading', { name: 'Browser' })).toBeVisible();
    await expect(page.getByText(NOT_ANSWERING), JSON.stringify(start)).toHaveCount(0);
  }
});
