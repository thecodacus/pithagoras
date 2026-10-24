import path from 'node:path';
import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply } from '../../../../tests/browser/portal-mock';

/**
 * Voice servers' page in Settings (src/web/VoiceServers.tsx), over what its server half would answer: the addresses,
 * models and voices typed in and saved with one Save, the voices read from the speech server, voice mode's source
 * chosen and stopped, and custom voices (src/web/VoiceLibrary.tsx), off until they are switched on.
 */
test.use({ installed: ['extensions/voice-servers'] });

const BASE = '/api/x/pithagoras-voice-servers';

/** A voice of the library, as the server half keeps it. */
type Voice = { id: string; name: string; kind: 'design' | 'clone'; instruction: string; transcript: string; stored?: { url: string; at: string } };

/**
 * The server half as the page reaches it, with `saved` its settings at the start and `voices` its library; what the
 * page sent, in order, every request but the reads of the settings.
 */
async function portal(page: Page, saved: Record<string, unknown> = {}, voices: Voice[] = []) {
  const sent: { method: string; route: string; body: any }[] = [];
  let settings: Record<string, any> = { ...saved };
  let library = [...voices];
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
    // Custom voices and their form have routes of their own, and a save of the page's fields keeps them.
    if (method === 'PUT' && route === '/settings') {
      const { customVoices, speechServer } = settings;
      settings = { ...Object.fromEntries(Object.entries(body).filter(([, v]) => (v as string | unknown[]).length)), ...(customVoices ? { customVoices } : {}), ...(speechServer ? { speechServer } : {}) };
      return { ...settings, chosen };
    }
    if (method === 'POST' && route === '/server-voices') return { voices: [{ id: 'af_heart', name: 'af_heart' }, { id: 'bm_george', name: 'George' }] };
    if (method === 'PUT' && route === '/custom-voices') {
      const { customVoices, ...rest } = settings;
      settings = body.on ? { ...rest, customVoices: true } : rest;
      return { ...settings, chosen };
    }
    if (method === 'PUT' && route === '/speech-server') {
      const { speechServer, ...rest } = settings;
      settings = body.speechServer === 'fixed' ? rest : { ...rest, speechServer: body.speechServer };
      return { ...settings, chosen };
    }
    if (route === '/voices' && method === 'GET') return library;
    if (route === '/voices' && method === 'POST') {
      const voice: Voice = { id: `voice-${library.length + 1}`, name: body.name.trim(), kind: body.kind, instruction: body.instruction.trim(), transcript: body.transcript?.trim() ?? '' };
      library = [...library, voice];
      return voice;
    }
    const store = /^\/voices\/([\w-]+)\/store$/.exec(route);
    if (store && method === 'POST') {
      library = library.map((v) => (v.id === store[1] ? { ...v, stored: { url: 'http://127.0.0.1:8004/upload_reference', at: '2026-10-25T10:00:00.000Z' } } : v));
      return library.find((v) => v.id === store[1]);
    }
    const one = /^\/voices\/([\w-]+)$/.exec(route);
    if (one && method === 'PATCH') {
      library = library.map((v) => (v.id === one[1] ? { ...v, ...body } : v));
      return library.find((v) => v.id === one[1]);
    }
    if (one && method === 'DELETE') {
      library = library.filter((v) => v.id !== one[1]);
      return { ok: true };
    }
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
  await dialog.getByRole('textbox', { name: 'Voices' }).fill('af_heart\nbm_george = George\n\n');
  // Custom voices are off: their switch, and nothing else of them.
  await expect(dialog.getByRole('switch', { name: 'Custom voices' })).not.toBeChecked();
  await expect(dialog.getByRole('combobox', { name: 'Voice requests' })).toHaveCount(0);
  await expect(dialog.getByText('Your voices', { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Add voice' })).toHaveCount(0);
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
  await expect(dialog.getByRole('textbox', { name: 'Voices' })).toHaveValue('af_heart\nbm_george = George');
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
  await expect(dialog.getByRole('textbox', { name: 'Voices' })).toHaveValue('af_heart\nbm_george = George');
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

test('custom voices are switched on: the person says what the speech server is, and the page shows only what fits it', async ({ page }) => {
  const kept: Voice = { id: 'voice-kept', name: 'Kept clone', kind: 'clone', instruction: 'Warm', transcript: 'Words I said.' };
  // An input language, which Chatterbox in audio.cpp needs.
  const { sent } = await portal(page, { sttUrl: 'http://127.0.0.1:8178/inference', language: 'de', ttsUrl: 'http://127.0.0.1:8880/v1/audio/speech', voices: [{ id: 'af_heart', name: 'af_heart' }] }, [kept]);
  const dialog = await open(page);
  const toggle = dialog.getByRole('switch', { name: 'Custom voices' });
  const voiceMenu = dialog.getByRole('combobox', { name: 'Voice', exact: true });
  const engine = dialog.getByRole('combobox', { name: 'Speech engine' });
  const through = dialog.getByRole('combobox', { name: 'Reached through' });
  await toggle.click();
  await expect(toggle).toBeChecked();
  // Fixed voices first: the ids listed, said plainly, and no library.
  await expect(engine).toContainText('Fixed voices, such as Kokoro');
  await expect(through).toHaveCount(0);
  await expect(dialog.getByText('A server with fixed voices, such as Kokoro, speaks with its own voice ids', { exact: false })).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Voices' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Add voice' })).toHaveCount(0);

  // Breeze: designed voices and clones, reached through audio.cpp first; the ids for fixed voices are not shown.
  await engine.click();
  await page.getByRole('option', { name: 'Breeze-TTS-2' }).click();
  await expect(through).toContainText('audio.cpp');
  await expect(dialog.getByText('Sent as the voice service sends Breeze-TTS-2 in audio.cpp', { exact: false })).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Voices' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Read voices from the server' })).toHaveCount(0);
  await through.click();
  await page.getByRole('option', { name: "Breeze-TTS's own server" }).click();
  await expect(dialog.getByText("Sent as Breeze-TTS's own server takes it", { exact: false })).toBeVisible();

  // A designed voice added, opened, renamed and described anew.
  await dialog.getByRole('button', { name: 'Add voice' }).click();
  await dialog.getByLabel('Voice name').fill('Narrator');
  await dialog.getByRole('combobox', { name: 'Voice type' }).click();
  await page.getByRole('option', { name: 'Design from a description' }).click();
  await dialog.getByLabel('Voice description').fill('A deep, calm narrator');
  await dialog.getByRole('button', { name: 'Save new voice' }).click();
  // Added, it is opened in the list.
  await expect(dialog.getByRole('button', { name: /Narrator/, expanded: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Save new voice' })).toHaveCount(0);
  await expect(dialog.getByLabel('Voice name')).toHaveValue('Narrator');
  await dialog.getByLabel('Voice name').fill('Storyteller');
  await dialog.getByLabel('Voice description').fill('A bright storyteller');
  await dialog.getByRole('button', { name: 'Save voice', exact: true }).click();
  await expect(dialog.getByRole('button', { name: /Storyteller/ })).toBeVisible();

  // The Voice menu has the library's voices in place of the ids, chosen and saved with the page's Save.
  await voiceMenu.click();
  await expect(page.getByRole('option', { name: 'af_heart' })).toHaveCount(0);
  await expect(page.getByRole('option', { name: /Kept clone/ })).toBeVisible();
  await page.getByRole('option', { name: /Storyteller/ }).click();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();

  // Chatterbox clones, from the recording alone: the designed voice is kept and not shown, nor chosen any more.
  await engine.click();
  await page.getByRole('option', { name: 'Chatterbox', exact: true }).click();
  await expect(through).toContainText('audio.cpp: the recording with each phrase');
  await expect(voiceMenu).toContainText("The server's own");
  await expect(dialog.getByRole('button', { name: /Storyteller/ })).toHaveCount(0);
  await expect(dialog.getByText('Designed voices are kept for Breeze, and not offered to Chatterbox, which clones.')).toBeVisible();
  await dialog.getByRole('button', { name: /Kept clone/ }).click();
  await expect(dialog.getByLabel('Voice description')).toHaveCount(0);
  await expect(dialog.getByText('Chatterbox speaks from the recording alone: it takes no description.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Add voice' }).click();
  await expect(dialog.getByRole('combobox', { name: 'Voice type' })).toHaveCount(0);
  await expect(dialog.getByLabel('Reference recording')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close new voice' }).click();

  // Off: the choice and the library are hidden again, and kept.
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(engine).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /Kept clone/ })).toHaveCount(0);
  await expect(dialog.getByRole('textbox', { name: 'Voices' })).toBeVisible();

  expect(sent.map(({ method, route, body }) => [method, route, body])).toEqual([
    ['PUT', '/custom-voices', { on: true }],
    ['GET', '/voices', null],
    ['PUT', '/speech-server', { speechServer: 'breeze-audiocpp' }],
    ['PUT', '/speech-server', { speechServer: 'breeze-tts' }],
    ['POST', '/voices', { name: 'Narrator', kind: 'design', instruction: 'A deep, calm narrator' }],
    ['PATCH', '/voices/voice-2', { name: 'Storyteller', instruction: 'A bright storyteller' }],
    ['PUT', '/settings', expect.objectContaining({ voice: 'voice-2' })],
    ['PUT', '/speech-server', { speechServer: 'chatterbox-audiocpp' }],
    ['PUT', '/custom-voices', { on: false }],
  ]);
});

test("a clone for Chatterbox is made mono 16 kHz WAV in the browser, sent with its words, and stored on a server that keeps voices, again on demand", async ({ page }) => {
  const { sent } = await portal(page, { sttUrl: 'http://127.0.0.1:8178/inference', ttsUrl: 'http://127.0.0.1:8004/v1/audio/speech', ttsModel: 'chatterbox', customVoices: true, speechServer: 'chatterbox-tts-server' });
  const dialog = await open(page);
  await expect(dialog.getByRole('combobox', { name: 'Reached through' })).toContainText('Chatterbox-TTS-Server: voices stored on it');
  await expect(dialog.getByText('Each clone is stored on Chatterbox-TTS-Server once', { exact: false })).toBeVisible();
  await expect(dialog.getByText('No voices yet.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Add voice' }).click();
  await dialog.getByLabel('Voice name').fill('Me');
  await dialog.getByLabel('Reference recording').setInputFiles(path.resolve('tests/fixtures/jfk.wav'));
  await dialog.getByLabel('Exact words in the recording').fill('And so, my fellow Americans');
  await dialog.getByRole('button', { name: 'Save new voice' }).click();
  await expect(dialog.getByLabel('Voice reference preview')).toHaveAttribute('src', /\/api\/x\/pithagoras-voice-servers\/voices\/voice-1\/audio$/);
  await expect(dialog.getByText('And so, my fellow Americans')).toBeVisible();
  const added = sent.find((s) => s.method === 'POST')!.body;
  // Chatterbox takes no description: the clone keeps the first one, for Breeze.
  expect({ ...added, audio: undefined }).toEqual({ name: 'Me', kind: 'clone', instruction: 'Speak clearly and naturally.', transcript: 'And so, my fellow Americans', audio: undefined });
  const audio = Buffer.from(added.audio, 'base64');
  expect([audio.toString('ascii', 0, 4), audio.readUInt16LE(22), audio.readUInt32LE(24), audio.readUInt16LE(34)]).toEqual(['RIFF', 1, 16000, 16]);
  // The stand-in stored nothing as it was added: it says so, and stores it on demand.
  await expect(dialog.getByText('Not stored on this speech server yet', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: 'Store on the speech server' }).click();
  await expect(dialog.getByText('Stored on the speech server', { exact: false })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Store again' })).toBeVisible();
  // Deleting it says the server keeps its copy.
  await dialog.getByRole('button', { name: 'Delete voice' }).click();
  await expect(page.getByRole('alertdialog').getByText('The speech server keeps its copy, voice-1.wav', { exact: false })).toBeVisible();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(dialog.getByText('No voices yet.')).toBeVisible();
  expect(sent.filter((s) => s.method !== 'GET').map(({ method, route }) => [method, route])).toEqual([['POST', '/voices'], ['POST', '/voices/voice-1/store'], ['DELETE', '/voices/voice-1']]);
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
    await expect(dialog.getByRole('switch', { name: 'Eigene Stimmen' })).not.toBeChecked();
  });

  test('custom voices say what they are in its own German', async ({ page }) => {
    await portal(page, { sttUrl: 'http://127.0.0.1:8178/inference', language: 'de', customVoices: true });
    await page.goto('/settings/x/pithagoras-voice-servers');
    const dialog = page.getByRole('dialog', { name: 'Einstellungen' });
    await expect(dialog.getByRole('switch', { name: 'Eigene Stimmen' })).toBeChecked();
    const engine = dialog.getByRole('combobox', { name: 'Sprach-Engine' });
    await expect(engine).toContainText('Feste Stimmen, etwa Kokoro');
    await expect(dialog.getByText('Ein Server mit festen Stimmen, etwa Kokoro', { exact: false })).toBeVisible();
    await engine.click();
    await page.getByRole('option', { name: 'Chatterbox', exact: true }).click();
    await expect(dialog.getByRole('combobox', { name: 'Erreicht über' })).toContainText('audio.cpp: die Aufnahme mit jedem Satz');
    await expect(dialog.getByText('Deine Stimmen', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Noch keine Stimmen.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Stimme hinzufügen' }).click();
    await expect(dialog.getByLabel('Name der Stimme')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Neue Stimme speichern' })).toBeDisabled();
  });
});
