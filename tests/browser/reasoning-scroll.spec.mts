import { type Page } from '@playwright/test';
import { test, expect } from './portal-mock';
import { HOLD } from '../../core/web/src/use-follow-bottom';

const scroller = (page: Page) => page.locator('.chat-list').locator('..');
/** How far the conversation is from its end, in px. */
const left = (page: Page) => scroller(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
const scrollTop = (page: Page) => scroller(page).evaluate((el) => el.scrollTop);
const think = (page: Page, text: string) => page.evaluate((t) => (window as any).think(t), text);
const frames = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
/** Thinks more, and waits until it is drawn. */
const thinkDrawn = async (page: Page, text = line) => {
  await think(page, text);
  await frames(page);
};
const line = '\nStill reasoning about the bundle, one more line of it as it streams in.';
const reasoning = (page: Page) => page.locator('.chat-thinking-body').last();

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto('/tests/chat.html?phase=reasoning');
  await expect(page.getByText('And the last one?')).toBeVisible();
  await frames(page);
  expect(await left(page)).toBeLessThanOrEqual(1);
});

/** The reasoning being written, opened, grown past its own height, and the conversation at its end again. */
async function openLongReasoning(page: Page) {
  await page.locator('.chat-thinking-head').last().click();
  for (let i = 0; i < 30; i++) await thinkDrawn(page);
  await expect.poll(() => reasoning(page).evaluate((el) => el.scrollHeight > el.clientHeight + 100)).toBe(true);
  // Opened, it was held where it was pressed, and the end left below.
  await page.getByRole('button', { name: 'Latest output' }).click();
  await expect.poll(() => left(page)).toBeLessThanOrEqual(1);
  await thinkDrawn(page);
  expect(await left(page)).toBeLessThanOrEqual(1);
  // It shows its newest line.
  expect(await reasoning(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(1);
}

test('the last words of the reasoning, come with the first of the answer, are shown', async ({ page }) => {
  await openLongReasoning(page);
  // One update: more thinking, and the answer that ends it.
  await page.evaluate((line) => {
    for (let i = 0; i < 4; i++) (window as any).think(line);
    (window as any).say('The answer.');
  }, line);
  await expect(page.getByText('The answer.')).toBeVisible();
  await frames(page);
  expect(await reasoning(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(1);
});

test('the reasoning leaves the browser holding the conversation in view to the conversation', async ({ page }) => {
  await openLongReasoning(page);
  // Turned off in it, the reasoning and all in it were no longer anything the conversation's anchoring could hold on to.
  expect(await reasoning(page).evaluate((el) => getComputedStyle(el).overflowAnchor)).toBe('auto');
  expect(await scroller(page).evaluate((el) => getComputedStyle(el).overflowAnchor)).toBe('none');
  // Reading back, the conversation's anchoring is on again.
  await scroller(page).evaluate((el) => (el.scrollTop -= 300));
  await expect.poll(() => scroller(page).evaluate((el) => getComputedStyle(el).overflowAnchor)).toBe('auto');
});

test('the reasoning being written, scrolled back inside, stays where it was taken', async ({ page }) => {
  await openLongReasoning(page);
  const box = (await reasoning(page).boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  await page.mouse.wheel(0, -100);
  await expect.poll(() => reasoning(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(20);
  const top = await reasoning(page).evaluate((el) => el.scrollTop);
  // Every word put it back at its end.
  for (let i = 0; i < 4; i++) await thinkDrawn(page);
  expect(await reasoning(page).evaluate((el) => el.scrollTop)).toBeCloseTo(top, 0);
  // Down to its end again: it follows once more.
  await page.mouse.wheel(0, 4000);
  await expect.poll(() => reasoning(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(1);
  await thinkDrawn(page);
  expect(await reasoning(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(1);
});

test('the conversation scrolls back over the reasoning being written, and stays there', async ({ page }) => {
  await openLongReasoning(page);
  const box = (await reasoning(page).boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  const before = await scrollTop(page);
  // Past the top of the reasoning, and on up the conversation — a word arriving with each turn of the wheel.
  for (let i = 0; i < 15; i++) {
    await page.mouse.wheel(0, -150);
    await thinkDrawn(page);
  }
  // Each word took the reasoning back to its end, so the wheel never got past it.
  await expect.poll(() => scrollTop(page)).toBeLessThan(before - 100);
  const top = await scrollTop(page);
  for (let i = 0; i < 4; i++) await thinkDrawn(page);
  expect(await scrollTop(page)).toBeCloseTo(top, 0);
  await expect(page.getByRole('button', { name: 'Latest output' })).toBeVisible();
});

test('a scroll up not heard yet when the next word arrives is not undone by it', async ({ page }) => {
  // A touch or the scrollbar moves the box before its scroll event is dispatched; a word in between went to the end over it.
  await page.evaluate(() => {
    const box = document.querySelector('.chat-list')!.parentElement!;
    (window as any).unheard = (e: Event) => e.target === box && e.stopImmediatePropagation();
    window.addEventListener('scroll', (window as any).unheard, true);
  });
  const before = await scrollTop(page);
  await scroller(page).evaluate((el) => (el.scrollTop -= 300));
  for (let i = 0; i < 4; i++) await thinkDrawn(page);
  expect(await scrollTop(page)).toBeCloseTo(before - 300, 0);
  await page.evaluate(() => window.removeEventListener('scroll', (window as any).unheard, true));
  for (let i = 0; i < 2; i++) await thinkDrawn(page);
  expect(await scrollTop(page)).toBeCloseTo(before - 300, 0);
});

test('a reasoning block opened in the middle of the conversation while the model thinks stays where it was', async ({ page }) => {
  const head = page.locator('.chat-thinking-head').nth(2);
  await head.scrollIntoViewIfNeeded();
  await frames(page);
  const before = (await head.boundingBox())!;
  await head.click();
  await expect(page.locator('.chat-thinking').nth(2).locator('.chat-thinking-body')).toBeVisible();
  for (let i = 0; i < 10; i++) await thinkDrawn(page);
  // Past the moment a press holds it: the words that came since have not moved it either.
  await page.waitForTimeout(HOLD + 200);
  for (let i = 0; i < 4; i++) await thinkDrawn(page);
  expect(Math.abs((await head.boundingBox())!.y - before.y)).toBeLessThan(2);
});

test('a finished reasoning opens at its start, and stays where it is read', async ({ page }) => {
  const head = page.locator('.chat-thinking-head').nth(2);
  await head.scrollIntoViewIfNeeded();
  await head.click();
  const body = page.locator('.chat-thinking').nth(2).locator('.chat-thinking-body');
  await expect(body).toBeVisible();
  await expect.poll(() => body.evaluate((el) => el.scrollHeight > el.clientHeight + 100)).toBe(true);
  await frames(page);
  // It opened at its first line, not its last.
  expect(await body.evaluate((el) => el.scrollTop)).toBe(0);
  // Read a little way down, then the window narrows and the lines wrap anew: still there, not at the end.
  await body.evaluate((el) => (el.scrollTop = 40));
  await frames(page);
  await page.setViewportSize({ width: 700, height: 600 });
  await frames(page);
  await frames(page);
  expect(await body.evaluate((el) => el.scrollTop)).toBe(40);
});

test('a long conversation, more than is drawn at once, keeps following as its oldest messages leave the top', async ({ page }) => {
  await page.goto('/tests/chat.html?phase=reasoning&turns=20');
  await expect(page.getByText('And the last one?')).toBeVisible();
  await frames(page);
  expect(await left(page)).toBeLessThanOrEqual(1);
  // A command it runs is a message of its own: the oldest one drawn leaves the top, and the browser
  // moved the box up by as much to keep what was on screen — read as the person scrolling back.
  const oldest = () => page.locator('.chat-list > *').nth(1).textContent();
  const before = await oldest();
  await page.evaluate(() => (window as any).emit('tool_execution_start', { toolCallId: 'n1', toolName: 'bash', args: { command: 'ls dist' } }));
  await expect(page.locator('.chat-tool-head', { hasText: 'ls dist' })).toBeVisible();
  await frames(page);
  expect(await oldest()).not.toBe(before);
  expect(await left(page)).toBeLessThanOrEqual(1);
  await expect(page.getByRole('button', { name: 'Latest output' })).toBeHidden();
  for (let i = 2; i < 5; i++) {
    await page.evaluate((i) => (window as any).emit('tool_execution_start', { toolCallId: `n${i}`, toolName: 'bash', args: { command: `ls dist/${i}` } }), i);
    await frames(page);
  }
  await expect(page.locator('.chat-tool-head', { hasText: 'ls dist/4' })).toBeVisible();
  await frames(page);
  expect(await left(page)).toBeLessThanOrEqual(1);
});

test('in a long conversation, a scroll back not heard yet when a message comes keeps what is read in place', async ({ page }) => {
  await page.goto('/tests/chat.html?phase=reasoning&turns=20');
  await expect(page.getByText('And the last one?')).toBeVisible();
  await frames(page);
  // The move a touch makes, a frame before it is heard.
  await page.evaluate(() => {
    const box = document.querySelector('.chat-list')!.parentElement!;
    (window as any).unheard = (e: Event) => e.target === box && e.stopImmediatePropagation();
    window.addEventListener('scroll', (window as any).unheard, true);
    box.scrollTop -= 300;
  });
  const read = page.getByText('Question 20: what does step 20 of the build do?');
  const before = (await read.boundingBox())!.y;
  // A new message: the oldest one drawn left the top, and what was read went up by as much under the finger.
  await page.evaluate(() => (window as any).emit('tool_execution_start', { toolCallId: 'n1', toolName: 'bash', args: { command: 'ls dist' } }));
  await expect(page.locator('.chat-tool-head', { hasText: 'ls dist' })).toBeAttached();
  await frames(page);
  expect(Math.abs((await read.boundingBox())!.y - before)).toBeLessThan(2);
  await page.evaluate(() => window.removeEventListener('scroll', (window as any).unheard, true));
});

test('a conversation not shown for a while, as in voice mode, comes back where it was left', async ({ page }) => {
  const hidden = (yes: boolean) => scroller(page).evaluate((el, yes) => (el.style.display = yes ? 'none' : ''), yes);
  const more = async () => {
    for (let i = 0; i < 3; i++) await thinkDrawn(page);
  };
  // Scrolled back to read: not taken to the end while hidden, nor anywhere else.
  await page.mouse.move(450, 300);
  await page.mouse.wheel(0, -400);
  await expect.poll(() => left(page)).toBeGreaterThan(300);
  await frames(page);
  const read = await scrollTop(page);
  await hidden(true);
  await more();
  await hidden(false);
  await frames(page);
  await more();
  expect(await scrollTop(page)).toBe(read);
  await expect(page.getByRole('button', { name: 'Latest output' })).toBeVisible();
  // A browser that lets go of where a box was while it was not drawn: put back where it was.
  await hidden(true);
  await more();
  await scroller(page).evaluate((el) => {
    el.style.display = '';
    el.scrollTop = 0;
  });
  await frames(page);
  await more();
  expect(await scrollTop(page)).toBe(read);
  // At the end: still at the end, and following.
  await page.getByRole('button', { name: 'Latest output' }).click();
  await expect.poll(() => left(page)).toBeLessThanOrEqual(1);
  await hidden(true);
  await more();
  await hidden(false);
  await frames(page);
  await more();
  expect(await left(page)).toBeLessThanOrEqual(1);
});

test('the reasoning being written, closed and opened again at once, shows its newest line', async ({ page }) => {
  await openLongReasoning(page);
  const box = (await reasoning(page).boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  await page.mouse.wheel(0, -200);
  await expect.poll(() => reasoning(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(100);
  // Opened again before it has finished closing: the same body, not a new one.
  const head = page.locator('.chat-thinking-head').last();
  await head.click();
  await head.click();
  await thinkDrawn(page);
  expect(await reasoning(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(1);
});

test('what a message had attached, opened at the end, stays where it was pressed', async ({ page }) => {
  const chip = page.getByRole('button', { name: 'Routine' });
  await expect(chip).toBeVisible();
  const before = (await chip.boundingBox())!;
  await chip.click();
  await expect(page.getByText('Routine line 12: check the bundle.')).toBeVisible();
  await frames(page);
  // It went up by all it opened.
  expect(Math.abs((await chip.boundingBox())!.y - before.y)).toBeLessThan(2);
  for (let i = 0; i < 4; i++) await thinkDrawn(page);
  expect(Math.abs((await chip.boundingBox())!.y - before.y)).toBeLessThan(2);
});
