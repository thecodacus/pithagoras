import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/** Settings → Logs over a server whose lines are the test's: what the page asks for, and what it shows of the answer. */
async function portal(page: Page, lines: { id: number; level: string; text: string }[], boot = { value: 'a' }, gap = { value: false }) {
  const asked: string[] = [];
  await mockPortal(page, ({ path, url }) => {
    if (path !== '/api/logs') return undefined;
    asked.push(url.search);
    const since = url.searchParams.get('since');
    const wanted = lines.filter((l) => since === null || l.id > Number(since));
    return { boot: boot.value, gap: gap.value, last: lines.length ? lines[lines.length - 1].id : 0, lines: wanted.map((l) => ({ ...l, at: '2026-10-01T09:00:00Z' })) };
  }, { settings: true });
  return asked;
}

test('the log lists what the server printed, and the filter and the search narrow it', async ({ page }) => {
  await portal(page, [
    { id: 1, level: 'info', text: 'listening on port 3000' },
    { id: 2, level: 'warn', text: 'slow disk' },
    { id: 3, level: 'error', text: 'channel crashed\n  at start (x.js:1)' },
  ]);
  await page.goto('/settings/logs');
  const log = page.getByRole('log', { name: 'Server logs' });
  await expect(log).toContainText('listening on port 3000');
  await expect(log).toContainText('channel crashed');
  await expect(page.getByRole('status').filter({ hasText: '3 lines' })).toContainText('one error');

  await page.getByRole('radio', { name: 'Warnings and errors' }).click();
  await expect(log).not.toContainText('listening on port 3000');
  await expect(log).toContainText('slow disk');
  await page.getByRole('radio', { name: 'Errors', exact: true }).click();
  await expect(log).not.toContainText('slow disk');
  await expect(log).toContainText('channel crashed');

  await page.getByRole('radio', { name: 'Everything' }).click();
  await page.getByRole('searchbox', { name: 'Search the logs' }).fill('DISK');
  await expect(log).toContainText('slow disk');
  await expect(log).not.toContainText('channel crashed');
  await page.getByRole('searchbox', { name: 'Search the logs' }).fill('nothing like it');
  await expect(log).toContainText('Nothing matches.');
});

test('new lines are fetched after the last one seen, and the file is offered for download', async ({ page }) => {
  const lines = [{ id: 1, level: 'info', text: 'first' }];
  const asked = await portal(page, lines);
  await page.goto('/settings/logs');
  const log = page.getByRole('log', { name: 'Server logs' });
  await expect(log).toContainText('first');
  lines.push({ id: 2, level: 'error', text: 'second' });
  await expect(log).toContainText('second', { timeout: 8000 });
  // The first read asks for the newest lines; the next ones only for what came after the one it had.
  expect(asked[0]).toContain('limit=');
  expect(asked.some((q) => q.includes('since=1'))).toBe(true);
  // Shown once, though it was asked for more than once.
  await expect(log.getByText('first')).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Download' })).toHaveAttribute('href', '/api/logs/download');
});

test('a server that started again replaces the list instead of waiting for ids it will not reach', async ({ page }) => {
  const lines = [{ id: 1, level: 'info', text: 'old boot' }, { id: 2, level: 'info', text: 'old boot again' }];
  const boot = { value: 'a' };
  await portal(page, lines, boot);
  await page.goto('/settings/logs');
  const log = page.getByRole('log', { name: 'Server logs' });
  await expect(log).toContainText('old boot again');
  boot.value = 'b';
  lines.splice(0, lines.length, { id: 1, level: 'info', text: 'new boot' });
  await expect(log).toContainText('new boot', { timeout: 8000 });
  await expect(log).not.toContainText('old boot');
});

test('lines let go before they were read replace the list rather than joining it', async ({ page }) => {
  const lines = [{ id: 1, level: 'info', text: 'before the gap' }];
  const gap = { value: false };
  const asked = await portal(page, lines, { value: 'a' }, gap);
  await page.goto('/settings/logs');
  const log = page.getByRole('log', { name: 'Server logs' });
  await expect(log).toContainText('before the gap');
  // The server dropped the lines the page was waiting for; its answer to since= starts later.
  lines.splice(0, lines.length, { id: 50, level: 'info', text: 'after the gap' });
  gap.value = true;
  await expect(log).toContainText('after the gap', { timeout: 8000 });
  await expect(log).not.toContainText('before the gap');
  gap.value = false;
  // The newest lines were asked for again, not only what came after the last id seen.
  expect(asked.filter((q) => q.includes('limit=')).length).toBeGreaterThanOrEqual(2);
});

test('the page holds no more text than the server does, the newest lines staying', async ({ page }) => {
  // Lines at the server's length limit: 150 of them are 1.2 MB, 300 are more than the 2 MB it keeps.
  const line = (id: number) => ({ id, level: 'info', text: `line-${id} `.padEnd(8000, 'x') });
  const lines = Array.from({ length: 150 }, (_, i) => line(i + 1));
  await portal(page, lines);
  await page.goto('/settings/logs');
  const log = page.getByRole('log', { name: 'Server logs' });
  await expect(log).toContainText('line-150 ');
  for (let id = 151; id <= 300; id++) lines.push(line(id));
  await expect(log).toContainText('line-300 ', { timeout: 8000 });
  // The ids of the rows, not their text: a failure should not print megabytes.
  const held = await log.evaluate((el) => [...el.querySelectorAll('div.flex')].map((r) => Number(/line-(\d+) /.exec(r.textContent ?? '')?.[1])));
  expect(held[held.length - 1]).toBe(300);
  expect(held.length).toBeLessThanOrEqual(Math.floor(2_000_000 / 8000));
  expect(held.length).toBeGreaterThan(200);
  expect(held[0]).toBe(300 - held.length + 1);
});
