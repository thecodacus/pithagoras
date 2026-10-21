import { test, expect, mockPortal, reply } from './portal-mock';

/**
 * What the portal says when something went wrong: in an alert, where it can be seen, and only for as long as it is
 * true. A poll that failed and then did not is not an error any more, and an error from one page is not another's.
 */

test('a failed list of chats is said in an alert, and goes with the next list that comes', async ({ page }) => {
  let down = true;
  await mockPortal(page, ({ path, method }) => {
    if (path === '/api/sessions' && method === 'GET') return down ? reply(502, { error: 'Bad gateway' }) : { sessions: [], executor: 'host' };
  });
  await page.clock.install();
  await page.goto('/');
  const banner = page.getByRole('alert');
  // The message as the server gave it, not the error's own name in front of it.
  await expect(banner).toHaveText(/^Bad gateway\s*$/);
  // The portal is back by the poll, which is every five seconds.
  down = false;
  await page.clock.runFor(5500);
  await expect(banner).toHaveCount(0);
});

test('the portal-wide alert can be put away by hand', async ({ page }) => {
  await mockPortal(page, ({ path, method }) => {
    if (path === '/api/sessions' && method === 'GET') return reply(502, { error: 'Bad gateway' });
  });
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Bad gateway');
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('the routines page forgets a failed poll when the next one works', async ({ page }) => {
  let down = false;
  await mockPortal(page, ({ path, method }) => {
    if (path === '/api/routines' && method === 'GET') return down ? reply(500, { error: 'The scheduler is busy' }) : { routines: [] };
    if (path === '/api/workspaces') return { root: '/w', workspaces: [] };
    if (path === '/api/agents') return { agents: [] };
    if (path === '/api/routines/report-targets') return { targets: [], default: null };
    if (path === '/api/models') return { models: [], providers: {} };
  }, { settings: true });
  await page.clock.install();
  await page.goto('/routines');
  await expect(page.getByRole('heading', { name: 'Routines' })).toBeVisible();
  down = true;
  await page.clock.runFor(5500);
  await expect(page.getByRole('alert')).toContainText('The scheduler is busy');
  down = false;
  await page.clock.runFor(5500);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a failed save in Settings is scrolled into view, and is not there any more in the next section', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 420 });
  await mockPortal(page, ({ path }) => {
    if (path === '/api/mcp') return { path: '/a/mcp.json', exists: true, adapterInstalled: true, adapterSpec: 'npm:pi-mcp-adapter', settings: {}, raw: '{}', parseError: null, servers: [] };
    if (path === '/api/channels') return { channels: [], kinds: [], broken: [], agentHome: '/a', channelsDir: '/c' };
  }, { settings: true });
  await page.goto('/settings/mcp');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'Add server' }).click();
  await dialog.getByRole('textbox', { name: 'Command' }).fill('notes-mcp');
  // The Save is at the foot of a form that does not fit: the pane is scrolled down to it.
  const save = dialog.getByRole('button', { name: 'Save', exact: true });
  await save.scrollIntoViewIfNeeded();
  await save.click();
  const alert = dialog.getByRole('alert');
  await expect(alert).toContainText('Give the server a name');
  await expect(alert).toBeInViewport({ ratio: 1 });
  await dialog.getByRole('button', { name: 'Channels' }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
});
