import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/**
 * A chat mode an extension offers, which asks first: listed after the portal's own and the person's in the warning
 * colour, chosen only after a yes in the portal's dialog, named in the extension's own translations, and in the header
 * and the audit log once chosen. The extension is a stand-in whose browser half gives the mode's texts in German; the
 * server's answers are the spec's.
 */
test.use({ installed: ['tests/fixtures/extensions/modes'] });

const WARNING = 'The agent can install and remove extensions in this chat. Use it only with what you would install yourself.';
const FOCUS = { id: 'test-modes/focus', label: 'Focus mode', description: 'Works with the focus tool alone.', confirm: WARNING, extension: 'test-modes' };
/** A mode the person made (Settings → Modes). */
const MINE = { id: 'custom/research', label: 'Research', description: 'Reads first.' };
const MODES = [
  { id: 'standard', label: 'Standard mode', description: 'The agent as this chat would have it anyway: the tools that Settings → Tools, its agent and its project switch on.' },
  { id: 'code', label: 'Code mode', description: "The model works through one tool: it writes a short JavaScript script that calls the chat's tools, and is given only what the script puts out." },
  MINE,
  FOCUS,
];
const config = {
  live: false, state: { model: { id: 'model-a', name: 'Model A', provider: 'llama-swap' }, thinkingLevel: 'medium' }, stats: null,
  thinking: { levels: ['off', 'medium'] }, models: { models: [] }, named: { provider: null, model: null },
};

interface Portal {
  /** What each PUT of the mode sent. */
  puts: unknown[];
  /** What the modes GET answers now. */
  modes: unknown[];
}

/** A chat, `a`, in the stored `mode`, with a message in it where it has `said` something. */
async function portal(page: Page, { mode = null as string | null, said = false } = {}): Promise<Portal> {
  const state: Portal & { mode: string | null } = { puts: [], modes: MODES, mode };
  const at = new Date().toISOString();
  const session = () => ({ id: 'a', title: 'A chat', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: at, provider: null, model: null, thinking_level: null, mode: state.mode });
  await mockPortal(page, async ({ path: p, method, json }) => {
    if (p === '/api/sessions') return { sessions: [session()], executor: 'host' };
    if (p === '/api/sessions/a') return session();
    if (p === '/api/sessions/a/modes' && method === 'GET') return { modes: state.modes };
    if (p === '/api/sessions/a/modes' && method === 'PUT') {
      const { mode: chosen } = json();
      state.puts.push(json());
      state.mode = chosen === 'standard' ? null : chosen;
      return { mode: chosen };
    }
    if (p === '/api/sessions/a/config' || p === '/api/sessions/a/models') return config;
    if (p === '/api/workspaces') return { root: '/w', workspaces: [] };
    if (p === '/api/models') return { models: [], providers: {} };
  }, { streams: 'open', settings: true });
  // Out of the way, so the sidebar's chat is not what the test reaches for.
  await page.addInitScript(() => localStorage.setItem('sidebarCollapsed', 'true'));
  await page.goto('/s/a');
  await expect.poll(() => page.evaluate(() => (window as any).streams.some((s: any) => !s.closed))).toBe(true);
  await page.evaluate((said) => {
    const s = (window as any).streams.find((s: any) => !s.closed);
    if (said) s.emit('message', { seq: 1, type: 'portal_prompt', payload: { message: 'Hello there' } });
    s.emit('caught-up', { seq: said ? 1 : 0 });
  }, said);
  return state;
}

const chip = (page: Page) => page.getByRole('button', { name: /^(Mode|Modus): / });
const menu = (page: Page) => page.getByRole('menu');
const row = (page: Page, label: string) => menu(page).getByRole('menuitemradio', { name: new RegExp(`^${label}`) });
const asked = (page: Page, title: string) => page.getByRole('alertdialog', { name: title });

test("an extension's mode is listed after the portal's own and the person's, in the warning colour, with its line", async ({ page }) => {
  await portal(page);
  await chip(page).click();
  await expect(menu(page).getByRole('menuitemradio')).toHaveText([/^Standard mode/, /^Code mode/, /^Research/, /^Focus mode/]);
  await expect(menu(page).locator('[role^="menuitem"]').last()).toHaveAccessibleName('New mode…');
  await expect(row(page, 'Focus mode').getByText('Focus mode', { exact: true })).toHaveClass(/text-warn/);
  await expect(row(page, 'Code mode').getByText('Code mode', { exact: true })).not.toHaveClass(/text-warn/);
  await expect(row(page, 'Focus mode').getByText(FOCUS.description, { exact: true })).toBeVisible();
});

test('a mode that asks first is chosen only after a yes: Cancel leaves Standard and sends nothing, and a yes is sent as confirmed', async ({ page }) => {
  const state = await portal(page);
  await chip(page).click();
  await row(page, 'Focus mode').click();
  const question = asked(page, 'Use Focus mode?');
  await expect(question).toBeVisible();
  await expect(question.getByText(WARNING, { exact: true })).toBeVisible();
  await question.getByRole('button', { name: 'Cancel' }).click();
  await expect(question).toHaveCount(0);
  await expect(chip(page)).toHaveText('Standard mode');
  await expect(chip(page)).toBeFocused();
  await page.waitForTimeout(300);
  expect(state.puts).toEqual([]);

  await chip(page).click();
  await row(page, 'Focus mode').click();
  await asked(page, 'Use Focus mode?').getByRole('button', { name: 'Use Focus mode' }).click();
  await expect.poll(() => state.puts).toEqual([{ mode: 'test-modes/focus', confirmed: true }]);
  await expect(chip(page)).toHaveText('Focus mode');
  await expect(chip(page)).toHaveClass(/text-warn/);

  // Back to a mode that does not ask: no question, and nothing confirmed.
  await chip(page).click();
  await row(page, 'Standard mode').click();
  await expect.poll(() => state.puts).toEqual([{ mode: 'test-modes/focus', confirmed: true }, { mode: 'standard' }]);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(chip(page)).not.toHaveClass(/text-warn/);
});

test('a chat started in a mode that asked first has it in its header in the warning colour', async ({ page }) => {
  await portal(page, { mode: FOCUS.id, said: true });
  await expect(page.getByText('Hello there')).toBeVisible();
  const pill = page.locator('.chat-header').getByText('Focus mode', { exact: true });
  await expect(pill).toBeVisible();
  await expect(pill).toHaveClass(/bg-warn\/10/);
  await expect(pill).toHaveClass(/text-warn/);
  await expect(pill).toHaveAttribute('title', FOCUS.description);
});

test("an extension's mode is named, described and asked in the extension's own German", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pithagoras.language', 'de'));
  await portal(page);
  await chip(page).click();
  await expect(row(page, 'Fokusmodus').getByText('Arbeitet allein mit dem Fokus-Werkzeug.', { exact: true })).toBeVisible();
  await row(page, 'Fokusmodus').click();
  const question = asked(page, 'Fokusmodus verwenden?');
  await expect(question.getByText('Der Agent kann in diesem Chat Erweiterungen installieren und entfernen. Verwende ihn nur mit dem, was du selbst installieren würdest.', { exact: true })).toBeVisible();
  await expect(question.getByRole('button', { name: 'Fokusmodus verwenden' })).toBeVisible();
});

test("the modes are read again when what is installed changes: an extension's mode comes and goes with it", async ({ page }) => {
  const state = await portal(page);
  state.modes = MODES.slice(0, 2);
  await page.evaluate(() => window.dispatchEvent(new Event('pithagoras:extensions-changed')));
  await chip(page).click();
  await expect(menu(page).getByRole('menuitemradio')).toHaveCount(2);
  await page.keyboard.press('Escape');
  state.modes = MODES;
  await page.evaluate(() => window.dispatchEvent(new Event('pithagoras:extensions-changed')));
  await chip(page).click();
  await expect(row(page, 'Focus mode')).toBeVisible();
});

test('the audit log shows a mode chosen', async ({ page }) => {
  await mockPortal(page, ({ path }) => (path === '/api/audit'
    ? { entries: [{ id: 1, at: '2026-10-01T09:00:00Z', kind: 'mode', tool: '', subject: 'Focus mode', reason: 'test-modes/focus', person_key: null, person_name: null, session_id: 'a' }] }
    : undefined));
  await page.goto('/audit');
  const entry = page.getByRole('listitem').filter({ hasText: 'Mode chosen' });
  await expect(entry).toBeVisible();
  await expect(entry.getByText('Mode chosen', { exact: true })).toHaveClass(/text-warn/);
  await expect(entry.getByText('Focus mode')).toBeVisible();
  await expect(entry.getByText('test-modes/focus')).toBeVisible();
});
