import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from '../../../../tests/browser/portal-mock';

test.use({ installed: ['extensions/terminal'] });

/**
 * The terminal's emulator (its Shell tab, a chunk of its own) is fetched when the tab is first opened, not with the
 * chat, and one that cannot be fetched (the extension was updated after the page was opened) is said so in its tab.
 */
const at = new Date().toISOString();
const chat = { id: 'a', title: 'Chat A', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: at, created_at: at, provider: null, model: null, thinking_level: null };

async function portal(page: Page) {
  await mockPortal(page, ({ path }) => {
    if (path === '/api/sessions') return { sessions: [chat], executor: 'host' };
    if (/^\/api\/sessions\/\w+$/.test(path)) return chat;
    if (path.endsWith('/config')) return { live: false, state: null, stats: null, thinking: { levels: [] }, models: { models: [] }, named: { provider: null, model: null } };
    if (path === '/api/workspaces') return { root: '/w', workspaces: [] };
    if (path === '/api/models') return { models: [], providers: {} };
  });
  const files: string[] = [];
  page.on('request', (r) => files.push(new URL(r.url()).pathname));
  return files;
}

/** The terminal's shell, which brings the terminal emulator: built into a chunk of its own. */
const SHELL = /\/api\/extension-ui\/pithagoras-terminal\/chunks\/Shell-[^/]+\.js$/;

test('the first draw of a chat does not fetch the terminal emulator', async ({ page }) => {
  const files = await portal(page);
  await page.goto('/s/a');
  // The terminal is there, and its shell is not fetched.
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
  expect(files.filter((f) => SHELL.test(f) || /@xterm/.test(f))).toEqual([]);
});

test("a terminal whose file cannot be fetched is said so in its own tab, and the chat stays", async ({ page }) => {
  await portal(page);
  await page.route(SHELL, (route) => route.fulfill({ status: 404, body: 'not found' }));
  await page.goto('/s/a');
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await page.getByRole('tab', { name: 'Your shell' }).click();
  const note = page.getByRole('alert').filter({ hasText: 'could not be loaded' });
  await expect(note).toBeVisible();
  await expect(note.getByRole('button', { name: 'Reload the portal' })).toBeVisible();
  // Not the whole chat taken with it: the message box is where it was.
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
});
