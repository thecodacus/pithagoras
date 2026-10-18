import { test, expect } from '@playwright/test';

/**
 * The portal's Menu (also what extensions are given as `ui.Menu`), on its own page: a button that opens a list of choices at
 * the body, with the keys of a menu, and placed so that it stays in the window.
 */
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto('/tests/menu.html');
});

test('a menu opens on a click, starts at the page showing, and the arrows, Home and End move through it', async ({ page }) => {
  const button = page.getByRole('button', { name: 'Pages' });
  await expect(button).toHaveAttribute('aria-current', 'page');
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await button.click();
  const menu = page.getByRole('menu', { name: 'Pages' });
  await expect(menu).toBeVisible();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  const item = (name: string) => menu.getByRole('menuitem', { name });
  await expect(item('Beta')).toBeFocused();
  await expect(item('Beta')).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('ArrowDown');
  await expect(item('Gamma')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(item('Alpha')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(item('Gamma')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(item('Alpha')).toBeFocused();
  await page.keyboard.press('End');
  await expect(item('Gamma')).toBeFocused();
  // Beside the button, level with it.
  // The list pops in, so its box is taken once it has settled.
  await expect(async () => {
    const [b, m] = await Promise.all([button.boundingBox(), menu.boundingBox()]);
    expect(m!.x).toBeGreaterThanOrEqual(b!.x + b!.width);
    expect(Math.abs(m!.y - b!.y)).toBeLessThan(2);
  }).toPass();
});

test('Enter picks, the menu closes and the button has the focus again; Escape and a press elsewhere close it too', async ({ page }) => {
  const button = page.getByRole('button', { name: 'Pages' });
  await button.click();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('log')).toHaveText('gamma');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(button).toBeFocused();

  await button.press('ArrowDown');
  await expect(page.getByRole('menu', { name: 'Pages' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(button).toBeFocused();

  await button.click();
  await page.getByRole('button', { name: 'Elsewhere' }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  // Tab leaves for what follows the button, not for the end of the page the list is drawn at.
  await button.click();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByTestId('log')).toHaveText('gamma');
});

test('a choice can be a link that saves a file, and a list that would leave the window stays inside it', async ({ page }) => {
  const button = page.getByRole('button', { name: 'Download' });
  await button.click();
  const menu = page.getByRole('menu', { name: 'Download' });
  const link = menu.getByRole('menuitem', { name: 'Markdown (.md)' });
  await expect(link).toHaveAttribute('href', '/tests/menu.html?file=md');
  await expect(link).toHaveAttribute('download', 'note.md');
  // At the window's right edge the list hangs from the button's right edge, below it.
  await expect(async () => {
    const [b, m] = await Promise.all([button.boundingBox(), menu.boundingBox()]);
    expect(m!.x + m!.width).toBeLessThanOrEqual(900);
    expect(Math.abs(m!.x + m!.width - (b!.x + b!.width))).toBeLessThan(2);
    expect(m!.y).toBeGreaterThanOrEqual(b!.y + b!.height);
  }).toPass();
  const download = page.waitForEvent('download');
  await link.click();
  expect((await download).suggestedFilename()).toBe('note.md');
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('a menu at the bottom of the window opens above its button, and scrolls where there is no room', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 300 });
  const button = page.getByRole('button', { name: 'Low' });
  await button.click();
  const menu = page.getByRole('menu', { name: 'Low' });
  await expect(menu).toHaveClass(/is-above/);
  await expect(async () => {
    const [b, m] = await Promise.all([button.boundingBox(), menu.boundingBox()]);
    expect(m!.y + m!.height).toBeLessThanOrEqual(b!.y);
    expect(m!.y).toBeGreaterThanOrEqual(0);
  }).toPass();
});
