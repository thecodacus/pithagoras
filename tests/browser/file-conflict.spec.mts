import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply } from './portal-mock';
import { DEFAULT_ORB } from '../../core/server/src/orb-style';

/**
 * The agent writes MEMORY.md and a project's AGENTS.md while their pages are
 * open: a save made from the older copy is refused by the server (409), and the
 * page says so, with a way to take the new text or to keep one's own.
 */
async function portal(page: Page, answer: (path: string, method: string, body: any) => { status?: number; json: unknown } | undefined) {
  const sent: { path: string; body: any }[] = [];
  await mockPortal(page, ({ path: p, method, json }) => {
    if (method === 'PUT') sent.push({ path: p, body: json() });
    const given = answer(p, method, method === 'PUT' ? json() : undefined);
    if (given) return reply(given.status ?? 200, given.json);
    if (p === '/api/agents') return { agents: [{ id: 'home', name: 'Nova', home: '/a', first: true, initialised: true, chats: 0, channels: [], orb: DEFAULT_ORB, voice: '', unread: 0 }] };
    if (p === '/api/agent/sessions') return { sessions: [], agentHome: '/a' };
    if (p === '/api/projects') return { root: '/w', home: '/h', projects: [{ name: 'demo', path: '/w/demo', isGit: false, hasInstructions: true, hasTools: false, sessions: 0, lastActive: null }] };
  }, { settings: true });
  return sent;
}

const CHANGED = 'The file changed after you opened it';

test("an agent's file saved from an older copy asks what to keep, and sends the time it was read at", async ({ page }) => {
  let on = { content: '# MEMORY.md\nold\n', mtime: 1000 };
  const files = () => ({ initialised: true, home: '/a', memory: 'file', files: [{ name: 'MEMORY.md', exists: true, ...on }] });
  const sent = await portal(page, (p, method, body) => {
    if (p === '/api/agents/home/setup') return { json: files() };
    if (p === '/api/agents/home/files/MEMORY.md' && method === 'PUT') {
      // The agent has written since: the page's time is not the file's.
      if (body.mtime !== undefined && body.mtime !== on.mtime) return { status: 409, json: { error: CHANGED } };
      on = { content: body.content + '\n', mtime: on.mtime + 10 };
      return { json: files() };
    }
  });
  await page.goto('/agents?agent=home&tab=files');
  const main = page.getByRole('main');
  await main.getByRole('button', { name: 'MEMORY.md' }).click();
  const box = main.locator('textarea');
  await expect(box).toHaveValue('# MEMORY.md\nold\n');

  // The agent adds decisions while the page is open.
  on = { content: '# MEMORY.md\nold\nthree decisions\n', mtime: 2000 };
  await box.fill('# MEMORY.md\nold, with a typo fixed');
  await main.getByRole('button', { name: 'Save' }).click();
  await expect(main.getByRole('alert')).toContainText('This file changed after you opened it.');
  expect(sent.at(-1)!.body).toEqual({ content: '# MEMORY.md\nold, with a typo fixed', mtime: 1000 });
  expect(on.content).toBe('# MEMORY.md\nold\nthree decisions\n');

  // The new version: what the agent wrote is shown, and the next save carries its time.
  await main.getByRole('button', { name: 'Load the new version' }).click();
  await expect(box).toHaveValue('# MEMORY.md\nold\nthree decisions\n');
  await expect(main.getByRole('alert')).toHaveCount(0);
  await box.fill('# MEMORY.md\nold\nthree decisions\nand a fourth');
  await main.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => sent.at(-1)!.body.mtime).toBe(2000);
  expect(on.content).toBe('# MEMORY.md\nold\nthree decisions\nand a fourth\n');

  // Changed again, and kept anyway: sent without a time.
  on = { content: 'the agent again\n', mtime: 3000 };
  await box.fill('mine');
  await main.getByRole('button', { name: 'Save' }).click();
  await expect(main.getByRole('alert')).toBeVisible();
  await main.getByRole('button', { name: 'Save mine anyway' }).click();
  await expect.poll(() => sent.at(-1)!.body).toEqual({ content: 'mine' });
  expect(on.content).toBe('mine\n');
  await expect(main.getByRole('alert')).toHaveCount(0);
});

test("a project's instructions saved from an older copy ask what to keep", async ({ page }) => {
  let on = { text: 'Use tabs.\n', mtime: 1000 };
  const sent = await portal(page, (p, method, body) => {
    if (p === '/api/projects/demo/instructions' && method === 'GET') return { json: on };
    if (p === '/api/projects/demo/instructions' && method === 'PUT') {
      if (body.mtime !== undefined && body.mtime !== on.mtime) return { status: 409, json: { error: CHANGED } };
      on = { text: body.text + '\n', mtime: on.mtime + 10 };
      return { json: { ok: true } };
    }
  });
  await page.goto('/projects');
  await page.getByRole('button', { name: 'Instructions for demo' }).click();
  const box = page.getByRole('dialog').getByLabel('Project instructions');
  await expect(box).toHaveValue('Use tabs.\n');

  on = { text: 'Use tabs.\nNever force-push.\n', mtime: 2000 };
  await box.fill('Use spaces.');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('alert')).toContainText('This file changed after you opened it.');
  expect(sent.at(-1)!.body).toEqual({ text: 'Use spaces.', mtime: 1000 });
  // The dialog stays open on the person's text.
  await expect(box).toHaveValue('Use spaces.');

  await page.getByRole('button', { name: 'Load the new version' }).click();
  await expect(box).toHaveValue('Use tabs.\nNever force-push.\n');
  await box.fill('Use tabs. Never force-push. Be brief.');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(sent.at(-1)!.body).toEqual({ text: 'Use tabs. Never force-push. Be brief.', mtime: 2000 });
});

test("\"Save mine anyway\" on a project's instructions sends no time", async ({ page }) => {
  let on = { text: 'Use tabs.\n', mtime: 1000 };
  const sent = await portal(page, (p, method, body) => {
    if (p === '/api/projects/demo/instructions' && method === 'GET') return { json: on };
    if (p === '/api/projects/demo/instructions' && method === 'PUT') {
      if (body.mtime !== undefined && body.mtime !== on.mtime) return { status: 409, json: { error: CHANGED } };
      on = { text: body.text + '\n', mtime: on.mtime + 10 };
      return { json: { ok: true } };
    }
  });
  await page.goto('/projects');
  await page.getByRole('button', { name: 'Instructions for demo' }).click();
  const box = page.getByRole('dialog').getByLabel('Project instructions');
  await expect(box).toHaveValue('Use tabs.\n');
  on = { text: 'changed by the agent\n', mtime: 2000 };
  await box.fill('mine');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Save mine anyway' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(sent.at(-1)!.body).toEqual({ text: 'mine' });
  expect(on.text).toBe('mine\n');
});

test("an agent's file buttons say which of them is open", async ({ page }) => {
  const files = { initialised: true, home: '/a', memory: 'file', files: [{ name: 'MEMORY.md', exists: true, content: '# MEMORY.md\n', mtime: 1000 }, { name: 'SOUL.md', exists: true, content: '# SOUL.md\n', mtime: 1000 }] };
  await portal(page, (p) => (p === '/api/agents/home/setup' ? { json: files } : undefined));
  await page.goto('/agents?agent=home&tab=files');
  const main = page.getByRole('main');
  const memory = main.getByRole('button', { name: 'MEMORY.md' });
  await expect(memory).toHaveAttribute('aria-pressed', 'false');
  await memory.click();
  await expect(memory).toHaveAttribute('aria-pressed', 'true');
  await expect(main.getByRole('button', { name: 'SOUL.md' })).toHaveAttribute('aria-pressed', 'false');
  // A second click closes it, as it always did.
  await memory.click();
  await expect(memory).toHaveAttribute('aria-pressed', 'false');
});

test("a save of an agent's file that the server refuses says so, and keeps what was typed", async ({ page }) => {
  const files = { initialised: true, home: '/a', memory: 'file', files: [{ name: 'SOUL.md', exists: true, content: '# SOUL.md\n', mtime: 1000 }] };
  await portal(page, (p, method) => {
    if (p === '/api/agents/home/setup') return { json: files };
    if (p === '/api/agents/home/files/SOUL.md' && method === 'PUT') return { status: 500, json: { error: 'No space left on device' } };
  });
  await page.goto('/agents?agent=home&tab=files');
  const main = page.getByRole('main');
  await main.getByRole('button', { name: 'SOUL.md' }).click();
  const box = main.locator('textarea');
  await box.fill('# SOUL.md\nBe kind.');
  await main.getByRole('button', { name: 'Save' }).click();
  await expect(main.getByRole('alert')).toHaveText('No space left on device');
  // The draft is still there to copy or to send again.
  await expect(box).toHaveValue('# SOUL.md\nBe kind.');
  await expect(main.getByRole('button', { name: 'Save' })).toBeEnabled();
});
