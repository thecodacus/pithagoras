import { test, expect } from '../../../../tests/browser/portal-mock';

test.use({ installed: ['extensions/terminal'] });

/** What a screen reader is told by the terminal. */

test('the terminal is readable by a screen reader, and its input is named', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.goto('/tests/chat.html?phase=tools');
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await page.getByRole('tab', { name: 'Your shell' }).click();
  // xterm draws its screen in a canvas; in screen reader mode it adds the rows and the live region.
  await expect(page.locator('.xterm-accessibility')).toBeAttached();
  await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeAttached();
});
