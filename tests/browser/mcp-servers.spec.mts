import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/** Settings → MCP over canned answers, with every save that was sent. */
async function portal(page: Page) {
  const saves: string[] = [];
  const mcp = {
    path: '/a/mcp.json', exists: true, clashes: [], raw: '{}', parseError: null,
    servers: [
      { name: 'github', entry: { url: 'https://mcp.example.test', auth: 'oauth', headers: { 'X-Org': 'a' } }, transport: 'http', disabled: false, problem: null, commands: [] },
      { name: 'notes', entry: { command: 'notes-mcp' }, transport: 'stdio', disabled: false, problem: null, commands: [] },
    ],
  };
  await mockPortal(page, ({ path, method, json }) => {
    if (path === '/api/mcp') return mcp;
    if (path.startsWith('/api/mcp/servers/') && method === 'PUT') {
      saves.push(`${path.slice('/api/mcp/servers/'.length)} from ${json().from}`);
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
