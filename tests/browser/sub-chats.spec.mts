import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply } from './portal-mock';
import { DEFAULT_ORB } from '../../core/server/src/orb-style';

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const chat = (id: string, title: string, minutesAgo: number, extra: Record<string, unknown> = {}) =>
  ({ id, title, workspace: '/data/agent', status: 'idle', kind: 'task', pinned: false, updated_at: at(minutesAgo), created_at: at(minutesAgo), ...extra });
/** A sub-chat of `parent`, as the portal lists a child chat. */
const sub = (id: string, title: string, parent: string, minutesAgo: number, extra: Record<string, unknown> = {}) =>
  chat(id, title, minutesAgo, { parent, listed: true, ...extra });

/** A chat with two sub-chats, and a chat without any; the sub-chats changed last, so that a flat list would put them first. */
const family = () => [
  sub('links', 'Check the links', 'build', 1),
  sub('images', 'Shrink the images', 'build', 2),
  chat('build', 'Build the site', 10),
  chat('logo', 'Fix the logo', 20),
];

/** A portal with these chats, Home and the projects named; what is deleted is gone from the list it gives next. */
async function portal(page: Page, sessions: Record<string, unknown>[] = family(), projects: string[] = []) {
  const deleted: string[] = [];
  await mockPortal(page, ({ path: p, method }) => {
    const alive = (s: Record<string, unknown>) => !deleted.includes(s.id as string) && !deleted.includes(s.parent as string);
    // A child an extension keeps out of the list is found by its id only.
    if (p === '/api/sessions' && method === 'GET') return { sessions: sessions.filter((s) => alive(s) && s.listed !== false), executor: 'host' };
    const one = /^\/api\/sessions\/([^/]+)$/.exec(p);
    if (one && method === 'GET') {
      const found = sessions.find((s) => s.id === one[1] && alive(s));
      return found ?? reply(404, { error: 'No such session' });
    }
    const del = /^\/api\/sessions\/([^/]+)$/.exec(p);
    if (del && method === 'DELETE') {
      deleted.push(del[1]);
      return { ok: true };
    }
    if (p === '/api/projects') return { root: '/w', home: '/data/agent', projects: projects.map((name) => ({ name, path: `/w/${name}`, isGit: false, hasInstructions: false, sessions: 0, lastActive: null })) };
    if (p === '/api/models') return { models: [{ provider: 'x', id: 'm', name: 'M', reasoning: false }], providers: {} };
  }, { settings: true });
  return deleted;
}

const sidebar = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' });
const subChats = (scope: ReturnType<Page['locator']>, title: string) => scope.getByRole('group', { name: `Sub-chats of ${title}` });

test('a chat\'s sub-chats are under it in the sidebar, shut until opened, and stay as they were left', async ({ page }) => {
  await portal(page);
  await page.goto('/sessions');
  const side = sidebar(page);
  const toggle = side.getByRole('button', { name: '2 sub-chats' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(side.getByText('Check the links')).toHaveCount(0);
  // Listed on their own, the chats are only the two: the sub-chats are not rows among them.
  await expect(side.locator('[data-flip]')).toHaveCount(2);
  await expect(side.locator('[data-flip]').first()).toContainText('Build the site');

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const group = subChats(side, 'Build the site');
  await expect(group.locator('[data-flip]')).toHaveText(['Check the links', 'Shrink the images']);
  // Under its chat, a sub-chat has no pin: it is listed where its chat is.
  await group.getByText('Check the links').hover();
  await expect(group.getByRole('button', { name: 'Pin Check the links' })).toHaveCount(0);
  await expect(group.getByRole('button', { name: 'Delete Check the links' })).toBeVisible();

  await page.reload();
  await expect(side.getByRole('button', { name: '2 sub-chats' })).toHaveAttribute('aria-expanded', 'true');
  await side.getByRole('button', { name: '2 sub-chats' }).click();
  await page.reload();
  await expect(side.getByRole('button', { name: '2 sub-chats' })).toHaveAttribute('aria-expanded', 'false');
});

test('a chat shows as running while a sub-chat runs, with its sub-chats open, and as waiting for you while one asks', async ({ page }) => {
  await portal(page, [
    sub('links', 'Check the links', 'build', 1, { status: 'running' }),
    chat('build', 'Build the site', 10),
    sub('answer', 'Ask the owner', 'docs', 2, { asking: true }),
    chat('docs', 'Write the docs', 20, { status: 'running' }),
  ]);
  await page.goto('/sessions');
  const side = sidebar(page);
  const build = side.locator('[data-flip="build"]');
  await expect(build.getByRole('img', { name: 'running' })).toBeVisible();
  await expect(subChats(side, 'Build the site').getByText('Check the links')).toBeVisible();
  const docs = side.locator('[data-flip="docs"]');
  await expect(docs.getByRole('img', { name: 'waiting for you' })).toBeVisible();
  await expect(subChats(side, 'Write the docs').locator('[data-flip="answer"]').getByRole('img', { name: 'waiting for you' })).toBeVisible();
  // The Sessions page counts a chat as running while its sub-chat runs, and one that runs while its sub-chat asks.
  const main = page.getByRole('main');
  await expect(main.getByText('total').locator('..')).toContainText('2');
  await expect(main.getByText('running', { exact: true }).locator('..')).toContainText('2');
});

test('opening a sub-chat opens its chat\'s sub-chats, and its header leads back to its chat', async ({ page }) => {
  await portal(page);
  await page.goto('/s/images');
  const side = sidebar(page);
  await expect(side.getByRole('button', { name: '2 sub-chats' })).toHaveAttribute('aria-expanded', 'true');
  await expect(subChats(side, 'Build the site').locator('[data-flip="images"]')).toHaveAttribute('aria-current', 'page');
  const back = page.locator('.chat-header').getByRole('link', { name: 'Sub-chat of Build the site' });
  await back.click();
  await expect(page).toHaveURL(/\/s\/build$/);
  await expect(page.locator('.chat-header').getByRole('link')).toHaveCount(0);
});

test('the sidebar\'s limit and search count chats, not their sub-chats, and a search finds a sub-chat under its chat', async ({ page }) => {
  // Twelve chats fill the sidebar: their sub-chats neither push one of them out nor bring the search box.
  const chats = Array.from({ length: 12 }, (_, i) => chat(`c${i}`, `Chat ${i}`, 10 + i));
  await portal(page, [...chats, sub('s1', 'Sub one', 'c0', 1), sub('s2', 'Sub two', 'c0', 2)]);
  await page.goto('/sessions');
  const side = sidebar(page);
  await expect(side.locator('[data-flip]')).toHaveCount(12);
  await expect(side.getByRole('searchbox')).toHaveCount(0);
  await expect(side.getByText(/more…/)).toHaveCount(0);

  await portal(page, [...chats, chat('c12', 'Chat 12', 30), sub('s1', 'Sub one', 'c0', 1), sub('s2', 'Sub two', 'c0', 2)]);
  await page.reload();
  await expect(side.getByRole('button', { name: '1 more…' })).toBeVisible();
  await side.getByRole('searchbox', { name: 'Search chats' }).fill('sub two');
  await expect(side.locator('[data-flip]')).toHaveText(['Chat 0', 'Sub two']);
  await expect(subChats(side, 'Chat 0').getByText('Sub two')).toBeVisible();
});

test('a folder counts its chats without their sub-chats, and is marked running while one of those works', async ({ page }) => {
  await portal(page, family().map((s) => (s.id === 'logo' ? s : { ...s, workspace: '/w/site', ...(s.id === 'images' ? { status: 'running' } : {}) })), ['site']);
  await page.goto('/sessions');
  const side = sidebar(page);
  const site = side.locator('[data-folder="project:site"]');
  await expect(site.getByText('1 chat', { exact: true })).toBeAttached();
  await expect(site.getByRole('img', { name: 'running' })).toBeVisible();
  await site.getByRole('button', { name: 'site', exact: true }).click();
  // In it, the chat, and its sub-chats under it (open, as one of them works): none of them beside it.
  const inSite = side.getByRole('group', { name: 'site' });
  await expect(inSite.locator('[data-flip]')).toHaveCount(3);
  await expect(subChats(inSite, 'Build the site').locator('[data-flip]')).toHaveText(['Check the links', /Shrink the images/]);
});

test('the Sessions page lists sub-chats under their chat, and counts chats without them', async ({ page }) => {
  await portal(page);
  await page.goto('/sessions');
  const main = page.getByRole('main');
  await expect(main.getByText('total').locator('..')).toContainText('2');
  const toggle = main.getByRole('button', { name: '2 sub-chats' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(main.locator('li[data-flip]')).toHaveCount(2);
  await toggle.click();
  await expect(subChats(main, 'Build the site').locator('li[data-flip]')).toHaveCount(2);
  // Its own place to keep what was opened: the sidebar's stays shut.
  await expect(sidebar(page).getByRole('button', { name: '2 sub-chats' })).toHaveAttribute('aria-expanded', 'false');
  await main.getByPlaceholder('Search by name or folder…').fill('images');
  await expect(main.getByText('1 of 2')).toBeVisible();
  await expect(subChats(main, 'Build the site').locator('li[data-flip]')).toHaveText([/Shrink the images/]);
});

test('deleting a chat names the sub-chats that go with it, and takes them from the list', async ({ page }) => {
  const deleted = await portal(page);
  await page.goto('/sessions');
  const row = sidebar(page).locator('[data-flip="build"]');
  await row.hover();
  await row.getByRole('button', { name: 'Delete Build the site' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Its 2 sub-chats are deleted with it: "Check the links", "Shrink the images".');
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(sidebar(page).locator('[data-flip]')).toHaveText(['Fix the logo']);
  expect(deleted).toEqual(['build']);

  // A chat without sub-chats says nothing of them.
  await sidebar(page).locator('[data-flip="logo"]').hover();
  await sidebar(page).getByRole('button', { name: 'Delete Fix the logo' }).click();
  await expect(page.getByRole('alertdialog')).not.toContainText('sub-chat');
});

test('landing on / opens the newest chat of its own, not a sub-chat that changed after it', async ({ page }) => {
  await portal(page);
  await page.goto('/');
  await expect(page).toHaveURL(/\/s\/build$/);
});

test('deleting the open sub-chat leads to its chat, and deleting a chat with a sub-chat open leaves the sub-chat', async ({ page }) => {
  await portal(page);
  await page.goto('/s/links');
  const side = sidebar(page);
  const links = subChats(side, 'Build the site').locator('[data-flip="links"]');
  await links.hover();
  await links.getByRole('button', { name: 'Delete Check the links' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page).toHaveURL(/\/s\/build$/);

  // The chat itself deleted while a sub-chat is open: on to the next chat of its own, not left on a page that is gone.
  await page.goto('/s/images');
  const build = side.locator('[data-flip="build"]');
  await build.hover();
  await build.getByRole('button', { name: 'Delete Build the site' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page).toHaveURL(/\/s\/logo$/);
});

test('deleting a chat while one of its sub-chats that the lists leave out is open leaves that page too', async ({ page }) => {
  await portal(page, [...family(), sub('hidden', 'Looks it up', 'build', 3, { listed: false })]);
  await page.goto('/s/hidden');
  await expect(page.locator('.chat-header').getByRole('link', { name: 'Sub-chat of Build the site' })).toBeVisible();
  const build = sidebar(page).locator('[data-flip="build"]');
  await build.hover();
  await build.getByRole('button', { name: 'Delete Build the site' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page).toHaveURL(/\/s\/logo$/);
});

test('a folder past the eight it lists still lists the chat of the open sub-chat, with its sub-chats', async ({ page }) => {
  const chats = Array.from({ length: 9 }, (_, i) => chat(`c${i}`, `Chat ${i}`, 10 + i, { workspace: '/w/site' }));
  await portal(page, [...chats, sub('deep', 'Deep part', 'c8', 1, { workspace: '/w/site' })], ['site']);
  await page.goto('/s/deep');
  const inSite = sidebar(page).getByRole('group', { name: 'site' });
  await expect(inSite.locator('[data-flip="c8"]')).toBeVisible();
  await expect(subChats(inSite, 'Chat 8').locator('[data-flip="deep"]')).toHaveAttribute('aria-current', 'page');
});

test('a search of one folder on the Sessions page finds a sub-chat under its chat', async ({ page }) => {
  await portal(page, family().map((s) => ({ ...s, workspace: '/w/site' })), ['site']);
  await page.goto('/sessions?folder=project:site');
  const main = page.getByRole('main');
  await main.getByPlaceholder('Search by name or folder…').fill('images');
  await expect(main.locator('li[data-flip]')).toHaveText([/Build the site/, /Shrink the images/]);
  await expect(main.getByText('1 of 2')).toBeVisible();
});

test('a project\'s last activity is its newest chat of its own, not a sub-chat that changed later', async ({ page }) => {
  const sessions = family().map((s) => ({ ...s, workspace: '/w/site' }));
  await portal(page, sessions, ['site']);
  await page.goto('/projects');
  // The chat changed ten minutes ago; its sub-chats a minute and two.
  await expect(page.getByRole('main').getByText(/last 10m ago/)).toBeVisible();
});

test('a sub-chat whose chat is not listed is a chat of its own: it has a pin, and its run ending is told', async ({ page }) => {
  await portal(page, [chat('main', 'A chat', 5), sub('orphan', 'Channel part', 'a-channel-conversation', 1)]);
  await page.goto('/sessions');
  const row = sidebar(page).locator('[data-flip="orphan"]');
  await row.hover();
  await expect(row.getByRole('button', { name: 'Pin Channel part' })).toBeVisible();
});

test('a chat whose sub-chat runs shimmers its title with the π, and the toggles say whose sub-chats they open', async ({ page }) => {
  await portal(page, [
    sub('links', 'Check the links', 'build', 1, { status: 'running' }),
    chat('build', 'Build the site', 10),
    sub('more', 'More work', 'docs', 2),
    chat('docs', 'Write the docs', 20),
  ]);
  await page.goto('/sessions');
  const side = sidebar(page);
  await expect(side.locator('[data-flip="build"] .working-text')).toHaveText('Build the site');
  await expect(side.locator('[data-flip="docs"] .working-text')).toHaveCount(0);
  // The same words for a sighted and a voice-control user, and the chat's name for a screen reader.
  await expect(side.getByRole('button', { name: '1 sub-chat of Build the site' })).toBeVisible();
  await expect(side.getByRole('button', { name: '1 sub-chat of Write the docs' })).toBeVisible();
});

test('the Agents page lists a conversation\'s sub-chats under it, does not count them, and its delete names them', async ({ page }) => {
  const sessions = [
    sub('links', 'Check the links', 'build', 1, { status: 'running', workspace: '/a/ada', channel_key: '', channel: null }),
    chat('build', 'Build the site', 10, { workspace: '/a/ada', channel_key: '', channel: null }),
  ];
  await mockPortal(page, ({ path: p, method }) => {
    const a = { id: 'ada', name: 'Ada', home: '/a/ada', first: false, initialised: true, chats: 1, channels: [], orb: DEFAULT_ORB, voice: '', unread: 0 };
    if (p === '/api/agents') return { agents: [a] };
    if (p === '/api/agent/sessions') return { sessions, agentHome: '/a/ada' };
    if (p === '/api/agents/ada/setup') return { initialised: true, home: '/a/ada', files: [] };
    if (p === '/api/sessions' && method === 'GET') return { sessions, executor: 'host' };
  }, { settings: true });
  await page.goto('/agents?agent=ada');
  const main = page.getByRole('main');
  await expect(main.getByText('Build the site')).toBeVisible();
  await expect(main.getByText(/^1\s*conversation$/)).toBeVisible();
  // Not a row among the conversations; under its conversation, open as it runs.
  await expect(main.getByRole('group', { name: 'Sub-chats of Build the site' }).getByText('Check the links')).toBeVisible();
  await main.getByRole('button', { name: 'Delete Build the site' }).click({ force: true });
  await expect(page.getByRole('alertdialog')).toContainText('Its sub-chat "Check the links" is deleted with it.');
});
