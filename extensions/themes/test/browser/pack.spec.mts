import { readFileSync } from 'node:fs';
import { test, expect, mockPortal } from '../../../../tests/browser/portal-mock';

test.use({ installed: ['extensions/themes'] });

/**
 * The theme pack a fresh portal installs (extensions/themes): its seven themes are offered in Settings beside the
 * portal's own colours, and the one chosen paints the page, in dark and in light.
 */
const pack = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const triplet = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(' ');

test('a fresh portal offers Forest, Ocean, Rose, Amber, Mono, Dusk and Warm, and the one chosen paints the page', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.addInitScript(() => localStorage.setItem('pithagoras.theme', 'dark'));
  // What is installed is the pack, as a fresh portal has it: the base answer, not this test's.
  await mockPortal(page);
  const colour = (token: string) => page.evaluate((token) => getComputedStyle(document.documentElement).getPropertyValue(token).trim(), token);
  await page.goto('/settings/browser');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const colours = dialog.getByRole('combobox', { name: 'Colours' });
  await colours.click();
  for (const name of ['Forest', 'Ocean', 'Rose', 'Amber', 'Mono', 'Dusk', 'Warm']) await expect(page.getByRole('option', { name: new RegExp(`^${name}`) })).toBeVisible();

  const ocean = pack.pithagoras.themes.find((theme: { id: string }) => theme.id === 'ocean');
  await page.getByRole('option', { name: /^Ocean/ }).click();
  await expect(colours).toHaveText(/Ocean/);
  await expect.poll(() => colour('--accent')).toBe(triplet(ocean.dark.accent));
  expect(await colour('--canvas')).toBe(triplet(ocean.dark.canvas));
  await dialog.getByRole('radio', { name: 'Light' }).click();
  await expect.poll(() => colour('--accent')).toBe(triplet(ocean.light.accent));
  expect(await colour('--canvas')).toBe(triplet(ocean.light.canvas));
});
