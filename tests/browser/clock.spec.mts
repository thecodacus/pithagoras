import { test, expect } from './portal-mock';

/**
 * An elapsed time that counts, drawn for something that has only just started
 * running: the page it is on may have sat for a long time without it, and its
 * clock must be read again then, not a second later when it next ticks.
 */
test('what starts running after a long quiet is timed from the moment it starts, not from the last tick', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T10:00:00Z') });
  await page.goto('/tests/clock.html');
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
  // Time stands still from here, and the quiet is forty seconds long.
  await page.clock.pauseAt(new Date('2026-01-01T10:00:05Z'));
  await page.clock.runFor(40_000);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('.running-chip.is-extension .running-chip-time')).toHaveText('3s');
  await expect(page.locator('.running-chip.is-job .running-chip-time')).toHaveText('3s');
  // And it counts on from there.
  await page.clock.runFor(2000);
  await expect(page.locator('.running-chip.is-extension .running-chip-time')).toHaveText('5s');
});
