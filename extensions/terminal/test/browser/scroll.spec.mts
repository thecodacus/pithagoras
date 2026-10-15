import { type Page } from '@playwright/test';
import { test, expect } from '../../../../tests/browser/portal-mock';

test.use({ installed: ['extensions/terminal'] });

/** A command of the agent's, brought into view in the terminal from its card in the conversation, and its output as it grows. */

const frames = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
});

test('a command shown in the terminal stays in view while its output grows', async ({ page }) => {
  await page.goto('/tests/chat.html?phase=tools');
  await page.locator('.chat-tool-head', { hasText: 'seq 1 40' }).click();
  await page.getByRole('button', { name: /in the agent terminal/ }).last().click();
  const run = page.locator('.terminal-run').last();
  await expect(run).toBeVisible();
  await expect(run).toContainText('seq 1 40');
  // Much more output, at once, while it is being shown.
  await page.evaluate(() => (window as any).bashOut(Array.from({ length: 120 }, (_, i) => `step ${i + 1}`).join('\n')));
  await frames(page);
  const box = (await page.locator('.terminal-output').first().boundingBox())!;
  // Its command line, at the top of it: the output grew under it, not over it.
  const command = (await run.locator('.terminal-command').boundingBox())!;
  expect(command.y).toBeGreaterThanOrEqual(box.y - 1);
});

test('the terminal moved up a little to show a command follows its output again once it has shown it', async ({ page }) => {
  await page.goto('/tests/chat.html?phase=tools');
  await page.locator('.chat-tool-head', { hasText: 'seq 1 40' }).click();
  const link = page.getByRole('button', { name: /in the agent terminal/ }).last();
  await link.click();
  const output = page.locator('.terminal-output').first();
  const run = page.locator('.terminal-run').last();
  await expect(run).toBeVisible();
  // The command's output a little taller than the terminal: shown from its top, the terminal is a little short of its end.
  const out = (n: number) => page.evaluate((n) => (window as any).bashOut(Array.from({ length: n }, (_, i) => `step ${i + 1}`).join('\n')), n);
  await out(100);
  await frames(page);
  const lines = await output.evaluate((box) => {
    const run = box.lastElementChild as HTMLElement, line = parseFloat(getComputedStyle(run.querySelector('pre')!).lineHeight);
    const rest = run.offsetHeight - 100 * line;
    return Math.round((box.clientHeight + 10 - rest) / line);
  });
  await out(lines);
  // Read down to its end, where it follows: the first time it was shown is long over.
  await page.waitForTimeout(1300);
  const o = (await output.boundingBox())!;
  await page.mouse.move(o.x + 40, o.y + 40);
  await page.mouse.wheel(0, 4000);
  await expect.poll(() => output.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(1);
  await link.click();
  // Done sliding up to it (a smooth scroll): the same place twice in a row, inside the moment it is held there.
  let last = -1;
  await expect.poll(async () => { const now = await output.evaluate((el) => el.scrollTop); const still = now === last; last = now; return still && now > 0; }, { intervals: [50] }).toBe(true);
  const gap = await output.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  expect(gap).toBeGreaterThan(2);
  expect(gap).toBeLessThanOrEqual(48);
  // Held on it for a moment, then its new output is followed: it was left off screen.
  await page.waitForTimeout(1500);
  await out(lines + 30);
  await expect.poll(() => output.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(1);
});
