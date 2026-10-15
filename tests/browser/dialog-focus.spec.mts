import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/**
 * The keyboard in the dialogs that cover the page: Settings (the shared Modal),
 * an extension's question, and the phone's navigation drawer. Focus goes in,
 * Tab goes round, and Escape gives focus back to where it was.
 */
const at = new Date().toISOString();
const chat = { id: 'a', title: 'Chat A', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: at, created_at: at, provider: null, model: null, thinking_level: null };

const alpha = { id: 'm', name: 'Alpha', provider: 'prov-a' };

async function portal(page: Page, { withModel = false, expired = false } = {}) {
  const answered: unknown[] = [];
  await mockPortal(page, ({ path, method, json }) => {
    if (path === '/api/sessions') return { sessions: [chat], executor: 'host' };
    if (/^\/api\/sessions\/\w+$/.test(path)) return chat;
    if (path.endsWith('/ui-response')) {
      answered.push(json());
      return expired ? { ok: false, note: 'Expired.' } : { ok: true };
    }
    if (path.endsWith('/config') && withModel) return { live: true, state: { model: alpha, thinkingLevel: 'off' }, stats: null, thinking: { levels: [] }, models: { models: [alpha] }, named: { provider: 'prov-a', model: 'm' } };
    if (path.endsWith('/config')) return { live: false, state: null, stats: null, thinking: { levels: [] }, models: { models: [] }, named: { provider: null, model: null } };
    if (path === '/api/settings' && method === 'PUT') return { settings: {}, compaction: { keepRecentTokens: 20000 }, refreshed: 0, note: '' };
  }, { streams: 'open', settings: true });
  return { answered };
}

/** Waits for the chat's stream, and says its history has come. */
async function caughtUp(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as any).streams.filter((s: any) => !s.closed).length)).toBeGreaterThan(0);
  await page.evaluate(() => (window as any).streams.filter((s: any) => !s.closed).at(-1).emit('caught-up', {}));
}

/** Whether focus is inside the dialog with this name (the dialog itself counts). */
const focusIn = (page: Page, name: string) =>
  page.evaluate((n) => !!document.querySelector(`[role="dialog"][aria-label="${n}"]`)?.contains(document.activeElement), name);

/** Tab (or Shift+Tab) round the dialog twice over: focus must never leave it. */
async function goesRound(page: Page, name: string, shift = false) {
  for (let i = 0; i < 70; i++) {
    await page.keyboard.press(shift ? 'Shift+Tab' : 'Tab');
    expect(await focusIn(page, name), `after ${i + 1} presses`).toBe(true);
  }
}

test('Settings takes focus, keeps Tab inside, and gives focus back when it closes', async ({ page }) => {
  await portal(page);
  await page.goto('/s/a');
  const opener = page.getByRole('button', { name: 'Settings', exact: true }).first();
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  await expect.poll(() => focusIn(page, 'Settings')).toBe(true);
  await goesRound(page, 'Settings');
  await goesRound(page, 'Settings', true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test("an extension's question takes focus, keeps Tab inside, and gives focus back to the composer", async ({ page }) => {
  const { answered } = await portal(page);
  await page.goto('/s/a');
  const composer = page.getByLabel('Message', { exact: true });
  await composer.focus();
  await caughtUp(page);
  await page.evaluate(() =>
    (window as any).streams.filter((s: any) => !s.closed).at(-1).emit('message', { seq: -1, type: 'extension_ui_request', payload: { id: 'q1', method: 'select', title: 'Pick one', options: ['One', 'Two'] } }),
  );
  const dialog = page.getByRole('dialog', { name: 'Pick one' });
  await expect(dialog).toBeVisible();
  await expect.poll(() => focusIn(page, 'Pick one')).toBe(true);
  await goesRound(page, 'Pick one');
  await goesRound(page, 'Pick one', true);
  // Its close button has a name, as Settings' has.
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  expect(answered).toEqual([{ id: 'q1', cancelled: true }]);
  await expect(composer).toBeFocused();
});

test("after two questions that came together, focus goes back to the composer, as after one", async ({ page }) => {
  const { answered } = await portal(page);
  await page.goto('/s/a');
  const composer = page.getByLabel('Message', { exact: true });
  await composer.focus();
  await caughtUp(page);
  await page.evaluate(() => {
    const stream = (window as any).streams.filter((s: any) => !s.closed).at(-1);
    stream.emit('message', { seq: -1, type: 'extension_ui_request', payload: { id: 'q1', method: 'confirm', title: 'First?', message: 'one' } });
    stream.emit('message', { seq: -2, type: 'extension_ui_request', payload: { id: 'q2', method: 'confirm', title: 'Second?', message: 'two' } });
  });
  await page.getByRole('dialog', { name: 'First?' }).getByRole('button', { name: 'Yes' }).click();
  // The second is drawn in the commit that removes the first, from the button that answered it.
  const second = page.getByRole('dialog', { name: 'Second?' });
  await expect(second).toBeVisible();
  await expect.poll(() => focusIn(page, 'Second?')).toBe(true);
  await second.getByRole('button', { name: 'Yes' }).click();
  await expect(second).toBeHidden();
  expect(answered).toEqual([{ id: 'q1', value: true }, { id: 'q2', value: true }]);
  await expect(composer).toBeFocused();
});

test("an extension's question whose answer failed gives focus back to the composer when a click beside it closes it", async ({ page }) => {
  const { answered } = await portal(page, { expired: true });
  await page.goto('/s/a');
  const composer = page.getByLabel('Message', { exact: true });
  await composer.focus();
  await caughtUp(page);
  await page.evaluate(() =>
    (window as any).streams.filter((s: any) => !s.closed).at(-1).emit('message', { seq: -1, type: 'extension_ui_request', payload: { id: 'q1', method: 'input', title: 'Name it' } }),
  );
  const dialog = page.getByRole('dialog', { name: 'Name it' });
  await dialog.getByRole('textbox').fill('x');
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('alert')).toHaveText('Expired.');
  // The question stays, with its error, until it is dismissed; a press beside it does that without a request.
  await page.mouse.click(3, 3);
  await expect(dialog).toBeHidden();
  expect(answered).toEqual([{ id: 'q1', value: 'x' }]);
  await expect(composer).toBeFocused();
});

test('the phone drawer is a dialog that keeps the keyboard, and is only that while it covers the page', async ({ page }) => {
  await portal(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/s/a');
  await caughtUp(page);
  const open = page.getByRole('button', { name: 'Open navigation', exact: true });
  await expect(page.getByRole('dialog', { name: 'Navigation' })).toHaveCount(0);
  await open.focus();
  await page.keyboard.press('Enter');
  const drawer = page.getByRole('dialog', { name: 'Navigation' });
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveAttribute('aria-modal', 'true');
  await expect.poll(() => focusIn(page, 'Navigation')).toBe(true);
  await goesRound(page, 'Navigation');
  await goesRound(page, 'Navigation', true);
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(open).toBeFocused();
  // Widened to a window that has the sidebar in place, the drawer is not left open round it.
  await page.keyboard.press('Enter');
  await expect(drawer).toBeVisible();
  await page.setViewportSize({ width: 1000, height: 812 });
  await expect(page.getByRole('dialog', { name: 'Navigation' })).toHaveCount(0);
  await expect(page.getByLabel('Sidebar', { exact: true })).toBeVisible();
});

test('Settings opened from the phone drawer, which closes with it, gives focus back to what opened the drawer', async ({ page }) => {
  await portal(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/s/a');
  await caughtUp(page);
  const open = page.getByRole('button', { name: 'Open navigation', exact: true });
  await open.focus();
  await page.keyboard.press('Enter');
  const drawer = page.getByRole('dialog', { name: 'Navigation' });
  await drawer.getByRole('button', { name: 'Settings', exact: true }).focus();
  await page.keyboard.press('Enter');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  await expect(drawer).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await expect(open).toBeFocused();
});

test("Settings opened from the model menu gives focus back to the model pill, not to the item that went with the menu", async ({ page }) => {
  await portal(page, { withModel: true });
  await page.goto('/s/a');
  await caughtUp(page);
  const pill = page.getByRole('button', { name: 'Model: Alpha', exact: true });
  await pill.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Add or change providers…' }).focus();
  await page.keyboard.press('Enter');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await expect(pill).toBeFocused();
});

test("closing the confirmation of a sidebar row's Delete with Escape puts focus on the row, whose buttons were drawn only while it had focus", async ({ page }) => {
  await portal(page);
  await page.goto('/s/a');
  await caughtUp(page);
  const row = page.getByLabel('Sidebar', { exact: true }).locator('[data-flip="a"]');
  await row.focus();
  await row.getByRole('button', { name: /^Delete/ }).focus();
  await page.keyboard.press('Enter');
  const question = page.getByRole('alertdialog');
  await expect(question).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(question).toBeHidden();
  await expect(row).toBeFocused();
});
