import { type Page } from '@playwright/test';
import { test, expect, mockPortal } from '../../../../tests/browser/portal-mock';

/**
 * The voice service's page in Settings (src/web/VoiceService.tsx), over what its server half would answer: installing,
 * starting, stopping and removing it, Use for voice mode and Stop using, the engines it is built for and the GPU it runs
 * on, and whether its speech model is let go of once voice mode no longer uses it. How it speaks is your-voice.spec's.
 */
test.use({ installed: ['extensions/docker', 'extensions/voice'] });

/** Where Voice's server half answers: its routes, under the address the portal gives the package. */
const BASE = '**/api/x/pithagoras-voice';
/** How the service stands (`GET /state`), and an install (`POST /install`): one answer for both, as a test keeps them. */
const SERVICE = /\/api\/x\/pithagoras-voice\/(state|install)$/;

// Settings lists Voice, and Docker, which it requires, as the portal has them installed; a test's own routes come after
// this and win. The GPU is not read unless a test says, and how it speaks is as nothing was set, with no voice added.
test.beforeEach(async ({ page }) => {
  await mockPortal(page, ({ path, method }) => {
    if (method === 'GET' && path === '/api/extensions') return { settingsPath: '/a/settings.json', extensions: [
      { spec: 'extensions/docker', name: 'pithagoras-docker', version: '1.2.0', settings: [] },
      { spec: 'extensions/voice', name: 'pithagoras-voice', version: '0.1.0', settings: [] },
    ] };
    if (method === 'GET' && path === '/api/x/pithagoras-voice/hardware') return { gpus: [], source: 'none', error: '', checked: false, cpuOnly: false, host: { totalMiB: 16384, freeMiB: 12000, threads: 8 }, selected: null, reserveMiB: 0, suggestion: { tts: 'breeze', asr: 'whisper', asrModel: 'base' } };
    if (method === 'GET' && path === '/api/x/pithagoras-voice/speech') return { voice: 'design', instruction: 'A warm, clear English voice with a calm, conversational delivery.', cfgScale: 4, exaggeration: 0.5, kokoroVoice: 'af_heart', speed: 1, language: 'auto' };
    if (method === 'GET' && path === '/api/x/pithagoras-voice/voices') return [];
    return undefined;
  }, { settings: true });
});

/** Settings, on the voice service's page. */
const open = async (page: Page) => {
  await page.goto('/settings/x/pithagoras-voice');
  return page.getByRole('dialog', { name: 'Settings' });
};
const badge = (page: Page, text: string) => page.getByRole('dialog', { name: 'Settings' }).getByText(text, { exact: true });

test('install progress, ready, use for voice mode, stop using it, and stop', async ({ page }) => {
  let state = 'absent', chosen = false; const actions: string[] = [];
  await page.route(SERVICE, r => {
    if (r.request().method() === 'POST') { actions.push('install'); state = 'starting'; return r.fulfill({ json: { ok: true } }); }
    return r.fulfill({ json: { available: true, state, busy: false, progress: state === 'starting' ? 'Quantizing Breeze to Q8_0 on CPU' : '', error: '', lazyLoad: true, chosen } });
  });
  await page.route(`${BASE}/stop`, r => { actions.push('stop'); state = 'stopped'; return r.fulfill({ json: { ok: true } }); });
  await page.route(`${BASE}/chosen`, r => { chosen = r.request().postDataJSON().chosen; actions.push(`chosen ${chosen}`); return r.fulfill({ json: { chosen } }); });
  await open(page);
  const use = page.getByRole('button', { name: 'Use for voice mode' }), stopUsing = page.getByRole('button', { name: 'Stop using' });
  const inUse = page.getByRole('status').filter({ hasText: 'In use for voice mode' });
  await expect(badge(page, 'Not installed')).toBeVisible();
  await expect(use).toHaveCount(0);
  await page.getByRole('button', { name: 'Install voice', exact: true }).click();
  await expect(page.getByLabel('Voice setup log')).toContainText('Quantizing');
  await expect(page.getByRole('button', { name: 'Start voice', exact: true })).toBeDisabled();
  await expect(use).toHaveCount(0);
  state = 'running';
  await expect(badge(page, 'Ready')).toBeVisible({ timeout: 8000 });
  // Voice mode listens and speaks through it once the setup is done, which the server half sees to; and at once, when asked.
  await expect(inUse).toHaveCount(0);
  await expect(stopUsing).toHaveCount(0);
  await use.click();
  await expect.poll(() => actions).toEqual(['install', 'chosen true']);
  await expect(inUse).toBeVisible();
  await expect(use).toHaveCount(0);
  // Stop using is offered while it is the source, running or not.
  await page.getByRole('button', { name: 'Stop · release VRAM' }).click();
  await expect(page.getByRole('button', { name: 'Start voice', exact: true })).toBeEnabled();
  await expect(inUse).toBeVisible();
  await stopUsing.click();
  await expect.poll(() => actions).toEqual(['install', 'chosen true', 'stop', 'chosen false']);
  await expect(inUse).toHaveCount(0);
  await expect(stopUsing).toHaveCount(0);
  // Stopped, it is not offered for voice mode.
  await expect(use).toHaveCount(0);
});

test('a failed setup Docker is starting again is stopped from the page, which ends its tries; one that has exited has nothing to stop', async ({ page }) => {
  let retrying = true; const actions: string[] = [];
  await page.route(SERVICE, r => r.fulfill({ json: { available: true, state: 'failed', busy: false, progress: 'VOICE_SETUP_ERROR: setup or service failed (line 98)', error: retrying ? 'Voice setup or service exited, and Docker is starting it again. Review the log, or retry now.' : 'Voice setup or service exited. Review the log, then retry.', choice: { tts: 'breeze', asr: 'whisper', asrModel: 'base' }, lazyLoad: true, retrying } }));
  await page.route(`${BASE}/stop`, r => { actions.push('stop'); retrying = false; return r.fulfill({ json: { ok: true } }); });
  await open(page);
  const stop = page.getByRole('button', { name: 'Stop · release VRAM' }), retry = page.getByRole('button', { name: 'Retry setup', exact: true });
  await expect(badge(page, 'failed')).toBeVisible();
  await expect(retry).toBeEnabled();
  await stop.click();
  await expect.poll(() => actions).toEqual(['stop']);
  await expect(stop).toHaveCount(0);
  await expect(retry).toBeEnabled();
});

test('Use for voice mode refused says why, and the page stays as it was', async ({ page }) => {
  await page.route(SERVICE, r => r.fulfill({ json: { available: true, state: 'running', busy: false, progress: '', error: '', lazyLoad: true, chosen: false } }));
  await page.route(`${BASE}/chosen`, r => r.fulfill({ status: 400, json: { error: 'Wait for voice setup to finish before using it for voice mode' } }));
  await open(page);
  await page.getByRole('button', { name: 'Use for voice mode' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Wait for voice setup to finish before using it for voice mode' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'In use for voice mode' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Use for voice mode' })).toBeEnabled();
});

test.describe('in a browser set to German', () => {
  test.use({ locale: 'de-DE' });

  test("the page says a setup under way and its use for voice mode in its own words, and voice mode names the service as Voice does", async ({ page }) => {
    await page.route(SERVICE, r => r.fulfill({ json: { available: true, state: 'installing', busy: true, progress: 'Preparing voice setup', error: '', lazyLoad: true, chosen: true } }));
    await page.goto('/settings/x/pithagoras-voice');
    const settings = page.getByRole('dialog', { name: 'Einstellungen' });
    await expect(settings.getByText('wird installiert', { exact: true })).toBeVisible();
    await expect(settings.getByRole('status').filter({ hasText: 'Wird für den Sprachmodus verwendet' })).toBeVisible();
    await expect(settings.getByRole('button', { name: 'Nicht mehr verwenden' })).toBeVisible();
    await expect(settings.getByText('Die übrigen Einstellungen des Sprachmodus, etwa Spracherkennung und Sprechanweisungen, stehen unter Einstellungen → Standards → Sprachmodus.')).toBeVisible();
    // Voice mode's source in Settings → Defaults → Voice mode: Voice's label, in Voice's German.
    await page.route('**/api/voice', r => r.fulfill({ json: { provider: 'pithagoras-voice', label: 'Voice service', ready: true, speech: true, voices: [], enabled: true, responseInstructions: '', defaultResponseInstructions: '', responseInstructionsOff: false, skipThinkingProviders: [], defaultSkipThinkingProviders: [], voiceModel: '' } }));
    await page.goto('/settings/general');
    await expect(settings.getByText('Hört zu und spricht über „Sprachdienst“')).toBeVisible();
  });

  test('the uninstall question says in German that the voices are kept', async ({ page }) => {
    await page.route(SERVICE, r => r.fulfill({ json: { available: true, state: 'stopped', busy: false, progress: '', error: '', lazyLoad: true } }));
    await page.goto('/settings/x/pithagoras-voice');
    await page.getByRole('button', { name: 'Deinstallieren', exact: true }).click();
    await expect(page.getByRole('alertdialog')).toContainText('Der Sprachcontainer wird gestoppt und entfernt. Deine Stimmen bleiben erhalten. Der Sprachmodus hat dann keine Quelle, bis eine ausgewählt wird.');
  });
});

// A service as the server half says it, and what the page asked of it.
const uninstallPage = async (page: Page, state = 'running') => {
  let status = state, failure = '', reads = 0; const requests: any[] = [];
  // As the server answers: once there is a container, `progress` is its log, so a steady service has lines in it too.
  await page.route(SERVICE, r => { reads++; return r.fulfill({ json: { available: true, state: status, busy: false, progress: status === 'absent' ? '' : 'INFO: Uvicorn running on http://0.0.0.0:7862', error: '', choice: { tts: 'breeze', asr: 'qwen3-asr', asrModel: '0.6b' }, lazyLoad: true } }); });
  await page.route(`${BASE}/uninstall`, r => {
    requests.push(r.request().postDataJSON()); status = 'absent';
    // Docker refused to delete the volume: the container is gone all the same.
    return failure ? r.fulfill({ status: 409, json: { error: failure } }) : r.fulfill({ json: { ok: true } });
  });
  await open(page);
  return { requests, reads: () => reads, setState: (value: string) => { status = value; }, fail: (message: string) => { failure = message; } };
};

test('uninstall asks first and says what goes, keeps the downloads unless told, and leaves a service that was never installed', async ({ page }) => {
  const { requests } = await uninstallPage(page);
  const uninstall = page.getByRole('button', { name: 'Uninstall', exact: true });
  const dialog = page.getByRole('alertdialog');
  await uninstall.click();
  await expect(dialog.getByRole('heading', { name: 'Uninstall voice?' })).toBeVisible();
  await expect(dialog).toContainText('The voice container is stopped and removed. Your voices are kept. Voice mode then has no source until one is chosen.');
  // Keeping the downloads is the default: a new install is then quick.
  await expect(dialog.getByRole('checkbox', { name: /Also delete the downloaded engines and models/ })).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(requests).toEqual([]);
  await uninstall.click();
  await dialog.getByRole('button', { name: 'Uninstall', exact: true }).click();
  await expect.poll(() => requests).toEqual([{ removeData: false }]);
  // The page is that of a portal that never installed it, and Install is offered.
  await expect(page.getByRole('button', { name: 'Install voice', exact: true })).toBeVisible();
  await expect(badge(page, 'Not installed')).toBeVisible();
  await expect(uninstall).toBeHidden();
});

// Time goes by in the steps of the quick poll, with a moment of real time after each for the answer to come: a poll that is asked again only after its answer needs both.
const elapse = async (page: Page, ms: number) => {
  for (let left = ms; left > 0; left -= 2500) { await page.clock.runFor(Math.min(2500, left)); await page.waitForTimeout(25); }
};

test('the install status is asked for slowly once it is steady, and not at all in a hidden tab', async ({ page }) => {
  await page.clock.install();
  const { reads, setState } = await uninstallPage(page, 'running');
  await expect.poll(reads).toBeGreaterThan(0);
  const first = reads();
  await elapse(page, 60_000);
  // A minute of a steady service: two more questions, not twenty-four.
  expect(reads() - first).toBeLessThanOrEqual(3);
  // Hidden: nothing is asked, however long it stays so.
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  const hidden = reads();
  await elapse(page, 120_000);
  expect(reads()).toBe(hidden);
  // Looked at again: asked at once.
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(reads).toBeGreaterThan(hidden);
  // And quickly again once something is changing.
  setState('starting');
  await elapse(page, 32_500);
  await expect(badge(page, 'starting')).toBeVisible();
  const starting = reads();
  await elapse(page, 10_000);
  expect(reads() - starting).toBeGreaterThanOrEqual(3);
});

// A steady service is looked at again every half minute, and at once when the tab is come back to.
const lookAgain = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

test('uninstall deletes the downloaded engines and models only when the box is ticked, and is not offered where nothing is installed', async ({ page }) => {
  const { requests, setState } = await uninstallPage(page, 'absent');
  const uninstall = page.getByRole('button', { name: 'Uninstall', exact: true });
  await expect(page.getByRole('button', { name: 'Install voice', exact: true })).toBeVisible();
  await expect(uninstall).toBeHidden();
  // A stopped service is uninstalled too.
  setState('stopped');
  await lookAgain(page);
  await expect(uninstall).toBeVisible({ timeout: 8000 });
  await uninstall.click();
  await page.getByRole('alertdialog').getByRole('checkbox', { name: /Also delete the downloaded engines and models/ }).check();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Uninstall', exact: true }).click();
  await expect.poll(() => requests).toEqual([{ removeData: true }]);
});

test('the question can be answered with the keyboard alone, the box included', async ({ page }) => {
  const { requests } = await uninstallPage(page);
  const dialog = page.getByRole('alertdialog');
  const box = dialog.getByRole('checkbox', { name: /Also delete the downloaded engines and models/ });
  await page.getByRole('button', { name: 'Uninstall', exact: true }).focus();
  await page.keyboard.press('Enter');
  // Focus starts on Cancel; Tab goes on to Uninstall, then round to the box, which Space ticks, and Shift+Tab goes back.
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Uninstall', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(box).toBeFocused();
  await page.keyboard.press('Space');
  await expect(box).toBeChecked();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Uninstall', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => requests).toEqual([{ removeData: true }]);
});

test('where the downloads cannot be deleted the page still shows the uninstall, with the reason', async ({ page }) => {
  const { requests, fail } = await uninstallPage(page);
  fail('The voice container is removed, but its downloaded engines and models could not be deleted: volume is in use');
  await page.getByRole('button', { name: 'Uninstall', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('checkbox', { name: /Also delete the downloaded engines and models/ }).check();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Uninstall', exact: true }).click();
  await expect.poll(() => requests).toEqual([{ removeData: true }]);
  await expect(page.getByRole('alert').filter({ hasText: 'could not be deleted: volume is in use' })).toBeVisible();
  // The container is gone all the same, and so is the button.
  await expect(badge(page, 'Not installed')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Uninstall', exact: true })).toBeHidden();
});

test('lazy loading is the service\'s own setting, written as it is switched', async ({ page }) => {
  let lazyLoad = true; const puts: unknown[] = [];
  await page.route(SERVICE, r => r.fulfill({ json: { available: true, state: 'running', busy: false, progress: '', error: '', choice: { tts: 'breeze', asr: 'whisper', asrModel: 'base' }, lazyLoad } }));
  await page.route(`${BASE}/lazy-load`, r => { puts.push(r.request().postDataJSON()); lazyLoad = r.request().postDataJSON().on; return r.fulfill({ json: { lazyLoad } }); });
  await open(page);
  const box = page.getByRole('checkbox', { name: 'Lazy load · release GPU memory when voice is idle' });
  await expect(box).toBeChecked();
  await box.uncheck();
  await expect.poll(() => puts).toEqual([{ on: false }]);
  await page.reload();
  await expect(box).not.toBeChecked();
  await box.check();
  await expect.poll(() => puts).toEqual([{ on: false }, { on: true }]);
});

// A card with 6 GiB, 5 GiB of it free: the small recognition model fits next to Breeze with room to spare, the large one does not fit at all.
// `checked` is whether the check could tell: with no GPU listed, a probe that ran and found none, or nothing asked yet.
const host = { totalMiB: 16384, freeMiB: 12000, threads: 8 };
const hardware = (gpus: any[], checked = gpus.length > 0) => ({ gpus, source: 'host', error: '', checked, cpuOnly: false, host, selected: gpus.length ? 0 : null, chosen: '', reserveMiB: 0, suggestion: { tts: 'breeze', asr: 'qwen3-asr', asrModel: '0.6b' } });
// A host that was found to have no GPU: what is suggested is recognition alone, on the CPU.
const noGpu = (patch: any = {}) => ({ gpus: [], source: 'none', error: '', checked: true, cpuOnly: true, host, selected: null, reserveMiB: 0, suggestion: { tts: 'kokoro', ttsDevice: 'cpu', asr: 'qwen3-asr', asrModel: '0.6b' }, ...patch });
const card = { index: 0, name: 'Test GPU', totalMiB: 6144, freeMiB: 5000 };

test('engine choice: the GPU is shown, the install picks for it by default, and an explicit pick is checked against it and sent',async({page})=>{
 let state='absent'; let choice:any; const posts:any[]=[];
 await page.route(`${BASE}/hardware`,r=>r.fulfill({json:hardware([card])}));
 await page.route(SERVICE,r=>{
  if(r.request().method()==='POST'){posts.push(r.request().postDataJSON());state='starting';choice=posts.at(-1)??{tts:'breeze',asr:'qwen3-asr',asrModel:'0.6b'};return r.fulfill({json:{ok:true}});}
  return r.fulfill({json:{available:true,state,busy:false,progress:'',error:'',choice}});
 });
 await open(page);
 await expect(page.getByText('GPU detected: Test GPU, 6 GiB, 4.9 GiB free')).toBeVisible();
 // Left to the install, the engines are the suggestion and cannot be changed by accident.
 const auto=page.getByRole('checkbox',{name:'Choose for me, based on my GPU'});
 await expect(auto).toBeChecked();
 await expect(page.getByText('Suggested for this host: Breeze with Qwen3-ASR 0.6B.')).toBeVisible();
 const recognition=page.getByRole('combobox',{name:'Speech recognition engine'}),synthesis=page.getByRole('combobox',{name:'Speech synthesis engine'});
 await expect(recognition).toBeDisabled();
 await expect(recognition).toContainText('Qwen3-ASR 0.6B');
 await auto.uncheck();
 await recognition.click();
 await expect(page.getByRole('option',{name:/Whisper small/})).toContainText('CPU only, about 0.9 GiB of memory');
 await expect(page.getByRole('option',{name:/Qwen3-ASR 1\.7B/})).toContainText('About 2.9 GiB of memory on the CPU, or 2.5 GiB on the GPU');
 await page.getByRole('option',{name:/Qwen3-ASR 1\.7B/}).click();
 // More than the card has: flagged, with the way back to what fits.
 await expect(page.getByRole('alert').filter({hasText:'Needs about 7 GiB of GPU memory, more than this GPU has.'})).toBeVisible();
 await page.getByRole('button',{name:'Use the suggestion'}).click();
 await expect(recognition).toContainText('Qwen3-ASR 0.6B');
 await expect(page.getByText('The card is big enough, but other programs use part of it right now.')).toContainText('Needs about 5.9 GiB');
 await synthesis.click();
 await page.getByRole('option',{name:/Chatterbox/}).click();
 await expect(page.getByText('Needs about 4.3 GiB of GPU memory. Fits.')).toBeVisible();
 await page.getByRole('button',{name:'Install voice',exact:true}).click();
 await expect.poll(()=>posts.length).toBe(1);
 expect(posts[0]).toEqual({tts:'chatterbox',asr:'qwen3-asr',asrModel:'0.6b'});
 // Once the container is built for it, that is what is shown, and the pick is no longer pending.
 await expect(synthesis).toContainText('Chatterbox');
 await expect(page.getByRole('button',{name:'Rebuild with these engines'})).toHaveCount(0);
});

test('engine choice: left to the install, nothing is sent with it',async({page})=>{
 const posts:any[]=[]; let state='absent';
 await page.route(`${BASE}/hardware`,r=>r.fulfill({json:hardware([])}));
 await page.route(SERVICE,r=>{
  if(r.request().method()==='POST'){posts.push(r.request().postData());state='starting';return r.fulfill({json:{ok:true}});}
  return r.fulfill({json:{available:true,state,busy:false,progress:'',error:''}});
 });
 await open(page);
 // No GPU can be read from here: said so, with what happens instead.
 await expect(page.getByText('GPU not checked yet.')).toBeVisible();
 await expect(page.getByText('The install picks what fits your GPU.')).toBeVisible();
 await page.getByRole('button',{name:'Install voice',exact:true}).click();
 await expect.poll(()=>posts.length).toBe(1);
 expect(posts[0]).toBeNull();
});

test('engine choice: an installed service shows its engines, and another pick offers a rebuild that is sent',async({page})=>{
 let installed:any={tts:'breeze',asr:'whisper',asrModel:'base'}; const posts:any[]=[];
 await page.route(`${BASE}/hardware`,r=>r.fulfill({json:hardware([{...card,totalMiB:24576,freeMiB:24000}])}));
 await page.route(SERVICE,r=>{
  if(r.request().method()==='POST'){posts.push(r.request().postDataJSON());installed=posts.at(-1);return r.fulfill({json:{ok:true}});}
  return r.fulfill({json:{available:true,state:'running',busy:false,progress:'',error:'',choice:installed}});
 });
 await open(page);
 const recognition=page.getByRole('combobox',{name:'Speech recognition engine'});
 await expect(recognition).toContainText('Whisper base');
 await expect(page.getByRole('checkbox',{name:'Choose for me, based on my GPU'})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Start voice',exact:true})).toBeDisabled();
 await expect(page.getByRole('button',{name:'Rebuild with these engines'})).toHaveCount(0);
 await recognition.click();
 await page.getByRole('option',{name:/Qwen3-ASR 1\.7B/}).click();
 await expect(page.getByText('Switching engines recreates the voice container. Downloaded models are kept.')).toBeVisible();
 // Back to what is installed is no change: the rebuild is not offered for it.
 await recognition.click();
 await page.getByRole('option',{name:/Whisper base/}).click();
 await expect(page.getByRole('button',{name:'Rebuild with these engines'})).toHaveCount(0);
 await recognition.click();
 await page.getByRole('option',{name:/Qwen3-ASR 1\.7B/}).click();
 await page.getByRole('button',{name:'Rebuild with these engines'}).click();
 await expect.poll(()=>posts.length).toBe(1);
 expect(posts[0]).toEqual({tts:'breeze',asr:'qwen3-asr',asrModel:'1.7b'});
 await expect(recognition).toContainText('Qwen3-ASR 1.7B');
 await expect(page.getByRole('button',{name:'Rebuild with these engines'})).toHaveCount(0);
});

test('engine choice: a first install with a pick of its own is no rebuild while the image is still being pulled',async({page})=>{
 let state='absent';
 await page.route(`${BASE}/hardware`,r=>r.fulfill({json:hardware([card])}));
 // There is no container yet, so no choice to report: the daemon is still pulling the image.
 await page.route(SERVICE,r=>{
  if(r.request().method()==='POST'){state='installing';return r.fulfill({json:{ok:true}});}
  return r.fulfill({json:{available:true,state,busy:state==='installing',progress:state==='installing'?'Downloading layer':'',error:''}});
 });
 await open(page);
 await page.getByRole('checkbox',{name:'Choose for me, based on my GPU'}).uncheck();
 await page.getByRole('combobox',{name:'Speech synthesis engine'}).click();
 await page.getByRole('option',{name:/Chatterbox/}).click();
 await page.getByRole('button',{name:'Install voice',exact:true}).click();
 await expect(page.getByLabel('Voice setup log')).toContainText('Downloading layer');
 await expect(page.getByRole('button',{name:'Rebuild with these engines'})).toHaveCount(0);
 await expect(page.getByText('Switching engines recreates the voice container.')).toHaveCount(0);
 // What was picked stays shown, and cannot be changed while the install runs.
 await expect(page.getByRole('combobox',{name:'Speech synthesis engine'})).toContainText('Chatterbox');
 await expect(page.getByRole('combobox',{name:'Speech synthesis engine'})).toBeDisabled();
});

test('engine choice: an installed service is shown on its own card and is not judged by the memory it holds itself',async({page})=>{
 // GPU 1 runs the service (Breeze with the large model, lazy loading off) and so has little free; GPU 0 is idle and small.
 const gpus=[{index:0,name:'Test GPU A',totalMiB:6144,freeMiB:6000},{index:1,name:'Test GPU B',totalMiB:12288,freeMiB:5000}];
 await page.route(`${BASE}/hardware`,r=>r.fulfill({json:{...hardware(gpus),selected:1}}));
 await page.route(SERVICE,r=>r.fulfill({json:{available:true,state:'running',busy:false,progress:'',error:'',choice:{tts:'breeze',asr:'qwen3-asr',asrModel:'1.7b'}}}));
 await open(page);
 await expect(page.getByText('GPU detected: Test GPU B, 12 GiB, 4.9 GiB free')).toBeVisible();
 await expect(page.getByRole('combobox',{name:'Speech recognition engine'})).toContainText('Qwen3-ASR 1.7B');
 // Running there: no warning that other programs use the card, and no red alert about its size.
 await expect(page.getByText('other programs use part of it')).toHaveCount(0);
 await expect(page.getByText('more than this GPU has')).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Use the suggestion'})).toHaveCount(0);
 // Readings without a UUID name no card that could be chosen for good.
 await expect(page.getByRole('combobox',{name:'GPU',exact:true})).toHaveCount(0);
 // Another pick is judged as soon as there is one.
 await page.getByRole('combobox',{name:'Speech synthesis engine'}).click();
 await page.getByRole('option',{name:/Chatterbox/}).click();
 await expect(page.getByText('Needs about 5.5 GiB of GPU memory. The card is big enough, but other programs use part of it right now.')).toBeVisible();
});

test('engine choice: with several GPUs the card is chosen at once, by its UUID',async({page})=>{
 const gpus=[{index:0,uuid:'GPU-a',name:'Test GPU A',totalMiB:12288,freeMiB:4000},{index:1,uuid:'GPU-b',name:'Test GPU B',totalMiB:12288,freeMiB:12000}];
 const puts:any[]=[]; let chosen='';
 const shown=()=>({...hardware(gpus),selected:chosen?gpus.findIndex(g=>g.uuid===chosen):1,chosen});
 await page.route(`${BASE}/hardware`,r=>r.fulfill({json:shown()}));
 await page.route(`${BASE}/gpu`,r=>{puts.push(r.request().postDataJSON());chosen=puts.at(-1).gpu;return r.fulfill({json:{selected:chosen,restarting:true}});});
 await page.route(SERVICE,r=>r.fulfill({json:{available:true,state:'running',busy:false,progress:'',error:'',choice:{tts:'breeze',asr:'whisper',asrModel:'base'}}}));
 await open(page);
 const card=page.getByRole('combobox',{name:'GPU',exact:true});
 // Automatic: the card with the most room is the one in use.
 await expect(card).toContainText('Automatic');
 await expect(page.getByText('GPU detected: Test GPU B, 12 GiB, 11.7 GiB free')).toBeVisible();
 await expect(page.getByText('Changing the GPU restarts voice and keeps your models.')).toBeVisible();
 await card.click();
 await page.getByRole('option',{name:/Test GPU A/}).click();
 await expect.poll(()=>puts).toEqual([{gpu:'GPU-a'}]);
 // What the page shows is read again: the card chosen, and the one the engines are judged on.
 await expect(card).toContainText('Test GPU A');
 await expect(page.getByText('GPU detected: Test GPU A, 12 GiB, 3.9 GiB free')).toBeVisible();
 await card.click();
 await page.getByRole('option',{name:/Automatic/}).click();
 await expect.poll(()=>puts.at(-1)).toEqual({gpu:''});
 await expect(card).toContainText('Automatic');
});

test('engine choice: a GPU host also picks where recognition runs, and the CPU spares the card',async({page})=>{
 const posts:any[]=[];
 await page.route(`${BASE}/hardware`,r=>r.fulfill({json:hardware([card])}));
 await page.route(SERVICE,r=>{
  if(r.request().method()==='POST'){posts.push(r.request().postDataJSON());return r.fulfill({json:{ok:true}});}
  return r.fulfill({json:{available:true,state:'absent',busy:false,progress:'',error:''}});
 });
 await open(page);
 const recognition=page.getByRole('combobox',{name:'Speech recognition engine'}),device=page.getByRole('combobox',{name:'Speech recognition runs on'});
 await page.getByRole('checkbox',{name:'Choose for me, based on my GPU'}).uncheck();
 // Whisper is always on the CPU: the device is shown and cannot be changed.
 await recognition.click();
 await page.getByRole('option',{name:/Whisper small/}).click();
 await expect(device).toContainText('CPU');
 await expect(device).toBeDisabled();
 // Qwen3-ASR is on the GPU by default, next to the speech engine: too much for this card with the large model.
 await recognition.click();
 await page.getByRole('option',{name:/Qwen3-ASR 1\.7B/}).click();
 await expect(device).toBeEnabled();
 await expect(device).toContainText('GPU');
 await expect(page.getByRole('alert').filter({hasText:'Needs about 7 GiB of GPU memory, more than this GPU has.'})).toBeVisible();
 // On the CPU it takes memory of the host instead, and the card has room again.
 await device.click();
 await expect(page.getByRole('option',{name:/CPU/})).toContainText('Saves GPU memory, uses CPU threads');
 await page.getByRole('option',{name:/CPU/}).click();
 await expect(page.getByText('Needs about 4.5 GiB of GPU memory.',{exact:false})).toBeVisible();
 await expect(page.getByRole('alert').filter({hasText:'more than this GPU has'})).toHaveCount(0);
 await expect(page.getByText('Needs about 2.9 GiB of memory on the CPU. Fits.')).toBeVisible();
 await expect(page.getByText('This host: 8 CPU threads, 16 GiB of memory, 11.7 GiB free')).toBeVisible();
 await page.getByRole('button',{name:'Install voice',exact:true}).click();
 await expect.poll(()=>posts.length).toBe(1);
 expect(posts[0]).toEqual({tts:'breeze',asr:'qwen3-asr',asrModel:'1.7b',asrDevice:'cpu'});
});

test('engine choice: with no GPU everything runs on the CPU, which is said: Kokoro speaks there, and the other engines are not offered, with their reason',async({page})=>{
 const posts:any[]=[];let state='absent',choice:any;
 await page.route(`${BASE}/hardware`,r=>r.fulfill({json:noGpu()}));
 await page.route(SERVICE,r=>{
  if(r.request().method()==='POST'){posts.push(r.request().postDataJSON());state='starting';choice=posts.at(-1)??{tts:'none',asr:'qwen3-asr',asrModel:'0.6b'};return r.fulfill({json:{ok:true}});}
  return r.fulfill({json:{available:true,state,busy:false,progress:'',error:'',choice}});
 });
 await open(page);
 // The warning, and nothing that looks like a failure.
 await expect(page.getByRole('alert').filter({hasText:'No GPU detected. Everything runs on the CPU: Kokoro can speak, the other speech engines need a GPU.'})).toBeVisible();
 await expect(page.getByText('could not select device driver')).toHaveCount(0);
 await expect(page.getByText('GPU not checked yet.')).toHaveCount(0);
 const synthesis=page.getByRole('combobox',{name:'Speech synthesis engine'}),speechDevice=page.getByRole('combobox',{name:'Speech synthesis runs on'}),recognition=page.getByRole('combobox',{name:'Speech recognition engine'}),device=page.getByRole('combobox',{name:'Speech recognition runs on'});
 await expect(synthesis).toBeDisabled();
 await expect(synthesis).toContainText('Kokoro');
 await expect(page.getByText('Breeze and Chatterbox need a GPU: on a CPU, Breeze takes about 3.5 seconds to compute each second of speech and Chatterbox about 7, too slow for conversation. Kokoro takes about 0.24, measured on 8 threads of a desktop CPU like the others.')).toBeVisible();
 await expect(page.getByText('Suggested for this host: Kokoro on the CPU with Qwen3-ASR 0.6B.')).toBeVisible();
 await expect(page.getByText('This host: 8 CPU threads, 16 GiB of memory, 11.7 GiB free')).toBeVisible();
 await page.getByRole('checkbox',{name:'Choose for me, based on my GPU'}).uncheck();
 // The speech engines that run on the CPU, and none: Kokoro, on the CPU only.
 await expect(synthesis).toBeEnabled();
 await synthesis.click();
 await expect(page.getByRole('option',{name:/Kokoro/})).toBeVisible();
 await expect(page.getByRole('option',{name:/No speech synthesis/})).toBeVisible();
 await expect(page.getByRole('option',{name:/Breeze|Chatterbox/})).toHaveCount(0);
 await page.keyboard.press('Escape');
 await expect(speechDevice).toBeDisabled();
 await expect(speechDevice).toContainText('CPU');
 await expect(page.getByText("On this host's 8 CPU threads, each second of speech takes about 0.24 seconds to make.")).toBeVisible();
 // Recognition: every engine and size, on the CPU only.
 await expect(recognition).toBeEnabled();
 await expect(device).toBeDisabled();
 await expect(device).toContainText('CPU');
 await recognition.click();
 for(const name of [/Whisper base/,/Whisper small/,/Qwen3-ASR 0\.6B/,/Qwen3-ASR 1\.7B/])await expect(page.getByRole('option',{name})).toBeVisible();
 await page.getByRole('option',{name:/Whisper small/}).click();
 // Kokoro's memory and Whisper's, both on the CPU, and nothing on a GPU.
 await expect(page.getByText('Needs about 2.1 GiB of memory on the CPU. Fits.')).toBeVisible();
 await expect(page.getByText('Needs about',{exact:false}).filter({hasText:'GPU memory'})).toHaveCount(0);
 await page.getByRole('button',{name:'Install voice',exact:true}).click();
 await expect.poll(()=>posts.length).toBe(1);
 expect(posts[0]).toEqual({tts:'kokoro',ttsDevice:'cpu',asr:'whisper',asrModel:'small'});
 await expect(synthesis).toContainText('Kokoro');
 // Recognition alone is still a choice, and has nothing to put on a device.
 await synthesis.click();
 await page.getByRole('option',{name:/No speech synthesis/}).click();
 await expect(speechDevice).toHaveCount(0);
 await expect(page.getByText('Needs about 0.9 GiB of memory on the CPU. Fits.')).toBeVisible();
});

test('engine choice: on a host without a GPU the install is left to the check, and nothing is refused',async({page})=>{
 const posts:any[]=[];
 await page.route(`${BASE}/hardware`,r=>r.fulfill({json:noGpu({suggestion:{tts:'none',asr:'whisper',asrModel:'base'},host:{totalMiB:2048,freeMiB:1000,threads:2}})}));
 await page.route(SERVICE,r=>{
  if(r.request().method()==='POST'){posts.push(r.request().postData());return r.fulfill({json:{ok:true}});}
  return r.fulfill({json:{available:true,state:'absent',busy:false,progress:'',error:''}});
 });
 await open(page);
 await page.getByRole('checkbox',{name:'Choose for me, based on my GPU'}).uncheck();
 // Few threads: the large model would fall behind the speaker, and the host has little memory. It is said, and nothing stops the install.
 const recognition=page.getByRole('combobox',{name:'Speech recognition engine'});
 await recognition.click();
 await page.getByRole('option',{name:/Qwen3-ASR 1\.7B/}).click();
 await expect(page.getByRole('alert').filter({hasText:'Needs about 2.9 GiB of memory on the CPU, more than this host has.'})).toBeVisible();
 await expect(page.getByText('This host has 2 CPU threads: recognition on the CPU may be slower than the speaker.')).toBeVisible();
 await page.getByRole('checkbox',{name:'Choose for me, based on my GPU'}).check();
 await page.getByRole('button',{name:'Install voice',exact:true}).click();
 await expect.poll(()=>posts.length).toBe(1);
 expect(posts[0]).toBeNull();
});

test('engine choice: an installed recognition-only service shows its engines, and a GPU that turns up offers speech',async({page})=>{
 let hw:any=noGpu();const posts:any[]=[];
 await page.route(`${BASE}/hardware`,r=>r.fulfill({json:hw}));
 await page.route(SERVICE,r=>{
  if(r.request().method()==='POST'){posts.push(r.request().postDataJSON());return r.fulfill({json:{ok:true}});}
  return r.fulfill({json:{available:true,state:'running',busy:false,progress:'',error:'',choice:{tts:'none',asr:'qwen3-asr',asrModel:'0.6b'}}});
 });
 await open(page);
 const synthesis=page.getByRole('combobox',{name:'Speech synthesis engine'});
 await expect(page.getByRole('combobox',{name:'Speech recognition engine'})).toContainText('Qwen3-ASR 0.6B');
 // Kokoro can be added on the CPU; the engines that need a GPU are not offered.
 await expect(synthesis).toBeEnabled();
 await synthesis.click();
 await expect(page.getByRole('option',{name:/Kokoro/})).toBeVisible();
 await expect(page.getByRole('option',{name:/Breeze|Chatterbox/})).toHaveCount(0);
 await page.keyboard.press('Escape');
 // No verdict on what runs: its own memory is what the host shows as taken.
 await expect(page.getByText('Needs about',{exact:false})).toHaveCount(0);
 // A GPU turns up: the installation is still shown as what it is, recognition alone, and speech can be added.
 hw=hardware([card]);
 await page.reload();
 await expect(page.getByText('GPU detected: Test GPU, 6 GiB, 4.9 GiB free')).toBeVisible();
 await expect(page.getByRole('alert').filter({hasText:'No GPU detected'})).toHaveCount(0);
 await expect(synthesis).toBeEnabled();
 await expect(synthesis).toContainText('No speech synthesis');
 await expect(synthesis).not.toContainText('Choose');
 await synthesis.click();
 for(const name of [/Breeze/,/Chatterbox/,/Kokoro/,/No speech synthesis/])await expect(page.getByRole('option',{name})).toBeVisible();
 await page.getByRole('option',{name:/Breeze/}).click();
 await expect(page.getByRole('button',{name:'Rebuild with these engines'})).toBeVisible();
 // And back to what is installed is no change: nothing is left pending.
 await synthesis.click();
 await page.getByRole('option',{name:/No speech synthesis/}).click();
 await expect(synthesis).toContainText('No speech synthesis');
 await expect(page.getByRole('button',{name:'Rebuild with these engines'})).toHaveCount(0);
 // Breeze is a rebuild that is sent, with the recognition it had.
 await synthesis.click();
 await page.getByRole('option',{name:/Breeze/}).click();
 await page.getByRole('button',{name:'Rebuild with these engines'}).click();
 await expect.poll(()=>posts.length).toBe(1);
 expect(posts[0]).toEqual({tts:'breeze',asr:'qwen3-asr',asrModel:'0.6b'});
});

test('engine choice: on a GPU host Kokoro can be put on the CPU, which spares the card, and recognition goes there with it',async({page})=>{
 const posts:any[]=[];
 await page.route(`${BASE}/hardware`,r=>r.fulfill({json:hardware([card])}));
 await page.route(SERVICE,r=>{
  if(r.request().method()==='POST'){posts.push(r.request().postDataJSON());return r.fulfill({json:{ok:true}});}
  return r.fulfill({json:{available:true,state:'absent',busy:false,progress:'',error:''}});
 });
 await open(page);
 await page.getByRole('checkbox',{name:'Choose for me, based on my GPU'}).uncheck();
 const synthesis=page.getByRole('combobox',{name:'Speech synthesis engine'}),speechDevice=page.getByRole('combobox',{name:'Speech synthesis runs on'}),recognition=page.getByRole('combobox',{name:'Speech recognition engine'}),device=page.getByRole('combobox',{name:'Speech recognition runs on'});
 // Breeze has the GPU only.
 await expect(speechDevice).toBeDisabled();
 await expect(speechDevice).toContainText('GPU');
 await synthesis.click();
 await page.getByRole('option',{name:/Kokoro/}).click();
 await recognition.click();
 await page.getByRole('option',{name:/Qwen3-ASR 0\.6B/}).click();
 await expect(device).toBeEnabled();
 await expect(device).toContainText('GPU');
 // On the CPU: nothing is left on the GPU, so recognition is on the CPU too, and the memory is the host's.
 await expect(speechDevice).toBeEnabled();
 await speechDevice.click();
 await page.getByRole('option',{name:/^CPU/}).click();
 await expect(device).toBeDisabled();
 await expect(device).toContainText('CPU');
 await expect(page.getByText('Needs about',{exact:false}).filter({hasText:'GPU memory'})).toHaveCount(0);
 await expect(page.getByText('Needs about 2.8 GiB of memory on the CPU. Fits.')).toBeVisible();
 await page.getByRole('button',{name:'Install voice',exact:true}).click();
 await expect.poll(()=>posts.length).toBe(1);
 expect(posts[0]).toEqual({tts:'kokoro',ttsDevice:'cpu',asr:'qwen3-asr',asrModel:'0.6b'});
});

test('engine choice: a pick made before the GPU check answers is recognition alone once it says there is no GPU',async({page})=>{
 const posts:any[]=[];let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
 // The first answer is slow: the image of the throwaway container has to be downloaded.
 await page.route(`${BASE}/hardware`,async r=>{await gate;return r.fulfill({json:noGpu()});});
 await page.route(SERVICE,r=>{
  if(r.request().method()==='POST'){posts.push(r.request().postDataJSON());return r.fulfill({json:{ok:true}});}
  return r.fulfill({json:{available:true,state:'absent',busy:false,progress:'',error:''}});
 });
 await open(page);
 // Before the answer the page knows nothing of the GPU: Breeze is shown, and a pick is made on it.
 await expect(page.getByRole('combobox',{name:'Speech synthesis engine'})).toContainText('Breeze');
 await page.getByRole('checkbox',{name:'Choose for me, based on my GPU'}).uncheck();
 await page.getByRole('combobox',{name:'Speech recognition engine'}).click();
 await page.getByRole('option',{name:/Whisper small/}).click();
 release();
 await expect(page.getByRole('combobox',{name:'Speech synthesis engine'})).toContainText('No speech synthesis');
 await page.getByRole('button',{name:'Install voice',exact:true}).click();
 await expect.poll(()=>posts.length).toBe(1);
 // What is sent is what the page shows, not the Breeze it was picked with.
 expect(posts[0]).toEqual({tts:'none',asr:'whisper',asrModel:'small'});
});

test('engine choice: a speech engine installed on a host that has lost its GPU can be switched to recognition alone',async({page})=>{
 const posts:any[]=[];
 await page.route(`${BASE}/hardware`,r=>r.fulfill({json:noGpu()}));
 await page.route(SERVICE,r=>{
  if(r.request().method()==='POST'){posts.push(r.request().postDataJSON());return r.fulfill({json:{ok:true}});}
  return r.fulfill({json:{available:true,state:'stopped',busy:false,progress:'',error:'',choice:{tts:'breeze',asr:'whisper',asrModel:'base'}}});
 });
 await open(page);
 await expect(page.getByRole('alert').filter({hasText:'No GPU detected.'})).toBeVisible();
 // The installed engine is shown and can be left: recognition alone is offered beside it.
 const synthesis=page.getByRole('combobox',{name:'Speech synthesis engine'});
 await expect(synthesis).toBeEnabled();
 await expect(synthesis).toContainText('Breeze');
 await synthesis.click();
 await expect(page.getByRole('option',{name:/Chatterbox/})).toBeVisible();
 await page.getByRole('option',{name:/No speech synthesis/}).click();
 await expect(page.getByText('Switching engines recreates the voice container.')).toBeVisible();
 await page.getByRole('button',{name:'Rebuild with these engines'}).click();
 await expect.poll(()=>posts.length).toBe(1);
 expect(posts[0]).toEqual({tts:'none',asr:'whisper',asrModel:'base'});
});

test('engine choice: a card that Docker cannot use is named, with what to install, and only what runs on the CPU is offered',async({page})=>{
 await page.route(`${BASE}/hardware`,r=>r.fulfill({json:noGpu({unusable:['Test GPU']})}));
 await page.route(SERVICE,r=>r.fulfill({json:{available:true,state:'absent',busy:false,progress:'',error:''}}));
 await open(page);
 await expect(page.getByRole('alert').filter({hasText:'GPU detected: Test GPU, but Docker cannot use it. Install the NVIDIA Container Toolkit and restart Docker. Until then everything runs on the CPU: Kokoro can speak, the other speech engines need the GPU.'})).toBeVisible();
 await expect(page.getByRole('combobox',{name:'Speech synthesis engine'})).toBeDisabled();
 await expect(page.getByRole('combobox',{name:'Speech synthesis engine'})).toContainText('Kokoro');
 await expect(page.getByRole('combobox',{name:'Speech synthesis runs on'})).toContainText('CPU');
});
