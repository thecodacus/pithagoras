import { type Page } from '@playwright/test';
import { test, expect } from './portal-mock';

// Settings → Defaults → Voice mode: the extension voice mode listens and speaks through, which is chosen on that
// extension's own page, and how spoken conversations go. Each change is saved as it is made.
const BUILT_IN = 'Built-in speaking instructions for this test.';
const DEFAULT_LIST = ['llama.cpp', 'llama-server', 'llama-swap'];
const VAD = { positiveSpeechThreshold: 0.65, negativeSpeechThreshold: 0.35, minSpeechMs: 256, preSpeechPadMs: 320, redemptionMs: 1000 };
const SPEAKER = { provider: 'test-speaker', label: 'Speaker', ready: true, speech: true, voices: [], enabled: true };

/**
 * The section on its own, with voice mode's source `source`. A save is kept as the portal keeps it, the built-in text
 * and the default list as nothing, and answered as the portal answers. `puts` is every body saved; `builtIn` is the
 * portal's built-in text, which a test can change as an update of the portal would.
 */
async function voiceMode(page: Page, source: Record<string, unknown> = SPEAKER, kept: Record<string, any> = {}) {
  const portal = { puts: [] as any[], builtIn: BUILT_IN };
  let saved: Record<string, any> = kept;
  await page.route('**/api/voice', (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      portal.puts.push(body);
      const names = [...new Set<string>(body.skipThinkingProviders)];
      saved = { ...saved, ...body, responseInstructions: body.responseInstructions.trim() === portal.builtIn ? '' : body.responseInstructions.trim(), skipThinkingProviders: names.join() === DEFAULT_LIST.join() ? undefined : names };
    }
    return route.fulfill({ json: {
      ...source, vad: saved.vad ?? VAD, responseInstructions: saved.responseInstructions || portal.builtIn, defaultResponseInstructions: portal.builtIn,
      responseInstructionsOff: saved.responseInstructionsOff ?? false, skipThinkingProviders: saved.skipThinkingProviders ?? DEFAULT_LIST,
      defaultSkipThinkingProviders: DEFAULT_LIST, voiceModel: saved.voiceModel ?? '', conversation: saved.conversation ?? true,
    } });
  });
  await page.goto('/tests/voice-mode.html');
  return portal;
}
const saved = (page: Page) => page.getByText('Saved', { exact: true });

test('a speech detection slider is saved as it is let go, with the rest of the section, and Reset speech detection saves the defaults', async ({ page }) => {
  const { puts } = await voiceMode(page);
  await page.evaluate(() => { (window as any).changed = 0; window.addEventListener('voice-config-changed', () => { (window as any).changed++; }); });
  await page.locator('summary').filter({ hasText: 'Speech detection' }).click();
  const silence = page.getByRole('slider', { name: /End-of-turn silence/ });
  await expect(silence).toHaveValue('1000');
  // Moved with a key: saved as the key is let go, and voice mode's controls are told.
  await silence.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => puts.length).toBe(1);
  expect(puts[0]).toEqual({ vad: { ...VAD, redemptionMs: 1050 }, responseInstructions: '', skipThinkingProviders: DEFAULT_LIST, voiceModel: '', conversation: true });
  await expect(saved(page)).toBeVisible();
  expect(await page.evaluate(() => (window as any).changed)).toBe(1);
  await expect(saved(page)).toBeHidden({ timeout: 4000 });
  // Moved with the pointer: saved as it is let go, and not while it moves.
  await silence.fill('500');
  expect(puts).toHaveLength(1);
  await silence.dispatchEvent('pointerup');
  await expect.poll(() => puts.length).toBe(2);
  expect(puts[1].vad.redemptionMs).toBe(500);
  await expect(saved(page)).toBeVisible();
  await page.reload();
  await page.locator('summary').filter({ hasText: 'Speech detection' }).click();
  await expect(silence).toHaveValue('500');
  await page.getByRole('button', { name: 'Reset speech detection' }).click();
  await expect.poll(() => puts.length).toBe(3);
  expect(puts[2].vad).toEqual(VAD);
  await expect(silence).toHaveValue('1000');
});

test('speaking instructions show the built-in text, save an edit as the field is left and reset to the built-in text', async ({ page }) => {
  const { puts } = await voiceMode(page);
  await expect(page.getByText('This portal is set to send no speaking instructions')).toBeHidden();
  await page.locator('summary').filter({ hasText: 'Speaking instructions' }).click();
  const text = page.getByRole('textbox', { name: 'Speaking instructions' });
  const reset = page.getByRole('button', { name: 'Reset to default' });
  await expect(text).toHaveValue(BUILT_IN);
  await expect(reset).toBeDisabled();
  await text.fill('Answer in one word.');
  await expect(reset).toBeEnabled();
  // Nothing is sent while it is written.
  expect(puts).toHaveLength(0);
  await text.blur();
  await expect.poll(() => puts.length).toBe(1);
  expect(puts[0]).toEqual({ vad: VAD, responseInstructions: 'Answer in one word.', skipThinkingProviders: DEFAULT_LIST, voiceModel: '', conversation: true });
  await expect(saved(page)).toBeVisible();
  // Saved as it is, and the built-in text still there to reset to.
  await expect(text).toHaveValue('Answer in one word.');
  await reset.click();
  await expect.poll(() => puts.length).toBe(2);
  expect(puts[1].responseInstructions).toBe('');
  await expect(text).toHaveValue(BUILT_IN);
  await expect(reset).toBeDisabled();
  // Emptied to write a new text, it stays empty while being written, and is the built-in text once left.
  await text.fill('');
  await expect(text).toHaveValue('');
  await text.blur();
  await expect.poll(() => puts.length).toBe(3);
  expect(puts[2].responseInstructions).toBe('');
  await expect(text).toHaveValue(BUILT_IN);
  await page.reload();
  await page.locator('summary').filter({ hasText: 'Speaking instructions' }).click();
  await expect(text).toHaveValue(BUILT_IN);
});

test('speaking instructions say when the portal is set to send none', async ({ page }) => {
  await voiceMode(page, SPEAKER, { responseInstructions: 'Kept text.', responseInstructionsOff: true });
  await page.locator('summary').filter({ hasText: 'Speaking instructions' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'VOICE_RESPONSE_INSTRUCTIONS=false' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Speaking instructions' })).toHaveValue('Kept text.');
});

test('saving another setting does not pin the built-in text of an older portal', async ({ page }) => {
  const portal = await voiceMode(page);
  portal.builtIn = 'Built-in text before the update.';
  await page.reload();
  await page.locator('summary').filter({ hasText: 'Speaking instructions' }).click();
  const text = page.getByRole('textbox', { name: 'Speaking instructions' });
  await expect(text).toHaveValue('Built-in text before the update.');
  // The portal is updated, with new built-in text, while this page is open.
  portal.builtIn = 'Built-in text after the update.';
  await page.locator('summary').filter({ hasText: 'Speech detection' }).click();
  await page.getByRole('slider', { name: /End-of-turn silence/ }).fill('500');
  await page.getByRole('slider', { name: /End-of-turn silence/ }).dispatchEvent('pointerup');
  await expect.poll(() => portal.puts.length).toBe(1);
  expect(portal.puts[0].responseInstructions).toBe('');
  await expect(text).toHaveValue('Built-in text after the update.');
  // A text of the person's own is saved as it is.
  await text.fill('Answer in one word.');
  await text.blur();
  await expect.poll(() => portal.puts.length).toBe(2);
  expect(portal.puts[1].responseInstructions).toBe('Answer in one word.');
});

test('the providers that reply without thinking first: typed with commas, saved as the field is left as the server keeps them, and reset to the default list', async ({ page }) => {
  const { puts } = await voiceMode(page);
  const field = page.getByRole('textbox', { name: 'Reply without thinking first on' });
  const reset = page.getByRole('button', { name: 'Reset to the default list' });
  await expect(field).toHaveValue('llama.cpp, llama-server, llama-swap');
  await expect(reset).toBeDisabled();
  // Typed as it is, commas and all, while it is written.
  await field.fill('llama-swap, my-gateway, llama-swap, ');
  await expect(field).toHaveValue('llama-swap, my-gateway, llama-swap, ');
  await expect(reset).toBeEnabled();
  expect(puts).toHaveLength(0);
  await field.blur();
  await expect.poll(() => puts.length).toBe(1);
  expect(puts[0].skipThinkingProviders).toEqual(['llama-swap', 'my-gateway', 'llama-swap']);
  await expect(saved(page)).toBeVisible();
  // Once saved, the list the server kept, not the text that was typed.
  await expect(field).toHaveValue('llama-swap, my-gateway');
  await reset.click();
  await expect.poll(() => puts.length).toBe(2);
  expect(puts[1].skipThinkingProviders).toEqual(DEFAULT_LIST);
  await expect(field).toHaveValue('llama.cpp, llama-server, llama-swap');
});

test('a text being typed is kept while the answer to another save comes in', async ({ page }) => {
  const { puts } = await voiceMode(page);
  // Each save is held until the test lets it go.
  const asked: unknown[] = [];
  let answer!: () => void;
  const held = new Promise<void>((resolve) => { answer = resolve; });
  await page.route('**/api/voice', async (route) => {
    if (route.request().method() === 'PUT') { asked.push(route.request().postDataJSON()); await held; }
    return route.fallback();
  });
  await page.locator('summary').filter({ hasText: 'Speaking instructions' }).click();
  await page.getByRole('textbox', { name: 'Speaking instructions' }).fill('Answer in one word.');
  // Leaving the instructions for the providers saves the instructions.
  const field = page.getByRole('textbox', { name: 'Reply without thinking first on' });
  await field.click();
  await expect.poll(() => asked.length).toBe(1);
  await field.fill('llama-swap, my-gateway');
  answer();
  await expect.poll(() => puts.length).toBe(1);
  await expect(saved(page)).toBeVisible();
  await expect(field).toHaveValue('llama-swap, my-gateway');
  await field.blur();
  await expect.poll(() => puts.length).toBe(2);
  expect(puts[1]).toEqual({ vad: VAD, responseInstructions: 'Answer in one word.', skipThinkingProviders: ['llama-swap', 'my-gateway'], voiceModel: '', conversation: true });
});

test('the voice model is saved as it is chosen', async ({ page }) => {
  await page.route('**/api/models', (route) => route.fulfill({ json: { models: [{ provider: 'llama-swap', id: 'model-b', name: 'Model B', reasoning: false }], providers: {} } }));
  const { puts } = await voiceMode(page);
  const model = page.getByRole('combobox', { name: 'Voice model' });
  await expect(model).toContainText('Same as the chat');
  await model.click();
  await page.getByRole('option', { name: /Model B/ }).click();
  await expect.poll(() => puts.length).toBe(1);
  expect(puts[0]).toEqual({ vad: VAD, responseInstructions: '', skipThinkingProviders: DEFAULT_LIST, voiceModel: 'llama-swap/model-b', conversation: true });
  await expect(saved(page)).toBeVisible();
  await expect(model).toContainText('Model B');
});

test('a refused save is said, and the section shows what is saved', async ({ page }) => {
  await voiceMode(page);
  const refusal = '"my gateway" is not a provider name: use letters, digits, dot, colon, @, dash or underscore';
  await page.route('**/api/voice', (route) => route.request().method() === 'PUT' ? route.fulfill({ status: 400, json: { error: refusal } }) : route.fallback());
  const field = page.getByRole('textbox', { name: 'Reply without thinking first on' });
  await field.fill('my gateway');
  await field.blur();
  await expect(page.getByRole('alert')).toHaveText(refusal);
  await expect(field).toHaveValue('llama.cpp, llama-server, llama-swap');
  await expect(saved(page)).toHaveCount(0);
});

test('with no source the section says how to get one, and opens Extensions', async ({ page }) => {
  await voiceMode(page, { provider: '', ready: false, speech: true, voices: [], enabled: false });
  await expect(page.getByText('Nothing listens and speaks for voice mode. An extension that does is installed in Settings → Extensions and chosen on its own page.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop using' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open Extensions' }).click();
  await expect(page.getByRole('alert')).toHaveText('Opened Extensions');
  // How spoken conversations go is set all the same.
  await expect(page.getByRole('combobox', { name: 'Voice model' })).toBeVisible();
});

test('a running source is named, and its own page is a click away', async ({ page }) => {
  await voiceMode(page);
  await expect(page.getByText('Listens and speaks through Speaker')).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Running');
  await expect(page.getByRole('button', { name: 'Open Extensions' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open its page' }).click();
  await expect(page.getByRole('alert')).toHaveText('Opened the page of test-speaker');
});

test('a source that is not running, and may not be installed, is named as chosen, with Extensions in place of its page', async ({ page }) => {
  await voiceMode(page, { provider: 'gone-speaker', ready: false, speech: true, voices: [], enabled: true });
  await expect(page.getByText('Listens and speaks through gone-speaker')).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Not running');
  await expect(page.getByRole('button', { name: 'Open its page' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open Extensions' }).click();
  await expect(page.getByRole('alert')).toHaveText('Opened Extensions');
});

test('a source that recognises speech alone leaves only speech detection to set: nothing is spoken', async ({ page }) => {
  await voiceMode(page, { ...SPEAKER, speech: false });
  await expect(page.getByRole('status')).toHaveText('Recognition only: dictation works, and replies are not spoken.');
  await expect(page.getByRole('combobox', { name: 'Voice model' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Reply without thinking first on' })).toHaveCount(0);
  await expect(page.locator('summary').filter({ hasText: 'Speaking instructions' })).toHaveCount(0);
  // Nor is there a conversation to switch off.
  await expect(page.getByRole('switch', { name: 'Voice conversations' })).toHaveCount(0);
  // Dictation listens with it too.
  await expect(page.locator('summary').filter({ hasText: 'Speech detection' })).toBeVisible();
});

test('voice conversations are switched off and on again, saved as they are, and off leaves only what dictation listens with', async ({ page }) => {
  const { puts } = await voiceMode(page);
  await page.evaluate(() => { (window as any).changed = 0; window.addEventListener('voice-config-changed', () => { (window as any).changed++; }); });
  const conversations = page.getByRole('switch', { name: 'Voice conversations' });
  await expect(conversations).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('combobox', { name: 'Voice model' })).toBeVisible();
  await conversations.click();
  await expect.poll(() => puts.length).toBe(1);
  expect(puts[0]).toEqual({ vad: VAD, responseInstructions: '', skipThinkingProviders: DEFAULT_LIST, voiceModel: '', conversation: false });
  await expect(saved(page)).toBeVisible();
  // Voice mode's controls are told: see voice.spec.mts for what the chat then offers.
  expect(await page.evaluate(() => (window as any).changed)).toBe(1);
  await expect(conversations).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('combobox', { name: 'Voice model' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Reply without thinking first on' })).toHaveCount(0);
  await expect(page.locator('summary').filter({ hasText: 'Speaking instructions' })).toHaveCount(0);
  await expect(page.locator('summary').filter({ hasText: 'Speech detection' })).toBeVisible();
  await page.reload();
  await expect(conversations).toHaveAttribute('aria-checked', 'false');
  await conversations.click();
  await expect.poll(() => puts.length).toBe(2);
  expect(puts[1].conversation).toBe(true);
  await expect(page.getByRole('combobox', { name: 'Voice model' })).toBeVisible();
});

test('Stop using leaves voice mode without a source, and the rest of the section as it is', async ({ page }) => {
  const { puts } = await voiceMode(page);
  const deleted: string[] = [];
  await page.route('**/api/voice/provider', (route) => {
    deleted.push(route.request().method());
    // As the portal answers: the whole of voice mode's settings, of which the section takes only where it listens.
    return route.fulfill({ json: { provider: '', ready: false, speech: true, voices: [], enabled: false, vad: VAD, responseInstructions: 'Not this.', defaultResponseInstructions: BUILT_IN, skipThinkingProviders: [], defaultSkipThinkingProviders: DEFAULT_LIST, voiceModel: '' } });
  });
  await page.evaluate(() => { (window as any).changed = 0; window.addEventListener('voice-config-changed', () => { (window as any).changed++; }); });
  await page.getByRole('button', { name: 'Stop using' }).click();
  await expect(page.getByText('Nothing listens and speaks for voice mode.')).toBeVisible();
  expect(deleted).toEqual(['DELETE']);
  expect(await page.evaluate(() => (window as any).changed)).toBe(1);
  await expect(page.getByRole('textbox', { name: 'Reply without thinking first on' })).toHaveValue('llama.cpp, llama-server, llama-swap');
  await page.locator('summary').filter({ hasText: 'Speaking instructions' }).click();
  await expect(page.getByRole('textbox', { name: 'Speaking instructions' })).toHaveValue(BUILT_IN);
  expect(puts).toHaveLength(0);
});
