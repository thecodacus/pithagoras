import { test, expect } from '../../../../tests/browser/portal-mock';

test.use({ installed: ['extensions/terminal'] });

/**
 * A job's time on the Background tab, for a job that has only just started: the page may have sat for a long time
 * without it, and its clock must be read again then, not a second later when it next ticks.
 */
test('a job that starts after a long quiet is timed from the moment it starts, not from the last tick', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T10:00:00Z') });
  await page.goto('/tests/extension.html?page=terminal/clock');
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
  // The terminal is loaded and drawn (its job is listed, not running) before the clock is moved. The page loads an extension within
  // fifteen seconds of the clock's, and a clock run forty seconds ahead while the module is still being fetched has given it up.
  await expect(page.locator('.terminal-job-meta')).toBeVisible({ timeout: 15_000 });
  // Time stands still from here, and the quiet is forty seconds long.
  // The clock runs on from its first time until it is paused, so "five seconds on" is taken from where it is, not from where it began:
  // a loaded machine takes longer than that to get here, and a time in the past cannot be paused at.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 5000));
  await page.clock.runFor(40_000);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('.terminal-job-meta')).toHaveText('3s');
  // And it counts on from there.
  await page.clock.runFor(2000);
  await expect(page.locator('.terminal-job-meta')).toHaveText('5s');
});
