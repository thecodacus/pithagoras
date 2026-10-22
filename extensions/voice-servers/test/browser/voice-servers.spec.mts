import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply } from '../../../../tests/browser/portal-mock';

/**
 * Voice servers' page in Settings (src/web/VoiceServers.tsx), over what its server half would answer: the addresses,
 * models and voices typed in and saved with one Save, the voices read from the speech server, and voice mode's source
 * chosen and stopped.
 */
test.use({ installed: ['extensions/voice-servers'] });

const BASE = '/api/x/pithagoras-voice-servers';

/** The server half as the page reaches it, with `saved` its settings at the start; what the page sent, in order. */
async function portal(page: Page, saved: Record<string, unknown> = {}) {
  const sent: { method: string; route: string; body: any }[] = [];
  let settings = { ...saved };
  let chosen = false;
  await mockPortal(page, ({ path, method, json }) => {
    // Settings lists the extension as the portal has it installed.
    if (path === '/api/extensions' && method === 'GET') return { settingsPath: '/a/settings.json', extensions: [{ spec: 'extensions/voice-servers', name: 'pithagoras-voice-servers', version: '0.1.0', settings: [] }] };
    if (!path.startsWith(BASE)) return undefined;
    const route = path.slice(BASE.length);
    if (method === 'GET' && route === '/settings') return { ...settings, chosen };
    const body = json();
    sent.push({ method, route, body });
    // What is empty is left out, as the server half keeps it.
    if (method === 'PUT' && route === '/settings') {
      settings = Object.fromEntries(Object.entries(body).filter(([, v]) => (v as string | unknown[]).length));
      return { ...settings, chosen };
    }
    if (method === 'POST' && route === '/server-voices') return { voices: [{ id: 'af_heart', name: 'af_heart' }, { id: 'bm_george', name: 'George' }] };
    if (method === 'PUT' && route === '/chosen') {
      if (body.chosen && !settings.sttUrl) return reply(400, { error: 'Set a speech recognition address first' });
      chosen = body.chosen;
      return { chosen };
    }
    return undefined;
  }, { settings: true });
  return { sent };
}

const settingsDialog = (page: Page) => page.getByRole('dialog', { name: 'Settings' });
const open = async (page: Page) => {
  await page.goto('/settings/x/pithagoras-voice-servers');
  return settingsDialog(page);
};

test('the addresses, models and voices are typed in and saved together, and Escape asks first while they are not', async ({ page }) => {
  const { sent } = await portal(page);
  const dialog = await open(page);
  const save = dialog.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeDisabled();
  await expect(dialog.getByText('The speech server has to answer 24 kHz mono WAV.', { exact: false })).toBeVisible();
  await dialog.getByLabel('Speech recognition URL').fill('http://127.0.0.1:8178/inference');
  await dialog.getByLabel('Speech recognition model').fill('whisper-1');
  await dialog.getByLabel('Input language').fill('de');
  await dialog.getByLabel('Dictation endpoint').fill('http://127.0.0.1:8179/inference');
  await dialog.getByLabel('Dictation model').fill('accurate');
  await dialog.getByLabel('Speech synthesis URL').fill('http://127.0.0.1:8880/v1/audio/speech');
  await dialog.getByLabel('Speech synthesis model').fill('kokoro');
  await dialog.getByLabel('Voices').fill('af_heart\nbm_george = George\n\n');
  await dialog.getByRole('combobox', { name: 'Voice', exact: true }).click();
  await page.getByRole('option', { name: 'George' }).click();

  // Not saved yet: closing asks first.
  const ask = page.getByRole('alertdialog', { name: 'Discard your changes?' });
  await page.keyboard.press('Escape');
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Cancel' }).click();

  await save.click();
  await expect(dialog.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  await expect(save).toBeDisabled();
  expect(sent).toEqual([{
    method: 'PUT',
    route: '/settings',
    body: {
      sttUrl: 'http://127.0.0.1:8178/inference', sttModel: 'whisper-1', language: 'de',
      dictationUrl: 'http://127.0.0.1:8179/inference', dictationModel: 'accurate',
      ttsUrl: 'http://127.0.0.1:8880/v1/audio/speech', ttsModel: 'kokoro',
      voices: [{ id: 'af_heart', name: 'af_heart' }, { id: 'bm_george', name: 'George' }], voice: 'bm_george',
    },
  }]);
  // As saved: the list a line each, and nothing left unsaved.
  await expect(dialog.getByLabel('Voices')).toHaveValue('af_heart\nbm_george = George');
  await page.keyboard.press('Escape');
  await expect(settingsDialog(page)).toBeHidden();
});

test("the voices are read from the speech server into the list, and the one chosen goes when it is taken out of it", async ({ page }) => {
  const { sent } = await portal(page, { sttUrl: 'http://127.0.0.1:8178/inference', voices: [{ id: 'af_sky', name: 'Sky' }], voice: 'af_sky' });
  const dialog = await open(page);
  const read = dialog.getByRole('button', { name: 'Read voices from the server' });
  await expect(read).toBeDisabled();
  await expect(dialog.getByRole('combobox', { name: 'Voice', exact: true })).toContainText('Sky');
  await dialog.getByLabel('Speech synthesis URL').fill('http://127.0.0.1:8880/v1/audio/speech');
  await read.click();
  await expect(dialog.getByLabel('Voices')).toHaveValue('af_heart\nbm_george = George');
  expect(sent).toEqual([{ method: 'POST', route: '/server-voices', body: { ttsUrl: 'http://127.0.0.1:8880/v1/audio/speech' } }]);
  // Sky is no longer listed: the server's own voice, until one is chosen.
  await expect(dialog.getByRole('combobox', { name: 'Voice', exact: true })).toContainText("The server's own");
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  expect(sent[1].body).toMatchObject({ voices: [{ id: 'af_heart', name: 'af_heart' }, { id: 'bm_george', name: 'George' }], voice: '' });
});

test('voice mode is used once a recognition address is saved, and stopped', async ({ page }) => {
  const { sent } = await portal(page);
  const dialog = await open(page);
  const use = dialog.getByRole('button', { name: 'Use for voice mode' });
  const inUse = dialog.getByRole('status').filter({ hasText: 'In use for voice mode' });
  await expect(use).toBeDisabled();
  await expect(dialog.getByText('Set a speech recognition address first')).toBeVisible();
  // Typed in is not saved: voice mode would listen through what is saved.
  await dialog.getByLabel('Speech recognition URL').fill('http://127.0.0.1:8178/inference');
  await expect(use).toBeDisabled();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(use).toBeEnabled();
  await expect(dialog.getByText('Set a speech recognition address first')).toBeHidden();
  await use.click();
  await expect(inUse).toBeVisible();
  await expect(use).toBeHidden();
  await dialog.getByRole('button', { name: 'Stop using' }).click();
  await expect(inUse).toBeHidden();
  await expect(use).toBeEnabled();
  expect(sent.map(({ route, body }) => [route, route === '/chosen' ? body.chosen : body.sttUrl])).toEqual([
    ['/settings', 'http://127.0.0.1:8178/inference'],
    ['/chosen', true],
    ['/chosen', false],
  ]);
});

test.describe('in a browser set to German', () => {
  test.use({ locale: 'de-DE' });

  test('the page says what it is in its own German', async ({ page }) => {
    await portal(page, { sttUrl: 'http://127.0.0.1:8178/inference' });
    await page.goto('/settings/x/pithagoras-voice-servers');
    const dialog = page.getByRole('dialog', { name: 'Einstellungen' });
    await expect(dialog.getByText('Der Sprachserver muss 24-kHz-Mono-WAV liefern.', { exact: false })).toBeVisible();
    await expect(dialog.getByLabel('URL der Spracherkennung')).toHaveValue('http://127.0.0.1:8178/inference');
    await expect(dialog.getByRole('button', { name: 'Für den Sprachmodus verwenden' })).toBeEnabled();
    await expect(dialog.getByRole('button', { name: 'Stimmen vom Server lesen' })).toBeDisabled();
  });
});
