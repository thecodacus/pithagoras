import { test, expect } from '@playwright/test';

// The same read by a bash command and by a lazy tool, which the model calls through the `tools` tool: the chat's row is the outer call.
for (const phase of ['flagged', 'flagged-lazy']) test(`a result flagged as a suspected prompt injection says why, and can be trusted or have its turn removed (${phase})`, async ({ page }) => {
  const trusted: string[] = [];
  await page.route('**/api/sessions/preview/flagged/*/trust', (route) => { trusted.push(route.request().url()); return route.fulfill({ json: { ok: true } }); });
  await page.goto(`/tests/chat.html?phase=${phase}`);
  const notice = page.getByRole('alert').filter({ hasText: 'This result looks like a prompt injection' });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('tells the reader to ignore its instructions; speaks to an AI reading it');
  // Removing the turn asks first, and removes the message the result answered.
  await notice.getByRole('button', { name: 'Remove the turn' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).deleted?.length)).toBe(1);
  // The message of the turn the result came in: the question just before it.
  expect(await page.evaluate(() => (window as any).deleted[0])).toBeGreaterThan(0);
  // Trusting it tells the portal which result, and the notice says it was trusted.
  await notice.getByRole('button', { name: 'Trust it' }).click();
  await expect.poll(() => trusted.length).toBe(1);
  expect(trusted[0]).toContain('/flagged/0123456789abcdef/trust');
  await expect(page.getByText('You trusted this result.')).toBeVisible();
  await expect(notice).toBeHidden();
});
