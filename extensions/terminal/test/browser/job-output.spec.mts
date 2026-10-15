import { test, expect } from '../../../../tests/browser/portal-mock';

test.use({ installed: ['extensions/terminal'] });

/**
 * A background job's output is followed once a second. One read that failed,
 * with the portal restarting, ended it for good and replaced what had been read
 * with the error, while the job went on writing.
 */
test('a read that fails keeps what was read, says so, and goes on when the portal answers again', async ({ page }) => {
  let fail = false;
  let size = 0;
  await page.route('**/api/sessions/jobs/background/j1/output*', (route) => {
    if (fail) return route.fulfill({ status: 502, json: { error: 'The portal is restarting' } });
    const text = size === 0 ? 'ready\n' : 'then more\n';
    size += text.length;
    return route.fulfill({ json: { text, from: 0, size } });
  });
  await page.goto('/tests/extension.html?page=terminal/jobs');
  const pane = page.locator('.terminal-job-output');
  await expect(pane).toContainText('ready');
  fail = true;
  await expect(page.getByRole('alert')).toContainText('The output could not be read — trying again: The portal is restarting');
  // What was read stays.
  await expect(pane).toContainText('ready');
  fail = false;
  await expect(pane).toContainText('then more', { timeout: 15_000 });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a job whose output is not a file the portal can follow is not asked again', async ({ page }) => {
  let reads = 0;
  await page.route('**/api/sessions/jobs/background/j1/output*', (route) => {
    reads++;
    return route.fulfill({ status: 404, json: { error: "This job's output is not in a file the portal can follow" } });
  });
  await page.goto('/tests/extension.html?page=terminal/jobs');
  await expect(page.getByText("This job's output is not in a file the portal can follow")).toBeVisible();
  await page.waitForTimeout(2500);
  // The page is in development mode, where an effect runs twice: two asks at the start, none after.
  expect(reads).toBeLessThanOrEqual(2);
});
