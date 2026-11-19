import { test, expect } from './portal-mock';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  // A chat that has not started, with Files beside it.
  await page.goto('/tests/chat.html?phase=files');
});

test('before the first message the tools are listed and can be switched for this chat alone', async ({ page }) => {
  await page.getByRole('button', { name: 'Which tools this conversation may use' }).click();
  const menu = page.locator('.composer-menu');
  await expect(menu.getByText('Not started yet')).toBeVisible();
  await expect(menu.getByText('the defaults stay as they are')).toBeVisible();
  await expect(menu.getByText('Send a message first')).toHaveCount(0);
  await menu.getByRole('button', { name: /pi-web-access/ }).click();
  await menu.getByRole('checkbox', { name: 'web_search' }).uncheck();
  await expect.poll(() => page.evaluate(() => (window as any).sentTools)).toEqual([['web_search']]);
  await expect(menu.getByRole('checkbox', { name: 'web_search' })).not.toBeChecked();
  await expect(menu.getByText('default on')).toBeVisible();
});

test('a chat that froze its lazy tools says when the marks would make others lazy now, and reads them again only when asked', async ({ page }) => {
  await page.goto('/tests/chat.html?phase=lazy-stale');
  await page.getByRole('button', { name: 'Which tools this conversation may use' }).click();
  const menu = page.locator('.composer-menu');
  await expect(menu.getByText('This chat keeps what it started with')).toBeVisible();
  // Nothing is read again on its own: only the button does it.
  expect(await page.evaluate(() => (window as any).readAgain)).toBe(0);
  await menu.getByRole('button', { name: 'Read the tools again' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).readAgain)).toBe(1);
  await expect(menu.getByText('This chat keeps what it started with')).toHaveCount(0);
  await expect(menu.getByRole('button', { name: 'Read the tools again' })).toHaveCount(0);
});

test('a chat whose lazy tools are as they would be now offers nothing to read again', async ({ page }) => {
  await page.goto('/tests/chat.html?phase=files');
  await page.getByRole('button', { name: 'Which tools this conversation may use' }).click();
  await expect(page.getByText('This chat keeps what it started with')).toHaveCount(0);
});
