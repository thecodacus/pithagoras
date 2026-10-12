import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/** Settings → Agent → Media: one tab for the image model and the video model, over a portal where neither is set up. */
async function portal(page: Page) {
  await mockPortal(page, async ({ path: p, method }) => {
    if (method !== 'GET') return undefined;
    if (p === '/api/features/flags') return { subagent: { enabled: false }, understory: { enabled: false }, images: { enabled: false }, videos: { enabled: false } };
    if (p === '/api/features/images') return { images: { enabled: false, baseUrl: '', model: '', size: '', keySet: false, editEnabled: false, editBaseUrl: '', editModel: '', editMultiple: false, editMaxSize: '', editKeySet: false, timeoutSeconds: 300, sdExtras: false, ready: false, editReady: false } };
    if (p === '/api/features/videos') return { videos: { enabled: false, backend: 'sdcpp', backends: [{ id: 'sdcpp', label: 'stable-diffusion.cpp' }], baseUrl: '', model: '', size: '', frames: null, fps: null, keySet: false, timeoutSeconds: 1800, storageLimitMb: 0, ready: false } };
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
