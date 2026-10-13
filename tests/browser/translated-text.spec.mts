import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';
import { DEFAULT_ORB } from '../../server/src/orb-style';

/**
 * Words the page used to show as the code had them, whatever the language: a badge, a count with its noun, a kind, a
 * source, the example in an empty file.
 */

const session = { id: 'demo', title: 'A chat', workspace: '/workspaces/demo', status: 'idle', kind: 'task', pinned: false };
const agent = { id: 'home', name: 'Home', home: '/a', first: true, initialised: true, chats: 1, channels: [], orb: DEFAULT_ORB, voice: '', heartbeat: { minutes: 0, quietStart: '', quietEnd: '', timeZone: 'UTC', last: null, status: null, running: false, watching: false, available: true }, unread: 0 };

/** The agent's page, with one chat and a WATCH.md that has nothing in it yet. */
async function agentPage(page: Page) {
  await mockPortal(page, ({ path: p, method }) => {
    if (method !== 'GET') return;
    if (p === '/api/agents') return { agents: [agent] };
    if (p === '/api/agent/sessions') return { sessions: [{ ...session, id: 's1', kind: 'agent', updated_at: new Date().toISOString(), channel_key: 'telegram:1', channel: null }], agentHome: '/a' };
    if (p === '/api/agents/home/setup') return { initialised: true, home: '/a', files: [{ name: 'WATCH.md', exists: false, content: '', mtime: 0 }] };
  }, { settings: true });
}

/** The page that lists who may drive the browser: one chat that has said so, of the kind the portal names `task`. */
async function browserPage(page: Page) {
  await mockPortal(page, ({ path: p, method }) => {
    if (p === '/api/browser' && method === 'GET') {
      return {
        running: true, unprotected: false, connectedAs: 'browser', version: '1', pages: [], uiPort: '3011', uiExposed: false, uiOutdated: false, cursor: true, allowlist: '', configured: true, byDefault: false,
        sessions: [{ id: 'demo', title: 'A chat', kind: 'task', allowed: true }, { id: 'beat', title: 'Its rounds', kind: 'heartbeat', allowed: false }, { id: 'new', title: 'From a newer portal', kind: 'future-kind', allowed: true }], routines: [],
        install: { available: true, mode: 'docker', image: true, container: 'running', binary: null, pulling: { active: false, line: '' } },
        config: { user: 'abc', hasPassword: true },
      };
    }
    if (p === '/api/sessions') return { sessions: [session], executor: 'host' };
  }, { settings: true });
}

/** A chat with slash commands from every place the portal knows them from, and one it does not. */
async function commandsPage(page: Page) {
  await mockPortal(page, ({ path: p, method }) => {
    if (p === '/api/sessions') return { sessions: [session], executor: 'host' };
    if (p === `/api/sessions/${session.id}`) return session;
    if (p.endsWith('/commands')) {
      return { commands: [
        { name: 'compact', description: 'Summarise the conversation', source: 'builtin', where: 'server' },
        { name: 'skill:review', description: 'Review the change', source: 'skill' },
        { name: 'ship', description: 'Ship it', source: 'prompt' },
        { name: 'lint', description: 'Lint it', source: 'extension' },
        { name: 'odd', description: 'From a newer portal', source: 'plugin' },
      ] };
    }
    if (p.endsWith('/config')) return { live: false, state: { model: { id: 'test', name: 'Test', provider: 'local' }, thinkingLevel: 'medium' }, stats: null, thinking: { levels: [] }, models: { models: [] } };
    if (p.endsWith('/canvases')) return [];
    if (method !== 'GET') return { ok: true };
  }, { streams: 'open', setup: 'skipped', settings: true });
  await page.addInitScript(() => localStorage.setItem('sidebarCollapsed', 'true'));
}

/** The warnings among the calls' badges: the two before them say how a command ended, as an exit code. */
const badges = (page: Page) => page.locator('.chat-tool-badge.is-warn');

test('a call a restart cut off says so in English, for a command and for any other tool', async ({ page }) => {
  await page.goto('/tests/chat.html?phase=interrupted');
  await expect(badges(page)).toHaveText(['interrupted', 'interrupted']);
});

test('the agent page counts its one chat in the singular, and shows the example for WATCH.md', async ({ page }) => {
  await agentPage(page);
  await page.goto('/agents?agent=home');
  await expect(page.getByText('conversation', { exact: true })).toBeVisible();
  await page.goto('/agents?agent=home&tab=files');
  await page.getByRole('button', { name: 'WATCH.md' }).click();
  await expect(page.getByRole('textbox', { name: 'WATCH.md' })).toHaveAttribute('placeholder', /^# What to keep an eye on\n\n- The open pull requests/);
});

test('the browser page names the kind of chat in English, and one it does not know as it is', async ({ page }) => {
  await browserPage(page);
  await page.goto('/browser');
  await expect(page.getByRole('button', { name: /A chat/ })).toContainText('task');
  await expect(page.getByRole('button', { name: /From a newer portal/ })).toContainText('future-kind');
});

test.describe('in a browser set to German', () => {
  test.use({ locale: 'de-DE' });

  test('a call a restart cut off says so, for a command and for any other tool', async ({ page }) => {
    await page.goto('/tests/chat.html?phase=interrupted');
    await page.evaluate(() => (window as any).setLang('de'));
    await expect(badges(page)).toHaveText(['unterbrochen', 'unterbrochen']);
  });

  test('the agent page counts its one chat in the singular, and shows the example for WATCH.md in German', async ({ page }) => {
    await agentPage(page);
    await page.goto('/agents?agent=home');
    await expect(page.getByText('Gespräch', { exact: true })).toBeVisible();
    await page.goto('/agents?agent=home&tab=files');
    await page.getByRole('button', { name: 'WATCH.md' }).click();
    await expect(page.getByRole('textbox', { name: 'WATCH.md' })).toHaveAttribute('placeholder', /^# Worauf du ein Auge haben sollst\n\n- Die offenen Pull Requests/);
  });

  test('the browser page names the kind of chat in German', async ({ page }) => {
    await browserPage(page);
    await page.goto('/browser');
    await expect(page.getByRole('button', { name: /A chat/ })).toContainText('Aufgabe');
    await expect(page.getByRole('button', { name: /Its rounds/ })).toContainText('Herzschlag');
    // A kind the table does not know is shown as the portal sent it.
    await expect(page.getByRole('button', { name: /From a newer portal/ })).toContainText('future-kind');
  });

  test('the list of commands says where each comes from, in German', async ({ page }) => {
    await commandsPage(page);
    await page.goto('/s/demo');
    await page.getByLabel('Nachricht', { exact: true }).fill('/');
    const list = page.getByRole('listbox', { name: 'Befehle' });
    await expect(list.getByRole('option', { name: /compact/ })).toContainText('eingebaut');
    await expect(list.getByRole('option', { name: /skill:review/ })).toContainText('Skill');
    await expect(list.getByRole('option', { name: /ship/ })).toContainText('Prompt-Vorlage');
    await expect(list.getByRole('option', { name: /lint/ })).toContainText('Erweiterung');
    await expect(list.getByRole('option', { name: /odd/ })).toContainText('plugin');
  });
});
