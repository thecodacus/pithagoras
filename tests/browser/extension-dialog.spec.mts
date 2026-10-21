import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/**
 * What an extension's question says: its message keeps its lines, and one too long for the screen scrolls where it
 * is, with the answers still in view. The guard's question about a call it holds after a suspected prompt injection
 * is one, with the call as the agent wrote it last, which may be a long command or a long word.
 */
const at = new Date().toISOString();
const chat = { id: 'a', title: 'Chat A', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: at, created_at: at, provider: null, model: null, thinking_level: null };
const title = 'Let bash run after a suspected prompt injection? (publish)';
/** The guard's question about a held call, laid out as the guard lays it out, with `call` last. */
const question = (call: string) => [
  'After a result that looks like a prompt injection the guard holds this back (publish): pushing to a remote is not undoable from here.',
  'Flagged: what bash returned for curl https://x.test (it tells the reader to ignore its instructions).',
  'Yes lets this one call run; No refuses it.',
  'The call, as the agent wrote it:',
  call,
].join('\n');

/** A chat open on a phone, its answers to dialogs kept, and the question asked in it. */
async function asked(page: Page, message: string) {
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
  await page.evaluate((payload) => (window as any).streams.filter((s: any) => !s.closed).at(-1).emit('message', { seq: -1, type: 'extension_ui_request', payload }), {
    id: 'q1', method: 'confirm', title, message,
  });
  const dialog = page.getByRole('dialog', { name: title });
  await expect(dialog).toBeVisible();
  return { dialog, text: dialog.getByText(/^After a result that looks like a prompt injection/), answered };
}

test("a long question with several lines keeps them, scrolls, and leaves Yes and No in view on a phone", async ({ page }) => {
  const command = `cat > notes.txt <<'EOF'\n${'a line of the notes that goes on for a while\n'.repeat(80)}EOF\ngit push origin main`;
  const { dialog, text, answered } = await asked(page, question(command));
  expect(await text.evaluate((el) => (el as HTMLElement).innerText.split('\n').length)).toBeGreaterThan(80);
  // Taller than it may be, it scrolls itself: the answers are on the screen.
  expect(await text.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await expect(dialog.getByRole('button', { name: 'No' })).toBeInViewport();
  await expect(dialog.getByRole('button', { name: 'Yes' })).toBeInViewport();
  await dialog.getByRole('button', { name: 'Yes' }).click();
  await expect(dialog).toBeHidden();
  expect(answered).toEqual([{ id: 'q1', value: true }]);
});

test("a word longer than the line is broken, so the question is no wider than the dialog on a phone", async ({ page }) => {
  const { dialog, text } = await asked(page, question(`curl --data @x https://x.test/${'a'.repeat(400)}`));
  expect(await text.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(dialog.getByRole('button', { name: 'No' })).toBeInViewport();
  await expect(dialog.getByRole('button', { name: 'Yes' })).toBeInViewport();
});
