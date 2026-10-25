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
  // An extension's panel: the portal's tests' stand-in for one.
  test.use({ installed: ['tests/fixtures/extensions/console'] });

  test('an extension\'s panel is not drawn again for what is typed in the box', async ({ page }) => {
    await page.setViewportSize({ width: 1300, height: 800 });
    await page.goto('/tests/chat.html?phase=stream&count=1');
    await page.getByRole('button', { name: 'Console', exact: true }).click();
    await expect(page.getByRole('complementary', { name: 'Panels' }).getByRole('tablist', { name: 'Consoles' })).toBeVisible();
    await expect.poll(async () => (await drawn(page)).ConsolePanel ?? 0).toBeGreaterThan(0);
    // Settled: nothing is left to come when two looks agree.
    let last = -1;
    await expect
      .poll(async () => {
        const now = (await drawn(page)).ConsolePanel;
        const same = now === last;
        last = now;
        return same;
      }, { intervals: [150] })
      .toBe(true);
    const before = (await drawn(page)).ConsolePanel;
    await page.getByRole('textbox').first().pressSequentially('hello there', { delay: 5 });
    await expect(page.getByRole('textbox').first()).toHaveValue('hello there');
    expect((await drawn(page)).ConsolePanel).toBe(before);
  });
});
