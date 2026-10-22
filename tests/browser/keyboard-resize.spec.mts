import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';
import { DEFAULT_ORB } from '../../core/server/src/orb-style';

// Two panels beside the conversation: the portal's tests' stand-ins for extensions' panels.
test.use({ installed: ['tests/fixtures/extensions/console', 'tests/fixtures/extensions/viewer'] });

/**
 * What a keyboard can do that a pointer does: go through a list of tabs with the arrow keys, and size the panels, the
 * edge between two of them and a floating window from its grip.
 */

const panels = (page: Page) => page.locator('.chat-aside');
const bounds = async (page: Page, selector = '.chat-aside') => (await page.locator(selector).first().boundingBox())!;
/** Done sliding in or out: measured on the way, a panel is where it is going plus the slide. */
const settled = (page: Page) =>
  page.evaluate(() => Promise.all([...document.querySelectorAll('.chat-aside')].flatMap((e) => e.getAnimations({ subtree: true }).filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished))));
/** The chat with the panels open, in the place the browser last had them. */
async function chat(page: Page, stored: Record<string, string> = {}, open: ('Console' | 'Viewer')[] = ['Console', 'Viewer']) {
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.goto('/tests/chat.html?phase=tools');
  await page.evaluate((s) => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, stored);
  await page.reload();
  for (const name of open) await page.getByRole('button', { name, exact: true }).click();
  await expect(panels(page).first()).toBeVisible();
  await settled(page);
}

test('the edge between the conversation and the panels is sized with the arrow keys, kept, and given back with Home', async ({ page }) => {
  await chat(page);
  const edge = page.getByRole('separator', { name: 'Width of the panels on the right' });
  await expect(edge).toHaveAttribute('aria-orientation', 'vertical');
  const first = (await bounds(page)).width;
  await expect(edge).toHaveAttribute('aria-valuenow', String(Math.round(first)));
  await edge.focus();
  // The edge goes the way the arrow points, as it does with a pointer: to the left, the panels are wider.
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await bounds(page)).width).toBeCloseTo(first + 24, 0);
  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(async () => (await bounds(page)).width).toBeCloseTo(first + 24 + 96, 0);
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await bounds(page)).width).toBeCloseTo(first + 96, 0);
  await expect(edge).toHaveAttribute('aria-valuenow', String(Math.round(first + 96)));
  // The edge is still the one with the focus, so that the next key goes on from here.
  await expect(edge).toBeFocused();
  await page.reload();
  await page.getByRole('button', { name: 'Console', exact: true }).click();
  await page.getByRole('button', { name: 'Viewer', exact: true }).click();
  await settled(page);
  expect((await bounds(page)).width).toBeCloseTo(first + 96, 0);
  await page.getByRole('separator', { name: 'Width of the panels on the right' }).focus();
  await page.keyboard.press('Home');
  await expect.poll(async () => (await bounds(page)).width).toBeCloseTo(first, 0);
});

test('at the left an arrow to the right makes the panels wider, and at the bottom an arrow up makes them taller', async ({ page }) => {
  await chat(page, { panelDock: 'left' });
  const side = page.getByRole('separator', { name: 'Width of the panels on the left' });
  const w = (await bounds(page)).width;
  await side.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await bounds(page)).width).toBeCloseTo(w + 24, 0);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await bounds(page)).width).toBeCloseTo(w, 0);

  await chat(page, { panelDock: 'bottom' });
  const foot = page.getByRole('separator', { name: 'Height of the panels at the bottom' });
  await expect(foot).toHaveAttribute('aria-orientation', 'horizontal');
  const h = (await bounds(page)).height;
  await foot.focus();
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await bounds(page)).height).toBeCloseTo(h + 24, 0);
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await bounds(page)).height).toBeCloseTo(h, 0);
});

test('the edge between two panels moves with the arrow keys, stops short of the ends, and comes back with Home', async ({ page }) => {
  await chat(page);
  const divider = page.getByRole('separator', { name: 'Space between the two panels' });
  // One above the other: the line is horizontal, and the arrows that move it are Up and Down.
  await expect(divider).toHaveAttribute('aria-orientation', 'horizontal');
  await expect(divider).toHaveAttribute('aria-valuenow', '55');
  const top = async () => (await page.locator('.chat-aside-panel').first().boundingBox())!.height;
  const whole = (await bounds(page)).height;
  const was = await top();
  await divider.focus();
  await page.keyboard.press('ArrowDown');
  await expect(divider).toHaveAttribute('aria-valuenow', '60');
  await expect.poll(top).toBeGreaterThan(was + whole * 0.03);
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowUp');
  await expect(divider).toHaveAttribute('aria-valuenow', '15');
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowDown');
  await expect(divider).toHaveAttribute('aria-valuenow', '85');
  await page.keyboard.press('Home');
  await expect(divider).toHaveAttribute('aria-valuenow', '55');
  await expect.poll(top).toBeCloseTo(was, 0);
});

test('a floating window is sized from its grip with the arrow keys, and Home gives it its first size back', async ({ page }) => {
  await chat(page, { panelDock: 'float' }, ['Console']);
  const grip = page.getByRole('button', { name: 'Resize Console' });
  const first = await bounds(page);
  await grip.focus();
  // First placed against the right edge of the chat, where it has no room to grow: made smaller first.
  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(async () => (await bounds(page)).width).toBeCloseTo(first.width - 96, 0);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await bounds(page)).width).toBeCloseTo(first.width - 72, 0);
  await expect.poll(async () => (await bounds(page)).height).toBeCloseTo(first.height + 24, 0);
  // The corner stays where the window began: it is the grip that moves.
  expect((await bounds(page)).x).toBeCloseTo(first.x, 0);
  for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowLeft');
  expect((await bounds(page)).width).toBeCloseTo(320, 0);
  await page.keyboard.press('Home');
  await expect.poll(async () => (await bounds(page)).width).toBeCloseTo(first.width, 0);
  await expect.poll(async () => (await bounds(page)).height).toBeCloseTo(first.height, 0);
});

test('the sections of an agent take the arrow keys', async ({ page }) => {
  const agent = { id: 'home', name: 'Home', home: '/a', first: true, initialised: true, chats: 0, channels: [], orb: DEFAULT_ORB, voice: '', heartbeat: { minutes: 0, quietStart: '', quietEnd: '', timeZone: 'UTC', last: null, status: null, running: false, watching: false, available: true }, unread: 0 };
  await mockPortal(page, ({ path: p, method }) => {
    if (method !== 'GET') return;
    if (p === '/api/agents') return { agents: [agent] };
    if (p === '/api/agents/home/sessions') return { sessions: [] };
    if (p === '/api/agents/home/setup') return { initialised: true, home: '/a', files: [] };
  }, { settings: true });
  await page.goto('/agents?agent=home');
  const sections = page.getByRole('tablist', { name: 'Agent sections' });
  const first = sections.getByRole('tab').first();
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await first.focus();
  await page.keyboard.press('ArrowRight');
  const second = sections.getByRole('tab').nth(1);
  await expect(second).toBeFocused();
  await expect(second).toHaveAttribute('aria-selected', 'true');
  await expect(first).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('End');
  await expect(sections.getByRole('tab').last()).toHaveAttribute('aria-selected', 'true');
});
