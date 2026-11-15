import { test, expect } from '../../../../tests/browser/portal-mock';

test.use({ installed: ['extensions/terminal'] });

/** The person's text size reaches the shell's screen, which is a canvas and takes its font size from code. */

test("the shell's screen follows the person's text size", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.goto('/tests/chat.html?phase=tools');
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await page.getByRole('tab', { name: 'Your shell' }).click();
  // xterm measures its characters in a hidden element that has the font size it draws with.
  const size = () => page.locator('.xterm-char-measure-element').first().evaluate((el) => getComputedStyle(el).fontSize);
  await expect.poll(size).toBe('12px');
  // What the portal does for a text size of 150 % (theme.tsx): the variable on the root.
  await page.evaluate(() => document.documentElement.style.setProperty('--text-base', 'calc(1rem * 1.5)'));
  await expect.poll(size).toBe('18px');
  await page.evaluate(() => document.documentElement.style.removeProperty('--text-base'));
  await expect.poll(size).toBe('12px');
});
