import { readFileSync } from 'node:fs';
import { test, expect, mockPortal } from './portal-mock';

/**
 * The Warm theme, as its package.json names it: chosen in Settings, it paints the page in its colours, in dark and in light.
 */
const warm = JSON.parse(readFileSync(new URL('../../extensions/theme-warm/package.json', import.meta.url), 'utf8'));
const triplet = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(' ');

test('Warm is chosen in Settings and the page is painted with its tokens, in dark and in light', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.addInitScript(() => localStorage.setItem('pithagoras.theme', 'dark'));
  await mockPortal(page, ({ path }) => {
    if (path === '/api/extension-ui') return { extensions: [{ name: warm.name, version: warm.version, themes: warm.pithagoras.themes }] };
  });
  const [{ dark, light }] = warm.pithagoras.themes;
  const colour = (token: string) => page.evaluate((token) => getComputedStyle(document.documentElement).getPropertyValue(token).trim(), token);
  await page.goto('/settings/browser');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const colours = dialog.getByRole('combobox', { name: 'Colours' });
  await colours.click();
  await expect(page.getByRole('option')).toHaveText([/^The portal's own/, /^Warm.*pithagoras-theme-warm/]);
  await page.getByRole('option', { name: /Warm/ }).click();
  await expect(colours).toHaveText(/Warm/);
  await expect.poll(() => colour('--accent')).toBe(triplet(dark.accent));
  for (const token of ['canvas', 'surface', 'raised', 'fg', 'fg-faint']) expect(await colour(`--${token}`), `${token} in dark`).toBe(triplet(dark[token]));
  // The page itself is in the theme's canvas and text.
  const [back, text] = [dark.canvas, dark.fg].map((hex) => `rgb(${triplet(hex).replaceAll(' ', ', ')})`);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(back);
  expect(await page.evaluate(() => getComputedStyle(document.body).color)).toBe(text);

  await dialog.getByRole('radio', { name: 'Light' }).click();
  await expect.poll(() => colour('--accent')).toBe(triplet(light.accent));
  for (const token of ['canvas', 'surface', 'raised', 'fg', 'fg-faint']) expect(await colour(`--${token}`), `${token} in light`).toBe(triplet(light[token]));
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(`rgb(${triplet(light.canvas).replaceAll(' ', ', ')})`);
});
