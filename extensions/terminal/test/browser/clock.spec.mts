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
  // Time stands still from here, and the quiet is forty seconds long.
  await page.clock.pauseAt(new Date('2026-01-01T10:00:05Z'));
  await page.clock.runFor(40_000);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('.terminal-job-meta')).toHaveText('3s');
  // And it counts on from there.
  await page.clock.runFor(2000);
  await expect(page.locator('.terminal-job-meta')).toHaveText('5s');
});
