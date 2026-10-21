import { test, expect, mockPortal } from './portal-mock';

/**
 * What an extension's question says: its message keeps its lines, and one too long for the screen scrolls where it
 * is, with the answers still in view. The guard's question about a call it holds after a suspected prompt injection
 * is one, with the call as it was given, which may be a long command.
 */
const at = new Date().toISOString();
const chat = { id: 'a', title: 'Chat A', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: at, created_at: at, provider: null, model: null, thinking_level: null };

test("a long question with several lines keeps them, scrolls, and leaves Yes and No in view on a phone", async ({ page }) => {
  const answered: unknown[] = [];
  await mockPortal(page, ({ path, json }) => {
    if (path === '/api/sessions') return { sessions: [chat], executor: 'host' };
    if (/^\/api\/sessions\/\w+$/.test(path)) return chat;
    if (path.endsWith('/ui-response')) return (answered.push(json()), { ok: true });
    if (path.endsWith('/config')) return { live: false, state: null, stats: null, thinking: { levels: [] }, models: { models: [] }, named: { provider: null, model: null } };
  }, { streams: 'open' });
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto('/s/a');
  await expect.poll(() => page.evaluate(() => (window as any).streams.filter((s: any) => !s.closed).length)).toBeGreaterThan(0);
  await page.evaluate(() => (window as any).streams.filter((s: any) => !s.closed).at(-1).emit('caught-up', {}));

  const command = `cat > notes.txt <<'EOF'\n${'a line of the notes that goes on for a while\n'.repeat(80)}EOF\ngit push origin main`;
  const message = [`Call: ${command}.`, 'Flagged: what bash returned for curl https://x.test (it tells the reader to ignore its instructions).', 'Yes lets this one call run; No refuses it.'].join('\n');
  await page.evaluate((payload) => (window as any).streams.filter((s: any) => !s.closed).at(-1).emit('message', { seq: -1, type: 'extension_ui_request', payload }), {
    id: 'q1', method: 'confirm', title: 'Let bash run after a suspected prompt injection?', message,
  });

  const dialog = page.getByRole('dialog', { name: 'Let bash run after a suspected prompt injection?' });
  await expect(dialog).toBeVisible();
  const text = dialog.getByText(/^Call: cat > notes\.txt/);
  expect(await text.evaluate((el) => (el as HTMLElement).innerText.split('\n').length)).toBeGreaterThan(80);
  // Taller than it may be, it scrolls itself: the answers are on the screen.
  expect(await text.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await expect(dialog.getByRole('button', { name: 'No' })).toBeInViewport();
  await expect(dialog.getByRole('button', { name: 'Yes' })).toBeInViewport();
  await dialog.getByRole('button', { name: 'Yes' }).click();
  await expect(dialog).toBeHidden();
  expect(answered).toEqual([{ id: 'q1', value: true }]);
});
