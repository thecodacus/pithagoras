import { type Page } from '@playwright/test';
import { test, expect } from './portal-mock';

// An extension's panel that fills its body by itself and goes fullscreen, as the browser's does, beside a plain one:
// the portal's tests' stand-ins for them.
test.use({ installed: ['tests/fixtures/extensions/console', 'tests/fixtures/extensions/viewer'] });

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/chat.html?phase=model');
  await page.getByRole('button', { name: 'Console', exact: true }).click();
  await page.getByRole('button', { name: 'Viewer', exact: true }).click();
  await expect(page.locator('.viewer-pane')).toBeVisible();
});

/** How the body of the panel that has `part` in it is drawn: the element an extension's panel is drawn in, under its head. */
const body = (page: Page, part: string) =>
  page.evaluate((part) => {
    const el = document.querySelector(part)!.closest<HTMLElement>('.chat-aside-head ~ div')!;
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect(), whole = el.parentElement!.getBoundingClientRect();
    return { background: style.backgroundColor, overflow: style.overflowY, wide: Math.round(box.width) === Math.round(whole.width) };
  }, part);

test('a panel that asks for it is black from edge to edge, and one that does not is as it was', async ({ page }) => {
  expect(await body(page, '.viewer-pane')).toEqual({ background: 'rgb(0, 0, 0)', overflow: 'hidden', wide: true });
  const plain = await body(page, '.console-pane');
  expect(plain.background).not.toBe('rgb(0, 0, 0)');
  expect(plain.overflow).toBe('auto');
});

test('its own Fullscreen takes it alone to the whole screen, and closed, it takes fullscreen with it', async ({ page }) => {
  await page.getByRole('button', { name: 'Fullscreen' }).click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement?.querySelector('.viewer-pane'))).toBe(true);
  // Its head goes with it, and the panel beside it stays where it is.
  expect(await page.evaluate(() => document.fullscreenElement!.querySelector('.chat-aside-head')?.textContent)).toMatch(/Viewer/);
  expect(await page.evaluate(() => !!document.fullscreenElement!.querySelector('[role=tablist][aria-label=Consoles]'))).toBe(false);
  await page.getByRole('button', { name: 'Close Viewer' }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
  await expect(page.getByRole('button', { name: 'Close Console' })).toBeVisible();
});

test('asked for while it is closed, nothing happens, and nothing fails', async ({ page }) => {
  const failed: Error[] = [];
  page.on('pageerror', (e) => failed.push(e));
  await expect.poll(() => page.evaluate(() => !!(window as any).viewerPanel)).toBe(true);
  await page.getByRole('button', { name: 'Close Viewer' }).click();
  await expect(page.locator('.viewer-pane')).toHaveCount(0);
  await page.evaluate(() => (window as any).viewerPanel.fullscreen());
  // A rejection nobody caught is said a moment later.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 200)));
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
  expect(failed).toEqual([]);
});
