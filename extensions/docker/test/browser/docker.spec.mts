import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from '../../../../tests/browser/portal-mock';

/**
 * Docker's page in Settings (src/client.tsx), over what its server half would answer: whether the portal reaches
 * Docker, and every extension's containers and volumes, which the person may start, stop, read and remove.
 */
test.use({ installed: ['extensions/docker'] });

const DOCKER = { spec: '/app/extensions/docker', name: 'pithagoras-docker', version: '0.1.0', kinds: ['pithagoras'], settings: [], enabled: true, scope: 'user' };
const BASE = '/api/x/pithagoras-docker';
const container = (o: Record<string, unknown>) => ({ id: `${o.name}-id`, image: 'img:1', state: 'running', status: 'Up 2 minutes', ...o });
const REACHED = {
  available: true,
  version: '27.3.1',
  containers: [
    container({ name: 'pithagoras-browser', owner: 'pithagoras-browser', image: 'lscr.io/linuxserver/chromium:latest' }),
    container({ name: 'voice-tts', owner: 'pithagoras-voice', state: 'exited', status: 'Exited (0) 1 minute ago' }),
  ],
  volumes: [{ name: 'pithagoras_browser-profile', owner: 'pithagoras-browser' }],
};

/**
 * Settings, on Docker's page, with `overview` as how things stand and `extensions` installed; what the page asked of the
 * server half is in `asked`.
 */
async function open(page: Page, overview: unknown, extensions: unknown[] = [DOCKER]) {
  const asked: string[] = [];
  const state = { overview };
  await mockPortal(page, ({ path, method }) => {
    if (path === '/api/extensions' && method === 'GET') return { settingsPath: '/a/settings.json', extensions };
    if (path === `${BASE}/overview`) return state.overview;
    if (path === `${BASE}/containers/pithagoras-browser/logs`) return { text: 'started\nlistening on 9222\n' };
    if (path.startsWith(`${BASE}/`)) {
      asked.push(`${method} ${path.slice(BASE.length)}`);
      return { ok: true };
    }
    return undefined;
  }, { settings: true });
  await page.goto('/settings/extensions');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('listitem').filter({ hasText: 'pithagoras-docker' }).getByRole('button', { name: /Configure/ }).click();
  return { dialog, asked, state };
}

test('without a socket the page says the portal cannot reach Docker, and how to give it the socket', async ({ page }) => {
  const { dialog } = await open(page, { available: false, socket: false });
  await expect(dialog.getByText('The portal cannot reach Docker: its container has no Docker socket.')).toBeVisible();
  await expect(dialog.locator('code')).toHaveText('- /var/run/docker.sock:/var/run/docker.sock');
});

test('a socket that does not answer is said to be one', async ({ page }) => {
  const { dialog } = await open(page, { available: false, socket: true });
  await expect(dialog.getByText("Docker's socket is there, but Docker does not answer on it. Is Docker running?")).toBeVisible();
  await expect(dialog.locator('code')).toHaveCount(0);
});

test('each extension\'s containers are listed under it, and are stopped, started, read and removed from here', async ({ page }) => {
  const { dialog, asked } = await open(page, REACHED);
  await expect(dialog.getByText(/^Docker 27\.3\.1, reached through its socket/)).toBeVisible();
  const browser = dialog.getByRole('listitem').filter({ hasText: 'pithagoras-browser' }).filter({ hasText: 'chromium' });
  await expect(browser).toContainText('lscr.io/linuxserver/chromium:latest · Up 2 minutes');
  const voice = dialog.getByRole('listitem').filter({ hasText: 'voice-tts' });
  await expect(voice).toContainText('Exited (0) 1 minute ago');
  // Under the extension that runs each.
  await expect(dialog.getByRole('heading', { name: 'pithagoras-voice' })).toBeVisible();

  await browser.getByRole('button', { name: 'Stop' }).click();
  await voice.getByRole('button', { name: 'Start' }).click();
  await expect.poll(() => asked).toEqual(['POST /containers/pithagoras-browser/stop', 'POST /containers/voice-tts/start']);

  // What it wrote, under it; asked again, it goes.
  await browser.getByRole('button', { name: 'Logs' }).click();
  await expect(browser.getByLabel('What pithagoras-browser wrote')).toHaveText('started\nlistening on 9222\n');
  await browser.getByRole('button', { name: 'Logs' }).click();
  await expect(browser.getByLabel('What pithagoras-browser wrote')).toHaveCount(0);

  // Removed only once the person says so.
  await voice.getByRole('button', { name: 'Remove' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText('Remove voice-tts?');
  await confirm.getByRole('button', { name: 'Remove' }).click();
  await expect.poll(() => asked.at(-1)).toBe('DELETE /containers/voice-tts');
});

test('one Docker is waiting to start again is stopped from here, which ends the wait: a start would do nothing', async ({ page }) => {
  const { dialog, asked } = await open(page, { ...REACHED, containers: [container({ name: 'pithagoras-voice', owner: 'pithagoras-voice', state: 'restarting', status: 'Restarting (1) 4 seconds ago' })] });
  const voice = dialog.getByRole('listitem').filter({ hasText: 'pithagoras-voice' }).filter({ hasText: 'Restarting' });
  await expect(voice.getByRole('button', { name: 'Start' })).toHaveCount(0);
  await voice.getByRole('button', { name: 'Stop' }).click();
  await expect.poll(() => asked).toEqual(['POST /containers/pithagoras-voice/stop']);
});

test('a volume is deleted only once the person says so, being what an extension keeps', async ({ page }) => {
  const { dialog, asked } = await open(page, REACHED);
  const volume = dialog.getByRole('listitem').filter({ hasText: 'pithagoras_browser-profile' });
  await volume.getByRole('button', { name: 'Delete' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText('Everything pithagoras-browser kept in it is deleted for good.');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  expect(asked).toEqual([]);
  await volume.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect.poll(() => asked).toEqual(['DELETE /volumes/pithagoras_browser-profile']);
});

test("in Settings' list it is Docker, with its own icon, not the package's name and the mark every extension has", async ({ page }) => {
  // A package with settings the portal found and no page of its own is drawn with that mark.
  const plain = { spec: 'npm:plain', name: 'plain', version: '1.0.0', kinds: ['pi'], settings: [{ key: 'token', value: '', configured: false }], enabled: true, scope: 'user' };
  const { dialog } = await open(page, REACHED, [DOCKER, plain]);
  const entry = dialog.locator('.rail-item').filter({ hasText: /^Docker$/ });
  await expect(entry).toBeVisible();
  await expect(dialog.locator('.rail-item').filter({ hasText: 'pithagoras-docker' })).toHaveCount(0);
  const mark = await dialog.locator('.rail-item').filter({ hasText: /^plain$/ }).locator('svg').innerHTML();
  expect(await entry.locator('svg').innerHTML()).not.toBe(mark);
});
