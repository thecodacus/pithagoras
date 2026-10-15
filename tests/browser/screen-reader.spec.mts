import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply } from './portal-mock';

/**
 * What a screen reader is told that a sighted person sees without being told: that a run has finished, which command
 * the arrow keys are on in the list, and that something went wrong.
 */

const session = { id: 'demo', title: 'A chat', workspace: '/workspaces/demo', status: 'idle', kind: 'task', pinned: false };
const other = { ...session, id: 'other', title: 'Another chat' };
const commands = [
  { name: 'compact', description: 'Summarise the conversation', source: 'builtin', where: 'server' },
  { name: 'settings', description: 'Open settings', source: 'builtin', where: 'client' },
  { name: 'skill:review', description: 'Review the change', source: 'skill' },
];

/** What the portal says the chat is doing: the list and the chat answer with it, as they do once the run has started. */
const live = { status: 'idle' };

async function portal(page: Page, opts: { password?: boolean } = {}) {
  live.status = 'idle';
  await mockPortal(page, ({ path: p, method }) => {
    if (opts.password && p === '/api/auth/status') return { authRequired: true, authed: false };
    if (opts.password && p === '/api/auth/login') return reply(401, { error: 'Wrong password' });
    if (p === '/api/sessions') return { sessions: [{ ...session, status: live.status }, other], executor: 'host' };
    if (p === `/api/sessions/${session.id}`) return { ...session, status: live.status };
    if (p === `/api/sessions/${other.id}`) return other;
    if (p.endsWith('/commands')) return { commands };
    if (p.endsWith('/config')) return { live: false, state: { model: { id: 'test', name: 'Test', provider: 'local' }, thinkingLevel: 'medium' }, stats: null, thinking: { levels: [] }, models: { models: [] } };
    if (method !== 'GET' && p.endsWith('/prompt')) return { ok: true };
  }, { streams: 'open', setup: 'skipped', settings: true });
  await page.addInitScript(() => localStorage.setItem('sidebarCollapsed', 'true'));
}

/** Says `event` to the open chat's stream, as the server would. */
const say = (page: Page, event: { type: string; payload?: unknown }, seq: number) => {
  const status = (event.payload as { status?: string } | undefined)?.status;
  if (event.type === 'portal_status' && status) live.status = status;
  return page.evaluate(([e, n]) => (window as any).streams.filter((s: any) => !s.closed).at(-1).emit('message', { ...(e as object), seq: n, at: Date.now() }), [event, seq] as const);
};

async function opened(page: Page) {
  await page.goto('/s/demo');
  await expect.poll(() => page.evaluate(() => (window as any).streams.filter((s: any) => !s.closed).length)).toBeGreaterThan(0);
  await page.evaluate(() => (window as any).streams.filter((s: any) => !s.closed).at(-1).emit('caught-up', {}));
}

/** The hidden line a run's end is said on; the "Working" line beside it is another status. */
const announcer = (page: Page) => page.locator('[data-transcript] [role=status].sr-only');

test('a run that ends is announced once, with the start of what it answered', async ({ page }) => {
  await portal(page);
  await opened(page);
  await expect(announcer(page)).toHaveText('');
  await say(page, { type: 'portal_status', payload: { status: 'running' } }, 1);
  await say(page, { type: 'message_end', payload: { streamId: 'r1', message: { role: 'assistant', content: [{ type: 'text', text: 'The build is green.' }] } } }, 2);
  // While it runs nothing is said: the words are not read out as they arrive.
  await expect(announcer(page)).toHaveText('');
  // The status comes at once, and the reply is drawn a frame later: it is the reply that is said, not the lack of one.
  await say(page, { type: 'portal_status', payload: { status: 'idle' } }, 3);
  await expect(announcer(page)).toHaveText('The build is green.');
});

test('a run that ended is not announced again when its chat is opened again', async ({ page }) => {
  await portal(page);
  await opened(page);
  await say(page, { type: 'portal_status', payload: { status: 'running' } }, 1);
  await say(page, { type: 'message_end', payload: { streamId: 'r1', message: { role: 'assistant', content: [{ type: 'text', text: 'The build is green.' }] } } }, 2);
  await say(page, { type: 'portal_status', payload: { status: 'idle' } }, 3);
  await expect(announcer(page)).toHaveText('The build is green.');

  // Another chat, and back by the browser's own way, which keeps the page and its state.
  const go = (to: string) => page.evaluate((url) => { history.pushState({}, '', url); dispatchEvent(new PopStateEvent('popstate')); }, to);
  await go('/s/other');
  await expect(page.getByRole('heading', { name: 'Another chat' }).first()).toBeVisible();
  await go('/s/demo');
  await expect(page.getByRole('heading', { name: 'A chat' }).first()).toBeVisible();
  // Said once. What was said then is not said as news now, and not a moment later either.
  await expect(announcer(page)).toHaveText('');
  await page.waitForTimeout(400);
  await expect(announcer(page)).toHaveText('');
});

test('a run that ends without a reply says so', async ({ page }) => {
  await portal(page);
  await opened(page);
  await say(page, { type: 'portal_status', payload: { status: 'running' } }, 1);
  await say(page, { type: 'portal_status', payload: { status: 'idle' } }, 2);
  await expect(announcer(page)).toHaveText('The run has finished.');
});

test('the message box points at the command the arrows are on', async ({ page }) => {
  await portal(page);
  await opened(page);
  const box = page.getByLabel('Message', { exact: true });
  await expect(box).not.toHaveAttribute('aria-controls', /.+/);
  await box.fill('/');
  const list = page.getByRole('listbox', { name: 'Commands' });
  await expect(list.getByRole('option')).toHaveCount(3);
  // The list is the box's, and the picked command is the one a reader says.
  const listId = await list.getAttribute('id');
  await expect(box).toHaveAttribute('aria-controls', listId!);
  await expect(box).toHaveAttribute('aria-autocomplete', 'list');
  const active = async () => page.evaluate(() => {
    const id = document.querySelector('[aria-label="Message"]')!.getAttribute('aria-activedescendant');
    return id ? document.getElementById(id)?.textContent ?? '' : null;
  });
  expect(await active()).toContain('compact');
  await box.press('ArrowDown');
  await expect.poll(active).toContain('settings');
  await box.press('ArrowDown');
  await expect.poll(active).toContain('skill:review');
  await box.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(box).not.toHaveAttribute('aria-activedescendant', /.+/);
});

test('a failure in the chat is an alert', async ({ page }) => {
  await page.route('**/api/sessions/demo/abort', (r) => r.fulfill({ status: 500, json: { error: 'Nothing to stop' } }));
  await portal(page);
  await opened(page);
  await say(page, { type: 'portal_status', payload: { status: 'running' } }, 1);
  // Escape in the box stops the run.
  await page.getByLabel('Message', { exact: true }).press('Escape');
  await expect(page.getByRole('alert')).toContainText('Nothing to stop');
});

test('a wrong password is an alert that the field points to', async ({ page }) => {
  await portal(page, { password: true });
  await page.goto('/');
  await page.getByLabel('Password').fill('nope');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Wrong password');
  await expect(page.getByLabel('Password')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Password')).toHaveAccessibleDescription('Wrong password');
});
