import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply, DONE } from '../../../../tests/browser/portal-mock';

test.use({ installed: ['extensions/terminal'] });

/**
 * The shell tab of the terminal panel, over a stream the test drives: what it says when keystrokes go nowhere.
 */
const at = new Date().toISOString();
const chat = { id: 'a', title: 'Chat A', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: at, created_at: at, provider: null, model: null, thinking_level: null };

/** The panel open on a shell whose input requests `fails` says what each of them does. */
async function shell(page: Page, fails: (n: number, route: import('@playwright/test').Route) => unknown) {
  let inputs = 0;
  await mockPortal(page, ({ path, method, route }) => {
    if (path === '/api/sessions') return { sessions: [chat], executor: 'host' };
    if (/^\/api\/sessions\/\w+$/.test(path)) return chat;
    if (path === '/api/x/pithagoras-terminal/terminal' && method === 'POST') return { id: 't1', cwd: '/w/site' };
    if (path === '/api/x/pithagoras-terminal/terminal/t1/input') return fails(++inputs, route);
    if (path === '/api/x/pithagoras-terminal/terminal/t1/resize' || path === '/api/x/pithagoras-terminal/terminal/t1') return { ok: true };
    if (path.endsWith('/config')) return { live: false, state: null, stats: null, thinking: { levels: [] }, models: { models: [] }, named: { provider: null, model: null } };
  }, { streams: 'open', settings: true });
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.goto('/s/a');
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await page.getByRole('tab', { name: 'Shell' }).click();
  await expect(page.locator('.xterm')).toBeVisible();
  // The shell's own stream, as the page keeps it.
  const stream = () => page.evaluate(() => (window as any).streams.filter((s: any) => /\/api\/x\/pithagoras-terminal\/terminal\/t1\/stream/.test(s.url)).length);
  await expect.poll(stream).toBe(1);
  return {
    /** What the server sends on a connection, as the page would get it. */
    send: (text: string) => page.evaluate((data) => (window as any).streams.find((s: any) => /\/api\/x\/pithagoras-terminal\/terminal\//.test(s.url)).emit('message', data), text),
    /** The stream coming back after a break: EventSource reconnects by itself and says it is open. */
    reopened: () => page.evaluate(() => (window as any).streams.find((s: any) => /\/api\/x\/pithagoras-terminal\/terminal\//.test(s.url)).onopen?.()),
    type: async (keys: string) => {
      await page.locator('.xterm').click();
      await page.keyboard.type(keys);
    },
    screen: () => page.locator('.xterm-rows').innerText(),
  };
}

const LOST = 'Connection to the shell lost';

test('keystrokes that go nowhere are said once, and said again after the stream has come back and its replay cleared the screen', async ({ page }) => {
  const t = await shell(page, (n, route) => {
    // The first key is lost on the way; after that the portal has restarted, and the shell is not there.
    if (n === 1) {
      void route.abort('internetdisconnected');
      return DONE;
    }
    return reply(404, { error: 'No such terminal' });
  });
  await t.send('user@host:~$ ');
  await t.type('a');
  await expect(page.locator('.xterm-rows')).toContainText(LOST);

  // The stream reconnects and replays the scrollback behind a reset: the notice is gone, and so is the reason for it.
  await t.reopened();
  await t.send('\x1bcuser@host:~$ ');
  await expect(page.locator('.xterm-rows')).not.toContainText(LOST);

  // Later the shell is really gone.
  await t.type('b');
  await expect(page.locator('.xterm-rows')).toContainText(LOST);
  // Said once while it lasts.
  await t.type('cd');
  await expect.poll(async () => ((await t.screen()).match(/Connection to the shell lost/g) ?? []).length).toBe(1);
});
