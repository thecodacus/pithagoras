import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply } from './portal-mock';

/**
 * What the shell around a chat does with what arrives: tokens drawn a frame at
 * a time, polls that find nothing new, a chat that is gone, and the questions an
 * extension asks one after the other.
 */
const at = new Date().toISOString();
const chat = (id: string, title: string) =>
  ({ id, title, workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: at, created_at: at, provider: null, model: null, thinking_level: null });

type Opts = { gone?: boolean; answer?: { ok: boolean; note?: string }; /** An answer to an extension is not given until this is. */ hold?: Promise<void> };

async function portal(page: Page, opts: Opts = {}) {
  const sessions = ['a', 'b', 'c', 'd'].map((id, i) => chat(id, `Chat ${'ABCD'[i]}`));
  const asked: Record<string, number> = {};
  const answered: unknown[] = [];
  await mockPortal(page, async ({ path: p, method, json }) => {
    if (method === 'GET') asked[p] = (asked[p] ?? 0) + 1;
    if (p === '/api/sessions') return { sessions, executor: 'host' };
    if (p === '/api/sessions/gone') return reply(404, { error: 'Session not found' });
    if (/^\/api\/sessions\/\w+$/.test(p)) return sessions.find((s) => p.endsWith('/' + s.id));
    if (p.endsWith('/ui-response')) {
      answered.push(json());
      await opts.hold;
      return opts.answer ?? { ok: true };
    }
    if (p.endsWith('/config')) return { live: false, state: null, stats: null, thinking: { levels: [] }, models: { models: [] }, named: { provider: null, model: null } };
  }, { streams: 'none', settings: true });
  await page.addInitScript(() => {
    // The page's animations are on here: the sidebar measures its rows only then.
    localStorage.removeItem('animations');
    (window as any).hide = (hidden: boolean) => {
      (window as any).hidden = hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    };
    Object.defineProperty(document, 'hidden', { get: () => !!(window as any).hidden });
    Object.defineProperty(document, 'visibilityState', { get: () => ((window as any).hidden ? 'hidden' : 'visible') });
    // How often a row of the sidebar's list was measured: it is, after each draw of the sidebar.
    (window as any).measured = 0;
    const rect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.hasAttribute('data-flip')) (window as any).measured++;
      return rect.call(this);
    };
    const streams: any[] = ((window as any).streams = []);
    (window as any).EventSource = class {
      url: string; closed = false; onmessage: any; onopen: any; onerror: any;
      listeners: Record<string, ((e: any) => void)[]> = {};
      constructor(url: string) {
        this.url = url;
        streams.push(this);
        // The chat that is gone has no stream to give: it fails, and keeps on failing.
        setTimeout(() => (/\/gone\//.test(url) ? this.onerror?.() : this.onopen?.()), 0);
      }
      addEventListener(name: string, fn: (e: any) => void) { (this.listeners[name] ??= []).push(fn); }
      close() { this.closed = true; }
      emit(name: string, data: unknown) {
        const e = { data: JSON.stringify(data) };
        if (name === 'message') this.onmessage?.(e);
        else (this.listeners[name] ?? []).forEach((fn) => fn(e));
      }
    };
  });
  return { asked, answered };
}

/** Says `data` to the open chat's stream, as the server would. */
const say = (page: Page, event: unknown) =>
  page.evaluate((e) => (window as any).streams.filter((s: any) => !s.closed).at(-1).emit('message', e), event);
/** Waits for the chat's stream, and says its history has come. */
async function caughtUp(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as any).streams.filter((s: any) => !s.closed).length)).toBeGreaterThan(0);
  await page.evaluate(() => (window as any).streams.filter((s: any) => !s.closed).at(-1).emit('caught-up', {}));
}
const measured = (page: Page) => page.evaluate(() => (window as any).measured as number);

test('a reply arriving token by token is drawn a frame at a time, and the sidebar is not measured for any of them', async ({ page }) => {
  await portal(page);
  await page.goto('/s/a');
  await expect(page.getByRole('complementary', { name: 'Sidebar' }).getByText('Chat B')).toBeVisible();
  await caughtUp(page);
  await expect(page.locator('[data-transcript]')).toBeVisible();
  const before = await measured(page);

  const draws = await page.evaluate(async () => {
    const es = (window as any).streams.filter((s: any) => !s.closed).at(-1);
    let n = 0;
    new MutationObserver(() => n++).observe(document.querySelector('[data-transcript]')!, { childList: true, subtree: true, characterData: true });
    // One task per token, as a connection delivers them.
    for (let i = 0; i < 300; i++) {
      es.emit('message', { seq: -1 - i, type: 'message_update', at: Date.now(), payload: { streamId: 'r1', assistantMessageEvent: { type: 'text_delta', delta: `w${i} ` } } });
      await new Promise((r) => setTimeout(r, 0));
    }
    return n;
  });
  await expect(page.locator('[data-transcript]')).toContainText('w299');
  await expect(page.locator('[data-transcript]')).toContainText('w0 w1 w2');
  // Not 300 draws of the chat for 300 tokens.
  expect(draws).toBeLessThan(200);
  // Nor 300 times each row of the sidebar looked at.
  expect(await measured(page) - before).toBeLessThan(30);
});

test('a reply ending replaces what was written so far, also when the end comes right behind the last token', async ({ page }) => {
  await portal(page);
  await page.goto('/s/a');
  await caughtUp(page);
  await say(page, { seq: -1, type: 'message_update', at: Date.now(), payload: { streamId: 'r1', assistantMessageEvent: { type: 'text_delta', delta: 'Half an ans' } } });
  await say(page, { seq: -2, type: 'message_update', at: Date.now(), payload: { streamId: 'r1', assistantMessageEvent: { type: 'text_delta', delta: 'wer' } } });
  await say(page, { seq: 7, type: 'message_end', at: Date.now(), payload: { streamId: 'r1', message: { role: 'assistant', content: [{ type: 'text', text: 'The whole answer.' }] } } });
  await expect(page.locator('[data-transcript]')).toContainText('The whole answer.');
  await expect(page.locator('[data-transcript]')).not.toContainText('Half an answer');
  await expect(page.locator('[data-transcript]').getByText('The whole answer.')).toHaveCount(1);
});

test('a poll that finds the chats as they were does not draw the sidebar again', async ({ page }) => {
  const { asked } = await portal(page);
  // Home and the projects as the page knew them from before, and as the portal says they are. Not known, they are
  // asked for once the chats are drawn, and their answer draws the sidebar again: late, that came after the count.
  await page.addInitScript(() => localStorage.setItem('knownPlaces', JSON.stringify({ home: '/h', agents: [], projects: [] })));
  await page.goto('/s/a');
  await expect(page.getByRole('complementary', { name: 'Sidebar' }).getByText('Chat B')).toBeVisible();
  await page.evaluate(() => (window as any).hide(true));
  const polled = asked['/api/sessions'];
  const before = await measured(page);
  // Coming back to the page asks for the list at once.
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => (window as any).hide(false));
    await expect.poll(() => asked['/api/sessions']).toBeGreaterThan(polled + i);
    await page.evaluate(() => (window as any).hide(true));
  }
  await page.waitForTimeout(200);
  expect(await measured(page)).toBe(before);
});

test('going from chat to chat does not ask for the list again, nor a chat for the feature flags at all', async ({ page }) => {
  const { asked } = await portal(page);
  await page.goto('/s/a');
  const side = page.getByRole('complementary', { name: 'Sidebar' });
  await expect(side.getByText('Chat B')).toBeVisible();
  const list = asked['/api/sessions'];
  for (const name of ['Chat B', 'Chat C', 'Chat D']) {
    await side.getByText(name).click();
    await expect(page.getByRole('heading', { name })).toBeVisible();
  }
  // What a chat's menus once asked of them (whether the subagent tool was on) is the subagent extension's to draw.
  expect([asked['/api/features/flags'] ?? 0, asked['/api/sessions']]).toEqual([0, list]);
});

test('a chat the portal has none of says so, and is not retried as a lost connection', async ({ page }) => {
  await portal(page);
  await page.goto('/s/gone');
  await expect(page.getByText('This chat no longer exists.')).toBeVisible();
  await expect(page.getByText('Pick a session from the list.')).toHaveCount(0);
  // Where two failures in a row would have said so, and the stream been tried again.
  await page.waitForTimeout(2600);
  await expect(page.getByText(/Lost the connection/)).toHaveCount(0);
  const tried = await page.evaluate(() => (window as any).streams.length);
  await page.waitForTimeout(2600);
  expect(await page.evaluate(() => (window as any).streams.length)).toBe(tried);
  await page.getByRole('button', { name: 'Back to Sessions' }).click();
  await expect(page).toHaveURL(/\/sessions$/);
});

test('the next question of an extension starts empty, whatever the last one was answered or failed with', async ({ page }) => {
  const { answered } = await portal(page, { answer: { ok: false, note: 'This one has expired' } });
  await page.goto('/s/a');
  await caughtUp(page);
  await say(page, { seq: -1, type: 'extension_ui_request', payload: { id: 'q1', method: 'input', title: 'First question' } });
  await say(page, { seq: -2, type: 'extension_ui_request', payload: { id: 'q2', method: 'input', title: 'Second question', defaultValue: 'proposal' } });
  const dialog = page.getByRole('dialog', { name: 'First question' });
  await dialog.getByRole('textbox').fill('my draft');
  await dialog.getByRole('button', { name: 'Submit' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('This one has expired');
  expect(answered).toEqual([{ id: 'q1', value: 'my draft' }]);
  // The extension gives that question up: the next is another one.
  await say(page, { seq: -3, type: 'extension_ui_cancel', payload: { id: 'q1' } });
  const next = page.getByRole('dialog', { name: 'Second question' });
  await expect(next.getByRole('textbox')).toHaveValue('proposal');
  await expect(next.getByRole('alert')).toHaveCount(0);
});

test('the answer to a yes-or-no question of an extension looks disabled while it is being sent', async ({ page }) => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  const { answered } = await portal(page, { hold });
  await page.goto('/s/a');
  await caughtUp(page);
  await say(page, { seq: -1, type: 'extension_ui_request', payload: { id: 'q1', method: 'confirm', title: 'Go ahead?', message: 'It will take a minute' } });
  const dialog = page.getByRole('dialog', { name: 'Go ahead?' });
  const yes = dialog.getByRole('button', { name: 'Yes' });
  await expect(yes).toBeEnabled();
  await yes.click();
  await expect.poll(() => answered.length).toBe(1);
  await expect(yes).toBeDisabled();
  // Dimmed like the other buttons of the settings and the dialogs, not left looking pressable.
  await expect(yes).toHaveCSS('opacity', '0.4');
  release();
  await expect(dialog).toHaveCount(0);
});
