import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/**
 * What the first draw has to fetch: the shell and the chat, not the other
 * pages or the dialogs that open over it. (The dev server serves each module
 * as a file of its own, so what was asked for says what the entry reached.)
 */
const at = new Date().toISOString();
const chat = { id: 'a', title: 'Chat A', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: at, created_at: at, provider: null, model: null, thinking_level: null };

async function portal(page: Page, more: (path: string) => unknown = () => undefined) {
  await mockPortal(page, ({ path }) => {
    const given = more(path);
    if (given !== undefined) return given as never;
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

const PAGES = /\/components\/(SessionsPage|ProjectsPage|AgentPage|RoutinesPage|AuditPanel|SetupAssistant)\.tsx$/;
test('the first draw does not fetch the other pages, and a page is fetched when it is opened', async ({ page }) => {
  const files = await portal(page);
  await page.goto('/s/a');
  await expect(page.getByRole('complementary', { name: 'Sidebar' }).getByText('Chat A')).toBeVisible();
  expect(files.filter((f) => PAGES.test(f))).toEqual([]);

  await page.getByRole('button', { name: 'Sessions', exact: true }).first().click();
  await expect(page).toHaveURL(/\/sessions$/);
  await expect(page.getByRole('heading', { name: 'Sessions' }).first()).toBeVisible();
  expect(files.some((f) => /\/components\/SessionsPage\.tsx$/.test(f))).toBe(true);
  // Only that one.
  expect(files.filter((f) => PAGES.test(f))).toHaveLength(1);
});

test('a dialog whose file cannot be fetched is said so over the portal, which stays, and can be closed', async ({ page }) => {
  await portal(page);
  // After an update the old file is gone: the server answers 404, and the import fails.
  await page.route(/\/components\/(ConfigModal|SetupAssistant)\.tsx/, (route) => route.fulfill({ status: 404, body: 'not found' }));
  await page.goto('/s/a/settings/general');
  const dialog = page.getByRole('dialog', { name: 'Could not be opened' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Reload the portal' })).toBeVisible();
  // Not a blank page: the shell, with its chats, is where it was.
  await expect(page.getByRole('complementary', { name: 'Sidebar' }).getByText('Chat A')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/s\/a$/);
  await expect(page.getByRole('complementary', { name: 'Sidebar' }).getByText('Chat A')).toBeVisible();
});

test('a page whose file cannot be fetched offers a reload, and no new try that could only fail again', async ({ page }) => {
  await portal(page);
  await page.route(/\/components\/SessionsPage\.tsx/, (route) => route.fulfill({ status: 404, body: 'not found' }));
  await page.goto('/sessions');
  const note = page.getByRole('alert').filter({ hasText: 'could not be loaded' });
  await expect(note).toBeVisible();
  await expect(note.getByRole('button', { name: 'Reload the portal' })).toBeVisible();
  await expect(note.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  // A page that threw while drawing is another matter: it can be tried again.
  await expect(page.getByRole('complementary', { name: 'Sidebar' }).getByText('Chat A')).toBeVisible();
});

test('a panel that throws says what went wrong, not that the portal was updated', async ({ page }) => {
  // An answer one version apart from the page: the address of pi's settings is missing.
  await portal(page, (path) => (path === '/api/settings' ? { executor: 'host' } : undefined));
  await page.goto('/s/a/settings/about');
  const dialog = page.getByRole('dialog', { name: 'Could not be opened' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('ran into a problem');
  await expect(dialog).toContainText(/Cannot read properties|undefined/);
  await expect(dialog).not.toContainText('updated');
  await expect(dialog.getByRole('button', { name: 'Reload the portal' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
});
