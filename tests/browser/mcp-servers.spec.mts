import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply } from './portal-mock';

/** Settings → MCP over canned answers, with every save that was sent. */
async function portal(page: Page, extra: object[] = []) {
  const saves: string[] = [];
  const mcp = {
    path: '/a/mcp.json', exists: true, raw: '{}', parseError: null,
    servers: [
      { name: 'github', entry: { url: 'https://mcp.example.test', auth: 'oauth', headers: { 'X-Org': 'a' } }, transport: 'http', enabled: true, problem: null, ignored: null },
      { name: 'notes', entry: { command: 'notes-mcp' }, transport: 'stdio', enabled: true, problem: null, ignored: null },
      ...extra,
    ],
  };
  await mockPortal(page, ({ path, method, json }) => {
    if (path === '/api/mcp') return mcp;
    if (path.startsWith('/api/mcp/servers/') && method === 'PUT') {
      saves.push(`${path.slice('/api/mcp/servers/'.length)} from ${json().from}`);
      // What the server answers to a server that is on with a key pi does not read.
      if (path.endsWith('/gated') && json().entry?.enabled !== false) return reply(400, { error: 'pi does not read approveTools (tools that ask before each call), so a server that is on would run without it' });
      return { ok: true };
    }
  }, { settings: true });
  await page.goto('/settings/mcp');
  return { saves, dialog: page.getByRole('dialog', { name: 'Settings' }) };
}

test('a new server cannot take the name of one that is there: it is said, and nothing is saved', async ({ page }) => {
  const { saves, dialog } = await portal(page);
  await dialog.getByRole('button', { name: 'Add server' }).click();
  const name = dialog.getByPlaceholder('filesystem', { exact: true });
  await name.fill('github');
  await dialog.getByRole('textbox', { name: 'Command' }).fill('other');
  await expect(dialog.getByText('A server called github already exists')).toBeVisible();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByRole('alert')).toContainText('A server called github already exists');
  expect(saves).toEqual([]);
  // Another name is saved.
  await name.fill('github-two');
  await expect(dialog.getByText('A server called github-two already exists')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => saves).toEqual(['github-two from undefined']);
});

test('a server cannot be renamed onto another, and keeps its own name for an edit', async ({ page }) => {
  const { saves, dialog } = await portal(page);
  await dialog.getByRole('button', { name: /^notes/ }).first().click();
  const name = dialog.getByPlaceholder('filesystem', { exact: true });
  await name.fill('github');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByRole('alert')).toContainText('A server called github already exists');
  expect(saves).toEqual([]);
  // Its own name is no clash.
  await name.fill('notes');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => saves).toEqual(['notes from notes']);
});

test('a server the move left off for a key pi does not read says why in its row, and switching it on shows the refusal', async ({ page }) => {
  const gated = { name: 'gated', entry: { command: 'gated-mcp', approveTools: true, enabled: false }, transport: 'stdio', enabled: false, problem: null, ignored: 'approveTools (tools that ask before each call (approveTools), which pi does not do)' };
  const { saves, dialog } = await portal(page, [gated]);
  const row = dialog.getByRole('listitem').filter({ hasText: 'gated' });
  await expect(row).toContainText('pi does not read this: approveTools');
  await expect(row).toContainText('cannot be switched on');
  await expect(dialog.getByRole('listitem').filter({ hasText: 'notes' })).not.toContainText('pi does not read');
  await row.getByRole('checkbox').click();
  await expect(dialog.getByRole('alert')).toContainText('pi does not read approveTools');
  expect(saves).toEqual(['gated from gated']);
});

