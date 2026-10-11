import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply } from './portal-mock';

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const chat = (id: string, title: string, workspace: string, minutesAgo: number, extra: Record<string, unknown> = {}) =>
  ({ id, title, workspace, status: 'idle', kind: 'task', pinned: false, updated_at: at(minutesAgo), created_at: at(minutesAgo), ...extra });

const HOME = '/data/agent';

/** A portal with chats in Home, in the projects site and notes, and none in the project empty. */
async function portal(page: Page, sessions = [
  chat('h1', 'Home chat', HOME, 30),
  chat('s1', 'Site chat', '/w/site', 5),
  chat('s2', 'Site docs chat', '/w/site/docs', 50),
  chat('n1', 'Notes chat', '/w/notes', 10),
  chat('p1', 'Pinned chat', '/w/notes', 60, { pinned: true }),
], opts: { projects?: string[]; projectsHeld?: Promise<void> } = {}) {
  const sent: { method: string; path: string; body: any }[] = [];
  await mockPortal(page, async ({ path: p, method, json }) => {
    const body = json();
    if (method !== 'GET') sent.push({ method, path: p, body });
    if (p === '/api/sessions' && method === 'GET') return { sessions, executor: 'host' };
    if (p === '/api/sessions' && method === 'POST') return chat('new', 'New chat', body?.workspace ?? HOME, 0);
    if (p === '/api/projects') {
      await opts.projectsHeld;
      return {
      root: '/w', home: HOME,
      projects: (opts.projects ?? ['site', 'notes', 'empty']).map((name) => ({ name, path: `/w/${name}`, isGit: false, hasInstructions: false, sessions: 0, lastActive: null })),
      };
    }
    if (p === '/api/models') return { models: [{ provider: 'x', id: 'm', name: 'M', reasoning: false }], providers: {} };
  }, { settings: true });
  return Object.assign(sent, { sessions });
}

const sidebar = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' });
const folder = (scope: ReturnType<Page['locator']>, name: string) => scope.getByRole('button', { name, exact: true });
/** The folders' names, top to bottom. */
const folderNames = (scope: ReturnType<Page['locator']>) =>
  scope.locator('[data-folder] button[aria-expanded]').allInnerTexts().then((names) => names.map((n) => n.trim()));

test('the sidebar gathers the chats by folder, and remembers which are open', async ({ page }) => {
  await portal(page);
  await page.goto('/sessions');
  const side = sidebar(page);
  // Pinned chats keep their place at the top; the folders hold the rest.
  await expect(side.getByText('Pinned', { exact: true })).toBeVisible();
  await expect(folder(side, 'Home')).toHaveAttribute('aria-expanded', 'true');
  await expect(side.getByRole('group', { name: 'Home' }).getByText('Home chat')).toBeVisible();
  await expect(folder(side, 'site')).toHaveAttribute('aria-expanded', 'false');
  await expect(side.getByText('Site chat')).toHaveCount(0);

  await folder(side, 'site').click();
  const site = side.getByRole('group', { name: 'site' });
  // A chat in a project's subfolder is the project's.
  await expect(site.getByText('Site chat')).toBeVisible();
  await expect(site.getByText('Site docs chat')).toBeVisible();
  await expect(side.getByRole('group', { name: 'notes' })).toHaveCount(0);
  await folder(side, 'Home').click();
  await expect(side.getByText('Home chat')).toHaveCount(0);

  await page.reload();
  await expect(folder(side, 'site')).toHaveAttribute('aria-expanded', 'true');
  await expect(folder(side, 'Home')).toHaveAttribute('aria-expanded', 'false');
  // An empty project is there to start a chat in.
  await folder(side, 'empty').click();
  await expect(side.getByRole('group', { name: 'empty' }).getByText('No chats yet.')).toBeVisible();
});

test('the folder of the chat opened is opened', async ({ page }) => {
  await portal(page);
  await page.goto('/s/n1');
  await expect(folder(sidebar(page), 'notes')).toHaveAttribute('aria-expanded', 'true');
  await expect(sidebar(page).getByRole('group', { name: 'notes' }).getByText('Notes chat')).toBeVisible();
});

test('the folders are sorted, moved by hand, and the order is kept, in the sidebar and on the Sessions page', async ({ page }) => {
  await portal(page);
  await page.goto('/sessions');
  const side = sidebar(page);
  const main = page.getByRole('main');
  // Latest first: site's chat moved last, then notes', then Home's; empty has none.
  await expect.poll(() => folderNames(side)).toEqual(['site', 'notes', 'Home', 'empty']);
  await expect.poll(() => folderNames(main)).toEqual(['site', 'notes', 'Home', 'empty']);

  await side.getByRole('combobox', { name: 'Order of the folders' }).click();
  await page.getByRole('option', { name: 'By name' }).click();
  await expect.poll(() => folderNames(side)).toEqual(['Home', 'empty', 'notes', 'site']);
  await expect.poll(() => folderNames(main)).toEqual(['Home', 'empty', 'notes', 'site']);

  // With the keys: Alt and an arrow on the folder's name, which keeps the focus.
  await folder(side, 'site').focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => folderNames(side)).toEqual(['Home', 'empty', 'site', 'notes']);
  await expect(folder(side, 'site')).toBeFocused();
  await expect(side.getByRole('combobox', { name: 'Order of the folders' })).toContainText('Your order');

  // By its grip: carried above Home.
  const grip = side.locator('[data-folder="project:notes"] .folder-grip');
  await folder(side, 'notes').hover();
  const from = await grip.boundingBox();
  const to = await folder(side, 'Home').boundingBox();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(from!.x + 4, from!.y - 10, { steps: 3 });
  await page.mouse.move(to!.x + 10, to!.y + 2, { steps: 5 });
  await expect(side.locator('.folder-drop')).toHaveCount(1);
  await page.mouse.up();
  await expect.poll(() => folderNames(side)).toEqual(['notes', 'Home', 'empty', 'site']);
  await expect.poll(() => folderNames(main)).toEqual(['notes', 'Home', 'empty', 'site']);

  await page.reload();
  await expect.poll(() => folderNames(side)).toEqual(['notes', 'Home', 'empty', 'site']);
  await expect.poll(() => folderNames(main)).toEqual(['notes', 'Home', 'empty', 'site']);
});

test('a folder on the Sessions page is shown on its own, and the link keeps it', async ({ page }) => {
  await portal(page);
  await page.goto('/sessions');
  const main = page.getByRole('main');
  // All open here: there is room.
  await expect(main.getByRole('group', { name: 'Home' }).getByText('Home chat')).toBeVisible();
  await expect(main.getByRole('group', { name: 'notes' }).getByText('Pinned chat')).toBeVisible();
  await folder(main, 'site').hover();
  await main.getByRole('button', { name: 'Only site' }).click();
  await expect(page).toHaveURL(/\/sessions\?folder=project%3Asite$/);
  await expect(main.getByText('Only site')).toBeVisible();
  await expect(main.getByText('Site chat')).toBeVisible();
  await expect(main.getByText('Site docs chat')).toBeVisible();
  await expect(main.getByText('Home chat')).toHaveCount(0);
  await expect(main.getByText('Notes chat')).toHaveCount(0);

  await page.reload();
  await expect(main.getByText('Only site')).toBeVisible();
  await expect(main.getByText('Home chat')).toHaveCount(0);
  await main.getByRole('button', { name: 'Show every folder' }).click();
  await expect(page).toHaveURL(/\/sessions$/);
  await expect(main.getByText('Home chat')).toBeVisible();
});

test('a folder with more chats than the sidebar shows opens on its own on the Sessions page', async ({ page }) => {
  const many = Array.from({ length: 11 }, (_, i) => chat(`s${i}`, `Site chat ${i}`, '/w/site', i + 1));
  await portal(page, [chat('h1', 'Home chat', HOME, 30), ...many]);
  await page.goto('/sessions');
  const side = sidebar(page);
  await folder(side, 'site').click();
  await expect(side.getByRole('group', { name: 'site' }).getByText(/^Site chat \d+$/)).toHaveCount(8);
  await side.getByRole('button', { name: '3 more in site…' }).click();
  await expect(page).toHaveURL(/folder=project%3Asite/);
  await expect(page.getByRole('main').getByText(/^Site chat \d+$/)).toHaveCount(11);
  await expect(page.getByRole('main').getByText('Home chat')).toHaveCount(0);
});

test('a chat is started in a folder from its line', async ({ page }) => {
  const sent = await portal(page);
  await page.goto('/sessions');
  const side = sidebar(page);
  await folder(side, 'empty').hover();
  await side.getByRole('button', { name: 'New chat in empty' }).click();
  await expect.poll(() => sent.find((s) => s.method === 'POST' && s.path === '/api/sessions')?.body).toEqual({ workspace: '/w/empty' });
  await expect(page).toHaveURL(/\/s\/new$/);
  sent.length = 0;
  await page.goto('/sessions');
  await folder(side, 'Home').hover();
  await side.getByRole('button', { name: 'New chat in Home' }).click();
  // Home's own folder is named, not left out: a chat started without one goes to the agent picked for new chats.
  await expect.poll(() => sent.find((s) => s.method === 'POST' && s.path === '/api/sessions')?.body ?? null).toEqual({ workspace: HOME });
});

test('the chats can be listed together again, as they were', async ({ page }) => {
  await portal(page);
  await page.goto('/sessions');
  const side = sidebar(page);
  await side.getByRole('button', { name: 'List the chats together' }).click();
  await expect(side.getByText('Recents', { exact: true })).toBeVisible();
  await expect(side.locator('[data-folder]')).toHaveCount(0);
  await expect(side.getByText('Site docs chat')).toBeVisible();
  // The Sessions page lists them the same way.
  await expect(page.getByRole('main').locator('[data-folder]')).toHaveCount(0);
  await page.reload();
  await expect(side.getByText('Recents', { exact: true })).toBeVisible();
  await side.getByRole('button', { name: 'Group the chats by folder' }).click();
  await expect(folder(side, 'Home')).toBeVisible();
});

test('searching the sidebar shows the folders with a match, open', async ({ page }) => {
  const many = Array.from({ length: 12 }, (_, i) => chat(`h${i}`, `Home chat ${i}`, HOME, i + 1));
  await portal(page, [...many, chat('s1', 'Deploy the site', '/w/site', 40)]);
  await page.goto('/sessions');
  const side = sidebar(page);
  await expect(folder(side, 'site')).toHaveAttribute('aria-expanded', 'false');
  await side.getByLabel('Search chats').fill('deploy');
  await expect(side.locator('[data-folder]')).toHaveCount(1);
  await expect(side.getByRole('group', { name: 'site' }).getByText('Deploy the site')).toBeVisible();
  await side.getByLabel('Search chats').fill('');
  await expect(folder(side, 'site')).toHaveAttribute('aria-expanded', 'false');
});

test('without projects the sidebar lists the chats as before', async ({ page }) => {
  await portal(page, [chat('h1', 'Home chat', HOME, 30)]);
  // Asked after the portal's, so heard first.
  await page.route('**/api/projects*', (route) => route.fulfill({ json: { root: '/w', home: HOME, projects: [] } }));
  await page.goto('/sessions');
  const side = sidebar(page);
  await expect(side.getByText('Recents', { exact: true })).toBeVisible();
  await expect(side.locator('[data-folder]')).toHaveCount(0);
  await expect(side.getByRole('button', { name: 'Group the chats by folder' })).toHaveCount(0);
});

test('with a second agent and no projects the sidebar gathers the chats by agent', async ({ page }) => {
  await portal(page, [chat('h1', 'Home chat', HOME, 30), chat('a1', 'Scout chat', '/data/agents/scout', 5)]);
  // Asked after the portal's, so heard first.
  await page.route('**/api/projects*', (route) => route.fulfill({ json: {
    root: '/w', home: HOME, projects: [],
    agents: [{ id: 'home', name: 'Nova', home: HOME }, { id: 'scout', name: 'Scout', home: '/data/agents/scout' }],
  } }));
  await page.goto('/sessions');
  const side = sidebar(page);
  await expect(folder(side, 'Nova')).toBeVisible();
  await expect(folder(side, 'Scout')).toBeVisible();
  await expect(side.locator('[data-folder]')).toHaveCount(2);
});

test('the house marks the agent that New starts chats with, not the first agent', async ({ page }) => {
  await portal(page, [chat('h1', 'Home chat', HOME, 30), chat('a1', 'Scout chat', '/data/agents/scout', 5)]);
  await page.route('**/api/projects*', (route) => route.fulfill({ json: {
    root: '/w', home: HOME, projects: [],
    agents: [{ id: 'home', name: 'Nova', home: HOME, newChats: false }, { id: 'scout', name: 'Scout', home: '/data/agents/scout', newChats: true }],
  } }));
  await page.goto('/sessions');
  const side = sidebar(page);
  await expect(folder(side, 'Scout')).toBeVisible();
  await expect(side.locator('[data-folder="agent:scout"] [data-icon="house"]')).toHaveCount(1);
  await expect(side.locator('[data-folder="home"] [data-icon="house"]')).toHaveCount(0);
});

test('a folder shut while searching is shut only for the search', async ({ page }) => {
  const many = Array.from({ length: 12 }, (_, i) => chat(`h${i}`, `Home chat ${i}`, HOME, i + 1));
  await portal(page, [...many, chat('s1', 'Home and site', '/w/site', 40)]);
  await page.goto('/sessions');
  const side = sidebar(page);
  await side.getByLabel('Search chats').fill('home');
  await expect(folder(side, 'Home')).toHaveAttribute('aria-expanded', 'true');
  await expect(folder(side, 'site')).toHaveAttribute('aria-expanded', 'true');
  await folder(side, 'Home').click();
  await folder(side, 'site').click();
  await expect(folder(side, 'Home')).toHaveAttribute('aria-expanded', 'false');
  await expect(folder(side, 'site')).toHaveAttribute('aria-expanded', 'false');
  await side.getByLabel('Search chats').fill('');
  // As they were before the search: Home open, site shut, and kept so.
  await expect(folder(side, 'Home')).toHaveAttribute('aria-expanded', 'true');
  await expect(folder(side, 'site')).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => localStorage.getItem('sidebarFoldersOpen'))).toBeNull();
  await side.getByLabel('Search chats').fill('home');
  await expect(folder(side, 'Home')).toHaveAttribute('aria-expanded', 'true');

  // The same on the Sessions page.
  const main = page.getByRole('main');
  await main.getByPlaceholder('Search by name or folder…').fill('site');
  await folder(main, 'site').click();
  await expect(folder(main, 'site')).toHaveAttribute('aria-expanded', 'false');
  await main.getByPlaceholder('Search by name or folder…').fill('');
  await expect(folder(main, 'site')).toHaveAttribute('aria-expanded', 'true');
  expect(await page.evaluate(() => localStorage.getItem('sessionsFoldersOpen'))).toBeNull();
});

test('folders reordered by a chat while one is carried stay put until it is let go, and it goes where the line was', async ({ page }) => {
  const sent = await portal(page);
  await page.goto('/sessions');
  const side = sidebar(page);
  await expect.poll(() => folderNames(side)).toEqual(['site', 'notes', 'Home', 'empty']);
  const grip = side.locator('[data-folder="project:empty"] .folder-grip');
  await folder(side, 'empty').hover();
  const from = await grip.boundingBox();
  const to = await folder(side, 'notes').boundingBox();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(from!.x + 4, from!.y - 10, { steps: 3 });
  // Between site and notes.
  await page.mouse.move(to!.x + 10, to!.y + 2, { steps: 5 });
  await expect(side.locator('.folder-drop')).toHaveCount(1);
  // Home's chat moves: latest first, Home would be at the top.
  sent.sessions[0].updated_at = new Date().toISOString();
  await page.waitForTimeout(5600);
  await expect.poll(() => folderNames(page.getByRole('main'))).toEqual(['Home', 'site', 'notes', 'empty']);
  expect(await folderNames(side)).toEqual(['site', 'notes', 'Home', 'empty']);
  await page.mouse.up();
  await expect.poll(() => folderNames(side)).toEqual(['site', 'empty', 'notes', 'Home']);
});

test('the chats are listed before the projects are known, and by folder once they have been', async ({ page }) => {
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  await portal(page, undefined, { projectsHeld: held });
  await page.goto('/sessions');
  const side = sidebar(page);
  await expect(side.getByText('Site chat')).toBeVisible();
  await expect(side.getByText('Recents', { exact: true })).toBeVisible();
  release();
  await expect(folder(side, 'site')).toBeVisible();
  await expect(side.getByText('Recents', { exact: true })).toHaveCount(0);

  // Next time the folders are there from the start, while the projects are still being asked.
  await page.route('**/api/projects*', () => {});
  await page.reload();
  await expect(folder(side, 'site')).toBeVisible();
  await expect(side.getByText('Recents', { exact: true })).toHaveCount(0);
});

test('a pinned chat orders its folder the same in the sidebar and on the Sessions page', async ({ page }) => {
  await portal(page, [
    chat('s1', 'Site chat', '/w/site', 20),
    chat('n1', 'Notes chat', '/w/notes', 30),
    chat('p1', 'Pinned chat', '/w/notes', 1, { pinned: true }),
  ]);
  await page.goto('/sessions');
  await expect.poll(() => folderNames(page.getByRole('main'))).toEqual(['notes', 'site', 'Home', 'empty']);
  await expect.poll(() => folderNames(sidebar(page))).toEqual(['notes', 'site', 'Home', 'empty']);
});

test('the chat opened is listed in its folder, however far down it is', async ({ page }) => {
  const many = Array.from({ length: 11 }, (_, i) => chat(`s${i}`, `Site chat ${i}`, '/w/site', i + 1));
  await portal(page, many);
  await page.goto('/s/s10');
  const site = sidebar(page).getByRole('group', { name: 'site' });
  await expect(site.getByText('Site chat 10')).toBeVisible();
  await expect(site.locator('[aria-current="page"]')).toHaveText(/Site chat 10/);
  await expect(site.getByText(/^Site chat \d+$/)).toHaveCount(9);
  await expect(sidebar(page).getByRole('button', { name: '2 more in site…' })).toBeVisible();
});

test("a folder's line controls its chats, whatever its name", async ({ page }) => {
  await portal(page, [chat('m1', 'Repo chat', '/w/My Repo', 5)], { projects: ['My Repo'] });
  await page.goto('/sessions');
  const main = page.getByRole('main');
  const line = folder(main, 'My Repo');
  const controls = await line.getAttribute('aria-controls');
  expect(controls).not.toContain(' ');
  await expect(page.locator(`[id="${controls}"]`)).toContainText('Repo chat');
});

test('pressing + twice on the Sessions page starts one chat', async ({ page }) => {
  const sent = await portal(page);
  let answer = () => {};
  const answered = new Promise<void>((r) => (answer = r));
  await page.route('**/api/sessions', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    sent.push({ method: 'POST', path: '/api/sessions', body: route.request().postDataJSON() });
    await answered;
    await route.fulfill({ json: chat('new', 'New chat', '/w/empty', 0) });
  });
  await page.goto('/sessions');
  const main = page.getByRole('main');
  await folder(main, 'empty').hover();
  const plus = main.getByRole('button', { name: 'New chat in empty' });
  await plus.click();
  await plus.click();
  answer();
  await expect(page).toHaveURL(/\/s\/new$/);
  expect(sent.filter((s) => s.method === 'POST' && s.path === '/api/sessions')).toHaveLength(1);
});

/** The folders and the drop line, top to bottom, as they are drawn. */
const drawnWithLine = (scope: ReturnType<Page['locator']>) =>
  // The line is drawn inside the folder it comes before, and after it in the document.
  scope.locator('[data-folder], .folder-drop').evaluateAll((els) => {
    const out: string[] = [];
    for (const el of els as HTMLElement[]) {
      const owner = el.classList.contains('folder-drop') ? el.parentElement?.dataset.folder : undefined;
      if (owner) out.splice(out.lastIndexOf(owner), 0, '|');
      else out.push(el.classList.contains('folder-drop') ? '|' : el.dataset.folder!);
    }
    return out;
  });

test('a folder let go where it was picked up leaves the order as it is sorted', async ({ page }) => {
  await portal(page);
  await page.goto('/sessions');
  const side = sidebar(page);
  const grip = side.locator('[data-folder="project:notes"] .folder-grip');
  await folder(side, 'notes').hover();
  const from = await grip.boundingBox();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2 + 6, { steps: 3 });
  await page.mouse.up();
  await expect(side.getByRole('combobox', { name: 'Order of the folders' })).toContainText('Latest first');
  expect(await page.evaluate(() => localStorage.getItem('folderSort'))).toBeNull();
});

test('a folder shut while its chat is open stays shut', async ({ page }) => {
  const many = Array.from({ length: 12 }, (_, i) => chat(`h${i}`, `Home chat ${i}`, HOME, i + 1));
  await portal(page, [...many, chat('s1', 'Site chat', '/w/site', 40)]);
  await page.goto('/s/s1');
  const side = sidebar(page);
  await expect(folder(side, 'site')).toHaveAttribute('aria-expanded', 'true');
  await folder(side, 'site').click();
  await expect(folder(side, 'site')).toHaveAttribute('aria-expanded', 'false');
  // A search that hides the open chat, then none.
  await side.getByLabel('Search chats').fill('Home chat 3');
  await side.getByLabel('Search chats').fill('');
  await expect(folder(side, 'site')).toHaveAttribute('aria-expanded', 'false');
  // As one list and back.
  await side.getByRole('button', { name: 'List the chats together' }).click();
  await side.getByRole('button', { name: 'Group the chats by folder' }).click();
  await expect(folder(side, 'site')).toHaveAttribute('aria-expanded', 'false');
});

test('a folder whose chats are all pinned says so, and Elsewhere only holds what it shows', async ({ page }) => {
  await portal(page, [
    chat('s1', 'Site one', '/w/site', 5, { pinned: true }),
    chat('s2', 'Site two', '/w/site', 6, { pinned: true }),
    chat('r1', 'Root chat', '/w', 7, { pinned: true }),
  ]);
  await page.goto('/sessions');
  const side = sidebar(page);
  await folder(side, 'site').click();
  await expect(side.getByRole('group', { name: 'site' })).toHaveText('Only pinned chats, above.');
  await expect(folder(side, 'Elsewhere')).toHaveCount(0);
  await expect(folder(page.getByRole('main'), 'Elsewhere')).toBeVisible();
});

test('with projects and no chats, each folder says so and nothing more', async ({ page }) => {
  await portal(page, []);
  await page.goto('/sessions');
  const side = sidebar(page);
  await expect(folder(side, 'Home')).toBeVisible();
  await expect(side.getByText('No sessions yet.')).toHaveCount(0);
  await expect(side.getByRole('group', { name: 'Home' })).toHaveText('No chats yet.');
});

test('a folder that goes while another is carried: the line and the drop agree', async ({ page }) => {
  const projects = ['site', 'notes', 'empty'];
  const sent = await portal(page, undefined, { projects });
  await page.goto('/sessions');
  const side = sidebar(page);
  await expect.poll(() => folderNames(side)).toEqual(['site', 'notes', 'Home', 'empty']);
  const grip = side.locator('[data-folder="project:empty"] .folder-grip');
  await folder(side, 'empty').hover();
  const from = await grip.boundingBox();
  const to = await folder(side, 'Home').boundingBox();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(from!.x + 4, from!.y - 10, { steps: 3 });
  await page.mouse.move(to!.x + 10, to!.y + 2, { steps: 5 });
  await expect.poll(() => drawnWithLine(side)).toEqual(['project:site', 'project:notes', '|', 'home', 'project:empty']);
  // site is removed, its chats with it: the list is asked for again.
  projects.splice(0, 1);
  sent.sessions.splice(1, 2);
  await expect.poll(() => drawnWithLine(side), { timeout: 8000 }).not.toContain('project:site');
  const line = await drawnWithLine(side);
  await page.mouse.up();
  const expected = line.filter((k) => k !== 'project:empty').map((k) => (k === '|' ? 'project:empty' : k));
  const names = expected.map((k) => (k === 'home' ? 'Home' : k.replace('project:', '')));
  await expect.poll(() => folderNames(side)).toEqual(names);
});

test('stored places that are not whole do not take the page down', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('knownPlaces', JSON.stringify({ home: '/h', projects: [{ name: 'x' }, null, { name: 'site', path: '/w/site' }] })));
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  await portal(page, undefined, { projectsHeld: held });
  await page.goto('/sessions');
  const side = sidebar(page);
  // From what was whole in them: site.
  await expect(folder(side, 'site')).toBeVisible();
  await expect(folder(side, 'x')).toHaveCount(0);
  release();
  await expect(folder(side, 'notes')).toBeVisible();
});

test('a project made elsewhere shows up within half a minute', async ({ page }) => {
  await page.clock.install();
  const projects = ['site'];
  await portal(page, undefined, { projects });
  await page.goto('/sessions');
  const side = sidebar(page);
  await expect(folder(side, 'site')).toBeVisible();
  projects.push('made-by-the-agent');
  await page.clock.runFor(31_000);
  await expect(folder(side, 'made-by-the-agent')).toBeVisible();
});

test('what is kept about folders lets go of projects that are gone', async ({ page }) => {
  const projects = ['site', 'notes', 'empty'];
  await portal(page, undefined, { projects });
  await page.goto('/sessions');
  const side = sidebar(page);
  await folder(side, 'empty').click();
  await folder(side, 'empty').focus();
  await page.keyboard.press('Alt+ArrowUp');
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem('folderOrder')))!)).toContain('project:empty');
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem('sidebarFoldersOpen')))!)).toHaveProperty('project:empty');
  projects.splice(2, 1);
  await page.reload();
  await expect(folder(side, 'empty')).toHaveCount(0);
  await folder(side, 'notes').click();
  await folder(side, 'notes').focus();
  await page.keyboard.press('Alt+ArrowDown');
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem('folderOrder')))!)).not.toContain('project:empty');
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem('sidebarFoldersOpen')))!)).not.toHaveProperty('project:empty');
});

test('a chat whose project was not known yet has that project opened once it is', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('knownPlaces', JSON.stringify({ home: '/data/agent', projects: [{ name: 'site', path: '/w/site' }] })));
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  await portal(page, [chat('h1', 'Home chat', HOME, 30), chat('x1', 'New project chat', '/w/fresh', 1)], { projects: ['site', 'fresh'], projectsHeld: held });
  await page.goto('/s/x1');
  const side = sidebar(page);
  await expect(folder(side, 'Elsewhere')).toHaveAttribute('aria-expanded', 'true');
  release();
  await expect(folder(side, 'fresh')).toHaveAttribute('aria-expanded', 'true');
  await expect(side.getByRole('group', { name: 'fresh' }).getByText('New project chat')).toBeVisible();
});

test('a folder hidden in the sidebar keeps its place when others are moved there', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('folderSort', 'manual');
    localStorage.setItem('folderOrder', JSON.stringify(['elsewhere', 'home', 'project:site', 'project:notes', 'project:empty']));
  });
  await portal(page, [chat('s1', 'Site chat', '/w/site', 5), chat('r1', 'Root chat', '/w', 7, { pinned: true })]);
  await page.goto('/sessions');
  const side = sidebar(page);
  const main = page.getByRole('main');
  await expect(folder(side, 'Elsewhere')).toHaveCount(0);
  await expect.poll(() => folderNames(main)).toEqual(['Elsewhere', 'Home', 'site', 'notes', 'empty']);
  await folder(side, 'notes').focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => folderNames(side)).toEqual(['Home', 'notes', 'site', 'empty']);
  await expect.poll(() => folderNames(main)).toEqual(['Elsewhere', 'Home', 'notes', 'site', 'empty']);
});

test('a folder counts, and shows running, all its chats in the sidebar as on the Sessions page', async ({ page }) => {
  await portal(page, [
    chat('n1', 'Notes chat', '/w/notes', 10),
    chat('p1', 'Pinned chat', '/w/notes', 60, { pinned: true, status: 'running' }),
  ]);
  await page.goto('/sessions');
  const side = sidebar(page);
  const main = page.getByRole('main');
  // The number is for the eye and its noun for a screen reader: the count has no role to carry a label.
  const count = (scope: ReturnType<Page['locator']>) => scope.locator('[data-folder="project:notes"]').getByText(/^\d+ chats?$/).first();
  await expect(count(side)).toHaveText('2 chats');
  await expect(count(main)).toHaveText('2 chats');
  // Shut, a folder shows that something in it runs.
  await expect(folder(side, 'notes')).toHaveAttribute('aria-expanded', 'false');
  await expect(side.locator('[data-folder="project:notes"] > div').first().locator('.status-working')).toHaveCount(1);
});

test('a link to a folder that is gone says so, and leads back to all of them', async ({ page }) => {
  await portal(page);
  await page.goto('/sessions?folder=project%3Agone');
  const main = page.getByRole('main');
  await expect(main.getByText('There is no folder “gone” any more')).toBeVisible();
  await expect(main.getByText('Site chat')).toHaveCount(0);
  await main.getByRole('button', { name: 'Show every folder' }).click();
  await expect(page).toHaveURL(/\/sessions$/);
  await expect(main.getByText('Site chat')).toBeVisible();
  // Elsewhere with nothing in it is still a folder.
  await page.goto('/sessions?folder=elsewhere');
  await expect(main.getByText('Only Elsewhere')).toBeVisible();
  await expect(main.getByText('No chats in Elsewhere yet.')).toBeVisible();
});

test('the folders are asked for without their counts, and even when the chats cannot be had', async ({ page }) => {
  const asked: string[] = [];
  await portal(page);
  page.on('request', (r) => { if (r.url().includes('/api/projects')) asked.push(new URL(r.url()).search); });
  await page.route('**/api/sessions', (route) => route.request().method() === 'GET' ? route.fulfill({ status: 502, json: { error: 'starting' } }) : route.fallback());
  await page.goto('/sessions');
  await expect.poll(() => asked).toContain('?bare=1');
  expect(asked.every((q) => q === '?bare=1')).toBe(true);
});
