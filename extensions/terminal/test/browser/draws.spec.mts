import { type Page } from '@playwright/test';
import { test, expect } from '../../../../tests/browser/portal-mock';

test.use({ installed: ['extensions/terminal'] });

/**
 * How often the terminal's parts are drawn, counted as the chat page counts a component of an extension's
 * (core/web/tests/chat.html, `&count=1`): its bundle is minified, so a part is known by a class it draws.
 */
const drawn = (page: Page) => page.evaluate(() => ({ ...(window as any).drawn }) as Record<string, number>);

test('a job that is timed is not drawn again for each second', async ({ page }) => {
  await page.addInitScript(() => ((window as any).drawsWith = { JobOutput: { className: 'terminal-job-output' } }));
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.clock.install();
  await page.goto('/tests/chat.html?phase=agents&count=1');
  // The running tray's job, shown on the terminal's Background tab.
  await page.getByLabel('Running beside the conversation').getByRole('button', { name: /npm run dev/ }).click();
  await expect(page.locator('.terminal-job-output')).toContainText('VITE');
  await expect.poll(async () => (await drawn(page)).JobOutput ?? 0).toBeGreaterThan(0);
  // Settled: the clock stands still until it is run.
  await page.clock.runFor(200);
  const before = await drawn(page);
  await page.clock.runFor(3500);
  expect((await drawn(page)).JobOutput).toBe(before.JobOutput);
});
