import { test, expect } from './portal-mock';
import { settled } from './settled';
import { readFileSync } from 'node:fs';

// An extension's window at the side: the portal's tests' stand-in for one, opening on each command the agent runs.
test.use({ installed: ['tests/fixtures/extensions/console'] });
const sample = readFileSync(new URL('../fixtures/jfk.wav', import.meta.url));
// What the portal answers a phrase with: 24 kHz PCM, here the fixture's samples.
const pcm = sample.subarray(sample.indexOf('data') + 8);
const speech = { body: pcm, headers: { 'content-type': 'audio/pcm', 'x-sample-rate': '24000' } };
test.beforeEach(async ({ page }) => {
  await page.route('**/api/sessions/test/commands', route => route.fulfill({ json: { commands: [] } }));
  await page.route('**/api/sessions/test/config', route => route.fulfill({ status: 503, json: {} }));
});
test('real browser VAD submits turns, supports barge-in, and releases the mic', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', e => failures.push(e.message));
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true } }));
  await page.route('**/test-speech.wav', route => route.fulfill({ body: sample, contentType: 'audio/wav' }));
  await page.route('**/voice/transcribe', route => {
    expect(route.request().postDataBuffer()?.subarray(0, 4).toString()).toBe('RIFF');
    return route.fulfill({ json: { text: 'A test voice turn.' } });
  });
  await page.route('**/voice/speech', route => route.fulfill(speech));
  await page.goto('/tests/voice.html');
  await page.getByRole('textbox', { name: 'Message' }).fill('Keep this draft');
  await page.getByRole('button', { name: 'Profile voice latency' }).click();
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('button', { name: 'End voice mode' })).toBeVisible({ timeout: 25000 });
  await expect(page.getByRole('status')).toContainText('Listening');
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeHidden();
  await expect(page.getByText('We can work through it together.')).toBeHidden();
  await page.getByRole('button', { name: 'Inject speech' }).click();
  await expect(page.getByRole('status')).toContainText('Hearing you');
  await expect(page.getByTestId('sent')).toHaveText('1', { timeout: 12000 });
  await expect(page.getByTestId('voice-send')).toHaveText('true');
  await expect(page.getByRole('status')).toContainText('Speaking');
  await expect(page.getByLabel('Voice latency profiler')).toContainText('from last detected speech to reply audio');
  await expect(page.getByLabel('Voice latency profiler')).toContainText('Turn detection');
  const timingDownload=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download timing report'}).click();
  expect((await timingDownload).suggestedFilename()).toBe('voice-latency.json');
  await page.getByRole('button',{name:'Close voice profiler'}).click();
  await page.getByRole('button', { name: 'Inject speech' }).click();
  await expect(page.getByRole('status')).toContainText('Hearing you');
  await expect(page.getByTestId('aborted')).toHaveText('1');
  await expect(page.getByTestId('sent')).toHaveText('2', { timeout: 12000 });
  await page.getByRole('button', { name: 'End voice mode' }).click();
  await page.getByRole('button', { name: 'Check mic tracks' }).click();
  await expect(page.getByTestId('tracks')).toHaveText('ended:true');
  await expect(page.getByRole('button', { name: 'Turn on hands-free voice' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('Keep this draft');
  await expect(page.getByText('We can work through it together.')).toBeVisible();
  expect(failures).toEqual([]);
});

test('cancelling while the VAD model loads releases the microphone without sending', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true } }));
  await page.route('**/silero_vad_v5.onnx', async route => { await gate; await route.continue(); });
  await page.goto('/tests/voice.html');
  const request = page.waitForRequest('**/silero_vad_v5.onnx');
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await request;
  await page.getByRole('button', { name: 'End voice mode' }).click();
  release();
  await page.getByRole('button', { name: 'Check mic tracks' }).click();
  await expect(page.getByTestId('tracks')).toHaveText('ended:true');
  await expect(page.getByTestId('sent')).toHaveText('0');
  await expect(page.getByRole('button', { name: 'Turn on hands-free voice' })).toBeVisible();
});

test('mute keeps playback and option prompts available; end restores the chat', async ({ page }) => {
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true } }));
  await page.route('**/test-speech.wav', route => route.fulfill({ body: sample, contentType: 'audio/wav' }));
  await page.route('**/voice/transcribe', route => route.fulfill({ json: { text: 'A test voice turn.' } }));
  await page.route('**/voice/speech', route => route.fulfill(speech));
  let chosen: unknown;
  await page.route('**/ui-response', route => { chosen = route.request().postDataJSON(); return route.fulfill({ json: { ok: true } }); });
  await page.goto('/tests/voice.html');
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('status')).toHaveText('Listening', { timeout: 25000 });
  await page.getByRole('button', { name: 'Inject speech' }).click();
  await expect(page.locator('.voice-orb')).toHaveAttribute('data-mode', 'input');
  await expect(page.getByTestId('sent')).toHaveText('1', { timeout: 12000 });
  await expect(page.locator('.voice-orb')).toHaveAttribute('data-mode', 'output');
  await page.getByRole('button', { name: 'Mute microphone', exact: true }).click();
  await page.getByRole('button', { name: 'Check mic tracks' }).click();
  await expect(page.getByTestId('tracks')).toHaveText('live:false');
  await expect(page.locator('.voice-orb')).toHaveAttribute('data-mode', 'output');
  await page.getByRole('button', { name: 'Inject speech' }).click();
  await page.waitForTimeout(4200); // Longer than the injected speech plus turn-end silence.
  await expect(page.getByTestId('sent')).toHaveText('1');
  await expect(page.getByTestId('aborted')).toHaveText('0');
  await page.getByRole('button', { name: 'Show options' }).click();
  await page.getByRole('button', { name: 'Run tests', exact: true }).click();
  await expect(page.getByTestId('selected')).toHaveText('1');
  expect(chosen).toMatchObject({ id: 'choice', value: 'Run tests' });
  await page.getByRole('button', { name: 'Unmute microphone' }).click();
  await page.getByRole('button', { name: 'Check mic tracks' }).click();
  await expect(page.getByTestId('tracks')).toHaveText('live:true');
  await page.getByRole('button', { name: 'Inject speech' }).click();
  await expect(page.getByTestId('sent')).toHaveText('2', { timeout: 12000 });
  await page.getByRole('button', { name: 'End voice mode' }).click();
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
});

test('composer and voice controls fit a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true } }));
  await page.goto('/tests/voice.html');
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('status')).toHaveText('Listening', { timeout: 25000 });
  const end = await page.getByRole('button', { name: 'End voice mode' }).boundingBox();
  expect(end!.y + end!.height).toBeLessThan(844);
  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(horizontalOverflow).toBe(false);
  await page.getByRole('button', { name: 'End voice mode' }).click();
});


test('voice pipelines next-sentence synthesis during PCM playback and cancels on End', async ({ page }) => {
  const failures: string[] = []; page.on('pageerror', e => failures.push(e.message));
  const pcm = Buffer.alloc(24000 * 2 * 5);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 220 / 24000) * 5000), i * 2);
  const texts: string[] = [];
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true } }));
  await page.route('**/voice/speech', route => {
    // The spoken error line, asked for as voice mode starts, is not a phrase of the reply.
    const text = route.request().postDataJSON().text;
    if (text !== 'An error occurred.') texts.push(text);
    return route.fulfill({ body: pcm, headers: { 'content-type': 'audio/pcm', 'x-sample-rate': '24000' } });
  });
  await page.goto('/tests/voice.html');
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('status')).toHaveText('Listening', { timeout: 25000 });
  await page.getByRole('button', { name: 'Stream reply', exact: true }).click();
  await expect(page.locator('.voice-orb')).toHaveAttribute('data-mode', 'output');
  expect(texts).toEqual(['Here is the first sentence.']);
  await page.getByRole('button', { name: 'Finish reply', exact: true }).click();
  // The first phrase is five seconds long: request two must start while it plays.
  await expect.poll(() => texts.length, { timeout: 1500 }).toBe(2);
  await expect(page.locator('.voice-orb')).toHaveAttribute('data-mode', 'output');
  expect(texts).toEqual(['Here is the first sentence.', 'More text follows.']);
  await page.getByRole('button', { name: 'End voice mode' }).click();
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
  expect(failures).toEqual([]);
});

for (const pipelineMode of ['parallel', 'sequential'] as const) {
  test(`a phrase is played ${pipelineMode === 'parallel' ? 'before the rest of its PCM has come, in the streaming pipeline' : 'only once all its PCM has come, one phrase after another'}`, async ({ page }) => {
    // A phrase answered with 0.7 s of 24 kHz PCM at once, and the rest once the test lets go; each buffer of a phrase started is counted.
    await page.addInitScript(() => {
      const w = window as any;
      w.started = 0;
      w.held = [] as (() => void)[];
      w.letGo = () => { w.free = true; w.held.forEach((release: () => void) => release()); };
      const start = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (...args: Parameters<typeof start>) { w.started++; return start.apply(this, args); };
      const real = window.fetch;
      window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        // The spoken error line, asked for as voice mode starts, is not a phrase of the reply.
        if (!String(input).endsWith('/voice/speech') || JSON.parse(String(init?.body)).text === 'An error occurred.') return real(input, init);
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            const rest = () => { c.enqueue(new Uint8Array(48000)); c.close(); };
            c.enqueue(new Uint8Array(33600));
            if (w.free) rest(); else w.held.push(rest);
          },
        });
        return new Response(body, { headers: { 'content-type': 'audio/pcm', 'x-sample-rate': '24000' } });
      }) as typeof fetch;
    });
    await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true, pipelineMode } }));
    await page.route('**/voice/speech', route => route.fulfill(speech));
    await page.goto('/tests/voice.html');
    await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
    await expect(page.getByRole('status')).toHaveText('Listening', { timeout: 25000 });
    await page.getByRole('button', { name: 'Stream reply', exact: true }).click();
    await page.getByRole('button', { name: 'Finish reply', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).held.length)).toBeGreaterThan(0);
    const started = () => page.evaluate(() => (window as any).started);
    if (pipelineMode === 'parallel') {
      await expect.poll(started).toBeGreaterThan(0);
    } else {
      await page.waitForTimeout(1000);
      expect(await started()).toBe(0);
    }
    await page.evaluate(() => (window as any).letGo());
    await expect.poll(started).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'End voice mode' }).click();
  });
}

test('slow PCM chunks become one uninterrupted buffer, including split samples', async ({ page }) => {
  await page.goto('/tests/voice.html');
  const result = await page.evaluate(async () => {
    const { readPcmStream, playAudioBuffer } = await import('/src/pcm-stream.ts');
    // One phrase, buffered whole and then played: what a consumer without a pipeline does.
    const playPcmStream = async (body: ReadableStream<Uint8Array>, audio: AudioContext, destination: AudioNode, signal: AbortSignal, onStarted: () => void) =>
      playAudioBuffer(await readPcmStream(body, audio, signal), audio, destination, signal, onStarted);
    const audio = new AudioContext(); await audio.resume();
    let writer!: ReadableStreamDefaultController<Uint8Array>;
    let started = false, sourceCount = 0;
    const original = audio.createBufferSource.bind(audio);
    audio.createBufferSource = () => { sourceCount++; return original(); };
    const body = new ReadableStream<Uint8Array>({ start(c) { writer = c; } });
    const pending = playPcmStream(body, audio, audio.destination, new AbortController().signal, () => { started = true; });
    writer.enqueue(new Uint8Array([0]));
    writer.enqueue(new Uint8Array(4801));
    await new Promise(resolve => setTimeout(resolve, 300)); // Producer slower than the 100 ms of available audio.
    const startedTooEarly = started;
    writer.enqueue(new Uint8Array(4800)); writer.close();
    await pending; await audio.close();
    return { startedTooEarly, started, sourceCount };
  });
  expect(result).toEqual({ startedTooEarly: false, started: true, sourceCount: 1 });
});

test('End cancels PCM buffering before any audio can start', async ({ page }) => {
  await page.goto('/tests/voice.html');
  const result = await page.evaluate(async () => {
    const { readPcmStream, playAudioBuffer } = await import('/src/pcm-stream.ts');
    // One phrase, buffered whole and then played: what a consumer without a pipeline does.
    const playPcmStream = async (body: ReadableStream<Uint8Array>, audio: AudioContext, destination: AudioNode, signal: AbortSignal, onStarted: () => void) =>
      playAudioBuffer(await readPcmStream(body, audio, signal), audio, destination, signal, onStarted);
    const audio = new AudioContext(); await audio.resume();
    let cancelled = false, started = false;
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(4800)); }, cancel() { cancelled = true; } });
    const abort = new AbortController();
    const pending = playPcmStream(body, audio, audio.destination, abort.signal, () => { started = true; }).then(() => 'finished', () => 'aborted');
    await new Promise(resolve => setTimeout(resolve, 50)); abort.abort();
    const outcome = await pending; await audio.close();
    return { started, cancelled, outcome };
  });
  expect(result).toEqual({ started: false, cancelled: true, outcome: 'aborted' });
});

test('live transcription begins before turn completion and previews recognized words', async ({ page }) => {
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true } }));
  await page.route('**/test-speech.wav', route => route.fulfill({ body: sample, contentType: 'audio/wav' }));
  const purposes: (string | null)[] = [];
  await page.route('**/voice/transcribe*', route => { purposes.push(new URL(route.request().url()).searchParams.get('purpose')); return route.fulfill({ json: { text: 'Recognized while you speak.' } }); });
  await page.route('**/voice/speech', route => route.fulfill(speech));
  await page.goto('/tests/voice.html');
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('status')).toHaveText('Listening', { timeout: 25000 });
  const request = page.waitForRequest('**/voice/transcribe*');
  await page.getByRole('button', { name: 'Inject speech' }).click();
  await request;
  await expect(page.getByTestId('sent')).toHaveText('0');
  await expect(page.getByLabel('Live transcription')).toHaveText('Recognized while you speak.');
  await expect(page.getByTestId('sent')).toHaveText('1', { timeout: 12000 });
  // Voice mode asks for the speech model, not the dictation one: no purpose goes with its requests.
  expect(purposes.length).toBeGreaterThan(0);
  expect(purposes.every(purpose => purpose === null)).toBe(true);
  await page.getByRole('button', { name: 'End voice mode' }).click();
});


// An extension's window in the middle as well, beside the console's at the side: the portal's tests' stand-in for one.
test.describe('with a window in the middle', () => {
  test.use({ installed: ['tests/fixtures/extensions/console', 'tests/fixtures/extensions/viewer'] });

  test('voice panels animate into a middle window, a side window and both at once', async ({ page }) => {
    await page.addInitScript(() => {
      // Streams, which have no server behind them here.
      (window as any).EventSource=class { onmessage:any; onopen:any; close(){} };
    });
    const failures: string[] = []; page.on('pageerror', e => failures.push(e.message));
    await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true } }));
    await page.goto('/tests/voice.html');
    await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
    await expect(page.getByRole('status')).toHaveText('Listening', { timeout: 25000 });
    await page.getByRole('button', { name: 'Voice settings' }).click();
    await page.getByRole('group', { name: 'Sound effects' }).getByRole('button', { name: 'Off' }).click();
    expect(await page.evaluate(() => localStorage.getItem('voiceSounds'))).toBe('off');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Show Viewer', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Viewer', exact: true })).toBeVisible();
    await expect(page.locator('.voice-stage')).toHaveClass(/is-browsing/);
    await settled(page);
    await page.getByRole('button', { name: 'Use terminal', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Console', exact: true })).toBeVisible();
    await expect(page.getByLabel('Console output')).toContainText('42 modules transformed');
    await expect(page.getByLabel('Tool activity')).toContainText('Running a command');
    await settled(page);
    const middle = await page.locator('.voice-extension-window[data-extension="test-viewer"]').boundingBox();
    const consoleWindow = await page.locator('.voice-extension-window[data-extension="test-console"]').boundingBox();
    expect(middle!.width).toBeGreaterThan(consoleWindow!.width * 1.8);
    expect(middle!.x + middle!.width).toBeLessThan(consoleWindow!.x);

    await page.getByRole('button', { name: 'Minimize Viewer' }).click();
    await settled(page);
    const orb = await page.locator('.voice-presence').boundingBox();
    const right = await page.locator('.voice-extension-window[data-extension="test-console"]').boundingBox();
    const stage = await page.locator(".voice-stage").boundingBox();
    expect(orb!.x + orb!.width).toBeLessThan(right!.x);
    expect(orb!.height).toBeGreaterThan(150);
    await page.getByRole('button', { name: 'Finish terminal', exact: true }).click();
    await expect(page.getByLabel('Console output')).toContainText('Build completed successfully');
    await page.getByRole('button', { name: 'Show Viewer', exact: true }).click();
    await page.getByRole('button', { name: 'Stream thinking', exact: true }).click();
    await expect(page.getByLabel('Live model thinking')).toContainText('verify the page layout');
    await expect(page.locator('.voice-presence')).toHaveCSS('height', '80px');
    await page.setViewportSize({ width: 390, height: 844 });
    await settled(page);
    const mobileMiddle = await page.locator('.voice-extension-window[data-extension="test-viewer"]').boundingBox();
    const mobileConsole = await page.locator('.voice-extension-window[data-extension="test-console"]').boundingBox();
    expect(mobileMiddle!.y + mobileMiddle!.height).toBeLessThan(mobileConsole!.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    await page.getByRole('button', { name: 'End voice mode' }).click();
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
    expect(failures).toEqual([]);
  });
});

test('voice mode takes its lease before listening and gives it back on End, whatever it listens and speaks through',async({page})=>{
 const leases:boolean[]=[];
 await page.route('**/api/voice',r=>r.fulfill({json:{enabled:true}}));
 await page.route('**/api/sessions/test/voice/connection',r=>{leases.push(r.request().postDataJSON().active);return r.fulfill({json:{ok:true}});});
 await page.goto('/tests/voice.html');
 await page.getByRole('button',{name:'Turn on hands-free voice'}).click();
 await expect(page.getByRole('status')).toHaveText('Listening',{timeout:25000});
 expect(leases).toEqual([true]);
 await page.getByRole('button',{name:'End voice mode'}).click();
 await expect.poll(()=>leases).toEqual([true,false]);
});

test('ending while the lease is being taken (a model loading) gives it back once it is taken, and never starts listening',async({page})=>{
 let finishLoad!:()=>Promise<void>; const leases:boolean[]=[];
 await page.route('**/api/voice',r=>r.fulfill({json:{enabled:true}}));
 await page.route('**/api/sessions/test/voice/connection',async r=>{
  const active=r.request().postDataJSON().active;leases.push(active);
  if(active){finishLoad=()=>r.fulfill({json:{ok:true}});return;}
  await r.fulfill({json:{ok:true}});
 });
 await page.goto('/tests/voice.html');await page.getByRole('button',{name:'Turn on hands-free voice'}).click();
 await expect.poll(()=>leases).toEqual([true]);
 await page.getByRole('button',{name:'End voice mode'}).click();
 await expect(page.getByRole('button',{name:'Turn on hands-free voice'})).toBeVisible();
 // The lease's updates go in the order they were made: the release waits for the lease to be answered, and so reaches the server after it.
 expect(leases).toEqual([true]);
 await finishLoad();
 await expect.poll(()=>leases).toEqual([true,false]);
 await expect(page.getByLabel('Voice conversation')).toHaveCount(0);
});

test('a lease voice mode is refused, as by an extension it listens through that is not running, is said, and nothing listens',async({page})=>{
 const notRunning='Voice mode listens and speaks through test-speaker, which is not running: install or start it in Settings → Extensions, or stop using it in Settings → Defaults → Voice mode';
 await page.route('**/api/voice',r=>r.fulfill({json:{enabled:true,provider:'test-speaker',ready:false,speech:true,voices:[]}}));
 await page.route('**/api/sessions/test/voice/connection',r=>r.fulfill({status:503,json:{error:notRunning}}));
 await page.goto('/tests/voice.html');
 await page.getByRole('button',{name:'Turn on hands-free voice'}).click();
 await expect(page.getByRole('alert')).toContainText(notRunning);
 await page.getByRole('button',{name:'Check mic tracks'}).click();
 await expect(page.getByTestId('tracks')).toHaveText('ended:true');
 await expect(page.getByRole('button',{name:'Turn on hands-free voice'})).toBeVisible();
});


test('prompt and compaction progress remain visible in chat and voice',async({page})=>{
 await page.route('**/api/voice',r=>r.fulfill({json:{enabled:true}}));
 await page.route('**/voice/speech',r=>r.fulfill(speech));
 await page.goto('/tests/voice.html');
 await page.getByRole('button',{name:'Show prefill',exact:true}).click();
 // In the chat it is the status pill, there at once like the other phases rather than after two seconds.
 await expect(page.getByRole('progressbar',{name:'Prompt processing'})).toHaveAttribute('aria-valuenow','40');
 await expect(page.getByRole('progressbar',{name:'Prompt processing'})).toHaveAttribute('aria-valuetext','40% — 16,000 / 40,000 tokens · 8,000 from cache');
 await page.getByRole('button',{name:'Turn on hands-free voice'}).click();
 await expect(page.locator('.voice-stage').getByRole('progressbar',{name:'Prompt processing'})).toBeVisible({timeout:25000});
 await page.getByRole('button',{name:'Start compaction',exact:true}).click();
 const bar=page.locator('.voice-stage').getByRole('progressbar',{name:'Conversation compaction'});
 await expect(bar).toBeVisible();await expect(bar).not.toHaveAttribute('aria-valuenow');
 await page.getByRole('button',{name:'End compaction',exact:true}).click();
 await expect(bar).toHaveCount(0);
 await page.getByRole('button',{name:'End voice mode'}).click();
});

test('composer offers send beside stop for a follow-up, and an extension\'s panel has its button in the header',async({page})=>{
 await page.goto('/tests/voice.html');
 const input=page.locator('textarea').first();
 await expect(page.getByRole('button',{name:'Send message',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'Stream reply',exact:true}).click();
 await expect(page.getByRole('button',{name:'Stop generation',exact:true})).toBeVisible();
 await input.fill('Change direction');
 // Stop stays while a follow-up is written: steering and stopping are both still open.
 await expect(page.getByRole('button',{name:'Stop generation',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Send message',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'Send message',exact:true}).click();
 await expect(page.getByTestId('sent')).toHaveText('1');
 await expect(page.getByRole('button',{name:'Stop generation',exact:true})).toBeVisible();
 await input.fill('   ');
 await page.getByRole('button',{name:'Stop generation',exact:true}).click();
 await expect(page.getByTestId('aborted')).toHaveText('1');
 await expect(page.locator('.session-workspace > header').getByRole('button',{name:'Console',exact:true})).toBeVisible();
});

test('without speech synthesis voice mode is not offered, because it speaks its replies, and dictation, which only listens, is', async ({ page }) => {
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true, speech: false } }));
  await page.goto('/tests/voice.html');
  await expect(page.getByRole('button', { name: 'Dictate a message' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn on hands-free voice' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
  // With speech both are there.
  await page.unroute('**/api/voice');
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true, speech: true } }));
  await page.reload();
  await expect(page.getByRole('button', { name: 'Dictate a message' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn on hands-free voice' })).toBeVisible();
});

test('voice conversations switched off end voice mode that is on, and leave dictation: voice mode is not offered, and its shortcut starts nothing', async ({ page }) => {
  let conversation = true;
  const leases: boolean[] = [];
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true, speech: true, conversation } }));
  await page.route('**/voice/connection', route => { leases.push(route.request().postDataJSON().active); return route.fulfill({ json: { ok: true } }); });
  // As Settings → Defaults → Voice mode tells the page once it has saved.
  const switched = async (on: boolean) => { conversation = on; await page.evaluate(() => window.dispatchEvent(new Event('voice-config-changed'))); };
  await page.goto('/tests/voice.html');
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('button', { name: 'End voice mode' })).toBeVisible({ timeout: 25000 });
  await switched(false);
  await expect(page.getByRole('button', { name: 'End voice mode' })).toHaveCount(0);
  await expect.poll(() => leases).toEqual([true, false]);
  await expect(page.getByRole('button', { name: 'Dictate a message' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn on hands-free voice' })).toHaveCount(0);
  // Alt+V starts nothing, from the page or from the message box.
  await page.keyboard.press('Alt+v');
  await page.getByRole('textbox', { name: 'Message' }).focus();
  await page.keyboard.press('Alt+v');
  expect(await page.evaluate(() => sessionStorage.getItem('voiceActive'))).toBeNull();
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
  expect(leases).toEqual([true, false]);
  // Dictation listens as before.
  await page.getByRole('button', { name: 'Dictate a message' }).click();
  await expect(page.getByRole('button', { name: 'Stop dictating' })).toBeVisible({ timeout: 25000 });
  await page.getByRole('button', { name: 'Stop dictating' }).click();
  // Switched on again: voice mode is offered once more.
  await switched(true);
  await expect(page.getByRole('button', { name: 'Turn on hands-free voice' })).toBeVisible();
});

test('voice mode that a reload would bring back while voice conversations are off does not start when they are switched on again', async ({ page }) => {
  let conversation = false;
  const leases: boolean[] = [];
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true, speech: true, conversation } }));
  await page.route('**/voice/connection', route => { leases.push(route.request().postDataJSON().active); return route.fulfill({ json: { ok: true } }); });
  // Voice mode was on in this tab, and was switched off in another before this one was reloaded.
  await page.addInitScript(() => sessionStorage.setItem('voiceActive', 'test'));
  await page.goto('/tests/voice.html');
  await expect(page.getByRole('button', { name: 'Dictate a message' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('voiceActive'))).toBeNull();
  // Switched on again, and Settings closed in this tab, which tells the page.
  conversation = true;
  await page.evaluate(() => window.dispatchEvent(new Event('voice-config-changed')));
  await expect(page.getByRole('button', { name: 'Turn on hands-free voice' })).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page.getByRole('button', { name: 'End voice mode' })).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('voiceActive'))).toBeNull();
  expect(leases).toEqual([]);
});

test('dictation in send mode sends what was said to the chat it was started in', async ({ page }) => {
  const asked: string[] = [], purposes: (string | null)[] = [];
  await page.addInitScript(() => localStorage.setItem('dictationMode', 'send'));
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true } }));
  await page.route('**/test-speech.wav', route => route.fulfill({ body: sample, contentType: 'audio/wav' }));
  await page.route('**/voice/transcribe*', route => { const url = new URL(route.request().url()); asked.push(url.pathname); purposes.push(url.searchParams.get('purpose')); return route.fulfill({ json: { text: 'A dictated sentence.' } }); });
  await page.goto('/tests/voice.html');
  await page.getByRole('button', { name: 'Dictate a message' }).click();
  await expect(page.getByRole('button', { name: 'Stop dictating' })).toBeVisible({ timeout: 25000 });
  await page.getByRole('button', { name: 'Inject speech' }).click();
  await expect(page.getByTestId('sent')).toHaveText('1', { timeout: 15000 });
  await expect(page.getByTestId('last-send')).toContainText('A dictated sentence.');
  expect(asked.at(-1)).toBe('/api/sessions/test/voice/transcribe');
  // Dictation asks for the dictation model; voice mode does not (see the hands-free test).
  expect(purposes.at(-1)).toBe('dictation');
});

test('a sentence being dictated when another chat is opened is not sent to that chat', async ({ page }) => {
  const asked: string[] = [], purposes: (string | null)[] = [];
  await page.addInitScript(() => localStorage.setItem('dictationMode', 'send'));
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true } }));
  await page.route('**/test-speech.wav', route => route.fulfill({ body: sample, contentType: 'audio/wav' }));
  // The answer to what was said is held until the chat has been switched. Answered at once, it is the sentence of the chat it was
  // started in, sent there when the switch comes late (a slow machine takes longer to click than a sentence takes to end), and
  // that is what the portal does and the test would take for the fault.
  let switched!: () => void;
  const afterSwitch = new Promise<void>(resolve => { switched = resolve; });
  await page.route('**/voice/transcribe*', async route => {
    const url = new URL(route.request().url());
    asked.push(url.pathname);
    purposes.push(url.searchParams.get('purpose'));
    await afterSwitch;
    // The page has dropped the request by then, as it should: there is nobody to answer.
    await route.fulfill({ json: { text: 'A dictated sentence.' } }).catch(() => {});
  });
  // The chat switched to answers as the one the page starts in does.
  await page.route('**/api/sessions/other/commands', route => route.fulfill({ json: { commands: [] } }));
  await page.route('**/api/sessions/other/config', route => route.fulfill({ status: 503, json: {} }));
  await page.goto('/tests/voice.html');
  await page.getByRole('button', { name: 'Dictate a message' }).click();
  await expect(page.getByRole('button', { name: 'Stop dictating' })).toBeVisible({ timeout: 25000 });
  // The chat is switched in the middle of the sentence: heard, not yet ended by a pause, and already being transcribed for the chat
  // it was started in, which is what the switch has to keep from the other one. The speech is long enough that the sentence is
  // still going when a slow machine gets to the click. It is played in real time, and a machine too busy to keep up with it misses
  // it, so it is played again when neither has happened after a while.
  await page.evaluate(() => { (window as any).speechSeconds = 8; });
  let injected = 0;
  await expect.poll(async () => {
    if (Date.now() - injected > 8000) {
      injected = Date.now();
      await page.getByRole('button', { name: 'Inject speech' }).click();
    }
    return asked.length > 0 && await page.getByText('Hearing you').isVisible();
  }, { timeout: 30000, intervals: [100] }).toBe(true);
  await page.getByRole('button', { name: 'Switch chat' }).click();
  switched();
  // The sentence is not to be sent to the chat it was not started in, which only waiting for as long as a send takes shows.
  await page.waitForTimeout(2500);
  await expect(page.getByTestId('sent')).toHaveText('0');
  expect(asked.filter(path => path.includes('/other/'))).toEqual([]);
});

test('a refused microphone says how to allow it, in dictation and in voice mode, not the browser\'s "Permission denied"', async ({ page }) => {
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true } }));
  await page.goto('/tests/voice.html');
  await page.evaluate(() => { (window as any).micFails = 'NotAllowedError'; });
  await page.getByRole('button', { name: 'Dictate a message' }).click();
  await expect(page.getByRole('alert')).toContainText('The microphone is blocked for this site');
  await expect(page.getByRole('alert')).not.toContainText('Permission denied');
  await page.reload();
  await page.evaluate(() => { (window as any).micFails = 'NotFoundError'; });
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('alert')).toContainText('No microphone was found');
});

test('the orb is never painted empty while it glides beside a window and into its dock', async ({ page }) => {
  await page.route('**/api/voice', route => route.fulfill({ json: { enabled: true } }));
  await page.goto('/tests/voice.html');
  await page.getByRole('button', { name: 'Turn on hands-free voice' }).click();
  await expect(page.getByRole('button', { name: 'End voice mode' })).toBeVisible({ timeout: 25000 });
  // What a canvas holds is what is painted when it is read in a resize observer made after the orb's own: those are
  // told in the order they were made, after the frame's animation callbacks and before it is painted. The orb sizes
  // its canvas as its box changes, and a canvas that is sized is cleared.
  await page.waitForFunction(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.voice-orb')!;
    return canvas.width > 0 && canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data.some((v, i) => i % 4 === 3 && v);
  });
  await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.voice-orb')!;
    const seen = ((window as any).orbSteps = { steps: 0, empty: 0, same: true });
    new ResizeObserver(() => {
      seen.steps++;
      seen.same &&= canvas === document.querySelector('.voice-orb');
      if (!canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data.some((v, i) => i % 4 === 3 && v)) seen.empty++;
    }).observe(canvas);
  });
  // The first window: the orb moves from the middle to its side. The second: into its dock.
  await page.getByRole('button', { name: 'Show the conversation' }).click();
  await expect(page.locator('.voice-stage')).toHaveAttribute('data-orb', 'beside');
  await settled(page);
  const first = await page.evaluate(() => ({ ...(window as any).orbSteps }));
  expect(first.steps).toBeGreaterThan(5);
  await page.getByRole('button', { name: 'Show console' }).click();
  await expect(page.locator('.voice-stage')).toHaveAttribute('data-orb', 'dock');
  await settled(page);
  const second = await page.evaluate(() => ({ ...(window as any).orbSteps }));
  expect(second.steps).toBeGreaterThan(first.steps);
  expect(second.same).toBe(true);
  expect(second.empty).toBe(0);
});
