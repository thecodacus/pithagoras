import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from '../../../../tests/browser/portal-mock';
import { MODE } from '../../src/mode';

/**
 * Creator mode in the page, over what its server half and the portal would answer: the mode in the picker above the
 * message box, chosen only after a yes to its warning, in English and in the extension's own German; and its page in
 * Settings, which lists what was made with its state and its chat, forgets one that is not installed after asking,
 * and says so when nothing was made.
 */
test.use({ installed: ['extensions/creator'] });

const CREATOR = { id: `pithagoras-creator/${MODE.id}`, label: MODE.label, description: MODE.description, confirm: MODE.confirm, extension: 'pithagoras-creator' };
const STANDARD = { id: 'standard', label: 'Standard mode', description: 'The agent as this chat would have it anyway: the tools that Settings → Tools, its agent and its project switch on.' };
const config = {
  live: false, state: { model: { id: 'model-a', name: 'Model A', provider: 'llama-swap' }, thinkingLevel: 'medium' }, stats: null,
  thinking: { levels: ['off', 'medium'] }, models: { models: [] }, named: { provider: null, model: null },
};

/** A chat, `a`, that has said nothing yet, offered Standard and Creator mode; what each PUT of its mode sent. */
async function chat(page: Page) {
  const puts: unknown[] = [];
  let mode: string | null = null;
  const at = new Date().toISOString();
  const session = () => ({ id: 'a', title: 'A chat', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: at, provider: null, model: null, thinking_level: null, mode });
  await mockPortal(page, ({ path, method, json }) => {
    if (path === '/api/sessions') return { sessions: [session()], executor: 'host' };
    if (path === '/api/sessions/a') return session();
    if (path === '/api/sessions/a/modes' && method === 'GET') return { modes: [STANDARD, CREATOR] };
    if (path === '/api/sessions/a/modes' && method === 'PUT') {
      puts.push(json());
      mode = json().mode === 'standard' ? null : json().mode;
      return { mode: json().mode };
    }
    if (path === '/api/sessions/a/config' || path === '/api/sessions/a/models') return config;
    if (path === '/api/workspaces') return { root: '/w', workspaces: [] };
    if (path === '/api/models') return { models: [], providers: {} };
  }, { streams: 'open', settings: true });
  await page.addInitScript(() => localStorage.setItem('sidebarCollapsed', 'true'));
  await page.goto('/s/a');
  await expect.poll(() => page.evaluate(() => (window as any).streams.some((s: any) => !s.closed))).toBe(true);
  await page.evaluate(() => (window as any).streams.find((s: any) => !s.closed).emit('caught-up', { seq: 0 }));
  return { puts };
}

const chip = (page: Page) => page.getByRole('button', { name: /^(Mode|Modus): / });
const row = (page: Page, label: string) => page.getByRole('menu').getByRole('menuitemradio', { name: new RegExp(`^${label}`) });

test('the picker lists Creator mode, and choosing it shows its warning first: Cancel sends nothing, a yes sends it confirmed', async ({ page }) => {
  const { puts } = await chat(page);
  await chip(page).click();
  await expect(row(page, 'Creator mode').getByText(MODE.description, { exact: true })).toBeVisible();
  await expect(row(page, 'Creator mode').getByText('Creator mode', { exact: true })).toHaveClass(/text-warn/);
  await row(page, 'Creator mode').click();
  const question = page.getByRole('alertdialog', { name: 'Use Creator mode?' });
  await expect(question.getByText(MODE.confirm, { exact: true })).toBeVisible();
  await question.getByRole('button', { name: 'Cancel' }).click();
  await expect(question).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(puts).toEqual([]);

  await chip(page).click();
  await row(page, 'Creator mode').click();
  await page.getByRole('alertdialog', { name: 'Use Creator mode?' }).getByRole('button', { name: 'Use Creator mode' }).click();
  await expect.poll(() => puts).toEqual([{ mode: CREATOR.id, confirmed: true }]);
  await expect(chip(page)).toHaveText('Creator mode');
});

test('in German the mode is named, described and warned of in the extension\'s own German', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pithagoras.language', 'de'));
  await chat(page);
  await chip(page).click();
  await expect(row(page, 'Creator-Modus').getByText('Der Agent schreibt Erweiterungen für das Portal, installiert sie und ruft ihre Tools in diesem Chat auf.', { exact: true })).toBeVisible();
  await row(page, 'Creator-Modus').click();
  const question = page.getByRole('alertdialog', { name: 'Creator-Modus verwenden?' });
  await expect(question.getByText(/^Der Agent in diesem Chat schreibt Erweiterungen und installiert sie im Portal\. Er installiert, ohne dich zu fragen, außer nachdem dieser Chat etwas gelesen hat, das eine Prompt-Injection sein könnte\./)).toBeVisible();
  await expect(question.getByText(/Jede Installation steht in Einstellungen → Audit, und jede Erweiterung lässt sich in Einstellungen → Erweiterungen ausschalten oder entfernen\.$/)).toBeVisible();
});

const MADE = '/api/x/pithagoras-creator/made';
/** Creator's page in Settings, over `made` as its server half lists it; what was deleted, by name. */
async function settings(page: Page, made: unknown[]) {
  const deleted: string[] = [];
  let listed = made;
  await mockPortal(page, ({ path, method }) => {
    if (path === '/api/extensions' && method === 'GET') return { settingsPath: '/a/settings.json', extensions: [{ spec: 'extensions/creator', name: 'pithagoras-creator', version: '0.1.0', settings: [] }] };
    if (path === MADE && method === 'GET') return { made: listed };
    if (path.startsWith(`${MADE}/`) && method === 'DELETE') {
      const name = decodeURIComponent(path.slice(MADE.length + 1));
      deleted.push(name);
      listed = listed.filter((one: any) => one.name !== name);
      return { forgotten: name };
    }
  }, { settings: true });
  await page.goto('/settings/x/pithagoras-creator');
  return { dialog: page.getByRole('dialog', { name: 'Settings' }), deleted };
}

const at = '2026-10-23T08:30:00.000Z';
const digest = 'a1b2c3d4e5f6'.padEnd(64, '0');

test('its page in Settings lists what was made, with its state and its chat; Forget asks, then deletes one that is not installed', async ({ page }) => {
  const { dialog, deleted } = await settings(page, [
    { name: 'moon', version: '1.0.0', digest, at, chat: { id: 'c1', title: 'Moon work' }, draft: 'extensions/moon', installed: true, enabled: true },
    { name: 'echo', version: '0.1.0', digest, at, chat: null, draft: 'extensions/echo', installed: true, enabled: false },
    { name: 'old', digest, at, chat: { id: 'c2', title: 'Earlier' }, draft: 'extensions/old', installed: false },
  ]);
  await expect(dialog.getByText('What agents made in Creator mode chats, newest first.', { exact: false })).toBeVisible();
  const item = (name: string) => dialog.getByRole('listitem').filter({ has: page.getByText(name, { exact: true }) });
  await expect(item('moon').getByText('On', { exact: true })).toBeVisible();
  await expect(item('moon').getByRole('link', { name: 'Moon work' })).toHaveAttribute('href', '/s/c1');
  await expect(item('moon').getByText('a1b2c3d4e5f6', { exact: true })).toBeVisible();
  await expect(item('moon').getByRole('button', { name: 'Forget' })).toHaveCount(0);
  await expect(item('echo').getByText('Off', { exact: true })).toBeVisible();
  await expect(item('echo').getByText('Made in a chat that was deleted')).toBeVisible();
  await expect(item('old').getByText('Not installed', { exact: true })).toBeVisible();

  await item('old').getByRole('button', { name: 'Forget' }).click();
  const ask = page.getByRole('alertdialog', { name: 'Forget old?' });
  await expect(ask.getByText("Its copy is deleted from Creator mode's folder. It is not installed, so nothing else changes.")).toBeVisible();
  // It deletes: its button is red, and Enter does not delete.
  await expect(ask.getByRole('button', { name: 'Forget' })).toHaveClass(/text-danger/);
  await expect(ask.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForTimeout(200);
  expect(deleted).toEqual([]);
  await item('old').getByRole('button', { name: 'Forget' }).click();
  await page.getByRole('alertdialog', { name: 'Forget old?' }).getByRole('button', { name: 'Forget' }).click();
  await expect.poll(() => deleted).toEqual(['old']);
  await expect(item('old')).toHaveCount(0);
  await expect(item('moon')).toBeVisible();
});

test('with nothing made, its page says how to make something', async ({ page }) => {
  const { dialog } = await settings(page, []);
  await expect(dialog.getByText('Nothing made yet. Start a chat in Creator mode: what its agent installs is listed here.')).toBeVisible();
});
