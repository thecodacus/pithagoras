import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import {
  CPU_PORT, ASR_MODELS, speechCpuSeconds, speechSlow, ttsDevices, DEFAULT_CHOICE, LEAN_CHOICE, TTS_ENGINES, asrDevice, asrDevices, choiceFromKey, choiceKey, choiceLabel, cpuRealtime, cpuServerConfig, cpuSlow, cpuThreads, endpoints, fitOn, fitRam, healthUrls, parseChoice, pickGpu,
  ramNeeded, sameChoice, serverConfig, suggestChoice, suggestCpuChoice, ttsModel, usesGpu, vramNeeded,
  type Gpu, type Host, type VoiceChoice,
} from '../src/engines.ts';
import { DRIVER_TOO_OLD_MESSAGE, NO_GPU_FOR_SPEECH, NO_GPU_FOR_SPEECH_UNUSABLE, NO_GPU_MESSAGE, NoGpu, decide, detectGpus, explain, isNoGpu, parseGpus, readHost, type Probe } from '../src/server/gpu.ts';

// Neutral cards: only the sizes matter.
const card = (totalMiB: number | null, freeMiB: number | null = totalMiB, index = 0): Gpu => ({ index, name: `Test GPU ${index}`, totalMiB, freeMiB });
const combos: VoiceChoice[] = (Object.keys(TTS_ENGINES) as VoiceChoice['tts'][]).flatMap(tts => ASR_MODELS.map(o => ({ tts, asr: o.asr, asrModel: o.model })));

test('nvidia-smi output is read as one GPU per line, and what does not fit the shape is skipped', () => {
  assert.deepEqual(parseGpus('0, Test GPU A, 12288, 11000\n1, Test GPU B, 8192, 8000\n'), [
    { index: 0, name: 'Test GPU A', totalMiB: 12288, freeMiB: 11000 },
    { index: 1, name: 'Test GPU B', totalMiB: 8192, freeMiB: 8000 },
  ]);
  // A terminal's line ends, a name with a comma in it, a card that reports no memory.
  assert.deepEqual(parseGpus('0, Test GPU, Rev 2, 4096, 100\r\n1, Shared GPU, [N/A], [N/A]\r\n'), [
    { index: 0, name: 'Test GPU, Rev 2', totalMiB: 4096, freeMiB: 100 },
    { index: 1, name: 'Shared GPU', totalMiB: null, freeMiB: null },
  ]);
  assert.deepEqual(parseGpus('NVIDIA-SMI has failed because it could not communicate with the driver\nNo devices were found'), []);
  assert.deepEqual(parseGpus(''), []);
});

test('the first probe that finds a GPU wins, and no GPU and no tool are answers, not failures', async () => {
  const fails: Probe = { name: 'host', run: async () => { throw new Error('nvidia-smi was not found'); } };
  const empty: Probe = { name: 'empty', run: async () => '\n' };
  const works: Probe = { name: 'docker', run: async () => '0, Test GPU A, 12288, 11000\n' };
  const found = await detectGpus([fails, works]);
  assert.deepEqual([found.source, found.checked, found.gpus[0].totalMiB], ['docker', true, 12288]);
  // A probe that ran and listed nothing found that there is none.
  const none = await detectGpus([fails, empty]);
  assert.deepEqual([none.gpus, none.source, none.checked], [[], 'none', true]);
  assert.match(none.error, /host: nvidia-smi was not found; empty: no GPU listed/);
  // Not being able to ask is not an answer: the tool is missing, or the image the probe needs is not there yet.
  const unknown = await detectGpus([fails, { name: 'docker', run: async () => { throw new Error('the CUDA image is not downloaded yet'); } }]);
  assert.deepEqual([unknown.gpus, unknown.checked], [[], false]);
  assert.deepEqual(await detectGpus([]), { gpus: [], source: 'none', error: '', checked: false });
});

test('Docker and the driver saying there is no GPU is "no GPU", in whatever words they use', async () => {
  const says = (message: string): Probe => ({ name: 'docker', run: async () => { throw new Error(message); } });
  for (const message of [
    'could not select device driver "nvidia" with capabilities: [[gpu]]',
    'failed to create task for container: OCI runtime create failed: nvidia-container-cli: initialization error: nvml error: driver not loaded',
    "Command failed: nvidia-smi --query-gpu=index\nNVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver. Make sure that the latest NVIDIA driver is installed and running.",
    'No devices were found',
    'unknown or invalid runtime name: nvidia',
  ]) {
    assert.equal(isNoGpu(message), true, message);
    const found = await detectGpus([says(message)]);
    assert.deepEqual([found.gpus, found.checked, found.error], [[], true, 'docker: no GPU available'], message);
    // The person reads one sentence about what is missing and what to do, not the daemon's words.
    assert.equal(explain(message), NO_GPU_MESSAGE);
  }
  assert.match(NO_GPU_MESSAGE, /NVIDIA Container Toolkit.*restart Docker/);
  // The card may be there: the sentence is about what Docker can hand out, not about what was found.
  assert.doesNotMatch(NO_GPU_MESSAGE, /none was found/);
  // The toolkit's other refusals are not "no GPU": a driver too old for the image is told as that, the rest as it was worded.
  const tooOld = 'error running hook #0: nvidia-container-cli: requirement error: unsatisfied condition: cuda>=12.4, please update your driver to a newer version, or use an earlier cuda container: unknown';
  assert.equal(isNoGpu(tooOld), false);
  assert.equal(explain(tooOld), DRIVER_TOO_OLD_MESSAGE);
  assert.deepEqual([(await detectGpus([says(tooOld)])).checked, (await detectGpus([says(tooOld)])).error.startsWith('docker: ')], [false, true]);
  for (const message of ['nvidia-container-cli: mount error: failed to add device rules', 'nvidia-container-cli: ldcache error: process /sbin/ldconfig failed', 'nvidia-container-cli: device error: unknown device id: 7']) {
    assert.equal(isNoGpu(message), false, message);
    assert.equal(explain(message), message);
  }
  assert.equal(isNoGpu('nvidia-container-cli: initialization error: load library failed: libnvidia-ml.so.1: cannot open shared object file'), true);
  // A probe can say it outright, as when Docker does not answer.
  assert.equal((await detectGpus([{ name: 'docker', run: async () => { throw new NoGpu('Docker did not answer'); } }])).checked, true);
  // Anything else is left as it is, and is not an answer.
  for (const message of ['no space left on device', 'port is already allocated']) {
    assert.equal(isNoGpu(message), false);
    assert.equal(explain(message), message);
    assert.deepEqual([(await detectGpus([says(message)])).checked, (await detectGpus([says(message)])).error], [false, `docker: ${message}`]);
  }
});

test('a choice fits when the GPU has room now, is tight when only the card is big enough, and is too large otherwise', () => {
  const need = vramNeeded(DEFAULT_CHOICE);
  assert.equal(need, TTS_ENGINES.breeze.vramMiB, 'Whisper runs on the CPU and takes no GPU memory');
  assert.equal(fitOn(DEFAULT_CHOICE, card(need)), 'fits');
  assert.equal(fitOn(DEFAULT_CHOICE, card(need * 2, need - 1)), 'tight');
  assert.equal(fitOn(DEFAULT_CHOICE, card(need - 1)), 'too-large');
  // Memory kept free for something else counts against the card.
  assert.equal(fitOn(DEFAULT_CHOICE, card(need + 999), 1000), 'too-large');
  assert.equal(fitOn(DEFAULT_CHOICE, card(need + 1000), 1000), 'fits');
  assert.equal(fitOn(DEFAULT_CHOICE, undefined), 'unknown');
  assert.equal(fitOn(DEFAULT_CHOICE, card(null)), 'unknown');
  assert.ok(vramNeeded({ tts: 'chatterbox', asr: 'qwen3-asr', asrModel: '1.7b' }) > vramNeeded({ tts: 'chatterbox', asr: 'qwen3-asr', asrModel: '0.6b' }));
});

test('the suggestion is the best combination that fits, and the original one when nothing can be said', () => {
  const at = (mib: number, reserve = 0) => suggestChoice(card(mib), reserve);
  assert.deepEqual(at(24576), { tts: 'breeze', asr: 'qwen3-asr', asrModel: '1.7b' });
  assert.deepEqual(at(vramNeeded({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '0.6b' })), { tts: 'breeze', asr: 'qwen3-asr', asrModel: '0.6b' });
  // Whisper small is offered but never suggested: it only costs speed.
  assert.deepEqual(at(TTS_ENGINES.breeze.vramMiB), DEFAULT_CHOICE);
  // Breeze does not fit, Chatterbox does.
  assert.deepEqual(at(TTS_ENGINES.chatterbox.vramMiB), { tts: 'chatterbox', asr: 'whisper', asrModel: 'base' });
  // Neither does, Kokoro does.
  assert.deepEqual(at(TTS_ENGINES.kokoro.vramMiB), { tts: 'kokoro', asr: 'whisper', asrModel: 'base' });
  // Room is kept for a model that comes later.
  assert.deepEqual(at(24576, 24576 - vramNeeded(DEFAULT_CHOICE)), DEFAULT_CHOICE);
  // Free memory is busy now but the card holds the original combination: do not change it for that.
  assert.deepEqual(suggestChoice(card(12288, 1000)), DEFAULT_CHOICE);
  // Not even the leanest fits: nothing better to name.
  assert.deepEqual(at(512), DEFAULT_CHOICE);
  assert.deepEqual(suggestChoice(undefined), DEFAULT_CHOICE);
  assert.deepEqual(suggestChoice(card(null)), DEFAULT_CHOICE);
});

test('the leanest choice is the one that needs the least GPU memory of all that are offered', () => {
  assert.equal(vramNeeded(LEAN_CHOICE), Math.min(...combos.map(vramNeeded)));
  // The suggestion falls back to it when the card is too small for the original combination but holds this one.
  assert.deepEqual(suggestChoice(card(vramNeeded(LEAN_CHOICE), 10)), LEAN_CHOICE);
});

test('the GPU is the one asked for, else the one with the most memory free', () => {
  const gpus = [card(8192, 1000, 0), card(12288, 11000, 1), card(24576, 2000, 2)];
  assert.equal(pickGpu(gpus)?.index, 1);
  assert.equal(pickGpu(gpus, 2)?.index, 2);
  assert.equal(pickGpu(gpus, 7)?.index, 1, 'a card that is not there is not an error');
  assert.equal(pickGpu([]), undefined);
});

test('a choice is checked and keyed so a container label names it exactly', () => {
  for (const c of combos) {
    assert.deepEqual(parseChoice(c), c);
    assert.deepEqual(choiceFromKey(choiceKey(c)), c);
  }
  assert.equal(combos.length, 12);
  assert.equal(choiceKey(DEFAULT_CHOICE), 'breeze+whisper:base');
  // A container from before engines could be chosen has no label.
  assert.deepEqual(choiceFromKey(undefined), DEFAULT_CHOICE);
  assert.deepEqual(choiceFromKey('nonsense'), DEFAULT_CHOICE);
  assert.deepEqual(choiceFromKey('breeze+whisper:gigantic'), DEFAULT_CHOICE);
  assert.throws(() => parseChoice({ tts: 'piper', asr: 'whisper', asrModel: 'base' }), /speech synthesis engine/);
  assert.throws(() => parseChoice({ tts: 'breeze', asr: 'whisper', asrModel: '1.7b' }), /speech recognition model/);
  assert.throws(() => parseChoice({ tts: 'breeze', asr: 'qwen3-asr' }), /speech recognition model/);
  assert.throws(() => parseChoice({ tts: 'toString', asr: 'whisper', asrModel: 'base' }), /speech synthesis engine/);
  assert.throws(() => parseChoice(null), /Choose/);
});

test('the original combination makes the server config the setup script has always written', () => {
  const script = readFileSync(new URL('../setup.sh', import.meta.url), 'utf8');
  const legacy = /<<'JSON'\n(.*)\nJSON\n/.exec(script)![1];
  assert.equal(JSON.stringify(serverConfig(DEFAULT_CHOICE)), legacy);
  assert.deepEqual(endpoints(DEFAULT_CHOICE), { listen: { url: 'http://127.0.0.1:8188/inference' }, speak: { url: 'http://127.0.0.1:7862/v1/audio/speech', engine: 'breeze' } });
  assert.deepEqual(healthUrls(DEFAULT_CHOICE), ['http://127.0.0.1:8188/health', 'http://127.0.0.1:7862/health']);
});

test('Chatterbox and Qwen3-ASR run in the one audio.cpp process, loaded together, and Whisper then has no process', () => {
  const config = serverConfig({ tts: 'chatterbox', asr: 'qwen3-asr', asrModel: '0.6b' })!;
  assert.equal(config.max_loaded_models, 2);
  assert.deepEqual(config.models.map(m => m.id), ['chatterbox', 'qwen3-asr']);
  assert.deepEqual(config.models.map(m => m.path), ['/voice/models/chatterbox-q8_0.gguf', '/voice/models/qwen3-asr-0.6b-q8_0.gguf']);
  // audio.cpp's own name for voice cloning.
  assert.equal(config.models[0].task, 'clon');
  assert.equal(serverConfig({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '1.7b' })!.models[1].path, '/voice/models/qwen3-asr-1.7b-q8_0.gguf');
  // A choice with Whisper has one audio.cpp model, so one is loaded at a time, as before.
  assert.equal(serverConfig({ tts: 'chatterbox', asr: 'whisper', asrModel: 'small' })!.max_loaded_models, 1);
  assert.deepEqual(endpoints({ tts: 'chatterbox', asr: 'qwen3-asr', asrModel: '1.7b' }), { listen: { url: 'http://127.0.0.1:7862/v1/audio/transcriptions', model: 'qwen3-asr' }, speak: { url: 'http://127.0.0.1:7862/v1/audio/speech', engine: 'chatterbox' } });
  assert.deepEqual(healthUrls({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '0.6b' }), ['http://127.0.0.1:7862/health']);
  // The load request and the server config describe a model the same way.
  assert.deepEqual(ttsModel('chatterbox'), config.models[0]);
});

test('Kokoro is a speech model of its own, spoken to at its own runtime, and the leanest one there is', () => {
  const config = serverConfig({ tts: 'kokoro', asr: 'qwen3-asr', asrModel: '0.6b' })!;
  assert.deepEqual(config.models[0], { id: 'kokoro', family: 'kokoro_tts', path: '/voice/models/kokoro-82m-q8_0.gguf', task: 'tts', mode: 'offline' });
  assert.deepEqual(ttsModel('kokoro'), config.models[0]);
  assert.deepEqual(endpoints({ tts: 'kokoro', asr: 'whisper', asrModel: 'base' }), { listen: { url: 'http://127.0.0.1:8188/inference' }, speak: { url: 'http://127.0.0.1:7862/v1/audio/speech', engine: 'kokoro' } });
  assert.equal(choiceKey({ tts: 'kokoro', asr: 'whisper', asrModel: 'base' }), 'kokoro+whisper:base');
  assert.deepEqual(LEAN_CHOICE, { tts: 'kokoro', asr: 'whisper', asrModel: 'base' });
});

test('Kokoro can be put on the CPU: it then shares the CPU process with recognition, and the GPU is not asked for', () => {
  const cpu: VoiceChoice = { tts: 'kokoro', ttsDevice: 'cpu', asr: 'qwen3-asr', asrModel: '0.6b' };
  assert.deepEqual(parseChoice(cpu), cpu);
  assert.equal(choiceKey(cpu), 'kokoro@cpu+qwen3-asr:0.6b');
  assert.deepEqual(choiceFromKey('kokoro@cpu+qwen3-asr:0.6b'), cpu);
  assert.deepEqual(choiceFromKey('kokoro+whisper:base'), { tts: 'kokoro', asr: 'whisper', asrModel: 'base' }, 'on the GPU, as before');
  // Nothing is on the GPU: recognition beside it is on the CPU too, and cannot be put on the GPU.
  assert.equal(usesGpu(cpu), false);
  assert.equal(asrDevice(cpu), 'cpu');
  assert.deepEqual(asrDevices(cpu), ['cpu']);
  assert.throws(() => parseChoice({ ...cpu, asrDevice: 'gpu' }), /without speech synthesis on the GPU runs on the CPU/);
  assert.equal(serverConfig(cpu), undefined);
  const config = cpuServerConfig(cpu, 8)!;
  assert.deepEqual([config.port, config.backend, config.threads, config.max_loaded_models], [CPU_PORT, 'cpu', 8, 2]);
  // The portal loads and unloads speech as voice sessions come and go: audio.cpp refuses that (403) without model management.
  assert.equal(config.ui_management, true);
  assert.equal('ui_management' in cpuServerConfig({ tts: 'none', asr: 'qwen3-asr', asrModel: '0.6b' })!, false, 'recognition alone is never loaded by the portal');
  assert.deepEqual(config.models.map(m => m.id), ['kokoro', 'qwen3-asr']);
  assert.deepEqual(cpuServerConfig({ tts: 'kokoro', ttsDevice: 'cpu', asr: 'whisper', asrModel: 'base' })!.models.map(m => m.id), ['kokoro']);
  assert.deepEqual(endpoints(cpu), { listen: { url: 'http://127.0.0.1:7863/v1/audio/transcriptions', model: 'qwen3-asr' }, speak: { url: 'http://127.0.0.1:7863/v1/audio/speech', engine: 'kokoro' } });
  assert.deepEqual(healthUrls({ tts: 'kokoro', ttsDevice: 'cpu', asr: 'whisper', asrModel: 'base' }), ['http://127.0.0.1:8188/health', 'http://127.0.0.1:7863/health']);
  // Its memory is the host's, not the card's.
  assert.deepEqual([vramNeeded(cpu), ramNeeded(cpu)], [0, TTS_ENGINES.kokoro.ramMiB! + 1600]);
  assert.equal(choiceLabel(cpu), 'Kokoro speech on the CPU with Qwen3-ASR 0.6B');
  // Only Kokoro runs there; a device written for the GPU says nothing.
  assert.deepEqual(ttsDevices('kokoro'), ['cpu', 'gpu']);
  assert.deepEqual(ttsDevices('breeze'), ['gpu']);
  assert.throws(() => parseChoice({ tts: 'breeze', ttsDevice: 'cpu', asr: 'whisper', asrModel: 'base' }), /Breeze runs on the GPU/);
  assert.throws(() => parseChoice({ tts: 'kokoro', ttsDevice: 'tpu', asr: 'whisper', asrModel: 'base' }), /CPU or the GPU for speech synthesis/);
  assert.deepEqual(parseChoice({ tts: 'kokoro', ttsDevice: 'gpu', asr: 'whisper', asrModel: 'base' }), { tts: 'kokoro', asr: 'whisper', asrModel: 'base' });
  // Its speed, scaled by the threads.
  assert.equal(speechCpuSeconds(cpu, 8), TTS_ENGINES.kokoro.cpuSecondsPerSecond);
  assert.equal(speechCpuSeconds({ tts: 'kokoro', asr: 'whisper', asrModel: 'base' }, 8), undefined, 'not on the CPU');
  assert.equal(speechSlow(cpu, 1), true);
  assert.equal(speechSlow(cpu, 4), false);
});

test('what the install decides tells the person what fits and what does not', () => {
  const twelve = [card(12288, 11000)];
  const auto = decide(undefined, twelve);
  assert.deepEqual(auto.choice, { tts: 'breeze', asr: 'qwen3-asr', asrModel: '1.7b' });
  assert.match(auto.summary, /Detected Test GPU 0 \(12\.0 GiB, 10\.7 GiB free\): Breeze speech with Qwen3-ASR 1\.7B needs about 7\.0 GiB, which fits/);
  const busy = decide({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '1.7b' }, [card(12288, 4000)]);
  assert.match(busy.summary, /big enough, but other programs use part of it now/);
  // Too large for the card: refused, with the combination that would fit.
  assert.throws(() => decide({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '1.7b' }, [card(6144)]),
    /Breeze speech with Qwen3-ASR 1\.7B needs about 7\.0 GiB of GPU memory, but Test GPU 0 \(6\.0 GiB, 6\.0 GiB free\) has less\. Breeze speech with Qwen3-ASR 0\.6B would fit\./);
  // The smallest is named as what it is, not as the original combination.
  assert.throws(() => decide(undefined, [{ index: 0, name: 'Small GPU', totalMiB: 512, freeMiB: 500 }]),
    /^Error: Even the smallest voice setup \(Kokoro speech with Whisper base\) needs about 1\.0 GiB of GPU memory, but Small GPU \(0\.5 GiB, 0\.5 GiB free\) has less\.$/);
  assert.throws(() => decide(undefined, [card(1536)], { reserveMiB: 1000 }), /smallest voice setup \(Kokoro speech with Whisper base\) needs about 1\.0 GiB of GPU memory, plus 1\.0 GiB kept free/);
  assert.throws(() => decide(DEFAULT_CHOICE, [card(20000)], { reserveMiB: 16000 }), /plus 15\.6 GiB kept free/);
  // No GPU read at all: the choice is kept, unchecked, and Docker has the last word.
  const blind = decide({ tts: 'chatterbox', asr: 'whisper', asrModel: 'base' }, []);
  assert.deepEqual(blind.choice, { tts: 'chatterbox', asr: 'whisper', asrModel: 'base' });
  assert.match(blind.summary, /No GPU could be read here; installing Chatterbox speech with Whisper base unchecked/);
  assert.deepEqual(decide(undefined, []).choice, DEFAULT_CHOICE);
  assert.match(decide(DEFAULT_CHOICE, [card(null)]).summary, /its memory could not be read/);
  // Several cards: the one asked for, which the container is then given.
  assert.equal(decide(undefined, [card(12288, 11000, 0), card(12288, 12000, 1)]).gpu?.index, 1);
  assert.equal(decide(undefined, [card(12288, 11000, 0), card(12288, 12000, 1)], { preferredGpu: 0 }).gpu?.index, 0);
});

// What recognition on the CPU has to run on, with a number of threads to say how fast it is.
const machine = (totalMiB: number | null, freeMiB: number | null, threads: number): Host => ({ totalMiB, freeMiB, threads });
const NONE = (asr: VoiceChoice['asr'], asrModel: string): VoiceChoice => ({ tts: 'none', asr, asrModel });

test('every recognition engine and size runs on the CPU, and none is a GPU matter alone', () => {
  for (const o of ASR_MODELS) {
    const choice = NONE(o.asr, o.model);
    assert.deepEqual(parseChoice(choice), choice, `${o.label} without speech synthesis`);
    assert.equal(usesGpu(choice), false, o.label);
    assert.equal(asrDevice(choice), 'cpu', o.label);
    assert.ok(ramNeeded(choice) > 0 && vramNeeded(choice) === 0, `${o.label} takes memory of the host, and none of a GPU`);
    // The GPU is offered for the one engine that can use it, and only next to a speech engine.
    assert.deepEqual(asrDevices({ tts: 'breeze', asr: o.asr }), o.asr === 'qwen3-asr' ? ['cpu', 'gpu'] : ['cpu'], o.label);
    assert.deepEqual(asrDevices({ tts: 'none', asr: o.asr }), ['cpu'], o.label);
  }
});

test('a choice names where recognition runs, and a label written before there was a choice of device means what it did', () => {
  const onCpu: VoiceChoice = { tts: 'breeze', asr: 'qwen3-asr', asrModel: '0.6b', asrDevice: 'cpu' };
  // Next to a speech engine Qwen3-ASR is on the GPU, as it always was, unless it is put on the CPU.
  assert.equal(asrDevice({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '0.6b' }), 'gpu');
  assert.equal(asrDevice(onCpu), 'cpu');
  assert.equal(choiceKey(onCpu), 'breeze+qwen3-asr:0.6b@cpu');
  assert.deepEqual(choiceFromKey('breeze+qwen3-asr:0.6b@cpu'), onCpu);
  assert.deepEqual(choiceFromKey('breeze+qwen3-asr:0.6b'), { tts: 'breeze', asr: 'qwen3-asr', asrModel: '0.6b' });
  assert.deepEqual(choiceFromKey('none+qwen3-asr:1.7b'), NONE('qwen3-asr', '1.7b'));
  assert.deepEqual(choiceFromKey('none+whisper:small'), NONE('whisper', 'small'));
  // A device that says nothing is not written: a choice is one thing, however it is spelt.
  assert.deepEqual(parseChoice({ tts: 'none', asr: 'qwen3-asr', asrModel: '0.6b', asrDevice: 'cpu' }), NONE('qwen3-asr', '0.6b'));
  assert.deepEqual(parseChoice({ tts: 'breeze', asr: 'whisper', asrModel: 'base', asrDevice: 'cpu' }), DEFAULT_CHOICE);
  assert.equal(sameChoice({ tts: 'breeze', asr: 'whisper', asrModel: 'base', asrDevice: 'cpu' }, DEFAULT_CHOICE), true);
  assert.equal(sameChoice(onCpu, { tts: 'breeze', asr: 'qwen3-asr', asrModel: '0.6b' }), false);
  // What cannot be is said so.
  assert.throws(() => parseChoice({ tts: 'breeze', asr: 'whisper', asrModel: 'base', asrDevice: 'gpu' }), /Whisper runs on the CPU/);
  assert.throws(() => parseChoice({ tts: 'none', asr: 'qwen3-asr', asrModel: '0.6b', asrDevice: 'gpu' }), /without speech synthesis on the GPU runs on the CPU/);
  assert.throws(() => parseChoice({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '0.6b', asrDevice: 'tpu' }), /CPU or the GPU/);
  assert.equal(choiceLabel(onCpu), 'Breeze speech with Qwen3-ASR 0.6B on the CPU');
  assert.equal(choiceLabel(NONE('whisper', 'small')), 'Whisper small (speech recognition only)');
  assert.equal(choiceLabel({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '1.7b' }), 'Breeze speech with Qwen3-ASR 1.7B');
});

test('recognition on the CPU takes memory of the host, not of the card, and is judged by it and by the threads', () => {
  const onCpu: VoiceChoice = { tts: 'breeze', asr: 'qwen3-asr', asrModel: '1.7b', asrDevice: 'cpu' };
  const onGpu: VoiceChoice = { tts: 'breeze', asr: 'qwen3-asr', asrModel: '1.7b' };
  assert.equal(vramNeeded(onGpu) - vramNeeded(onCpu), 2600, 'the card is spared the model');
  assert.equal(ramNeeded(onGpu), 0);
  assert.ok(ramNeeded(onCpu) > ramNeeded(NONE('qwen3-asr', '0.6b')));
  // A card that cannot hold the model next to Breeze can hold the choice with the model on the CPU.
  const small = card(6144);
  assert.equal(fitOn(onGpu, small), 'too-large');
  assert.equal(fitOn(onCpu, small), 'fits');
  // Nothing on the GPU needs no card at all.
  assert.equal(fitOn(NONE('qwen3-asr', '1.7b'), undefined), 'fits');
  // The host's memory: as for a card, there is room now, only the host is big enough, or it is not.
  const need = ramNeeded(onCpu);
  assert.equal(fitRam(onCpu, machine(need * 4, need, 8)), 'fits');
  assert.equal(fitRam(onCpu, machine(need * 4, need - 1, 8)), 'tight');
  assert.equal(fitRam(onCpu, machine(need - 1, need - 1, 8)), 'too-large');
  assert.equal(fitRam(onCpu, machine(null, null, 8)), 'unknown');
  assert.equal(fitRam(onGpu, machine(1, 1, 8)), 'fits', 'nothing of it is on the CPU');
  // Speed follows the threads, from one measurement on eight: an estimate, said where it is not known.
  assert.equal(cpuRealtime(NONE('qwen3-asr', '0.6b'), 8), 5.4);
  assert.equal(cpuRealtime(NONE('qwen3-asr', '0.6b'), 16), 5.4, 'no more than was measured');
  assert.ok(Math.abs(cpuRealtime(NONE('qwen3-asr', '1.7b'), 2)! - 0.65) < 1e-9);
  assert.equal(cpuRealtime(NONE('whisper', 'base'), 2), undefined, 'Whisper was not measured');
  assert.equal(cpuRealtime(onGpu, 8), undefined, 'not on the CPU');
  assert.deepEqual([cpuSlow(NONE('qwen3-asr', '1.7b'), 2), cpuSlow(NONE('qwen3-asr', '1.7b'), 4), cpuSlow(NONE('qwen3-asr', '0.6b'), 2), cpuSlow(NONE('whisper', 'base'), 1)], [true, false, false, false]);
  assert.deepEqual([cpuThreads(1), cpuThreads(2), cpuThreads(6), cpuThreads(32), cpuThreads(NaN)], [2, 2, 6, 8, 2]);
});

test('on a host without a GPU the suggestion is Kokoro on the CPU with the largest recognition that fits beside it and keeps well ahead of the speaker, else recognition alone', () => {
  const KOKORO = (asr: VoiceChoice['asr'], asrModel: string): VoiceChoice => ({ tts: 'kokoro', ttsDevice: 'cpu', asr, asrModel });
  assert.deepEqual(suggestCpuChoice(machine(16384, 12000, 8)), KOKORO('qwen3-asr', '0.6b'), 'the larger model is only 2.6 times faster than the audio');
  assert.deepEqual(suggestCpuChoice(machine(16384, 12000, 2)), KOKORO('whisper', 'base'), 'two threads are too few for either Qwen3-ASR, and enough for Kokoro');
  assert.deepEqual(suggestCpuChoice(machine(16384, 12000, 1)), NONE('whisper', 'base'), 'one thread is too few for Kokoro');
  assert.deepEqual(suggestCpuChoice(machine(16384, 2500, 8)), KOKORO('whisper', 'base'), 'Qwen3-ASR does not fit beside Kokoro, Whisper does');
  assert.deepEqual(suggestCpuChoice(machine(16384, 1000, 8)), NONE('whisper', 'base'), 'the memory is busy');
  assert.deepEqual(suggestCpuChoice(machine(512, 512, 8)), NONE('whisper', 'base'));
  assert.deepEqual(suggestCpuChoice(undefined), NONE('whisper', 'base'), 'nothing known of the memory: the one that asks for the least');
  // Whisper small is offered, never suggested.
  for (const threads of [1, 2, 4, 8, 64]) assert.notEqual(suggestCpuChoice(machine(65536, 60000, threads)).asrModel, 'small');
});

test('the processes of a choice: a GPU server for the speech engine, a CPU one for recognition on the CPU, and Whisper by itself', () => {
  const onCpu: VoiceChoice = { tts: 'breeze', asr: 'qwen3-asr', asrModel: '0.6b', asrDevice: 'cpu' };
  // Recognition put on the CPU leaves the GPU server to speech alone.
  assert.deepEqual(serverConfig(onCpu)!.models.map(m => m.id), ['breeze']);
  assert.equal(serverConfig(onCpu)!.max_loaded_models, 1);
  const cpu = cpuServerConfig(onCpu, 6)!;
  assert.deepEqual([cpu.backend, cpu.port, cpu.threads, cpu.max_loaded_models, cpu.host], ['cpu', CPU_PORT, 6, 1, '127.0.0.1']);
  assert.deepEqual(cpu.models, [{ id: 'qwen3-asr', family: 'qwen3_asr', path: '/voice/models/qwen3-asr-0.6b-q8_0.gguf', task: 'asr', mode: 'offline' }]);
  assert.equal(cpuServerConfig(onCpu)!.threads, 4, 'four, as the GPU server has');
  // Without a speech engine there is no GPU server, and no GPU.
  assert.equal(serverConfig(NONE('qwen3-asr', '1.7b')), undefined);
  assert.equal(cpuServerConfig(NONE('qwen3-asr', '1.7b'))!.models[0].path, '/voice/models/qwen3-asr-1.7b-q8_0.gguf');
  assert.equal(serverConfig(NONE('whisper', 'base')), undefined);
  assert.equal(cpuServerConfig(NONE('whisper', 'base')), undefined, 'Whisper is a process of its own');
  // On the GPU Qwen3-ASR is in the speech server, and there is no CPU one.
  assert.equal(cpuServerConfig({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '0.6b' }), undefined);
  assert.equal(cpuServerConfig(DEFAULT_CHOICE), undefined);
  // Where the portal looks.
  assert.deepEqual(endpoints(onCpu), { listen: { url: 'http://127.0.0.1:7863/v1/audio/transcriptions', model: 'qwen3-asr' }, speak: { url: 'http://127.0.0.1:7862/v1/audio/speech', engine: 'breeze' } });
  assert.deepEqual(endpoints(NONE('whisper', 'small')), { listen: { url: 'http://127.0.0.1:8188/inference' } });
  assert.deepEqual(endpoints(NONE('qwen3-asr', '0.6b')), { listen: { url: 'http://127.0.0.1:7863/v1/audio/transcriptions', model: 'qwen3-asr' } });
  // What has to answer: only what the choice runs.
  assert.deepEqual(healthUrls(onCpu), ['http://127.0.0.1:7862/health', 'http://127.0.0.1:7863/health']);
  assert.deepEqual(healthUrls(NONE('qwen3-asr', '0.6b')), ['http://127.0.0.1:7863/health']);
  assert.deepEqual(healthUrls(NONE('whisper', 'base')), ['http://127.0.0.1:8188/health']);
  assert.deepEqual(healthUrls({ tts: 'chatterbox', asr: 'qwen3-asr', asrModel: '1.7b' }), ['http://127.0.0.1:7862/health']);
});

test('on a host that was found to have no GPU, recognition alone is chosen, speech is refused, and the memory is judged', () => {
  const host = machine(16384, 12000, 8);
  const auto = decide(undefined, [], { noGpu: true, host });
  assert.deepEqual([auto.choice, auto.gpu], [{ tts: 'kokoro', ttsDevice: 'cpu', asr: 'qwen3-asr', asrModel: '0.6b' }, undefined]);
  assert.equal(auto.summary, 'No GPU detected: installing Kokoro speech on the CPU with Qwen3-ASR 0.6B needing about 2.8 GiB of memory on the CPU, which fits.');
  const listening = decide(NONE('qwen3-asr', '0.6b'), [], { noGpu: true, host });
  assert.equal(listening.summary, 'No GPU detected: installing Qwen3-ASR 0.6B (speech recognition only) needing about 1.6 GiB of memory on the CPU, which fits. Replies are not spoken: choose Kokoro on the CPU to hear them.');
  assert.deepEqual(decide(NONE('whisper', 'small'), [], { noGpu: true, host }).choice, NONE('whisper', 'small'));
  assert.throws(() => decide(DEFAULT_CHOICE, [], { noGpu: true, host }), (e: Error) => e.message === NO_GPU_FOR_SPEECH);
  assert.throws(() => decide({ tts: 'kokoro', asr: 'whisper', asrModel: 'base' }, [], { noGpu: true, host }), (e: Error) => e.message === NO_GPU_FOR_SPEECH, 'Kokoro on the GPU needs one too');
  assert.match(NO_GPU_FOR_SPEECH, /put Kokoro on the CPU/);
  assert.throws(() => decide({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '0.6b', asrDevice: 'cpu' }, [], { noGpu: true, host }), /This choice needs a GPU/);
  // On a GPU host, everything put on the CPU asks for no GPU, and says so.
  assert.equal(decide({ tts: 'kokoro', ttsDevice: 'cpu', asr: 'whisper', asrModel: 'base' }, [card(12288)], { host }).summary, 'Kokoro speech on the CPU with Whisper base needs no GPU, and about 1.7 GiB of memory on the CPU, which fits.');
  // Kokoro on a host with few threads is said to be slow, and still installs.
  assert.match(decide({ tts: 'kokoro', ttsDevice: 'cpu', asr: 'whisper', asrModel: 'base' }, [], { noGpu: true, host: machine(8192, 8000, 1) }).summary, /which fits, and on this host's 1 CPU threads speech may take longer to make than to say/);
  // A card the host lists that Docker cannot hand on is not "none was found": it is the toolkit that is asked for, in the log as well.
  const unusable = { noGpu: true, host, unusable: ['Test GPU'] };
  assert.throws(() => decide(DEFAULT_CHOICE, [], unusable), (e: Error) => e.message === NO_GPU_FOR_SPEECH_UNUSABLE);
  assert.doesNotMatch(NO_GPU_FOR_SPEECH_UNUSABLE, /none was found/);
  assert.equal(decide(NONE('qwen3-asr', '0.6b'), [], unusable).summary, 'GPU detected: Test GPU, but Docker cannot use it: installing Qwen3-ASR 0.6B (speech recognition only) needing about 1.6 GiB of memory on the CPU, which fits. Replies are not spoken: choose Kokoro on the CPU to hear them, or make the GPU usable by Docker.');
  // Too little memory is refused with what would fit; little free right now is said and goes on; slow threads are said.
  assert.throws(() => decide(NONE('qwen3-asr', '1.7b'), [], { noGpu: true, host: machine(2048, 1800, 8) }),
    /^Error: Qwen3-ASR 1\.7B \(speech recognition only\) needs about 2\.9 GiB of memory on the CPU, but this host has 2\.0 GiB\. Qwen3-ASR 0\.6B \(speech recognition only\) would fit\.$/);
  assert.match(decide(NONE('qwen3-asr', '1.7b'), [], { noGpu: true, host: machine(8192, 1000, 8) }).summary, /needing about 2\.9 GiB of memory on the CPU, of which the host has less free now\./);
  assert.match(decide(NONE('qwen3-asr', '1.7b'), [], { noGpu: true, host: machine(8192, 8000, 2) }).summary, /which fits and may be slower than the speaker on this host's 2 CPU threads/);
  // Without the finding that there is none, nothing changes: the original combination, unchecked.
  assert.deepEqual(decide(undefined, [], { host }).choice, DEFAULT_CHOICE);
  // A GPU host that puts recognition on the CPU: both parts are judged, and both are said.
  const onCpu: VoiceChoice = { tts: 'breeze', asr: 'qwen3-asr', asrModel: '1.7b', asrDevice: 'cpu' };
  assert.equal(decide(onCpu, [card(6144)], { host }).summary,
    'Detected Test GPU 0 (6.0 GiB, 6.0 GiB free): Breeze speech with Qwen3-ASR 1.7B on the CPU needs about 4.5 GiB, which fits, and about 2.9 GiB of memory on the CPU, which fits.');
  assert.throws(() => decide(onCpu, [card(6144)], { host: machine(2048, 1800, 8) }), /Breeze speech with Qwen3-ASR 1\.7B on the CPU needs about 2\.9 GiB of memory on the CPU, but this host has 2\.0 GiB\./);
  // Whisper's few hundred MiB are not worth a clause next to a GPU.
  assert.equal(decide(DEFAULT_CHOICE, [card(12288)], { host }).summary, 'Detected Test GPU 0 (12.0 GiB, 12.0 GiB free): Breeze speech with Whisper base needs about 4.5 GiB, which fits.');
});

test('the host is read as it is: the memory and the CPUs of the machine, not the limits of the portal\'s own container', () => {
  // Recognition runs in a container of its own that has no limit of the portal's, so a limit on the portal's is not what it has.
  const host = readHost();
  assert.equal(host.totalMiB, Math.round(os.totalmem() / 1048576));
  assert.ok(host.freeMiB! >= 0 && host.freeMiB! <= host.totalMiB!, JSON.stringify(host));
  assert.equal(host.threads, os.cpus().length);
  assert.ok(Number.isInteger(host.threads) && host.threads >= 1);
  assert.equal(readFileSync(new URL('../src/server/gpu.ts', import.meta.url), 'utf8').includes('/sys/fs/cgroup'), false, 'no cgroup of the portal is read');
});
