import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply } from './portal-mock';

/**
 * Messages sent while the agent works wait in the chat. Up in the empty box brings the latest one back for
 * rewriting, and each has a button to delete it and one to send it now.
 */
const session = { id: 'a', title: 'Queued', workspace: '/w/site', status: 'running', kind: 'task', pinned: false };
const ev = (seq: number, type: string, payload: unknown) => ({ seq, type, at: Date.now(), payload });

/** The portal with a run going and two messages waiting behind it; the calls made to take them back are kept in `calls`. */
async function portal(page: Page, { refuse = false } = {}) {
  const calls: string[] = [];
  await mockPortal(page, async ({ path: p, method }) => {
    if (p === '/api/sessions') return { sessions: [session], executor: 'host' };
    if (p === '/api/sessions/a') return session;
    if (p.includes('/queued/')) {
      calls.push(`${method} ${p}`);
      if (refuse) return reply(409, { error: 'The agent has taken that message in already.' });
      return { ok: true };
    }
    if (p.endsWith('/config')) return { live: false, state: { model: { id: 'test', name: 'Test', provider: 'local' }, thinkingLevel: 'medium' }, stats: null, thinking: { levels: [] }, models: { models: [] } };
  }, { streams: 'open', setup: 'skipped', settings: true });
  await page.addInitScript(() => localStorage.setItem('sidebarCollapsed', 'true'));
  return calls;
}

const stream = (page: Page, events: unknown[]) =>
  page.evaluate((events) => {
    const s = (window as any).streams.filter((x: any) => !x.closed).at(-1);
    s.emit('reloads', { reloads: 0 });
    s.emit('versions', { versions: {} });
    s.emit('live-reset', {});
    for (const e of events as unknown[]) s.emit('message', e);
    s.emit('caught-up', {});
  }, events);

async function open(page: Page) {
  await page.goto('/s/a');
  await expect.poll(() => page.evaluate(() => (window as any).streams.filter((s: any) => !s.closed).length)).toBeGreaterThan(0);
  await stream(page, [
    ev(1, 'portal_prompt', { message: 'Refactor the parser' }),
    ev(2, 'portal_prompt', { message: 'Also rename the helper', queued: true, steer: true }),
    ev(3, 'portal_prompt', { message: 'And add a test', queued: true }),
  ]);
  await expect(page.getByText('And add a test')).toBeVisible();
}

const box = (page: Page) => page.getByLabel('Message', { exact: true });

test('up in the empty box brings the latest waiting message back, and it is taken back from the queue', async ({ page }) => {
  const calls = await portal(page);
  await open(page);
  await box(page).focus();
  await box(page).press('ArrowUp');
  await expect(box(page)).toHaveValue('And add a test');
  await expect.poll(() => calls).toEqual(['DELETE /api/sessions/a/queued/3']);

  // The server tells the page that it is gone from the chat.
  await page.evaluate(() => (window as any).streams.filter((x: any) => !x.closed).at(-1).emit('message', { seq: -1, type: 'portal_removed', at: Date.now(), payload: { from: 3, to: 4 } }));
  await expect(page.locator('[data-key]').getByText('And add a test')).toHaveCount(0);
  await expect(page.getByText('Also rename the helper')).toBeVisible();

  // Only in an empty box: with something typed, up moves the caret as it does.
  await box(page).press('ArrowUp');
  expect(calls).toHaveLength(1);
});

test('a waiting message has a button to delete it and one to send it now', async ({ page }) => {
  const calls = await portal(page);
  await open(page);
  const second = page.locator('[data-key]').filter({ hasText: 'Also rename the helper' });
  await second.getByRole('button', { name: 'Delete this waiting message' }).click();
  await expect.poll(() => calls).toEqual(['DELETE /api/sessions/a/queued/2']);
  const third = page.locator('[data-key]').filter({ hasText: 'And add a test' });
  await third.getByRole('button', { name: 'Stop the run and send this message now' }).click();
  await expect.poll(() => calls).toEqual(['DELETE /api/sessions/a/queued/2', 'POST /api/sessions/a/queued/3/send']);
});

test('a waiting message the agent has read already is left in the chat and the box stays empty', async ({ page }) => {
  const calls = await portal(page, { refuse: true });
  await open(page);
  await box(page).focus();
  await box(page).press('ArrowUp');
  await expect.poll(() => calls).toEqual(['DELETE /api/sessions/a/queued/3']);
  await expect(page.getByText('The agent has taken that message in already.')).toBeVisible();
  await expect(box(page)).toHaveValue('');
  await expect(page.getByText('And add a test')).toBeVisible();
});
