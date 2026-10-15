import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const chat = (id: string, title: string, workspace: string, minutesAgo: number) =>
  ({ id, title, workspace, status: 'idle', kind: 'task', pinned: false, updated_at: at(minutesAgo), created_at: at(minutesAgo), provider: null, model: null, thinking_level: null });

const HOME = '/data/agent';

/** A portal with the project "site"; a chat's folder is a path no title or folder name contains. */
async function portal(page: Page, sessions: ReturnType<typeof chat>[]) {
  await mockPortal(page, ({ path: p, method }) => {
    if (p === '/api/sessions' && method === 'GET') return { sessions, executor: 'host' };
    if (/^\/api\/sessions\/\w+$/.test(p)) return sessions.find((s) => p.endsWith(s.id)) ?? sessions[0];
    if (p === '/api/projects') {
      return { root: '/w', home: HOME, projects: [{ name: 'site', path: '/w/site', isGit: false, hasInstructions: false, hasTools: false, sessions: 1, lastActive: null }] };
    }
    if (p.endsWith('/config')) return { live: false, state: null, stats: null, thinking: { levels: [] }, models: { models: [] }, named: { provider: null, model: null } };
    if (p === '/api/models') return { models: [], providers: {} };
  }, { streams: 'open', settings: true });
  await page.setViewportSize({ width: 1300, height: 800 });
}

const sidebar = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' });

test('the Sessions page names a chat\'s folder, never its path, and the search goes by the name', async ({ page }) => {
  await portal(page, [chat('s1', 'Fix login', '/w/site/docs', 5), chat('h1', 'Write report', HOME, 9)]);
  await page.goto('/sessions');
  const main = page.getByRole('main');
  await main.getByRole('button', { name: 'List the chats together' }).click();
  await expect(main.locator('[data-flip="s1"]').getByText('site', { exact: true })).toBeVisible();
  await expect(main.locator('[data-flip="h1"]').getByText('Home', { exact: true })).toBeVisible();
  await expect(page.getByText('/w/site', { exact: false })).toHaveCount(0);
  await expect(page.getByText(HOME, { exact: false })).toHaveCount(0);

  const search = main.getByPlaceholder('Search by name or folder…');
  // Words of the path that no folder name has: the chat must not turn up for them.
  await search.fill('docs');
  await expect(main.getByText('Nothing matches that.')).toBeVisible();
  await search.fill('/data');
  await expect(main.getByText('Nothing matches that.')).toBeVisible();
  // The name that is shown does.
  await search.fill('SITE');
  await expect(main.getByText('Fix login')).toBeVisible();
  await expect(main.getByText('Write report')).toHaveCount(0);
});

test('the Projects page shows a project by its name, with no path under it or on hover', async ({ page }) => {
  await portal(page, [chat('s1', 'Fix login', '/w/site', 5)]);
  await page.goto('/projects');
  await expect(page.getByRole('main').getByText('site', { exact: true })).toBeVisible();
  await expect(page.getByText('/w/site')).toHaveCount(0);
  await expect(page.locator('[title="/w/site"]')).toHaveCount(0);
});

test('the sidebar search matches the shown names only: a chat\'s path never finds it', async ({ page }) => {
  const many = Array.from({ length: 12 }, (_, i) => chat(`h${i}`, `Home chat ${i}`, HOME, i + 20));
  await portal(page, [...many, chat('s1', 'Quarterly numbers', '/w/site', 1)]);
  await page.goto('/sessions');
  const side = sidebar(page);
  const search = side.getByLabel('Search chats');
  // Gathered by folder, the folder's name is in front of the user and finds its chats.
  await search.fill('site');
  await expect(side.getByRole('group', { name: 'site' }).getByText('Quarterly numbers')).toBeVisible();
  // Words only the path has find nothing.
  await search.fill('data');
  await expect(side.getByText('Quarterly numbers')).toHaveCount(0);
  await expect(side.locator('[data-folder]')).toHaveCount(0);
  // One list shows no folder at all, so the folder's name finds nothing either.
  await search.fill('');
  await side.getByRole('button', { name: 'List the chats together' }).click();
  await search.fill('site');
  await expect(side.getByText('Quarterly numbers')).toHaveCount(0);
  await search.fill('quarterly');
  await expect(side.getByText('Quarterly numbers')).toBeVisible();
});

test('a pinned chat is not found by its folder\'s name, which the sidebar does not show next to it', async ({ page }) => {
  const many = Array.from({ length: 12 }, (_, i) => chat(`h${i}`, `Home chat ${i}`, HOME, i + 20));
  await portal(page, [...many, { ...chat('s1', 'Quarterly numbers', '/w/site', 1), pinned: true }, chat('s2', 'Fix login', '/w/site', 2)]);
  await page.goto('/sessions');
  const side = sidebar(page);
  const search = side.getByLabel('Search chats');
  await search.fill('site');
  // The unpinned chat sits under its folder heading, so the name finds it; the pinned one is in Pinned, with no folder.
  await expect(side.getByRole('group', { name: 'site' }).getByText('Fix login')).toBeVisible();
  await expect(side.getByText('Quarterly numbers')).toHaveCount(0);
  // Its title still does.
  await search.fill('quarterly');
  await expect(side.getByText('Quarterly numbers')).toBeVisible();
});
