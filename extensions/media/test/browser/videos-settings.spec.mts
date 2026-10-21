import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from '../../../../tests/browser/portal-mock';

test.use({ installed: ['extensions/media'] });

/** The video model of Media's page in Settings (src/web/MediaAddons.tsx, VideosAddon) over a portal whose video settings are made up. */
async function portal(page: Page) {
  const sent: { path: string; body: any }[] = [];
  const videos = {
    enabled: false, backend: 'sdcpp', backends: [{ id: 'sdcpp', label: 'stable-diffusion.cpp' }], baseUrl: '', model: '', size: '', frames: null as number | null, fps: null as number | null,
    keySet: false, timeoutSeconds: 1800, storageLimitMb: 0, ready: false,
  };
  await mockPortal(page, async ({ path: p, method, json }) => {
    // Settings lists the extension as the portal has it installed.
    if (p === '/api/extensions') return { settingsPath: '/a/settings.json', extensions: [{ spec: 'extensions/media', name: 'pithagoras-media', version: '0.1.0', settings: [] }] };
    if (p === '/api/x/pithagoras-media/state') return { images: { enabled: false }, videos: { enabled: videos.ready } };
    // The image model is on the same page: not set up here.
    if (p === '/api/x/pithagoras-media/settings/images' && method === 'GET') return { images: { enabled: false, baseUrl: '', model: '', size: '', keySet: false, editEnabled: false, editBaseUrl: '', editModel: '', editMultiple: false, editMaxSize: '', editKeySet: false, timeoutSeconds: 300, sdExtras: false, ready: false, editReady: false } };
    if (p === '/api/x/pithagoras-media/settings/videos' && method === 'GET') return { videos };
    if (p === '/api/x/pithagoras-media/settings/videos' && method === 'PUT') {
      const patch = json();
      sent.push({ path: p, body: patch });
      const changed = patch.enabled !== undefined && patch.enabled !== videos.enabled;
      const { apiKey, ...rest } = patch;
      Object.assign(videos, rest);
      // null takes a saved value away: the default again.
      if (patch.timeoutSeconds === null) videos.timeoutSeconds = 1800;
      if (patch.storageLimitMb === null) videos.storageLimitMb = 0;
      if (apiKey !== undefined) videos.keySet = apiKey !== '';
      videos.ready = videos.enabled && videos.baseUrl !== '';
      return { videos, changed, reloaded: 1, waiting: 1 };
    }
  }, { settings: true });
  return { sent, videos };
}

const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings' });
/** The video model's half of Media's page: the image model's has fields of the same names. */
const videoPanel = (page: Page) => settings(page).getByRole('region', { name: 'Video model' });
const save = (page: Page) => videoPanel(page).getByRole('button', { name: 'Save', exact: true });

test('video generation needs an endpoint before it can be switched on, and the key is sent once and never shown again', async ({ page }) => {
  const { sent } = await portal(page);
  await page.goto('/settings/x/pithagoras-media');
  const panel = videoPanel(page);
  const tool = panel.getByRole('switch', { name: 'Video generation', exact: true });
  await expect(tool).toHaveAttribute('aria-checked', 'false');
  await expect(tool).toBeDisabled();
  await expect(panel.getByText('Save the address of a video endpoint first.')).toBeVisible();
  await expect(panel.getByText('Off: no videos are made.')).toBeVisible();
  // The one backend there is is named.
  await expect(panel.getByText('stable-diffusion.cpp', { exact: true }).first()).toBeVisible();

  await panel.getByLabel('API address').fill('https://video.example.com');
  await panel.getByLabel('API key').fill('sk-test-123');
  await panel.getByLabel('Model', { exact: true }).fill('video-model');
  await expect(tool).toBeDisabled();
  await expect(panel.getByText('Save or discard the changes first.')).toBeVisible();
  await save(page).click();
  await expect(save(page)).toBeHidden();
  expect(sent).toEqual([{ path: '/api/x/pithagoras-media/settings/videos', body: { baseUrl: 'https://video.example.com', model: 'video-model', size: '', apiKey: 'sk-test-123' } }]);
  // The page is told only that a key is set: the field is empty and says so.
  await expect(panel.getByLabel('API key')).toHaveValue('');
  await expect(panel.getByLabel('API key')).toHaveAttribute('placeholder', 'saved — type to replace');

  await expect(tool).toBeEnabled();
  await tool.click();
  await expect(tool).toHaveAttribute('aria-checked', 'true');
  await expect(panel.getByText('On: videos are made on the Media page and by the agent.')).toBeVisible();
  await expect(panel.getByText(/one busy chat has it from its next step/)).toBeVisible();
  expect(sent.at(-1)!.body).toEqual({ enabled: true });

  // Changing only the model keeps the key: it is not sent again.
  await panel.getByLabel('Model', { exact: true }).fill('another-model');
  await save(page).click();
  await expect(save(page)).toBeHidden();
  expect(sent.at(-1)!.body).toEqual({ baseUrl: 'https://video.example.com', model: 'another-model', size: '' });

  await panel.getByRole('button', { name: 'Remove the saved key' }).click();
  await expect(panel.getByLabel('API key')).toHaveAttribute('placeholder', 'none needed for a local server');
  expect(sent.at(-1)!.body).toEqual({ apiKey: '' });
});

test('the Media page is in the sidebar while video generation is on, and the switch moves it at once', async ({ page }) => {
  await portal(page);
  await page.goto('/settings/x/pithagoras-media');
  const entry = page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Media' });
  await expect(entry).toHaveCount(0);
  const panel = videoPanel(page);
  await panel.getByLabel('API address').fill('https://video.example.com');
  await save(page).click();
  await expect(save(page)).toBeHidden();
  // An address is not enough: the tool is still off.
  await expect(entry).toHaveCount(0);
  await panel.getByRole('switch', { name: 'Video generation', exact: true }).click();
  await expect(entry).toHaveCount(1);
  await panel.getByRole('switch', { name: 'Video generation', exact: true }).click();
  await expect(entry).toHaveCount(0);
});

test('the time limit of a clip is half an hour, whole seconds from 30 to 14400, sent only when changed', async ({ page }) => {
  const { sent } = await portal(page);
  await page.goto('/settings/x/pithagoras-media');
  const panel = videoPanel(page);
  const field = panel.getByLabel('Time limit (seconds)');
  await expect(field).toHaveValue('1800');

  // Out of bounds: nothing to save.
  await field.fill('10');
  await expect(save(page)).toBeDisabled();
  await field.fill('15000');
  await expect(save(page)).toBeDisabled();
  await field.fill('1800s');
  await expect(save(page)).toBeDisabled();
  await field.fill('3600');
  await expect(save(page)).toBeEnabled();
  await save(page).click();
  await expect(save(page)).toBeHidden();
  expect(sent.at(-1)!.body).toEqual({ baseUrl: '', model: '', size: '', timeoutSeconds: 3600 });
  await expect(field).toHaveValue('3600');

  // Saving something else does not state the limit again.
  await panel.getByLabel('Model', { exact: true }).fill('video-model');
  await save(page).click();
  await expect(save(page)).toBeHidden();
  expect(sent.at(-1)!.body).toEqual({ baseUrl: '', model: 'video-model', size: '' });

  // Empty is the default, which is what the placeholder says: a saved limit is taken away, not stored as 1800.
  await field.fill('');
  await save(page).click();
  await expect(save(page)).toBeHidden();
  expect(sent.at(-1)!.body).toEqual({ baseUrl: '', model: 'video-model', size: '', timeoutSeconds: null });
  await expect(field).toHaveValue('1800');
});

test('the size, the frames, the frame rate and the disk limit are checked as the portal checks them and sent when they change', async ({ page }) => {
  const { sent } = await portal(page);
  await page.goto('/settings/x/pithagoras-media');
  const panel = videoPanel(page);
  const frames = panel.getByLabel('Frames', { exact: true });
  const fps = panel.getByLabel('Frame rate');
  const disk = panel.getByLabel('Disk limit (MB)');
  await expect(frames).toHaveValue('');
  await expect(frames).toHaveAttribute('placeholder', "the server's own");
  await expect(disk).toHaveAttribute('placeholder', 'no limit');

  for (const [field, bad] of [[frames, '0'], [frames, '1001'], [frames, '3.5'], [fps, '121'], [fps, 'fast'], [disk, '0'], [disk, '-5']] as const) {
    await field.fill(bad);
    await expect(save(page)).toBeDisabled();
    await field.fill('');
  }
  await panel.getByLabel('Video size').fill('832x480');
  await frames.fill('33');
  await fps.fill('16');
  await disk.fill('20000');
  await expect(save(page)).toBeEnabled();
  await save(page).click();
  await expect(save(page)).toBeHidden();
  expect(sent.at(-1)!.body).toEqual({ baseUrl: '', model: '', size: '832x480', frames: 33, fps: 16, storageLimitMb: 20000 });
  await expect(frames).toHaveValue('33');
  await expect(disk).toHaveValue('20000');

  // Saved ones are not stated again, and an emptied one is taken away.
  await panel.getByLabel('Model', { exact: true }).fill('m');
  await frames.fill('');
  await save(page).click();
  await expect(save(page)).toBeHidden();
  expect(sent.at(-1)!.body).toEqual({ baseUrl: '', model: 'm', size: '832x480', frames: null });
});

test('Escape over the video endpoint that was typed in asks first, and over one that was saved does not', async ({ page }) => {
  const { sent } = await portal(page);
  const ask = page.getByRole('alertdialog', { name: 'Discard your changes?' });
  await page.goto('/settings/x/pithagoras-media');
  await expect(videoPanel(page).getByLabel('API address')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settings(page)).toBeHidden();

  await page.goto('/settings/x/pithagoras-media');
  const address = videoPanel(page).getByLabel('API address');
  await address.fill('https://video.example.com');
  await page.keyboard.press('Escape');
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(address).toHaveValue('https://video.example.com');
  await save(page).click();
  await expect(save(page)).toBeHidden();
  expect(sent).toHaveLength(1);
  await page.keyboard.press('Escape');
  await expect(settings(page)).toBeHidden();
});

test('a save the portal refuses is said at the top of the page, which is brought into view from the section that was saved', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 500 });
  await portal(page);
  await page.route('**/api/x/pithagoras-media/settings/videos', (route) =>
    route.request().method() === 'PUT' ? route.fulfill({ status: 400, json: { error: 'The address must be an http or https URL' } }) : route.fallback(),
  );
  await page.goto('/settings/x/pithagoras-media');
  await videoPanel(page).getByLabel('API address').fill('localhost:1234');
  await save(page).click();
  const banner = settings(page).getByRole('alert');
  await expect(banner).toHaveText('The address must be an http or https URL');
  await expect(banner).toBeInViewport();
});

test('the search of Settings finds the video endpoint and lights it up', async ({ page }) => {
  await portal(page);
  await page.goto('/settings/general');
  const dialog = settings(page);
  await expect(dialog.getByLabel('Default model')).toBeVisible();
  await dialog.getByLabel('Search settings').fill('frame rate');
  await expect(dialog.getByRole('option').first()).toContainText('Video generation');
  await dialog.getByRole('option').first().click();
  await expect(dialog.getByRole('switch', { name: 'Video generation', exact: true })).toBeVisible();
  await expect(dialog.locator('[data-setting="Video model"]')).toHaveClass(/setting-flash/);
});

test('a note says that only a stable-diffusion.cpp server works and what the address is through llama-swap, under the address field while the section is open, and under its heading while it is closed', async ({ page }) => {
  await portal(page);
  await page.goto('/settings/x/pithagoras-media');
  const panel = videoPanel(page);
  const note = panel.getByRole('note');
  const heading = panel.getByRole('heading', { level: 3 });
  const box = async (locator: ReturnType<Page['locator']>) => (await locator.boundingBox())!;

  // Open (a model that is not set up starts open): right under the address and above the next field.
  await expect(note).toHaveCount(1);
  await expect(note).toBeVisible();
  await expect(note).toContainText('Only a stable-diffusion.cpp server works, through its native API (/sdcpp/v1) with a video model started on it.');
  await expect(note).toContainText('An OpenAI-style /v1 endpoint or another video server does not.');
  await expect(note).toContainText('Through llama-swap the address is http://host:port/upstream/<model>.');
  const address = await box(panel.getByLabel('API address'));
  const key = await box(panel.getByLabel('API key'));
  const open = await box(note);
  expect(open.y).toBeGreaterThanOrEqual(address.y + address.height);
  expect(open.y + open.height).toBeLessThanOrEqual(key.y);

  // Closed: still there, once, right under the heading and its line, and under the switch.
  await panel.getByRole('button', { name: /^Video model/ }).click();
  await expect(panel.getByLabel('API address')).toBeHidden();
  await expect(note).toHaveCount(1);
  await expect(note).toBeVisible();
  const row = await box(heading);
  const closed = await box(note);
  expect(closed.y).toBeGreaterThanOrEqual(row.y + row.height);
  expect(closed.y - (row.y + row.height)).toBeLessThanOrEqual(24);
  expect((await box(panel.getByRole('switch', { name: 'Video generation', exact: true }))).y).toBeLessThan(row.y);

  // And under the address again when it is opened again.
  await panel.getByRole('button', { name: /^Video model/ }).click();
  await expect(note).toHaveCount(1);
  await expect(panel.getByLabel('API address')).toBeVisible();
  const again = await box(note);
  expect(again.y).toBeGreaterThanOrEqual((await box(panel.getByLabel('API address'))).y);
});

test.describe('in a browser set to German', () => {
  test.use({ locale: 'de-DE' });

  test('the note on what the video address has to be is in German', async ({ page }) => {
    await portal(page);
    await page.goto('/settings/x/pithagoras-media');
    await expect(page.getByRole('note')).toContainText('Nur ein stable-diffusion.cpp-Server funktioniert');
    await expect(page.getByRole('note')).toContainText('Über llama-swap lautet die Adresse http://host:port/upstream/<model>.');
  });
});
