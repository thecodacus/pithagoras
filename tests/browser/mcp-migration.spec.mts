import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/**
 * The note the first start after the move to pi's own MCP support leaves (core/server/src/mcp-migration-run.ts): a line at
 * the top of the page until it is read, and the report under Settings → MCP, which stays.
 */
const REPORT = {
  v: 1, status: 'done', at: '2026-11-14T10:00:00.000Z',
  adapter: { was: 'on', removed: true, spec: 'npm:pi-mcp-adapter@2.18.0' },
  file: { state: 'converted', copy: 'mcp.json.adapter' },
  servers: [
    { name: 'github', state: 'on', why: [], notes: ['lifecycle: eager dropped: it has no counterpart'] },
    { name: 'docs.v2', renamedTo: 'docs_v2', state: 'on', why: [], notes: ["renamed to docs_v2: pi's server names have no dots"] },
    { name: 'secrets', state: 'off', why: ['env.KEY starts with !, which pi runs as a command, and the adapter\'s file never asked it to'], notes: [] },
    { name: 'mux', state: 'off', why: ['it is reached through an rmcp-mux socket, which pi cannot do (stdio and HTTP only)'], notes: [] },
  ],
  names: { converted: 12 },
  expanded: [],
  unconverted: [{ where: 'chat s2', name: 'github_delete_everything', why: 'not carried over (no cache of the adapter lists a tool of that name): github switched off' }],
  untrusted: [],
  texts: [{ where: 'routine morning', names: ['github_get_file'] }],
  projects: [{ folder: '/work/one', adapterSettings: true, mcpJson: true, foreign: ['.mcp.json'] }],
  gone: ['imports: cursor'],
  notes: [],
};

async function portal(page: Page, migration: { report: unknown; notice: boolean } | null, path = '/', imports: Record<string, unknown> = {}) {
  const sent: string[] = [];
  const mcp = { path: '/a/mcp.json', exists: true, clashes: [], raw: '{}', parseError: null, servers: [] };
  let view = migration ? { ...migration } : { report: null, notice: false };
  await mockPortal(page, ({ path: url, method, json }) => {
    if (url === '/api/mcp') return mcp;
    if (url === '/api/mcp/migration' && method === 'GET') return view;
    if (url === '/api/mcp/import-folder' && method === 'POST') {
      const { folder, file } = json();
      sent.push(`import ${folder} ${file}`);
      return imports[file] ?? { ok: true, added: [], skipped: [], commands: {} };
    }
    if (url === '/api/mcp/migration/notice' && method === 'DELETE') {
      sent.push(method);
      view = { ...view, notice: false };
      return { ok: true };
    }
  }, { settings: true });
  await page.goto(path);
  return { sent, dialog: page.getByRole('dialog', { name: 'Settings' }) };
}

test('the first start after the move says so at the top, with the number it switched off, and Review opens the report', async ({ page }) => {
  const { dialog } = await portal(page, { report: REPORT, notice: true });
  const line = page.getByRole('status').filter({ hasText: "pi's own MCP support" });
  await expect(line).toContainText('2 carried over, 2 switched off until you have looked at them');
  await line.getByRole('button', { name: 'Review' }).click();
  await expect(page).toHaveURL(/\/settings\/mcp$/);
  const report = dialog.getByRole('region', { name: "Moved to pi's own MCP support" });
  await expect(report).toContainText('4 servers were carried over');
  await expect(report).toContainText('The file as it was is kept beside it as mcp.json.adapter');
  await expect(report.getByText('secrets: env.KEY starts with !')).toBeVisible();
  await expect(report.getByText('mux: it is reached through an rmcp-mux socket')).toBeVisible();
  await expect(report.getByText('docs.v2 → docs_v2')).toBeVisible();
  await expect(report.getByText('chat s2: github_delete_everything')).toBeVisible();
  await expect(report.getByText('routine morning: github_get_file')).toBeVisible();
  await expect(report.getByText('/work/one — lists the adapter — has .pi/mcp.json — .mcp.json')).toBeVisible();
  await expect(report.getByText('github: lifecycle: eager dropped')).toBeVisible();
});

test('dismissing it takes the line away and keeps the report under Settings → MCP', async ({ page }) => {
  const { sent, dialog } = await portal(page, { report: REPORT, notice: true });
  const line = page.getByRole('status').filter({ hasText: "pi's own MCP support" });
  await line.getByRole('button', { name: 'Dismiss' }).click();
  await expect.poll(() => sent).toEqual(['DELETE']);
  await expect(line).toHaveCount(0);
  await page.goto('/settings/mcp');
  const report = dialog.getByRole('region', { name: "Moved to pi's own MCP support" });
  await expect(report).toBeVisible();
  // Read already: nothing to dismiss in it.
  await expect(report.getByRole('button', { name: 'Dismiss' })).toHaveCount(0);
});

test('a report the person has read leaves no line, and a portal that had nothing to move has neither', async ({ page }) => {
  await portal(page, { report: REPORT, notice: false });
  await expect(page.getByRole('status').filter({ hasText: "pi's own MCP support" })).toHaveCount(0);
  await page.goto('/settings/mcp');
  await expect(page.getByRole('region', { name: "Moved to pi's own MCP support" })).toBeVisible();
});

test('with nothing to move there is no line and no report', async ({ page }) => {
  const { dialog } = await portal(page, null, '/settings/mcp');
  await expect(dialog.getByText('Config file')).toBeVisible();
  await expect(dialog.getByRole('region', { name: "Moved to pi's own MCP support" })).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: "pi's own MCP support" })).toHaveCount(0);
});

test('a file that cannot be read says that nothing was moved, and the dismiss in the report is the same one', async ({ page }) => {
  const pending = { ...REPORT, status: 'pending', servers: [], file: { state: 'unreadable', note: 'Unexpected end of JSON input' } };
  const { sent, dialog } = await portal(page, { report: pending, notice: true });
  const line = page.getByRole('status').filter({ hasText: "pi's own MCP support" });
  await expect(line).toContainText('mcp.json cannot be read');
  await line.getByRole('button', { name: 'Review' }).click();
  const report = dialog.getByRole('region', { name: "Moved to pi's own MCP support" });
  await expect(report).toContainText('mcp.json cannot be read: Unexpected end of JSON input. Nothing was changed');
  await report.getByRole('button', { name: 'Dismiss' }).click();
  await expect.poll(() => sent).toEqual(['DELETE']);
  await expect(line).toHaveCount(0);
});

test("a folder's own MCP files are taken into the user's configuration from the report, and what came of it is said", async ({ page }) => {
  const { sent, dialog } = await portal(page, { report: REPORT, notice: false }, '/settings/mcp', {
    '.pi/mcp.json': { ok: true, added: ['tracker'], skipped: [{ name: 'override', reason: 'server "override" needs "command" or "url"' }], commands: {} },
    '.mcp.json': { ok: true, added: [], skipped: [{ name: 'local', reason: 'A server called local already exists' }], commands: {} },
  });
  const report = dialog.getByRole('region', { name: "Moved to pi's own MCP support" });
  await report.getByRole('button', { name: 'Import .pi/mcp.json of /work/one into the user config' }).click();
  await expect(report.getByRole('status')).toContainText('Added tracker, switched off: look at what each one runs, then switch it on.');
  await expect(report.getByRole('status')).toContainText('Skipped override: server "override" needs "command" or "url"');
  await report.getByRole('button', { name: 'Import .mcp.json of /work/one into the user config' }).click();
  await expect(report.getByText('Skipped local: A server called local already exists')).toBeVisible();
  expect(sent).toEqual(['import /work/one .pi/mcp.json', 'import /work/one .mcp.json']);
});

test('a refusal of the import is said where the button is', async ({ page }) => {
  const { dialog } = await portal(page, { report: REPORT, notice: false }, '/settings/mcp', {});
  await page.route('**/api/mcp/import-folder', (route) => route.fulfill({ status: 404, json: { error: 'That folder is not in the report' } }));
  const report = dialog.getByRole('region', { name: "Moved to pi's own MCP support" });
  await report.getByRole('button', { name: 'Import .pi/mcp.json of /work/one into the user config' }).click();
  await expect(report.getByRole('alert')).toContainText('That folder is not in the report');
});
