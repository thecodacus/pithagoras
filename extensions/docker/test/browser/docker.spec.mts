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

const OUTDATED = { running: 'nvidia/cuda:12.4.1-devel-ubuntu22.04', wanted: 'nvidia/cuda:12.9.1-devel-ubuntu22.04' };
const voiceRow = (extra: Record<string, unknown>) => container({ name: 'pithagoras-voice', owner: 'pithagoras-voice', image: OUTDATED.running, ...extra });
/** Docker's page with the voice container outdated; `overview` is what the page is told next, as it asks again. */
const outdated = (page: Page, row: Record<string, unknown> = {}) => open(page, { ...REACHED, containers: [voiceRow({ imageWarning: OUTDATED, ...row }), ...REACHED.containers] });

test('a container that runs another image than its extension wants is warned of, with an Update that asks first, and the update goes on in the background', async ({ page }) => {
  const { dialog, asked, state } = await outdated(page);
  const voice = dialog.getByRole('listitem').filter({ hasText: 'pithagoras-voice' });
  const warning = voice.getByText(/^Outdated image: it runs nvidia\/cuda:12\.4\.1/);
  await expect(warning).toContainText('and pithagoras-voice now wants nvidia/cuda:12.9.1-devel-ubuntu22.04.');
  // Only that one: a container that is as its extension wants it has none.
  await expect(dialog.getByText(/Outdated image/)).toHaveCount(1);

  await voice.getByRole('button', { name: 'Update' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText('Update pithagoras-voice?');
  await expect(confirm).toContainText('nvidia/cuda:12.9.1-devel-ubuntu22.04 is downloaded if it is not there yet, then pithagoras-voice is stopped and made again on it, with the same settings, mounts, networks and volumes.');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  expect(asked).toEqual([]);

  state.overview = { ...REACHED, containers: [voiceRow({ imageWarning: OUTDATED, update: { active: true, line: 'Downloading [=====>   ] 5MB/10MB' } })] };
  await voice.getByRole('button', { name: 'Update' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Update' }).click();
  await expect.poll(() => asked).toEqual(['POST /containers/pithagoras-voice/update']);
  // Under way: what Docker says of the download, and nothing else to press on the row until it ends.
  await expect(voice).toContainText('Updating: Downloading [=====>   ] 5MB/10MB');
  await expect(voice.getByRole('button', { name: 'Update' })).toHaveCount(0);
  for (const name of ['Stop', 'Logs', 'Remove']) await expect(voice.getByRole('button', { name })).toBeDisabled();
});

test('what an update came to is said under the container: that it runs the wanted image now, or why it failed and that it is as it was', async ({ page }) => {
  const { dialog, state } = await open(page, { ...REACHED, containers: [voiceRow({ image: OUTDATED.wanted, update: { active: false, line: '', done: { from: OUTDATED.running, to: OUTDATED.wanted } } })] });
  const voice = dialog.getByRole('listitem').filter({ hasText: 'pithagoras-voice' });
  await expect(voice).toContainText(`Updated: pithagoras-voice runs ${OUTDATED.wanted} now, and ran ${OUTDATED.running}.`);
  await expect(dialog.getByText(/Outdated image/)).toHaveCount(0);

  state.overview = { ...REACHED, containers: [voiceRow({ imageWarning: OUTDATED, update: { active: false, line: '', error: 'pull access denied for nvidia/cuda' } })] };
  await expect(voice).toContainText('The update failed, and pithagoras-voice is as it was: pull access denied for nvidia/cuda', { timeout: 10_000 });
  // And it can be tried again.
  await expect(voice.getByRole('button', { name: 'Update' })).toBeEnabled();
});

test('an update that left the old container behind says so, and one that could not name it back says so on the old container', async ({ page }) => {
  const { dialog, state } = await open(page, { ...REACHED, containers: [voiceRow({ image: OUTDATED.wanted, update: { active: false, line: '', done: { from: OUTDATED.running, to: OUTDATED.wanted }, leftover: 'pithagoras-voice-before-update' } })] });
  const voice = dialog.getByRole('listitem').filter({ hasText: 'pithagoras-voice' });
  await expect(voice).toContainText('Updated: pithagoras-voice runs');
  await expect(voice).toContainText('pithagoras-voice-before-update, which pithagoras-voice replaced, could not be removed and is left stopped: remove it.');
  await expect(voice).not.toContainText('is as it was');

  state.overview = { ...REACHED, containers: [voiceRow({ name: 'pithagoras-voice-before-update', update: { active: false, line: '', stranded: true, error: 'pithagoras-voice did not stay up. It is still named pithagoras-voice-before-update.' } })] };
  await expect(dialog.getByRole('listitem').filter({ hasText: 'pithagoras-voice-before-update' })).toContainText('The update failed, and pithagoras-voice-before-update has not got its name back: pithagoras-voice did not stay up.', { timeout: 10_000 });
  await expect(dialog.getByText('is as it was')).toHaveCount(0);
});

test('a container that is in use cannot be updated from here, and says why; it can once it is not in use', async ({ page }) => {
  const { dialog, state } = await outdated(page, { imageWarning: { ...OUTDATED, busy: 'its setup is running' } });
  const voice = dialog.getByRole('listitem').filter({ hasText: 'pithagoras-voice' });
  await expect(voice).toContainText('It is in use: its setup is running.');
  await expect(voice.getByRole('button', { name: 'Update' })).toBeDisabled();
  // No longer in use: the same warning, and the button works.
  state.overview = { ...REACHED, containers: [voiceRow({ imageWarning: OUTDATED })] };
  await expect(voice.getByRole('button', { name: 'Update' })).toBeEnabled({ timeout: 10_000 });
  await expect(voice).not.toContainText('It is in use');
});

test.describe('in a browser set to German', () => {
  test.use({ locale: 'de-DE' });

  test('the warning and its Update are in German', async ({ page }) => {
    await mockPortal(page, ({ path }) => {
      if (path === '/api/extensions') return { settingsPath: '/a/settings.json', extensions: [DOCKER] };
      if (path === `${BASE}/overview`) return { ...REACHED, containers: [voiceRow({ imageWarning: OUTDATED })] };
      return undefined;
    }, { settings: true });
    await page.goto('/settings/x/pithagoras-docker');
    const voice = page.getByRole('dialog', { name: 'Einstellungen' }).getByRole('listitem').filter({ hasText: 'pithagoras-voice' });
    await expect(voice).toContainText('Veraltetes Image: Er läuft mit nvidia/cuda:12.4.1-devel-ubuntu22.04, und pithagoras-voice will jetzt nvidia/cuda:12.9.1-devel-ubuntu22.04.');
    await voice.getByRole('button', { name: 'Aktualisieren' }).click();
    await expect(page.getByRole('alertdialog')).toContainText('pithagoras-voice aktualisieren?');
  });
});
