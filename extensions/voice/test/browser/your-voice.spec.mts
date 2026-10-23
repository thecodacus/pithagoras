import path from 'node:path';
import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from '../../../../tests/browser/portal-mock';

/**
 * How the voice service speaks, on its page in Settings (src/web/YourVoice.tsx and VoiceLibrary.tsx), over what its
 * server half would answer: for each speech engine its container is built for, the voice it speaks with, the voice
 * library, each engine's settings and the language, saved with one button; and Settings asking before it closes over
 * what was typed and not saved.
 */
test.use({ installed: ['extensions/docker', 'extensions/voice'] });

/** Where Voice's server half answers: its routes, under the address the portal gives the package. */
const BASE = '**/api/x/pithagoras-voice';
/** How it speaks where nothing was set. */
const SPEECH = { voice: 'design', instruction: 'Clear speech', cfgScale: 4, exaggeration: 0.5, kokoroVoice: 'af_heart', speed: 1, language: 'auto' };
type Voice = { id: string; name: string; kind: string; instruction: string; transcript: string };

test.beforeEach(async ({ page }) => {
  await mockPortal(page, ({ path, method }) => {
    if (method === 'GET' && path === '/api/extensions') return { settingsPath: '/a/settings.json', extensions: [
      { spec: 'extensions/docker', name: 'pithagoras-docker', version: '1.2.0', settings: [] },
      { spec: 'extensions/voice', name: 'pithagoras-voice', version: '0.1.0', settings: [] },
    ] };
    if (method === 'GET' && path === '/api/x/pithagoras-voice/hardware') return { gpus: [], source: 'none', error: '', checked: false, cpuOnly: false, host: { totalMiB: 16384, freeMiB: 12000, threads: 8 }, selected: null, reserveMiB: 0, suggestion: { tts: 'breeze', asr: 'whisper', asrModel: 'base' } };
    return undefined;
  }, { settings: true });
});

const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings' });
/** What the page said went wrong. */
const failures = (page: Page) => settings(page).getByRole('alert');

/**
 * The service running for the speech engine `tts`, and what its server half keeps of how it speaks (`speech`) and of
 * its library (`voices`), as the page saves them; a test's own routes come after these and win. Then its page.
 */
async function servicePage(page: Page, { tts = 'breeze', speech = {}, voices = [] as Voice[] }: { tts?: string; speech?: Record<string, unknown>; voices?: Voice[] } = {}) {
  const kept = { tts, speech: { ...SPEECH, ...speech } as Record<string, unknown>, voices, puts: [] as Record<string, unknown>[] };
  await page.route(/\/api\/x\/pithagoras-voice\/state$/, r => r.fulfill({ json: { available: true, state: 'running', busy: false, progress: '', error: '', choice: { tts: kept.tts, asr: 'whisper', asrModel: 'base' }, lazyLoad: true, chosen: true } }));
  await page.route(`${BASE}/speech`, r => {
    if (r.request().method() === 'PUT') { kept.puts.push(r.request().postDataJSON()); kept.speech = r.request().postDataJSON(); }
    return r.fulfill({ json: kept.speech });
  });
  await page.route(`${BASE}/voices`, r => r.fulfill({ json: kept.voices }));
  await page.goto('/settings/x/pithagoras-voice');
  await expect(settings(page).getByRole('heading', { name: 'Your voice' })).toBeVisible();
  return kept;
}

test('a service without speech synthesis listens only: it says so, and offers the language alone', async ({ page }) => {
  const kept = await servicePage(page, { tts: 'none' });
  await expect(settings(page).getByRole('status').filter({ hasText: 'This installation has no speech synthesis: replies are not spoken. Dictation, which only listens, works.' })).toBeVisible();
  // Nothing of the speaking side: the voice, the library, how it is generated.
  await expect(page.getByRole('combobox', { name: 'Speaking voice' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add voice', exact: true })).toHaveCount(0);
  await expect(page.getByText('Speech generation')).toHaveCount(0);
  await expect(page.getByText('Choose how your assistant sounds.')).toHaveCount(0);
  // What listening has stays: the language.
  await page.getByRole('combobox', { name: 'Input language' }).click();
  await page.getByRole('option', { name: 'German' }).click();
  await page.getByRole('button', { name: 'Save voice settings' }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  expect(kept.puts).toEqual([{ ...SPEECH, language: 'de' }]);
});

test('with Kokoro the voice list is its own voices, and its speed replaces the generation setting', async ({ page }) => {
  const kept = await servicePage(page, { tts: 'kokoro', speech: { voice: 'voice-1' }, voices: [{ id: 'voice-1', name: 'Library clone', kind: 'clone', instruction: 'Warm.', transcript: 'Hello.' }] });
  const voice = page.getByRole('combobox', { name: 'Speaking voice' });
  await expect(voice).toContainText('Heart');
  await voice.click();
  await expect(page.getByRole('option', { name: /Emma.*British English · female/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /Library clone|Designed voice/ })).toHaveCount(0);
  await expect(page.getByRole('option', { name: /Japanese/ })).toHaveCount(0);
  await page.getByRole('option', { name: /Emma/ }).click();
  await expect(page.getByText('Speech generation')).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Speaking speed' }).click();
  await page.getByRole('option', { name: 'Faster' }).click();
  await page.getByRole('button', { name: 'Save voice settings' }).click();
  await expect.poll(() => kept.puts.length).toBe(1);
  // The voice of the library is kept for the other engines.
  expect([kept.puts[0].kokoroVoice, kept.puts[0].speed, kept.puts[0].voice]).toEqual(['bf_emma', 1.15, 'voice-1']);
  // Built for Breeze, it has the library again.
  kept.tts = 'breeze';
  await page.reload();
  await expect(voice).toContainText('Library clone');
  await expect(page.getByRole('combobox', { name: 'Speech generation' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Speaking speed' })).toHaveCount(0);
});

test('with Breeze the designed voice is described, and the generation is chosen', async ({ page }) => {
  const kept = await servicePage(page);
  const description = page.getByLabel('Describe the speaking voice');
  await expect(description).toHaveValue('Clear speech');
  await description.fill('A low, slow voice.');
  await page.getByRole('combobox', { name: 'Speech generation' }).click();
  await page.getByRole('option', { name: /Fast/ }).click();
  await page.getByRole('button', { name: 'Save voice settings' }).click();
  await expect.poll(() => kept.puts).toEqual([{ ...SPEECH, instruction: 'A low, slow voice.', cfgScale: 1 }]);
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  await expect(failures(page)).toHaveCount(0);
});

test('with Chatterbox the languages are its own, delivery is chosen, and a voice without a recording is flagged', async ({ page }) => {
  const kept = await servicePage(page, { tts: 'chatterbox', speech: { language: 'de' }, voices: [
    { id: 'voice-clone', name: 'Recorded', kind: 'clone', instruction: 'Warm.', transcript: 'Hello.' },
    { id: 'voice-designed', name: 'Described', kind: 'design', instruction: 'Bright.', transcript: '' },
  ] });
  const flagged = failures(page).filter({ hasText: 'Choose a voice with a recording above: Chatterbox cannot speak with a designed voice.' });
  await expect(flagged).toBeVisible();
  await expect(page.getByText('Numbers are written out before synthesis so they are spoken correctly.')).toBeVisible();
  await page.getByRole('combobox', { name: 'Input language' }).click();
  await expect(page.getByRole('option', { name: 'Auto-detect' })).toHaveCount(0);
  await expect(page.getByRole('option', { name: 'Russian' })).toHaveCount(0);
  await page.getByRole('option', { name: 'Swahili' }).click();
  await expect(page.getByText('Numbers stay as digits in this language, which Chatterbox reads unreliably.')).toBeVisible();
  const voice = page.getByRole('combobox', { name: 'Speaking voice', exact: true });
  await voice.click();
  await page.getByRole('option', { name: /Described/ }).click();
  await expect(flagged).toBeVisible();
  await voice.click();
  await page.getByRole('option', { name: /Recorded/ }).click();
  await expect(flagged).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Speech delivery' }).click();
  await page.getByRole('option', { name: /Calm/ }).click();
  await page.getByRole('button', { name: 'Save voice settings' }).click();
  await expect.poll(() => kept.puts).toEqual([{ ...SPEECH, language: 'sw', voice: 'voice-clone', exaggeration: 0.3 }]);
});

test('a refused save says why, and does not claim to be saved', async ({ page }) => {
  await servicePage(page, { tts: 'chatterbox' });
  await page.route(`${BASE}/speech`, r => r.request().method() === 'PUT' ? r.fulfill({ status: 400, json: { error: 'Chatterbox speaks with a reference clone: choose a voice with a recording' } }) : r.fallback());
  await page.getByRole('combobox', { name: 'Speech delivery' }).click();
  await page.getByRole('option', { name: /Expressive/ }).click();
  await page.getByRole('button', { name: 'Save voice settings' }).click();
  await expect(failures(page).filter({ hasText: 'Chatterbox speaks with a reference clone: choose a voice with a recording' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save voice settings' })).toBeVisible();
});

test('upload a voice reference, select it, save settings, and delete it', async ({ page }) => {
  const kept = await servicePage(page);
  await page.route(`${BASE}/voices`, r => {
    if (r.request().method() === 'POST') {
      const body = r.request().postDataJSON(); const audio = Buffer.from(body.audio, 'base64');
      expect(audio.toString('ascii', 0, 4)).toBe('RIFF'); expect(audio.readUInt32LE(24)).toBe(16000); expect(audio.readUInt16LE(22)).toBe(1);
      const row = { ...body, id: 'voice-test' }; delete row.audio; kept.voices = [row]; return r.fulfill({ json: row });
    }
    return r.fulfill({ json: kept.voices });
  });
  await page.route(`${BASE}/voices/voice-test`, r => { expect(r.request().method()).toBe('DELETE'); kept.voices = []; return r.fulfill({ json: { ok: true } }); });
  await page.getByRole('button', { name: 'Add voice', exact: true }).click();
  await page.getByLabel('Voice name', { exact: true }).fill('New narrator');
  await page.getByLabel('Reference recording').setInputFiles(path.resolve('tests/fixtures/jfk.wav'));
  await page.getByLabel('Exact words in the recording').fill('And so my fellow Americans, ask not what your country can do for you, ask what you can do for your country.');
  await page.getByRole('button', { name: 'Save new voice', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Speaking voice', exact: true })).toHaveText('New narrator');
  const preview = page.getByLabel('Voice reference preview');
  await expect(preview).toBeVisible();
  // Heard from the service's own route.
  expect(await preview.getAttribute('src')).toMatch(/\/api\/x\/pithagoras-voice\/voices\/voice-test\/audio$/);
  await page.getByRole('button', { name: 'Save voice settings', exact: true }).click();
  await expect.poll(() => kept.puts.at(-1)?.voice).toBe('voice-test');
  // The page draws the portal's own dialog, not the browser's.
  await page.getByRole('button', { name: 'Delete voice', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Speaking voice', exact: true })).toHaveText('Designed voice');
  await expect(failures(page)).toHaveCount(0);
});

/** A voice of the library, designed, as the tests below describe them. */
const designed = (id: string, name: string, instruction: string): Voice => ({ id, name, kind: 'design', instruction, transcript: '' });

test('change the description of a saved voice after it was created', async ({ page }) => {
  let voice = designed('voice-test', 'Night narrator', 'Warm delivery');
  const patches: unknown[] = []; let refuse = '';
  await servicePage(page, { speech: { voice: 'voice-test' }, voices: [voice] });
  await page.route(`${BASE}/voices/voice-test`, r => {
    expect(r.request().method()).toBe('PATCH'); patches.push(r.request().postDataJSON());
    if (refuse) return r.fulfill({ status: 400, json: { error: refuse } });
    voice = { ...voice, instruction: (patches.at(-1) as { instruction: string }).instruction.trim() }; return r.fulfill({ json: voice });
  });
  const description = page.getByLabel('Voice description'); const save = page.getByRole('button', { name: 'Save description', exact: true });
  await expect(description).toHaveValue('Warm delivery');
  await expect(save).toBeDisabled();
  await description.fill('   '); await expect(save).toBeDisabled();
  await description.fill('  A slow, low voice.  '); await expect(save).toBeEnabled();
  await save.click();
  await expect(description).toHaveValue('A slow, low voice.');
  await expect(save).toBeDisabled();
  expect(patches).toEqual([{ instruction: '  A slow, low voice.  ' }]);
  await expect(failures(page)).toHaveCount(0);
  // A refusal from the server is shown and the text stays for another try.
  refuse = 'Describe the voice in 1–1000 characters';
  await description.fill('Another voice.'); await save.click();
  await expect(failures(page).filter({ hasText: refuse })).toBeVisible();
  await expect(description).toHaveValue('Another voice.'); await expect(save).toBeEnabled();
});

test('Save voice settings also saves an edited voice description, and does not claim to when it cannot', async ({ page }) => {
  let voice = designed('voice-test', 'Night narrator', 'Warm delivery');
  const calls: string[] = []; let refuse = '';
  await servicePage(page, { speech: { voice: 'voice-test' }, voices: [voice] });
  await page.route(`${BASE}/speech`, r => {
    if (r.request().method() === 'PUT') { calls.push('PUT'); return r.fulfill({ json: r.request().postDataJSON() }); }
    return r.fallback();
  });
  await page.route(`${BASE}/voices/voice-test`, r => {
    const { instruction } = r.request().postDataJSON(); calls.push('PATCH ' + instruction);
    if (refuse) return r.fulfill({ status: 400, json: { error: refuse } });
    voice = { ...voice, instruction: instruction.trim() }; return r.fulfill({ json: voice });
  });
  const description = page.getByLabel('Voice description'); const saveSettings = page.getByRole('button', { name: /^(Save voice settings|Saved)$/ });
  await expect(description).toHaveValue('Warm delivery');
  // Nothing edited: the settings are saved as before, without touching the voice.
  await saveSettings.click(); await expect(saveSettings).toHaveText('Saved');
  expect(calls).toEqual(['PUT']);
  // An edit is not saved yet, and the button no longer says it is.
  await description.fill('A slow, low voice.');
  await expect(saveSettings).toHaveText('Save voice settings');
  await saveSettings.click();
  await expect(saveSettings).toHaveText('Saved');
  expect(calls).toEqual(['PUT', 'PATCH A slow, low voice.', 'PUT']);
  await expect(description).toHaveValue('A slow, low voice.');
  await expect(page.getByRole('button', { name: 'Save description', exact: true })).toBeDisabled();
  await expect(failures(page)).toHaveCount(0);
  // A description the server refuses stops the save: the error is shown, the settings are not claimed as saved.
  refuse = 'Describe the voice in 1–1000 characters';
  await description.fill('');
  await expect(saveSettings).toHaveText('Save voice settings');
  await saveSettings.click();
  await expect(failures(page).filter({ hasText: refuse })).toBeVisible();
  await expect(saveSettings).toHaveText('Save voice settings');
  expect(calls).toEqual(['PUT', 'PATCH A slow, low voice.', 'PUT', 'PATCH ']);
});

test('a description edited on one voice survives looking at another voice', async ({ page }) => {
  let voices = [designed('voice-a', 'Anna', 'Warm delivery'), designed('voice-b', 'Bruno', 'Dry delivery')];
  const patches: string[] = [];
  const kept = await servicePage(page, { speech: { voice: 'voice-a' }, voices });
  await page.route(`${BASE}/voices/*`, r => {
    const id = r.request().url().split('/').pop()!; const { instruction } = r.request().postDataJSON(); patches.push(`${id} ${instruction}`);
    const row = { ...voices.find(v => v.id === id)!, instruction }; voices = voices.map(v => v.id === id ? row : v); return r.fulfill({ json: row });
  });
  const description = page.getByLabel('Voice description'); const picker = page.getByRole('combobox', { name: 'Speaking voice', exact: true });
  await expect(description).toHaveValue('Warm delivery');
  await description.fill('A bright voice.');
  await picker.click(); await page.getByRole('option', { name: /Bruno/ }).click();
  await expect(description).toHaveValue('Dry delivery');
  await picker.click(); await page.getByRole('option', { name: /Anna/ }).click();
  await expect(description).toHaveValue('A bright voice.');
  await page.getByRole('button', { name: 'Save voice settings', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  expect(patches).toEqual(['voice-a A bright voice.']);
  expect(kept.puts.at(-1)?.voice).toBe('voice-a');
});

test('an emptied description on another voice does not block saving the settings', async ({ page }) => {
  const calls: string[] = [];
  await servicePage(page, { speech: { voice: 'voice-a' }, voices: [designed('voice-a', 'Anna', 'Warm delivery'), designed('voice-b', 'Bruno', 'Dry delivery')] });
  await page.route(`${BASE}/speech`, r => {
    if (r.request().method() === 'PUT') { const saved = r.request().postDataJSON(); calls.push('PUT ' + saved.voice); return r.fulfill({ json: saved }); }
    return r.fallback();
  });
  await page.route(`${BASE}/voices/*`, r => { calls.push('PATCH ' + r.request().url().split('/').pop()); return r.fulfill({ status: 400, json: { error: 'Describe the voice in 1–1000 characters' } }); });
  const description = page.getByLabel('Voice description'); const picker = page.getByRole('combobox', { name: 'Speaking voice', exact: true });
  await description.fill('');
  await picker.click(); await page.getByRole('option', { name: /Bruno/ }).click();
  await expect(description).toHaveValue('Dry delivery');
  await page.getByRole('button', { name: 'Save voice settings', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  expect(calls).toEqual(['PUT voice-b']);
  await expect(failures(page)).toHaveCount(0);
  // The emptied text is still there when that voice is looked at again, to be written or left.
  await picker.click(); await page.getByRole('option', { name: /Anna/ }).click();
  await expect(description).toHaveValue('');
});

test('text typed while a description is being saved is kept', async ({ page }) => {
  let voice = designed('voice-test', 'Night narrator', 'Warm delivery');
  const patches: string[] = []; let answer!: () => void; const answered = new Promise<void>(r => { answer = r; });
  await servicePage(page, { speech: { voice: 'voice-test' }, voices: [voice] });
  await page.route(`${BASE}/voices/voice-test`, async r => {
    const { instruction } = r.request().postDataJSON(); patches.push(instruction);
    await answered; voice = { ...voice, instruction }; return r.fulfill({ json: voice });
  });
  const description = page.getByLabel('Voice description'); const save = page.getByRole('button', { name: 'Save description', exact: true });
  await description.fill('First edit.'); await save.click();
  await expect.poll(() => patches.length).toBe(1);
  await description.fill('First edit. And more typed while saving.');
  answer();
  await expect(save).toBeEnabled();
  await expect(description).toHaveValue('First edit. And more typed while saving.');
  await save.click();
  await expect.poll(() => patches.length).toBe(2);
  await expect(save).toBeDisabled();
  expect(patches).toEqual(['First edit.', 'First edit. And more typed while saving.']);
});

/** Escape asks, and "Cancel" leaves Settings as it was. */
async function asksBeforeClosing(page: Page, field: ReturnType<Page['getByLabel']>, typed: string) {
  await page.keyboard.press('Escape');
  const ask = page.getByRole('alertdialog', { name: 'Discard your changes?' });
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(settings(page)).toBeVisible();
  await expect(field).toHaveValue(typed);
}

test('Escape over a new voice that was named and described asks first, and over the form that was only opened does not', async ({ page }) => {
  await servicePage(page);
  await settings(page).getByRole('button', { name: 'Add voice', exact: true }).click();
  await expect(settings(page).getByLabel('Voice name', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settings(page)).toBeHidden();

  await page.goto('/settings/x/pithagoras-voice');
  await settings(page).getByRole('button', { name: 'Add voice', exact: true }).click();
  await settings(page).getByLabel('Voice name', { exact: true }).fill('Grandpa');
  const words = settings(page).getByLabel('Exact words in the recording');
  await words.fill('Once upon a time.');
  await asksBeforeClosing(page, words, 'Once upon a time.');
});

test('Escape that follows a voice description as soon as it is typed asks, as for every other field', async ({ page }) => {
  await servicePage(page, { speech: { voice: 'v1' }, voices: [designed('v1', 'Night narrator', 'Warm delivery')] });
  const description = settings(page).getByLabel('Voice description');
  await expect(description).toHaveValue('Warm delivery');
  // The next key at once: only what the page does in the same task, and the microtasks after it, has happened by then.
  await description.evaluate((field: HTMLTextAreaElement) => new Promise<void>((done) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Warm and slow.');
    field.dispatchEvent(new Event('input', { bubbles: true }));
    let ticks = 0;
    const tick = () => {
      if (++ticks < 5) return void Promise.resolve().then(tick);
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      done();
    };
    tick();
  }));
  const ask = page.getByRole('alertdialog', { name: 'Discard your changes?' });
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(settings(page)).toBeVisible();
  await expect(description).toHaveValue('Warm and slow.');
});

test('Escape over a voice description that its own button saved does not ask, and over one that was not saved does', async ({ page }) => {
  let voice = designed('v1', 'Night narrator', 'Warm delivery');
  const sent: string[] = [];
  await servicePage(page, { speech: { voice: 'v1' }, voices: [voice] });
  await page.route(`${BASE}/voices/v1`, r => {
    const body = r.request().postDataJSON(); sent.push(`${r.request().method()} ${JSON.stringify(body)}`);
    voice = { ...voice, instruction: body.instruction.trim() }; return r.fulfill({ json: voice });
  });
  const description = settings(page).getByLabel('Voice description');
  await description.fill('Warm and slow.');
  await asksBeforeClosing(page, description, 'Warm and slow.');

  await settings(page).getByRole('button', { name: 'Save description', exact: true }).click();
  await expect(settings(page).getByRole('button', { name: 'Save description', exact: true })).toBeDisabled();
  expect(sent).toEqual(['PATCH {"instruction":"Warm and slow."}']);
  // Stored: nothing is left of it to lose.
  await page.keyboard.press('Escape');
  await expect(settings(page)).toBeHidden();
});

test('Escape over the settings that were changed asks first, and over ones that were saved does not', async ({ page }) => {
  await servicePage(page);
  const description = settings(page).getByLabel('Describe the speaking voice');
  await description.fill('A whisper.');
  await asksBeforeClosing(page, description, 'A whisper.');
  await settings(page).getByRole('button', { name: 'Save voice settings' }).click();
  await expect(settings(page).getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settings(page)).toBeHidden();
});
