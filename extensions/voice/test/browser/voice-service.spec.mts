import { test, expect } from './portal-mock';
// The engine choice asks for the GPU as the page opens; the tests that are about something else get none to read.
test.beforeEach(async({page})=>{await page.route('**/api/voice/hardware',r=>r.fulfill({json:{gpus:[],source:'none',error:'',checked:false,cpuOnly:false,host:{totalMiB:16384,freeMiB:12000,threads:8},selected:null,reserveMiB:0,suggestion:{tts:'breeze',asr:'whisper',asrModel:'base'}}}));});
test('settings install progress, ready connection, and stop',async({page})=>{
 let state='absent'; const actions:string[]=[];
 const config={enabled:false,whisperUrl:'http://127.0.0.1:8178/inference',breezeUrl:'http://127.0.0.1:7860/v1/audio/speech',instruction:'Clear speech',voice:'design',runtime:'breeze',language:'auto',cfgScale:4};
 await page.route('**/api/voice/presets',r=>r.fulfill({json:[]}));
 await page.route('**/api/voice',r=>r.fulfill({json:{...config,enabled:state==='running'}}));
 await page.route('**/api/voice/install',async r=>{
  if(r.request().method()==='POST'){actions.push('install');state='starting';return r.fulfill({json:{ok:true}});}
  return r.fulfill({json:{available:true,state,busy:false,progress:state==='starting'?'Quantizing Breeze to Q8_0 on CPU':'',error:''}});
 });
 await page.route('**/api/voice/stop',r=>{actions.push('stop');state='stopped';return r.fulfill({json:{ok:true}});});
 await page.goto('/tests/voice-addon.html');
 await expect(page.getByLabel('Speech recognition URL')).toBeHidden();
 await page.locator('summary').filter({hasText:'Voice service'}).click();
 await page.getByRole('button',{name:'Install voice',exact:true}).click();
 await expect(page.getByLabel('Voice setup log')).toContainText('Quantizing');
 await expect(page.getByRole('button',{name:'Start voice',exact:true})).toBeDisabled();
 state='running';
 await expect(page.getByRole('checkbox',{name:'Enable voice controls in sessions'})).toBeChecked({timeout:8000});
 await page.getByRole('button',{name:'Stop · release VRAM'}).click();
 await expect(page.getByRole('button',{name:'Start voice',exact:true})).toBeEnabled();
 expect(actions).toEqual(['install','stop']);
});

// The saved settings the install overwrote, as the portal puts them back, and the page that has to show them.
const uninstallPage = async (page: any, state = 'running') => {
 let status = state, connected = false, failure = '', reads = 0; const requests: any[] = [];
 let config: any = { enabled: true, whisperUrl: 'http://127.0.0.1:7862/v1/audio/transcriptions', breezeUrl: 'http://127.0.0.1:7862/v1/audio/speech', instruction: 'Clear speech', voice: 'design', runtime: 'audio-cpp', sttModel: 'qwen3-asr', language: 'auto' };
 await page.route('**/api/voice/presets', (r: any) => r.fulfill({ json: [] }));
 await page.route('**/api/voice', (r: any) => r.fulfill({ json: config }));
 // As the server answers: once there is a container, `progress` is its log, so a steady service has lines in it too.
 await page.route('**/api/voice/install', (r: any) => { if (r.request().method() === 'GET') reads++; return r.fulfill({ json: { available: true, state: status, busy: false, progress: status === 'absent' ? '' : 'INFO: Uvicorn running on http://0.0.0.0:7862', error: '', connected, choice: { tts: 'breeze', asr: 'qwen3-asr', asrModel: '0.6b' } } }); });
 await page.route('**/api/voice/uninstall', (r: any) => {
  requests.push(r.request().postDataJSON()); status = 'absent'; connected = false;
  config = { ...config, enabled: false, runtime: 'breeze', whisperUrl: 'http://stt.example.test:9000/inference', breezeUrl: 'http://tts.example.test:9001/v1/audio/speech', sttModel: '' };
  // Docker refused to delete the volume: the container is gone and the settings are put back all the same.
  return failure ? r.fulfill({ status: 409, json: { error: failure } }) : r.fulfill({ json: { ok: true } });
 });
 await page.goto('/tests/voice-addon.html');
 await page.locator('summary').filter({ hasText: 'Voice service' }).click();
 return { requests, reads: () => reads, change: (patch: any) => { config = { ...config, ...patch }; }, setState: (value: string) => { status = value; }, setConnected: (value: boolean) => { connected = value; }, fail: (message: string) => { failure = message; } };
};

test('uninstall asks first and says what goes, keeps the downloads unless told, and shows the settings that were put back', async ({ page }) => {
 const { requests } = await uninstallPage(page);
 const uninstall = page.getByRole('button', { name: 'Uninstall', exact: true });
 const dialog = page.getByRole('alertdialog');
 await page.getByLabel('Describe the speaking voice').fill('Edited and not saved yet');
 await uninstall.click();
 await expect(dialog.getByRole('heading', { name: 'Uninstall voice?' })).toBeVisible();
 await expect(dialog).toContainText('The voice container is stopped and removed');
 await expect(dialog).toContainText('speech servers you set up yourself stay as they are');
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
 await expect(page.locator('summary').filter({ hasText: 'Voice service' })).toContainText('Not installed');
 await expect(uninstall).toBeHidden();
 // What was put back is shown, and an edit that was not saved yet is not lost with it.
 await page.locator('summary').filter({ hasText: 'Advanced connection' }).click();
 await expect(page.getByLabel('Speech recognition URL')).toHaveValue('http://stt.example.test:9000/inference');
 await expect(page.getByLabel('Speech synthesis URL')).toHaveValue('http://tts.example.test:9001/v1/audio/speech');
 await expect(page.getByLabel('Describe the speaking voice')).toHaveValue('Edited and not saved yet');
 await expect(page.getByRole('checkbox', { name: 'Enable voice controls in sessions' })).not.toBeChecked();
});

test('a service that turns ready takes over what the install wrote, and not what is being typed', async ({ page }) => {
 const { change, setState } = await uninstallPage(page, 'starting');
 await page.locator('summary').filter({ hasText: 'Advanced connection' }).click();
 await page.getByLabel('Describe the speaking voice').fill('Edited and not saved yet');
 // The install writes its own connection settings as it comes up.
 change({ whisperUrl: 'http://127.0.0.1:7999/v1/audio/transcriptions' });
 setState('running');
 await expect(page.getByLabel('Speech recognition URL')).toHaveValue('http://127.0.0.1:7999/v1/audio/transcriptions', { timeout: 8000 });
 await expect(page.getByLabel('Describe the speaking voice')).toHaveValue('Edited and not saved yet');
});

// Time goes by in the steps of the quick poll, with a moment of real time after each for the answer to come: a poll that is asked again only after its answer needs both.
const elapse = async (page: any, ms: number) => {
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
 await expect(page.locator('summary').filter({ hasText: 'Voice service' })).toContainText('starting');
 const starting = reads();
 await elapse(page, 10_000);
 expect(reads() - starting).toBeGreaterThanOrEqual(3);
});

// A steady service is looked at again every half minute, and at once when the tab is come back to.
const lookAgain = (page: any) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

test('uninstall deletes the downloaded engines and models only when the box is ticked, and is not offered where nothing is installed', async ({ page }) => {
 const { requests, setState, setConnected } = await uninstallPage(page, 'absent');
 const uninstall = page.getByRole('button', { name: 'Uninstall', exact: true });
 await expect(page.getByRole('button', { name: 'Install voice', exact: true })).toBeVisible();
 await expect(uninstall).toBeHidden();
 // The container was removed by hand and the settings still point at the service: they can be put right from here.
 setConnected(true);
 await lookAgain(page);
 await expect(uninstall).toBeVisible({ timeout: 8000 });
 setConnected(false);
 await lookAgain(page);
 await expect(uninstall).toBeHidden({ timeout: 8000 });
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
 // The container is gone all the same, and so is the button; the restored settings are shown.
 await expect(page.locator('summary').filter({ hasText: 'Voice service' })).toContainText('Not installed');
 await expect(page.getByRole('button', { name: 'Uninstall', exact: true })).toBeHidden();
 await page.locator('summary').filter({ hasText: 'Advanced connection' }).click();
 await expect(page.getByLabel('Speech recognition URL')).toHaveValue('http://stt.example.test:9000/inference');
});

test('speech detection settings save and restore defaults',async({page})=>{
 let config:any={enabled:true,whisperUrl:'http://localhost:8188/inference',breezeUrl:'http://localhost:7862/v1/audio/speech',instruction:'Clear speech',voice:'design',runtime:'audio-cpp'};
 await page.route('**/api/voice/presets',r=>r.fulfill({json:[]}));
 await page.route('**/api/voice/install',r=>r.fulfill({json:{available:true,state:'running',busy:false}}));
 await page.route('**/api/voice',async r=>{if(r.request().method()==='PUT')config=r.request().postDataJSON();await r.fulfill({json:config});});
 await page.goto('/tests/voice-addon.html');
 await page.locator('summary').filter({hasText:'Speech detection'}).click();
 const silence=page.getByRole('slider',{name:/End-of-turn silence/});
 await expect(silence).toHaveValue('1000');await silence.fill('500');
 await page.getByRole('button',{name:'Save voice settings'}).click();
 await expect.poll(()=>config.vad?.redemptionMs).toBe(500);
 await page.reload();await page.locator('summary').filter({hasText:'Speech detection'}).click();
 await expect(silence).toHaveValue('500');
 await page.getByRole('button',{name:'Reset speech detection'}).click();
 await expect(silence).toHaveValue('1000');
});

test('speaking instructions show the built-in text, save an edit and reset to the built-in text',async({page})=>{
 const builtIn='Built-in speaking instructions for this test.';
 let config:any={enabled:true,whisperUrl:'http://localhost:8188/inference',breezeUrl:'http://localhost:7862/v1/audio/speech',instruction:'Clear speech',voice:'design',runtime:'audio-cpp'};
 const puts:any[]=[];
 await page.route('**/api/voice/presets',r=>r.fulfill({json:[]}));
 await page.route('**/api/voice/install',r=>r.fulfill({json:{available:true,state:'running',busy:false}}));
 // As the server answers: the text in use and the built-in one, and the built-in text saved as nothing.
 const shown=()=>({...config,responseInstructions:config.responseInstructions||builtIn,defaultResponseInstructions:builtIn,responseInstructionsOff:false});
 await page.route('**/api/voice',async r=>{
  if(r.request().method()==='PUT'){const body=r.request().postDataJSON();puts.push(body);config={...body,responseInstructions:body.responseInstructions.trim()===builtIn?'':body.responseInstructions.trim()};}
  return r.fulfill({json:shown()});
 });
 await page.goto('/tests/voice-addon.html');
 await expect(page.getByText('This portal is set to send no speaking instructions')).toBeHidden();
 await page.locator('summary').filter({hasText:'Speaking instructions'}).click();
 const text=page.getByRole('textbox',{name:'Speaking instructions'});
 const reset=page.getByRole('button',{name:'Reset to default'});
 await expect(text).toHaveValue(builtIn);
 await expect(reset).toBeDisabled();
 await text.fill('Answer in one word.');
 await expect(reset).toBeEnabled();
 const save=page.getByRole('button',{name:'Save voice settings'}),saved=page.getByRole('button',{name:'Saved',exact:true});
 await save.click();
 await expect(saved).toBeVisible();
 expect(puts.at(-1).responseInstructions).toBe('Answer in one word.');
 // Saved as it is, and the built-in text still there to reset to.
 await expect(text).toHaveValue('Answer in one word.');
 await reset.click();
 await expect(text).toHaveValue(builtIn);
 await expect(reset).toBeDisabled();
 await save.click();
 await expect(saved).toBeVisible();
 expect(puts).toHaveLength(2);
 expect(puts[1].responseInstructions).toBe('');
 expect(config.responseInstructions).toBe('');
 // Emptied to write a new text, it stays empty while being written, and is the built-in text once saved.
 await text.fill('');
 await expect(text).toHaveValue('');
 await save.click();
 await expect(saved).toBeVisible();
 await expect(text).toHaveValue(builtIn);
 await page.reload();
 await page.locator('summary').filter({hasText:'Speaking instructions'}).click();
 await expect(text).toBeVisible();
 await expect(text).toHaveValue(builtIn);
 await reset.scrollIntoViewIfNeeded();
});

test('speaking instructions say when the portal is set to send none',async({page})=>{
 await page.route('**/api/voice/presets',r=>r.fulfill({json:[]}));
 await page.route('**/api/voice/install',r=>r.fulfill({json:{available:true,state:'running',busy:false}}));
 await page.route('**/api/voice',r=>r.fulfill({json:{enabled:true,whisperUrl:'http://localhost:8188/inference',breezeUrl:'http://localhost:7862/v1/audio/speech',instruction:'Clear speech',voice:'design',runtime:'audio-cpp',responseInstructions:'Kept text.',defaultResponseInstructions:'Built-in.',responseInstructionsOff:true}}));
 await page.goto('/tests/voice-addon.html');
 await page.locator('summary').filter({hasText:'Speaking instructions'}).click();
 await expect(page.getByRole('status').filter({hasText:'VOICE_RESPONSE_INSTRUCTIONS=false'})).toBeVisible();
 await expect(page.getByRole('textbox',{name:'Speaking instructions'})).toHaveValue('Kept text.');
});

test('saving other voice settings does not pin the built-in text of an older portal',async({page})=>{
 // The portal is updated, with new built-in text, while this page is open.
 let builtIn='Built-in text before the update.';
 let config:any={enabled:true,whisperUrl:'http://localhost:8188/inference',breezeUrl:'http://localhost:7862/v1/audio/speech',instruction:'Clear speech',voice:'design',runtime:'audio-cpp',responseInstructions:''};
 const puts:any[]=[];
 const shown=()=>({...config,responseInstructions:config.responseInstructions||builtIn,defaultResponseInstructions:builtIn,responseInstructionsOff:false});
 await page.route('**/api/voice/presets',r=>r.fulfill({json:[]}));
 await page.route('**/api/voice/install',r=>r.fulfill({json:{available:true,state:'running',busy:false}}));
 await page.route('**/api/voice',async r=>{
  if(r.request().method()==='PUT'){const body=r.request().postDataJSON();puts.push(body);config={...body,responseInstructions:body.responseInstructions.trim()===builtIn?'':body.responseInstructions.trim()};}
  return r.fulfill({json:shown()});
 });
 await page.goto('/tests/voice-addon.html');
 await page.locator('summary').filter({hasText:'Speaking instructions'}).click();
 const text=page.getByRole('textbox',{name:'Speaking instructions'});
 await expect(text).toHaveValue('Built-in text before the update.');
 builtIn='Built-in text after the update.';
 await page.locator('summary').filter({hasText:'Speech detection'}).click();
 await page.getByRole('slider',{name:/End-of-turn silence/}).fill('500');
 await page.getByRole('button',{name:'Save voice settings'}).click();
 await expect(page.getByRole('button',{name:'Saved',exact:true})).toBeVisible();
 expect(puts[0].responseInstructions).toBe('');
 expect(config.responseInstructions).toBe('');
 await expect(text).toHaveValue('Built-in text after the update.');
 // A text of the user's own is saved as it is.
 await text.fill('Answer in one word.');
 await page.getByRole('button',{name:'Save voice settings'}).click();
 await expect(page.getByRole('button',{name:'Saved',exact:true})).toBeVisible();
 expect(puts[1].responseInstructions).toBe('Answer in one word.');
});

// A card with 6 GiB, 5 GiB of it free: the small recognition model fits next to Breeze with room to spare, the large one does not fit at all.
// `checked` is whether the check could tell: with no GPU listed, a probe that ran and found none, or nothing asked yet.
const host = { totalMiB: 16384, freeMiB: 12000, threads: 8 };
const hardware = (gpus: any[], checked = gpus.length > 0) => ({ gpus, source: 'host', error: '', checked, cpuOnly: false, host, selected: gpus.length ? 0 : null, chosen: '', reserveMiB: 0, suggestion: { tts: 'breeze', asr: 'qwen3-asr', asrModel: '0.6b' } });
// A host that was found to have no GPU: what is suggested is recognition alone, on the CPU.
const noGpu = (patch: any = {}) => ({ gpus: [], source: 'none', error: '', checked: true, cpuOnly: true, host, selected: null, reserveMiB: 0, suggestion: { tts: 'kokoro', ttsDevice: 'cpu', asr: 'qwen3-asr', asrModel: '0.6b' }, ...patch });
const card = { index: 0, name: 'Test GPU', totalMiB: 6144, freeMiB: 5000 };
const config = { enabled: false, whisperUrl: 'http://127.0.0.1:8178/inference', breezeUrl: 'http://127.0.0.1:7860/v1/audio/speech', instruction: 'Clear speech', voice: 'design', runtime: 'breeze', language: 'auto', cfgScale: 4 };

test('engine choice: the GPU is shown, the install picks for it by default, and an explicit pick is checked against it and sent',async({page})=>{
 let state='absent'; let choice:any; const posts:any[]=[];
 await page.route('**/api/voice/presets',r=>r.fulfill({json:[]}));
 await page.route('**/api/voice/hardware',r=>r.fulfill({json:hardware([card])}));
 await page.route('**/api/voice',r=>r.fulfill({json:config}));
 await page.route('**/api/voice/install',r=>{
  if(r.request().method()==='POST'){posts.push(r.request().postDataJSON());state='starting';choice=posts.at(-1)??{tts:'breeze',asr:'qwen3-asr',asrModel:'0.6b'};return r.fulfill({json:{ok:true}});}
  return r.fulfill({json:{available:true,state,busy:false,progress:'',error:'',choice}});
 });
 await page.goto('/tests/voice-addon.html');
 await page.locator('summary').filter({hasText:'Voice service'}).click();
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
 await page.route('**/api/voice/presets',r=>r.fulfill({json:[]}));
 await page.route('**/api/voice/hardware',r=>r.fulfill({json:hardware([])}));
 await page.route('**/api/voice',r=>r.fulfill({json:config}));
 await page.route('**/api/voice/install',r=>{
  if(r.request().method()==='POST'){posts.push(r.request().postData());state='starting';return r.fulfill({json:{ok:true}});}
  return r.fulfill({json:{available:true,state,busy:false,progress:'',error:''}});
 });
 await page.goto('/tests/voice-addon.html');
 await page.locator('summary').filter({hasText:'Voice service'}).click();
 // No GPU can be read from here: said so, with what happens instead.
 await expect(page.getByText('GPU not checked yet.')).toBeVisible();
 await expect(page.getByText('The install picks what fits your GPU.')).toBeVisible();
 await page.getByRole('button',{name:'Install voice',exact:true}).click();
 await expect.poll(()=>posts.length).toBe(1);
 expect(posts[0]).toBeNull();
});

test('engine choice: an installed service shows its engines, and another pick offers a rebuild that is sent',async({page})=>{
 let installed:any={tts:'breeze',asr:'whisper',asrModel:'base'}; const posts:any[]=[];
 await page.route('**/api/voice/presets',r=>r.fulfill({json:[]}));
 await page.route('**/api/voice/hardware',r=>r.fulfill({json:hardware([{...card,totalMiB:24576,freeMiB:24000}])}));
 await page.route('**/api/voice',r=>r.fulfill({json:{...config,enabled:true}}));
 await page.route('**/api/voice/install',r=>{
  if(r.request().method()==='POST'){posts.push(r.request().postDataJSON());installed=posts.at(-1);return r.fulfill({json:{ok:true}});}
  return r.fulfill({json:{available:true,state:'running',busy:false,progress:'',error:'',choice:installed}});
 });
 await page.goto('/tests/voice-addon.html');
 await page.locator('summary').filter({hasText:'Voice service'}).click();
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
 await page.route('**/api/voice/presets',r=>r.fulfill({json:[]}));
 await page.route('**/api/voice/hardware',r=>r.fulfill({json:hardware([card])}));
 await page.route('**/api/voice',r=>r.fulfill({json:config}));
 // There is no container yet, so no choice to report: the daemon is still pulling the image.
 await page.route('**/api/voice/install',r=>{
  if(r.request().method()==='POST'){state='installing';return r.fulfill({json:{ok:true}});}
  return r.fulfill({json:{available:true,state,busy:state==='installing',progress:state==='installing'?'Downloading layer':'',error:''}});
 });
 await page.goto('/tests/voice-addon.html');
 await page.locator('summary').filter({hasText:'Voice service'}).click();
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
 await page.route('**/api/voice/presets',r=>r.fulfill({json:[]}));
 await page.route('**/api/voice/hardware',r=>r.fulfill({json:{...hardware(gpus),selected:1}}));
 await page.route('**/api/voice',r=>r.fulfill({json:{...config,enabled:true}}));
 await page.route('**/api/voice/install',r=>r.fulfill({json:{available:true,state:'running',busy:false,progress:'',error:'',choice:{tts:'breeze',asr:'qwen3-asr',asrModel:'1.7b'}}}));
 await page.goto('/tests/voice-addon.html');
 await page.locator('summary').filter({hasText:'Voice service'}).click();
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
 await page.route('**/api/voice/presets',r=>r.fulfill({json:[]}));
 await page.route('**/api/voice/hardware',r=>r.fulfill({json:shown()}));
 await page.route('**/api/voice/gpu',r=>{puts.push(r.request().postDataJSON());chosen=puts.at(-1).gpu;return r.fulfill({json:{selected:chosen,restarting:true}});});
 await page.route('**/api/voice',r=>r.fulfill({json:{...config,enabled:true}}));
 await page.route('**/api/voice/install',r=>r.fulfill({json:{available:true,state:'running',busy:false,progress:'',error:'',choice:{tts:'breeze',asr:'whisper',asrModel:'base'}}}));
 await page.goto('/tests/voice-addon.html');
 await page.locator('summary').filter({hasText:'Voice service'}).click();
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
 await page.route('**/api/voice/presets',r=>r.fulfill({json:[]}));
 await page.route('**/api/voice/hardware',r=>r.fulfill({json:hardware([card])}));
 await page.route('**/api/voice',r=>r.fulfill({json:config}));
 await page.route('**/api/voice/install',r=>{
  if(r.request().method()==='POST'){posts.push(r.request().postDataJSON());return r.fulfill({json:{ok:true}});}
  return r.fulfill({json:{available:true,state:'absent',busy:false,progress:'',error:''}});
 });
 await page.goto('/tests/voice-addon.html');
 await page.locator('summary').filter({hasText:'Voice service'}).click();
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
 await page.route('**/api/voice/presets',r=>r.fulfill({json:[]}));
 await page.route('**/api/voice/hardware',r=>r.fulfill({json:noGpu()}));
 await page.route('**/api/voice',r=>r.fulfill({json:config}));
 await page.route('**/api/voice/install',r=>{
  if(r.request().method()==='POST'){posts.push(r.request().postDataJSON());state='starting';choice=posts.at(-1)??{tts:'none',asr:'qwen3-asr',asrModel:'0.6b'};return r.fulfill({json:{ok:true}});}
  return r.fulfill({json:{available:true,state,busy:false,progress:'',error:'',choice}});
 });
 await page.goto('/tests/voice-addon.html');
 await page.locator('summary').filter({hasText:'Voice service'}).click();
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
 await page.route('**/api/voice/presets',r=>r.fulfill({json:[]}));
 await page.route('**/api/voice/hardware',r=>r.fulfill({json:noGpu({suggestion:{tts:'none',asr:'whisper',asrModel:'base'},host:{totalMiB:2048,freeMiB:1000,threads:2}})}));
 await page.route('**/api/voice',r=>r.fulfill({json:config}));
 await page.route('**/api/voice/install',r=>{
  if(r.request().method()==='POST'){posts.push(r.request().postData());return r.fulfill({json:{ok:true}});}
  return r.fulfill({json:{available:true,state:'absent',busy:false,progress:'',error:''}});
 });
 await page.goto('/tests/voice-addon.html');
 await page.locator('summary').filter({hasText:'Voice service'}).click();
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
 await page.route('**/api/voice/presets',r=>r.fulfill({json:[]}));
 await page.route('**/api/voice/hardware',r=>r.fulfill({json:hw}));
 await page.route('**/api/voice',r=>r.fulfill({json:{...config,enabled:true,runtime:'none',breezeUrl:''}}));
 await page.route('**/api/voice/install',r=>{
  if(r.request().method()==='POST'){posts.push(r.request().postDataJSON());return r.fulfill({json:{ok:true}});}
  return r.fulfill({json:{available:true,state:'running',busy:false,progress:'',error:'',choice:{tts:'none',asr:'qwen3-asr',asrModel:'0.6b'}}});
 });
 await page.goto('/tests/voice-addon.html');
 await page.locator('summary').filter({hasText:'Voice service'}).click();
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
 await page.locator('summary').filter({hasText:'Voice service'}).click();
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
 await page.route('**/api/voice/presets',r=>r.fulfill({json:[]}));
 await page.route('**/api/voice/hardware',r=>r.fulfill({json:hardware([card])}));
 await page.route('**/api/voice',r=>r.fulfill({json:config}));
 await page.route('**/api/voice/install',r=>{
  if(r.request().method()==='POST'){posts.push(r.request().postDataJSON());return r.fulfill({json:{ok:true}});}
  return r.fulfill({json:{available:true,state:'absent',busy:false,progress:'',error:''}});
 });
 await page.goto('/tests/voice-addon.html');
 await page.locator('summary').filter({hasText:'Voice service'}).click();
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

test('a service without speech synthesis is a listening one: the settings say so and offer nothing to speak with',async({page})=>{
 await page.route('**/api/voice/presets',r=>r.fulfill({json:[]}));
 await page.route('**/api/voice',r=>r.fulfill({json:{...config,enabled:true,runtime:'none',breezeUrl:'',speech:false,managed:true}}));
 await page.route('**/api/voice/install',r=>r.fulfill({json:{available:true,state:'running',busy:false,progress:'',error:'',choice:{tts:'none',asr:'whisper',asrModel:'base'}}}));
 await page.goto('/tests/voice-addon.html');
 await expect(page.getByRole('status').filter({hasText:'This installation has no speech synthesis: replies are not spoken and voice mode is off. Dictation, which only listens, works.'})).toBeVisible();
 await expect(page.getByRole('checkbox',{name:'Enable dictation in sessions'})).toBeChecked();
 // Nothing of the speaking side: the voice, how it is generated, how the assistant is told to speak.
 await expect(page.getByRole('heading',{name:'Your voice'})).toHaveCount(0);
 await expect(page.getByText('Speech generation')).toHaveCount(0);
 await expect(page.locator('summary').filter({hasText:'Speaking instructions'})).toHaveCount(0);
 // What listening has stays: the language, how turns are told apart, and the service itself.
 await expect(page.getByLabel('Input language')).toBeVisible();
 await expect(page.locator('summary').filter({hasText:'Speech detection'})).toBeVisible();
 await page.locator('summary').filter({hasText:'Advanced connection'}).click();
 await expect(page.getByLabel('Speech recognition URL')).toBeVisible();
 await expect(page.getByLabel('Speech synthesis URL')).toHaveCount(0);
 await expect(page.getByRole('combobox',{name:'Speech runtime'})).toContainText('No speech synthesis');
});

test('with Kokoro the voice list is its own voices, and its speed replaces the generation setting',async({page})=>{
 const puts:any[]=[];
 let saved:any={...config,enabled:true,runtime:'kokoro',breezeUrl:'http://127.0.0.1:7862/v1/audio/speech',voice:'voice-1',kokoroVoice:'af_heart',speed:1,managed:true};
 await page.route('**/api/voice/presets',r=>r.fulfill({json:[{id:'voice-1',name:'Library clone',kind:'clone',instruction:'Warm.',transcript:'Hello.'}]}));
 await page.route('**/api/voice',async r=>{if(r.request().method()==='PUT'){saved=r.request().postDataJSON();puts.push(saved);}await r.fulfill({json:saved});});
 await page.route('**/api/voice/install',r=>r.fulfill({json:{available:true,state:'running',busy:false,progress:'',error:'',choice:{tts:'kokoro',asr:'whisper',asrModel:'base'}}}));
 await page.goto('/tests/voice-addon.html');
 const voice=page.getByRole('combobox',{name:'Speaking voice'});
 await expect(voice).toContainText('Heart');
 await voice.click();
 await expect(page.getByRole('option',{name:/Emma.*British English · female/})).toBeVisible();
 await expect(page.getByRole('option',{name:/Library clone|Designed voice/})).toHaveCount(0);
 await expect(page.getByRole('option',{name:/Japanese/})).toHaveCount(0);
 await page.getByRole('option',{name:/Emma/}).click();
 await expect(page.getByText('Speech generation')).toHaveCount(0);
 await page.getByRole('combobox',{name:'Speaking speed'}).click();
 await page.getByRole('option',{name:'Faster'}).click();
 await page.getByRole('button',{name:'Save voice settings'}).click();
 await expect.poll(()=>puts.length).toBe(1);
 // The library voice is kept for the other engines.
 expect([puts[0].kokoroVoice,puts[0].speed,puts[0].voice]).toEqual(['bf_emma',1.15,'voice-1']);
 // Another engine has the library again.
 await page.locator('summary').filter({hasText:'Advanced connection'}).click();
 await page.getByRole('combobox',{name:'Speech runtime'}).click();
 await page.getByRole('option',{name:/Breeze audio\.cpp/}).click();
 await expect(voice).toContainText('Library clone');
});

test('engine choice: a pick made before the GPU check answers is recognition alone once it says there is no GPU',async({page})=>{
 const posts:any[]=[];let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
 await page.route('**/api/voice/presets',r=>r.fulfill({json:[]}));
 // The first answer is slow: the image of the throwaway container has to be downloaded.
 await page.route('**/api/voice/hardware',async r=>{await gate;return r.fulfill({json:noGpu()});});
 await page.route('**/api/voice',r=>r.fulfill({json:config}));
 await page.route('**/api/voice/install',r=>{
  if(r.request().method()==='POST'){posts.push(r.request().postDataJSON());return r.fulfill({json:{ok:true}});}
  return r.fulfill({json:{available:true,state:'absent',busy:false,progress:'',error:''}});
 });
 await page.goto('/tests/voice-addon.html');
 await page.locator('summary').filter({hasText:'Voice service'}).click();
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
 await page.route('**/api/voice/presets',r=>r.fulfill({json:[]}));
 await page.route('**/api/voice/hardware',r=>r.fulfill({json:noGpu()}));
 await page.route('**/api/voice',r=>r.fulfill({json:{...config,enabled:true}}));
 await page.route('**/api/voice/install',r=>{
  if(r.request().method()==='POST'){posts.push(r.request().postDataJSON());return r.fulfill({json:{ok:true}});}
  return r.fulfill({json:{available:true,state:'stopped',busy:false,progress:'',error:'',choice:{tts:'breeze',asr:'whisper',asrModel:'base'}}});
 });
 await page.goto('/tests/voice-addon.html');
 await page.locator('summary').filter({hasText:'Voice service'}).click();
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
 await page.route('**/api/voice/presets',r=>r.fulfill({json:[]}));
 await page.route('**/api/voice/hardware',r=>r.fulfill({json:noGpu({unusable:['Test GPU']})}));
 await page.route('**/api/voice',r=>r.fulfill({json:config}));
 await page.route('**/api/voice/install',r=>r.fulfill({json:{available:true,state:'absent',busy:false,progress:'',error:''}}));
 await page.goto('/tests/voice-addon.html');
 await page.locator('summary').filter({hasText:'Voice service'}).click();
 await expect(page.getByRole('alert').filter({hasText:'GPU detected: Test GPU, but Docker cannot use it. Install the NVIDIA Container Toolkit and restart Docker. Until then everything runs on the CPU: Kokoro can speak, the other speech engines need the GPU.'})).toBeVisible();
 await expect(page.getByRole('combobox',{name:'Speech synthesis engine'})).toBeDisabled();
 await expect(page.getByRole('combobox',{name:'Speech synthesis engine'})).toContainText('Kokoro');
 await expect(page.getByRole('combobox',{name:'Speech synthesis runs on'})).toContainText('CPU');
});

test('the providers that reply without thinking first: the list is typed with commas, saved as the server keeps it, and reset to the default one',async({page})=>{
 const builtIn=['llama.cpp','llama-server','llama-swap'];
 let config:any={enabled:true,whisperUrl:'http://localhost:8188/inference',breezeUrl:'http://localhost:7862/v1/audio/speech',instruction:'Clear speech',voice:'design',runtime:'audio-cpp'};
 const puts:any[]=[];
 await page.route('**/api/voice/presets',r=>r.fulfill({json:[]}));
 await page.route('**/api/voice/install',r=>r.fulfill({json:{available:true,state:'running',busy:false}}));
 // As the server answers: the list in use, the default one to go back to, and a list saved each name once.
 const shown=()=>({...config,skipThinkingProviders:config.skipThinkingProviders??builtIn,defaultSkipThinkingProviders:builtIn});
 await page.route('**/api/voice',async r=>{
  if(r.request().method()==='PUT'){const body=r.request().postDataJSON();puts.push(body);const names=[...new Set<string>(body.skipThinkingProviders)];config={...body,skipThinkingProviders:names.join()===builtIn.join()?undefined:names};}
  return r.fulfill({json:shown()});
 });
 await page.goto('/tests/voice-addon.html');
 const field=page.getByRole('textbox',{name:'Reply without thinking first on'});
 const reset=page.getByRole('button',{name:'Reset to the default list'});
 await expect(field).toHaveValue('llama.cpp, llama-server, llama-swap');
 await expect(reset).toBeDisabled();
 // Typed as it is, commas and all, while it is written.
 await field.fill('llama-swap, my-gateway, llama-swap, ');
 await expect(field).toHaveValue('llama-swap, my-gateway, llama-swap, ');
 await expect(reset).toBeEnabled();
 const save=page.getByRole('button',{name:'Save voice settings'}),saved=page.getByRole('button',{name:'Saved',exact:true});
 await save.click();
 await expect(saved).toBeVisible();
 expect(puts.at(-1).skipThinkingProviders).toEqual(['llama-swap','my-gateway','llama-swap']);
 // Once saved, the list the server kept, not the text that was typed.
 await expect(field).toHaveValue('llama-swap, my-gateway');
 await reset.click();
 await expect(field).toHaveValue('llama.cpp, llama-server, llama-swap');
 await save.click();
 await expect(saved).toBeVisible();
 expect(puts.at(-1).skipThinkingProviders).toEqual(builtIn);
 expect(config.skipThinkingProviders).toBeUndefined();
});
