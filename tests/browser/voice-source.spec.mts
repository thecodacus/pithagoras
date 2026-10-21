import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from './portal-mock';

/**
 * Where voice mode listens and speaks: at the person's own addresses, or through an extension that offers it a place
 * to (`portal.voice.provide`), chosen in Settings → Add-ons → Voice or on the extension's own page.
 */
const OWN = { enabled: true, whisperUrl: 'http://127.0.0.1:8178/inference', breezeUrl: 'http://127.0.0.1:7860/v1/audio/speech', instruction: 'Clear speech', voice: 'design', runtime: 'breeze', language: 'auto', cfgScale: 4 };
const SPEAKER = { name: 'test-speaker', label: 'Speaker', ready: true, runtime: 'kokoro' };

/** Settings → Add-ons → Voice on its own, with the settings `config` and what is saved kept in `saved`. */
async function voicePage(page: Page, config: Record<string, unknown>) {
  const saved: Record<string, unknown>[] = [];
  await page.route('**/api/voice/presets', (r) => r.fulfill({ json: [] }));
  await page.route('**/api/voice/install', (r) => r.fulfill({ json: { available: false, state: 'unavailable', busy: false, progress: '', error: '' } }));
  await page.route('**/api/voice/hardware', (r) => r.fulfill({ status: 503, json: { error: 'No Docker' } }));
  await page.route('**/api/voice', (r) => {
    if (r.request().method() === 'PUT') saved.push(r.request().postDataJSON());
    return r.fulfill({ json: { ...config, ...saved.at(-1) } });
  });
  await page.goto('/tests/voice-addon.html');
  return saved;
}
const source = (page: Page) => page.getByRole('combobox', { name: 'Listen and speak through' });

test('with nothing that offers voice mode a place, there is nothing to choose: the own addresses are all there is', async ({ page }) => {
  await voicePage(page, { ...OWN, provider: '', providers: [] });
  await expect(page.getByRole('combobox', { name: 'Speech generation' })).toBeVisible();
  await expect(source(page)).toHaveCount(0);
});

test('an extension is chosen in place of the own addresses, which stay as they are, and the page follows how it speaks', async ({ page }) => {
  const saved = await voicePage(page, { ...OWN, provider: '', providers: [SPEAKER] });
  await expect(source(page)).toContainText('Your own addresses');
  // Breeze at the own addresses: a designed voice, and Breeze's speed.
  await expect(page.getByLabel('Describe the speaking voice')).toBeVisible();
  await source(page).click();
  await page.getByRole('option', { name: /Speaker/ }).click();
  // Through the extension, Kokoro speaks: with its own voices.
  await expect(page.getByRole('combobox', { name: 'Speaking voice' })).toBeVisible();
  await expect(page.getByLabel('Describe the speaking voice')).toBeHidden();
  // The addresses in Advanced connection are the person's own, and say so.
  await page.locator('summary').filter({ hasText: 'Advanced connection' }).click();
  await expect(page.getByText('These are your own addresses')).toBeVisible();
  await expect(page.getByLabel('Speech synthesis URL')).toHaveValue(OWN.breezeUrl);
  await page.getByRole('button', { name: 'Save voice settings' }).click();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();
  expect(saved.at(-1)).toMatchObject({ provider: 'test-speaker', runtime: 'breeze', whisperUrl: OWN.whisperUrl, breezeUrl: OWN.breezeUrl });
  // And back.
  await source(page).click();
  await page.getByRole('option', { name: /Your own addresses/ }).click();
  await expect(page.getByText('These are your own addresses')).toBeHidden();
  await page.getByRole('button', { name: 'Save voice settings' }).click();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();
  expect(saved.at(-1)).toMatchObject({ provider: '' });
});

test('an extension chosen that is not running is shown as chosen, and one that speaks with Chatterbox is given a language it speaks', async ({ page }) => {
  await voicePage(page, { ...OWN, provider: 'gone-speaker', providers: [{ ...SPEAKER, name: 'chatty', label: 'Chatty', runtime: 'chatterbox' }, { name: 'resting', label: 'Resting', ready: false }] });
  await expect(source(page)).toContainText('gone-speaker');
  await expect(page.getByRole('status').filter({ hasText: 'Not running: voice mode cannot listen or speak through it' })).toBeVisible();
  await source(page).click();
  await expect(page.getByRole('option', { name: /gone-speaker/ })).toContainText('Not running');
  await expect(page.getByRole('option', { name: /Resting/ })).toContainText('Not running');
  await page.getByRole('option', { name: /Chatty/ }).click();
  await expect(page.getByText('Not running: voice mode cannot listen or speak through it')).toBeHidden();
  // Chatterbox has no detection mode: the language is one it speaks.
  await expect(page.getByRole('combobox', { name: 'Input language' })).toContainText('English');
  await expect(page.getByRole('combobox', { name: 'Speech delivery' })).toBeVisible();
});

test('a source chosen while Settings is open reaches the chat behind it as Settings closes, without a reload', async ({ page }) => {
  const chat = { id: 'a', title: 'First chat', workspace: '/w/site', status: 'idle', kind: 'task', pinned: false, updated_at: new Date().toISOString(), provider: null, model: null, thinking_level: null };
  // Recognition alone at first: the chat offers dictation, and not voice mode.
  let voice: Record<string, unknown> = { ...OWN, runtime: 'none', breezeUrl: '', speech: false, provider: '', providers: [SPEAKER] };
  await mockPortal(page, ({ path, method }) => {
    if (method !== 'GET') return undefined;
    if (path === '/api/sessions') return { sessions: [chat], executor: 'host' };
    if (path === '/api/sessions/a') return chat;
    if (path === '/api/voice') return voice;
    return undefined;
  }, { settings: true });
  await page.goto('/s/a');
  await expect(page.getByRole('button', { name: 'Dictate a message' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn on hands-free voice' })).toHaveCount(0);
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  // Chosen meanwhile, as an extension's own page does: one that speaks.
  voice = { ...voice, speech: true, provider: SPEAKER.name };
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Turn on hands-free voice' })).toBeVisible();
});
