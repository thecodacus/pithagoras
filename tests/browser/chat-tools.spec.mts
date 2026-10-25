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
