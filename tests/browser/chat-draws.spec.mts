import { type Page } from '@playwright/test';
import { test, expect } from './portal-mock';

/**
 * How often the conversation's rows are drawn: a long conversation is hundreds of them, each with its markdown and its
 * buttons, and the chat is drawn for every key typed in its box, every second that ticks and every word of a reply.
 * A row is counted by its Copy button (CopyAction), which every answer and every message has.
 */
const drawn = (page: Page) => page.evaluate(() => ({ ...(window as any).drawn }) as Record<string, number>);
const copies = async (page: Page) => (await drawn(page)).CopyAction ?? 0;

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto('/tests/chat.html?phase=stream&count=1');
  await expect(page.getByText('The last step')).toBeVisible();
  // Six questions and answers were drawn: the count is what a draw looks like.
  await expect.poll(() => copies(page)).toBeGreaterThanOrEqual(6);
});

test('typing in the box does not draw the conversation again', async ({ page }) => {
  const before = await copies(page);
  await page.getByRole('textbox').first().pressSequentially('hello there, this is a long line', { delay: 5 });
  await expect(page.getByRole('textbox').first()).toHaveValue('hello there, this is a long line');
  expect(await copies(page)).toBe(before);
});

test('a word of the reply being written draws the reply, and not what was said before it', async ({ page }) => {
  const before = await copies(page);
  for (let i = 0; i < 8; i++) await page.evaluate((word) => (window as any).say(word), ` word${i}`);
  await expect(page.getByText('word7')).toBeVisible();
  expect(await copies(page)).toBe(before);
});

test('a second ticking by does not draw the conversation again', async ({ page }) => {
  // Time is the page's from here, and three seconds of it go by.
  await page.clock.install();
  await page.goto('/tests/chat.html?phase=stream&count=1');
  await expect(page.getByText('The last step')).toBeVisible();
  await expect.poll(() => copies(page)).toBeGreaterThanOrEqual(6);
  const before = await copies(page);
  await page.clock.runFor(3500);
  expect(await copies(page)).toBe(before);
});

test('the rows, which are not drawn for the chat\'s other draws, are drawn for a change of language', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Copy' }).first()).toBeAttached();
  await page.evaluate(() => (window as any).setLang('de'));
  await expect(page.getByRole('button', { name: 'Kopieren' }).first()).toBeAttached();
  await expect(page.getByRole('button', { name: 'Copy' })).toHaveCount(0);
});

test.describe('the panels beside the conversation', () => {
  test('Git is not drawn again for what is typed in the box', async ({ page }) => {
    await page.setViewportSize({ width: 1300, height: 800 });
    await page.goto('/tests/chat.html?phase=git&count=1');
    await page.getByRole('button', { name: 'Git', exact: true }).click();
    const panels = page.getByRole('complementary', { name: 'Panels' });
    await expect(panels.getByText('notes.txt')).toBeVisible();
    await expect.poll(async () => (await drawn(page)).GitPanel ?? 0).toBeGreaterThan(0);
    // Let what it asks for arrive, so that what is counted next is only what typing does. It reads its state when it
    // opens, and once more 600 ms later for the file activity the chat already has: a fixed wait is short of that on a
    // slow machine, and the second read then lands in the middle of the typing.
    await expect.poll(() => page.evaluate(() => (window as any).gitAsked)).toBeGreaterThanOrEqual(2);
    // And drawn, which is a moment after it is read: nothing is left to come when two looks agree.
    let last = -1;
    await expect
      .poll(async () => {
        const now = (await drawn(page)).GitPanel;
        const same = now === last;
        last = now;
        return same;
      }, { intervals: [150] })
      .toBe(true);
    const before = (await drawn(page)).GitPanel;
    // The message box, which comes before the panels in the page: Git has boxes of its own.
    await page.getByRole('textbox').first().pressSequentially('hello there', { delay: 5 });
    await expect(page.getByRole('textbox').first()).toHaveValue('hello there');
    expect((await drawn(page)).GitPanel).toBe(before);
  });

  test('a subagent and a job that are timed are not drawn again for each second', async ({ page }) => {
    await page.setViewportSize({ width: 1300, height: 800 });
    await page.clock.install();
    await page.goto('/tests/chat.html?phase=agents&count=1');
    const tray = page.getByLabel('Running beside the conversation');
    await tray.getByRole('button', { name: /Deploy audit/ }).click();
    await expect(page.locator('.sub-head')).toContainText('Deploy audit');
    await expect.poll(async () => (await drawn(page)).ChildItem ?? 0).toBeGreaterThan(0);
    await tray.getByRole('button', { name: /npm run dev/ }).click();
    await expect(page.locator('.terminal-job-output')).toContainText('VITE');
    await expect.poll(async () => (await drawn(page)).JobOutput ?? 0).toBeGreaterThan(0);
    // Settled: the clock stands still until it is run.
    await page.clock.runFor(200);
    const before = await drawn(page);
    await page.clock.runFor(3500);
    const after = await drawn(page);
    expect(after.ChildItem).toBe(before.ChildItem);
    expect(after.JobOutput).toBe(before.JobOutput);
  });
});
