import { type Page } from '@playwright/test';
import { test, expect } from './portal-mock';

const scroller = (page: Page) => page.locator('.chat-list').locator('..');
/** How far the conversation is from its end, in px. */
const left = (page: Page) => scroller(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
const say = (page: Page, text: string) => page.evaluate((t) => (window as any).say(t), text);
const frames = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
/** Says more, and waits until it is drawn: measured before, nothing had grown to follow. */
const sayDrawn = async (page: Page, text: string) => {
  const before = await scroller(page).evaluate((el) => el.scrollHeight);
  await say(page, text);
  await expect.poll(() => scroller(page).evaluate((el) => el.scrollHeight)).toBeGreaterThan(before);
  await frames(page);
};
const paragraph = '\n\nMore of the answer, long enough to take a line or two of the conversation as it is written.\n\n';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto('/tests/chat.html?phase=stream');
  await expect(page.getByText('The last step')).toBeVisible();
  expect(await left(page)).toBeLessThanOrEqual(1);
});

test('a little scroll up while the agent writes stays where it was taken', async ({ page }) => {
  await page.mouse.move(450, 300);
  // Less than the 48 px that still counted as the end: the next word took it back down.
  await page.mouse.wheel(0, -30);
  await expect.poll(() => left(page)).toBeGreaterThan(20);
  const top = await scroller(page).evaluate((el) => el.scrollTop);
  for (let i = 0; i < 4; i++) { await say(page, paragraph); await frames(page); }
  expect(await scroller(page).evaluate((el) => el.scrollTop)).toBeCloseTo(top, 0);
  await expect(page.getByRole('button', { name: 'Latest output' })).toBeVisible();
  // Down to the end again: it follows once more.
  await page.mouse.wheel(0, 4000);
  await expect.poll(() => left(page)).toBeLessThanOrEqual(1);
  await say(page, paragraph);
  await frames(page);
  expect(await left(page)).toBeLessThanOrEqual(1);
});

test('its own jump to the end, heard after more arrived, does not stop it following', async ({ page }) => {
  // More arrives, the box goes to the end for it, and before that scroll is
  // heard more still has arrived: further from the end than the 48 px that
  // counted as there, and following stopped on its own.
  await page.evaluate(() => {
    const box = document.querySelector('.chat-list')!.parentElement!;
    const grow = (px: number) => {
      const tall = document.createElement('div');
      tall.style.height = `${px}px`;
      document.querySelector('.chat-list')!.lastElementChild!.appendChild(tall);
    };
    grow(100);
    box.scrollTop = box.scrollHeight;
    grow(300);
  });
  await frames(page);
  await say(page, paragraph);
  await frames(page);
  expect(await left(page)).toBeLessThanOrEqual(1);
  await expect(page.getByRole('button', { name: 'Latest output' })).toBeHidden();
});

test('what grows without a new word — a block that settles, a picture that loads — keeps the end in view', async ({ page }) => {
  await page.evaluate(() => {
    const tall = document.createElement('div');
    tall.style.height = '240px';
    document.querySelector('.chat-list')!.lastElementChild!.appendChild(tall);
  });
  // It stayed a screen short of the end until the next word came.
  await frames(page);
  expect(await left(page)).toBeLessThanOrEqual(1);
});

test('a shorter box, as when the keyboard opens, still ends at the last word', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 380 });
  await frames(page);
  expect(await left(page)).toBeLessThanOrEqual(1);
});

test('a tool call opened at the end stays where it was clicked, not carried up out of sight', async ({ page }) => {
  const head = page.locator('.chat-tool-head', { hasText: 'cat build.log' });
  await expect(head).toBeVisible();
  const before = (await head.boundingBox())!;
  await head.click();
  await expect(page.locator('.chat-tool', { hasText: 'cat build.log' }).locator('.chat-tool-output')).toBeVisible();
  await frames(page);
  // It went up by all the output it opened.
  expect(Math.abs((await head.boundingBox())!.y - before.y)).toBeLessThan(2);
  // Opened over the end: reading it, not following. New words wait below.
  await say(page, paragraph);
  await frames(page);
  expect(Math.abs((await head.boundingBox())!.y - before.y)).toBeLessThan(2);
  await expect(page.getByRole('button', { name: 'Latest output' })).toBeVisible();
});

test('a click in the words being written does not stop following them', async ({ page }) => {
  await page.getByText('The last step').click();
  for (let i = 0; i < 3; i++) await sayDrawn(page, paragraph);
  expect(await left(page)).toBeLessThanOrEqual(1);
});

test('the wheel turned back in a box of its own inside the conversation leaves it following', async ({ page }) => {
  // A long thinking or a block of code, scrolled on its own.
  await page.evaluate(() => {
    const inner = document.createElement('div');
    inner.id = 'inner';
    Object.assign(inner.style, { height: '120px', overflowY: 'auto' });
    inner.innerHTML = '<div style="height:600px">a long block</div>';
    document.querySelector('.chat-list')!.lastElementChild!.appendChild(inner);
    inner.scrollTop = 200;
  });
  await frames(page);
  const inner = (await page.locator('#inner').boundingBox())!;
  await page.mouse.move(inner.x + 20, inner.y + 60);
  await page.mouse.wheel(0, -100);
  await expect.poll(() => page.locator('#inner').evaluate((e) => e.scrollTop)).toBeLessThan(200);
  // The conversation itself never moved: it still follows what is written.
  await sayDrawn(page, paragraph);
  expect(await left(page)).toBeLessThanOrEqual(1);
});

test('what leaves the conversation box is no longer watched for its size', async ({ page }) => {
  const unwatched = await page.evaluate(async () => {
    const seen: string[] = [];
    const unobserve = ResizeObserver.prototype.unobserve;
    ResizeObserver.prototype.unobserve = function (target: Element) { seen.push(target.id); return unobserve.call(this, target); };
    const box = document.querySelector('.chat-list')!.parentElement!;
    const extra = document.createElement('div');
    extra.id = 'passing';
    box.appendChild(extra);
    await new Promise((r) => requestAnimationFrame(r));
    extra.remove();
    await new Promise((r) => requestAnimationFrame(r));
    ResizeObserver.prototype.unobserve = unobserve;
    return seen;
  });
  expect(unwatched).toContain('passing');
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

test('a press on a button that opens nothing, in the reply being written, does not stop following it', async ({ page }) => {
  // A code block's Copy, above the words still coming, in the turn that grows with every word.
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.textContent = 'Copy this';
    const turn = document.querySelector('.chat-list')!.lastElementChild!;
    turn.insertBefore(button, turn.firstChild);
  });
  await frames(page);
  await page.getByRole('button', { name: 'Copy this' }).click();
  for (let i = 0; i < 3; i++) await sayDrawn(page, paragraph);
  expect(await left(page)).toBeLessThanOrEqual(1);
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
