import { test, expect, mockPortal } from '../../../../tests/browser/portal-mock';

test.use({ installed: ['extensions/terminal'] });

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

/** A chat whose folder is a path its title does not contain, and the shell the terminal opens in it. */
async function portal(page: import('@playwright/test').Page) {
  const chat = { id: 's1', title: 'Fix login', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: at(5), created_at: at(5), provider: null, model: null, thinking_level: null };
  await mockPortal(page, ({ path: p, method }) => {
    if (p === '/api/sessions' && method === 'GET') return { sessions: [chat], executor: 'host' };
    if (/^\/api\/sessions\/\w+$/.test(p)) return chat;
    if (p === '/api/projects') return { root: '/w', home: '/data/agent', projects: [{ name: 'site', path: '/w/site', isGit: false, hasInstructions: false, hasTools: false, sessions: 1, lastActive: null }] };
    if (p === '/api/x/pithagoras-terminal/terminal' && method === 'POST') return { id: 't1', cwd: '/w/site' };
    if (p === '/api/x/pithagoras-terminal/terminal/t1/resize' || p === '/api/x/pithagoras-terminal/terminal/t1') return { ok: true };
    if (p.endsWith('/config')) return { live: false, state: null, stats: null, thinking: { levels: [] }, models: { models: [] }, named: { provider: null, model: null } };
    if (p === '/api/models') return { models: [], providers: {} };
  }, { streams: 'open', settings: true });
  await page.setViewportSize({ width: 1300, height: 800 });
}

test('the shell tab of the terminal panel does not draw the chat\'s path', async ({ page }) => {
  await portal(page);
  await page.goto('/s/s1');
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await page.getByRole('tab', { name: 'Shell' }).click();
  await expect(page.locator('.xterm')).toBeVisible();
  await expect(page.locator('.chat-aside-head')).not.toContainText('/w/site');
  await expect(page.getByText('/w/site')).toHaveCount(0);
});
