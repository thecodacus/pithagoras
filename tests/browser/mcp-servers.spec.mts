import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/** Settings → MCP over canned answers, with every save that was sent. */
async function portal(page: Page) {
  const saves: string[] = [];
  const status = {
    github: { lazy: true, by: 'threshold', tools: { count: 38, tokens: 9200, at: 1, stale: false }, approve: ['delete_*'], trusted: false },
    notes: { mark: 'direct', lazy: false, by: 'mark', tools: null, approve: [], trusted: true },
  };
  const mcp = {
    path: '/a/mcp.json', exists: true, clashes: [], raw: '{}', parseError: null,
    servers: [
      { name: 'github', entry: { url: 'https://mcp.example.test', oauth: { clientId: 'portal-test' }, headers: { 'X-Org': 'a' } }, transport: 'http', disabled: false, problem: null, commands: [] },
      { name: 'notes', entry: { command: 'notes-mcp' }, transport: 'stdio', disabled: false, problem: null, commands: [] },
    ],
  };
  await mockPortal(page, ({ path, method, json }) => {
    if (path === '/api/mcp') return mcp;
    if (path === '/api/mcp/status') return { servers: status, limits: { tokens: 3000, tools: 20 } };
    if (path.startsWith('/api/mcp/servers/') && path.endsWith('/mark') && method === 'PUT') {
      saves.push(`mark ${path.split('/')[4]} ${json().mark}`);
      return { marks: {}, resolved: { lazy: [], over: false } };
    }
    if (path.startsWith('/api/mcp/servers/') && path.endsWith('/approve') && method === 'PUT') {
      saves.push(`approve ${path.split('/')[4]} ${json().approve.join('|')}`);
      return { approve: json().approve };
    }
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

test('each server says what a chat does with its tools and what is known of them, where the server is listed', async ({ page }) => {
  const { dialog } = await portal(page);
  const github = dialog.getByRole('button', { name: /^github/ }).first();
  await expect(github).toContainText("auto, lazy now: the model's list is over the limits · 38 tools, about 9,200 tokens · asks first: delete_*");
  const notes = dialog.getByRole('button', { name: /^notes/ }).first();
  await expect(notes).toContainText("direct: always in the model's list · never connected, so its tools are not known yet");
});

test("a server's mark and the tools that ask first are saved with the server, and only when they changed", async ({ page }) => {
  const { saves, dialog } = await portal(page);
  await dialog.getByRole('button', { name: /^github/ }).first().click();
  await expect(dialog.getByText("Now: auto, lazy now: the model's list is over the limits. 38 tools, about 9,200 tokens.")).toBeVisible();
  // Nothing changed: only the entry is saved.
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => saves).toEqual(['github from github']);
  await dialog.getByRole('button', { name: /^github/ }).first().click();
  await dialog.getByRole('radio', { name: 'Direct' }).click();
  await dialog.getByRole('textbox', { name: 'Ask before these tools' }).fill('delete_*\ncreate_*');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => saves).toEqual(['github from github', 'github from github', 'mark github direct', 'approve github delete_*|create_*']);
});

test('a renamed server has its mark and its questions said again under the new name', async ({ page }) => {
  const { saves, dialog } = await portal(page);
  await dialog.getByRole('button', { name: /^notes/ }).first().click();
  await dialog.getByPlaceholder('filesystem', { exact: true }).fill('memo');
  await dialog.getByRole('textbox', { name: 'Ask before these tools' }).fill('drop');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => saves).toEqual(['memo from notes', 'mark memo direct', 'approve memo drop']);
});
