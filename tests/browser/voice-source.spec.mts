import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/**
 * Voice mode's source: the extension it listens and speaks through (`portal.voice.provide`), chosen on that extension's
 * own page. The voices it offers are what an agent's voice is picked from, on the Agents page.
 */
const SOURCE = { provider: 'test-speaker', label: 'Speaker', ready: true, speech: true, enabled: true };
const ORB = { avatar: 'orb', personality: 'balanced', palette: 'aurora', colors: { idle: '#82bcff', input: '#7fe0b4', output: '#c9a2ff', muted: '#8a91a0' }, speed: 1, reactivity: 1, glow: 1, pattern: 'ribbons', finish: 'glossy', eyes: 'none', eyeColor: '#111111', hat: 'none', hatColor: 'auto', prop: 'none', propColor: 'auto' };

/**
 * The Agents page with the agent Home, which speaks with `voice`, and its avatar opened. `config` is voice mode's
 * settings, read at each request, so a test can change them.
 */
async function avatar(page: Page, config: () => Record<string, unknown>, voice = '') {
  const answers: Record<string, unknown> = {
    '/api/agents': { agents: [{ id: 'home', name: 'Home', home: '/a', first: true, initialised: true, chats: 0, channels: [], orb: ORB, voice, heartbeat: { minutes: 0, quietStart: '', quietEnd: '', timeZone: 'UTC', last: null, status: null, running: false, watching: false, available: true }, unread: 0 }] },
    '/api/agent/sessions': { sessions: [], agentHome: '/a' },
    '/api/agents/home/setup': { home: '/a', initialised: true, files: [{ name: 'SOUL.md', exists: true, content: 'Kind.', mtime: 1 }] },
  };
  await mockPortal(page, (ask) => (ask.path === '/api/voice' ? config() : answers[ask.path]), { settings: true });
  await page.goto('/agents?agent=home');
  await page.getByRole('button', { name: /^(Customize the avatar|Avatar anpassen)$/ }).click();
  return page.getByRole('dialog', { name: 'Avatar' });
}

test("an agent's voice is picked from the voices the source offers, after the source's own choice, and a voice it no longer offers is kept", async ({ page }) => {
  const dialog = await avatar(page, () => ({ ...SOURCE, voices: [{ id: 'design', name: 'Designed voice', builtIn: true }, { id: 'voice-1', name: 'Library clone' }] }), 'voice-gone');
  const picker = dialog.getByRole('combobox', { name: 'Voice' });
  // Saved, and not offered now: shown as it is, not changed.
  await expect(picker).toContainText('voice-gone');
  await picker.click();
  const options = page.getByRole('option');
  await expect(options).toHaveCount(4);
  await expect(options.nth(0)).toHaveText('As Speaker chooses');
  await expect(options.nth(1)).toHaveText('Designed voice');
  await expect(options.nth(2)).toHaveText('Library clone');
  await expect(options.nth(3)).toContainText('voice-gone');
  await expect(options.nth(3)).toContainText('Not offered now');
  await page.keyboard.press('Escape');
  // Voices are added on the source's own page.
  await expect(dialog.getByRole('link', { name: 'Add a voice in Speaker' })).toHaveAttribute('href', '/settings/x/test-speaker');
});

test("while the source's server half does not run there is no page to add a voice on, and so no link", async ({ page }) => {
  const dialog = await avatar(page, () => ({ provider: 'gone-speaker', ready: false, speech: true, voices: [], enabled: true }));
  const picker = dialog.getByRole('combobox', { name: 'Voice' });
  await expect(picker).toContainText('As gone-speaker chooses');
  await expect(dialog.getByRole('link', { name: /Add a voice/ })).toHaveCount(0);
});

test("a voice of the source's own is named in its German, and one the person named is shown as they named it", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pithagoras.language', 'de'));
  // The source's browser half: its own texts in German.
  await page.route('**/api/extension-ui', (route) => route.fulfill({ json: { extensions: [{ name: 'test-speaker', version: '0.1.0', rev: 'test', entry: '/api/extension-ui/test-speaker/client.js?v=test' }] } }));
  await page.route('**/api/extension-ui/test-speaker/client.js*', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: 'export default function (portal) { portal.locale.add("de", { Speaker: "Sprecher", "Morning voice": "Morgenstimme", Calm: "Gelassen" }); window.speakerStrings = true; }',
  }));
  const dialog = await avatar(page, () => ({ ...SOURCE, voices: [{ id: 'morning', name: 'Morning voice', builtIn: true }, { id: 'voice-1', name: 'Calm' }] }));
  await page.waitForFunction(() => (window as any).speakerStrings);
  const picker = dialog.getByRole('combobox', { name: 'Sprachsteuerung' });
  await expect(picker).toContainText('Wie „Sprecher“ es wählt');
  await picker.click();
  await expect(page.getByRole('option', { name: 'Morgenstimme' })).toBeVisible();
  // "Calm" is a word both the source and the portal have German for: a name the person gave is neither.
  await expect(page.getByRole('option', { name: 'Calm', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: /Gelassen|Ruhig/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog.getByRole('link', { name: 'Eine Stimme in „Sprecher“ hinzufügen' })).toBeVisible();
});

test("the link opens the source's page in Settings, which closes back to the agent, whose avatar then lists a voice added there", async ({ page }) => {
  let voices = [{ id: 'voice-1', name: 'Library clone' }];
  const dialog = await avatar(page, () => ({ ...SOURCE, voices }));
  await dialog.getByRole('link', { name: 'Add a voice in Speaker' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/x\/test-speaker$/);
  // Added on the source's page.
  voices = [...voices, { id: 'voice-2', name: 'New clone' }];
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await expect(page).toHaveURL(/\/agents\?agent=home$/);
  await page.getByRole('button', { name: 'Customize the avatar' }).click();
  await page.getByRole('dialog', { name: 'Avatar' }).getByRole('combobox', { name: 'Voice' }).click();
  await expect(page.getByRole('option', { name: 'New clone' })).toBeVisible();
});

test('a voice picked and not saved is asked about before the link leaves the avatar, as closing it asks', async ({ page }) => {
  const dialog = await avatar(page, () => ({ ...SOURCE, voices: [{ id: 'voice-1', name: 'Library clone' }] }));
  const picker = dialog.getByRole('combobox', { name: 'Voice' });
  await picker.click();
  await page.getByRole('option', { name: 'Library clone' }).click();
  const link = dialog.getByRole('link', { name: 'Add a voice in Speaker' });
  const question = page.getByRole('alertdialog', { name: 'Discard your changes?' });
  // Kept: the avatar stays open with the voice picked.
  await link.click();
  await question.getByRole('button', { name: 'Cancel' }).click();
  await expect(question).toBeHidden();
  await expect(picker).toContainText('Library clone');
  await expect(page).toHaveURL(/\/agents\?agent=home$/);
  // Discarded: Settings opens on the source's page.
  await link.click();
  await question.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/x\/test-speaker$/);
});

test('a source chosen, or stopped, while Settings is open reaches the chat behind it, without a reload', async ({ page }) => {
  const chat = { id: 'a', title: 'First chat', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: new Date().toISOString(), provider: null, model: null, thinking_level: null };
  // Recognition alone at first: the chat offers dictation, and not voice mode.
  let voice: Record<string, unknown> = { ...SOURCE, speech: false, voices: [] };
  await mockPortal(page, ({ path, method }) => {
    if (path === '/api/voice/provider' && method === 'DELETE') return (voice = { provider: '', ready: false, speech: true, voices: [], enabled: false });
    if (method !== 'GET') return undefined;
    if (path === '/api/sessions') return { sessions: [chat], executor: 'host' };
    if (path === '/api/sessions/a') return chat;
    if (path === '/api/voice') return voice;
    return undefined;
  }, { settings: true });
  await page.goto('/s/a');
  await expect(page.getByRole('button', { name: 'Dictate a message' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn on hands-free voice' })).toHaveCount(0);
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Settings' }).click();
  await expect(settings).toBeVisible();
  // Chosen meanwhile, as an extension's own page does: one that speaks.
  voice = { ...voice, speech: true };
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await expect(page.getByRole('button', { name: 'Turn on hands-free voice' })).toBeVisible();
  // Stopped in Settings → Defaults → Voice mode: neither is offered once it closes.
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Settings' }).click();
  await settings.getByRole('button', { name: 'Stop using' }).click();
  await expect(settings.getByText('Nothing listens and speaks for voice mode.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await expect(page.getByRole('button', { name: 'Turn on hands-free voice' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Dictate a message' })).toHaveCount(0);
});
