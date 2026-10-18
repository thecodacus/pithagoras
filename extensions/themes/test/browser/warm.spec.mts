import { readFileSync } from 'node:fs';
import { test, expect, mockPortal } from '../../../../tests/browser/portal-mock';

test.use({ installed: ['extensions/themes'] });

/**
 * The Warm theme, as the themes package names it: chosen in Settings, it paints the page in its colours, in dark and in light.
 */
const pack = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const warm = { name: pack.name, themes: pack.pithagoras.themes.filter((theme: { id: string }) => theme.id === 'warm') };
const triplet = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(' ');

test('Warm is chosen in Settings and the page is painted with its tokens, in dark and in light', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.addInitScript(() => localStorage.setItem('pithagoras.theme', 'dark'));
  await mockPortal(page);
  const [{ dark, light }] = warm.themes;
  const colour = (token: string) => page.evaluate((token) => getComputedStyle(document.documentElement).getPropertyValue(token).trim(), token);
  await page.goto('/settings/browser');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const colours = dialog.getByRole('combobox', { name: 'Colours' });
  await colours.click();
  await expect(page.getByRole('option', { name: /^Warm/ })).toContainText('pithagoras-themes');
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

test('Warm chosen before it moved into this package is still chosen, now as one of its themes', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  const [{ dark }] = warm.themes;
  // What a browser kept when Warm was a package of its own: the old id, with the colours it was chosen with.
  await page.addInitScript((kept) => {
    localStorage.setItem('pithagoras.theme', 'dark');
    localStorage.setItem('pithagoras.palette', JSON.stringify({ id: 'pithagoras-theme-warm/warm', name: 'Warm', dark: kept }));
  }, Object.fromEntries(Object.entries(dark).map(([token, hex]) => [token, triplet(hex as string)])));
  await mockPortal(page);
  await page.goto('/settings/browser');
  const colours = page.getByRole('dialog', { name: 'Settings' }).getByRole('combobox', { name: 'Colours' });
  await expect(colours).toHaveText(/Warm/);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())).toBe(triplet(dark.accent));
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pithagoras.palette') ?? 'null')?.id)).toBe('pithagoras-themes/warm');
});
