import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/** Settings → Agent → Media: one tab for the image model and the video model, over a portal where neither is set up unless the test says. */
async function portal(page: Page, { imageAddress = '', videoAddress = '', editAddress = '' } = {}) {
  const images = {
    enabled: !!imageAddress, baseUrl: imageAddress, model: imageAddress ? 'image-model' : '', size: '', keySet: false, editEnabled: false, editBaseUrl: editAddress, editModel: '', editMultiple: false, editMaxSize: '',
    editKeySet: false, timeoutSeconds: 300, sdExtras: false, ready: !!imageAddress, editReady: false,
  };
  const videos = {
    enabled: !!videoAddress, backend: 'sdcpp', backends: [{ id: 'sdcpp', label: 'stable-diffusion.cpp' }], baseUrl: videoAddress, model: videoAddress ? 'video-model' : '', size: '', frames: null, fps: null, keySet: false,
    timeoutSeconds: 1800, storageLimitMb: 0, ready: !!videoAddress,
  };
  await mockPortal(page, async ({ path: p, method }) => {
    if (method !== 'GET') return undefined;
    if (p === '/api/features/flags') return { subagent: { enabled: false }, understory: { enabled: false }, images: { enabled: images.ready }, videos: { enabled: videos.ready } };
    if (p === '/api/features/images') return { images };
    if (p === '/api/features/videos') return { videos };
  }, { settings: true });
}

const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings' });

test('Media is one tab under Agent, with the image model and the video model as two sections', async ({ page }) => {
  await portal(page);
  await page.goto('/settings/general');
  const dialog = settings(page);
  await dialog.getByRole('button', { name: /^Media/ }).click();
  await expect(dialog.getByRole('heading', { name: 'Image model' })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Video model' })).toBeVisible();
  // Each section has its own endpoint, in a region of its own, and the tab has no Images or Videos beside it.
  await expect(dialog.getByRole('region', { name: 'Image model' }).getByLabel('API address')).toBeVisible();
  await expect(dialog.getByRole('region', { name: 'Video model' }).getByLabel('API address')).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Images/ })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /^Videos/ })).toHaveCount(0);
});

test('the settings routes of the old Images and Videos tabs open the Media tab', async ({ page }) => {
  await portal(page);
  for (const old of ['images', 'videos']) {
    await page.goto(`/settings/${old}`);
    await expect(settings(page).getByRole('heading', { name: 'Image model' })).toBeVisible();
    await expect(settings(page).getByRole('heading', { name: 'Video model' })).toBeVisible();
    await expect(settings(page).getByRole('button', { name: /^Media/ })).toHaveAttribute('aria-current', 'page');
  }
});

test('the search of Settings finds the image model in its section of the Media tab', async ({ page }) => {
  await portal(page);
  await page.goto('/settings/general');
  const dialog = settings(page);
  await expect(dialog.getByLabel('Default model')).toBeVisible();
  await dialog.getByLabel('Search settings').fill('bildgenerierung');
  await dialog.getByRole('option').first().click();
  await expect(dialog.getByRole('switch', { name: 'Image generation', exact: true })).toBeVisible();
  await expect(dialog.locator('[data-setting="Image model"]')).toHaveClass(/setting-flash/);
});

test('the Media tab fits a phone, with both sections in it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await portal(page);
  await page.goto('/settings/media');
  await expect(settings(page).getByRole('switch', { name: 'Video generation', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

const section = (page: Page, name: 'Image model' | 'Video model') => settings(page).getByRole('region', { name });
/** The button that opens and closes a section: its heading. */
const toggle = (page: Page, name: 'Image model' | 'Video model') => section(page, name).getByRole('button', { name: new RegExp(`^${name}`) });

test('a model that is not set up is open, with its fields, and a click on its heading closes it to a line that says so, the switch staying where it was', async ({ page }) => {
  await portal(page);
  await page.goto('/settings/media');
  for (const name of ['Image model', 'Video model'] as const) {
    await expect(toggle(page, name)).toHaveAttribute('aria-expanded', 'true');
    await expect(section(page, name).getByLabel('API address')).toBeVisible();
  }
  const image = section(page, 'Image model');
  await toggle(page, 'Image model').click();
  await expect(toggle(page, 'Image model')).toHaveAttribute('aria-expanded', 'false');
  await expect(image.getByLabel('API address')).toBeHidden();
  await expect(toggle(page, 'Image model')).toContainText('Not set up');
  // What is most used stays: both switches, with what they say, and the video model has not moved.
  await expect(image.getByRole('switch', { name: 'Image generation', exact: true })).toBeVisible();
  await expect(image.getByRole('switch', { name: 'Image editing', exact: true })).toBeVisible();
  await expect(image.getByText('Save the address of an image endpoint first.').first()).toBeVisible();
  await expect(toggle(page, 'Video model')).toHaveAttribute('aria-expanded', 'true');
  await expect(section(page, 'Video model').getByLabel('API address')).toBeVisible();

  await toggle(page, 'Image model').click();
  await expect(toggle(page, 'Image model')).toHaveAttribute('aria-expanded', 'true');
  await expect(image.getByLabel('API address')).toBeVisible();
  await expect(toggle(page, 'Image model')).not.toContainText('Not set up');
});

test('a model that is set up is closed to its address and model, and the choice is kept for the next visit', async ({ page }) => {
  await portal(page, { imageAddress: 'https://images.example.com/v1', videoAddress: 'https://video.example.com' });
  await page.goto('/settings/media');
  await expect(toggle(page, 'Image model')).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle(page, 'Image model')).toContainText('images.example.com · image-model');
  await expect(toggle(page, 'Video model')).toContainText('video.example.com · video-model');
  await expect(section(page, 'Image model').getByLabel('API address')).toBeHidden();
  await expect(section(page, 'Image model').getByRole('switch', { name: 'Image generation', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(section(page, 'Video model').getByRole('switch', { name: 'Video generation', exact: true })).toHaveAttribute('aria-checked', 'true');

  await toggle(page, 'Video model').click();
  await expect(section(page, 'Video model').getByLabel('API address')).toHaveValue('https://video.example.com');
  await page.reload();
  await expect(toggle(page, 'Video model')).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle(page, 'Image model')).toHaveAttribute('aria-expanded', 'false');
});

test('the groups inside the image model open and close on their own, each with a line of what is in it', async ({ page }) => {
  await portal(page, { imageAddress: 'https://images.example.com/v1' });
  await page.goto('/settings/media');
  await toggle(page, 'Image model').click();
  const image = section(page, 'Image model');
  const editing = image.locator('details:has(> summary:has-text("Editing endpoint"))');
  const more = image.locator('details:has(> summary:has-text("More options"))');
  await expect(editing).toContainText('Uses the image endpoint');
  await expect(more).toContainText('None on');
  await expect(image.getByLabel('Editing address')).toBeHidden();
  await expect(image.getByRole('switch', { name: 'Several pictures per edit' })).toBeHidden();
  await editing.locator('summary').click();
  await expect(image.getByLabel('Editing address')).toBeVisible();
  await more.locator('summary').click();
  await expect(image.getByRole('switch', { name: 'Several pictures per edit' })).toBeVisible();
  await editing.locator('summary').click();
  await expect(image.getByLabel('Editing address')).toBeHidden();
});

test('a section with something typed in it and not saved stays open', async ({ page }) => {
  await portal(page, { imageAddress: 'https://images.example.com/v1' });
  await page.goto('/settings/media');
  await toggle(page, 'Image model').click();
  await section(page, 'Image model').getByLabel('API address').fill('https://other.example.com/v1');
  // The button says it cannot (aria-disabled), which a click that waits for it to be enabled would wait on.
  await expect(toggle(page, 'Image model')).toHaveAttribute('aria-disabled', 'true');
  await toggle(page, 'Image model').click({ force: true });
  await expect(toggle(page, 'Image model')).toHaveAttribute('aria-expanded', 'true');
  await expect(section(page, 'Image model').getByLabel('API address')).toHaveValue('https://other.example.com/v1');
  await section(page, 'Image model').getByRole('button', { name: 'Discard' }).click();
  await toggle(page, 'Image model').click();
  await expect(toggle(page, 'Image model')).toHaveAttribute('aria-expanded', 'false');
});

test('a search opens the section or the group it leads to, and lights it up', async ({ page }) => {
  await portal(page, { imageAddress: 'https://images.example.com/v1', videoAddress: 'https://video.example.com' });
  await page.goto('/settings/general');
  const dialog = settings(page);
  await expect(dialog.getByLabel('Default model')).toBeVisible();
  await dialog.getByLabel('Search settings').fill('frame rate');
  await dialog.getByRole('option').first().click();
  await expect(toggle(page, 'Video model')).toHaveAttribute('aria-expanded', 'true');
  await expect(section(page, 'Video model').getByLabel('Frame rate')).toBeVisible();
  await expect(dialog.locator('[data-setting="Video model"]')).toHaveClass(/setting-flash/);

  // A group inside a closed section: both open.
  await toggle(page, 'Image model').click();
  await toggle(page, 'Image model').click();
  await expect(toggle(page, 'Image model')).toHaveAttribute('aria-expanded', 'false');
  await dialog.getByLabel('Search settings').fill('maximum picture size');
  await dialog.getByRole('option').first().click();
  await expect(toggle(page, 'Image model')).toHaveAttribute('aria-expanded', 'true');
  await expect(section(page, 'Image model').getByLabel('Maximum picture size')).toBeVisible();
});
