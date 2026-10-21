import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ASR_MODELS, DEFAULT_CHOICE, asrDevice, asrDevices, cpuServerConfig, parseChoice, serverConfig, ttsDevice, ttsDevices, usesGpu, type Device, type VoiceChoice } from '../src/engines.ts';
import { containerSpec } from '../src/server/service.ts';
import { scratch } from "../../../tests/helpers.mts";

// The setup script run for real, with every command that would build, download or
// install something replaced by a stub that writes down what it was asked to do.
// Nothing is downloaded, built or installed, and no GPU is needed.
const script = readFileSync(new URL('../setup.sh', import.meta.url), 'utf8');
const root = scratch('voice-setup-');
const calls = path.join(root, 'calls.log');
const stubs = path.join(root, 'stubs.sh');
const volume = path.join(root, 'volume');
const serverStub = path.join(root, 'server-stub');
const ggufStub = path.join(root, 'gguf-stub');
// A service writes its line and stays up a moment: the script ends when the first one exits and stops the other.
// It says which binary it is and whether it was given a GPU to see.
const SERVER_STUB = '#!/bin/sh\necho "$(basename "$0") $* cvd=${CUDA_VISIBLE_DEVICES-unset} bin=$0" >> "$CALLS"\nsleep 0.4\nexit 0\n';
const GGUF_STUB = '#!/bin/sh\necho "audiocpp_gguf $*" >> "$CALLS"\nwhile [ $# -gt 0 ]; do [ "$1" = --output ] && echo weights > "$2"; shift; done\nexit 0\n';
for (const [file, content] of [[serverStub, SERVER_STUB], [ggufStub, GGUF_STUB]]) { writeFileSync(file, content); chmodSync(file, 0o755); }
// Functions win over commands, so BASH_ENV reaches the script's own shell and no PATH is touched.
writeFileSync(stubs, `
log() { echo "$*" >> "$CALLS"; }
cd() { if [ "\${1:-}" = /voice ]; then builtin cd "$VOLUME"; else builtin cd "$@"; fi; }
touch() { case "\${1:-}" in /usr/*) log "touch $1";; *) command touch "$@";; esac; }
# Nothing is installed yet as far as a package query can tell.
dpkg() { log "dpkg $*"; [ "$1" != -s ]; }
apt-get() { log "apt-get $*"; }
nvidia-smi() { log "nvidia-smi $*"; echo "\${ARCH:-8.6}"; }
git() {
  log "git $*"
  if [ "$1" = clone ]; then mkdir -p "$3/.git" "$3/scripts"; fi
  # A clone from an earlier pin does not have the revision asked for.
  if [ "\${3:-}" = cat-file ] && [ -n "\${MISSING_REVISION:-}" ]; then return 1; fi
}
cmake() { log "cmake $*"; if [ "$1" = --build ]; then mkdir -p whisper/build/bin; cp "$SERVER_STUB" whisper/build/bin/whisper-server; fi; }
aria2c() {
  local dir out sum
  for a in "$@"; do case "$a" in --dir=*) dir="\${a#--dir=}";; --out=*) out="\${a#--out=}";; --checksum=*) sum="\${a#--checksum=}";; esac; done
  log "aria2c \${sum#sha-256=} \${@: -1} -> $dir/$out"
  echo weights > "$dir/$out"
}
bash() {
  log "bash $*"
  case "$1" in
    scripts/build_linux.sh)
      local dir='' arch='' targets=''
      shift
      while [ $# -gt 0 ]; do case "$1" in --build-dir) dir="$VOLUME\${2#/voice}";; --cuda-arch) arch="$2";; --target) targets="$targets $2";; esac; shift; done
      mkdir -p "$dir/bin"
      cp "$SERVER_STUB" "$dir/bin/audiocpp_server"
      # Only a build asked for the quantizer has it.
      case "$targets" in *audiocpp_gguf*) cp "$GGUF_STUB" "$dir/bin/audiocpp_gguf";; esac
      { echo 'AUDIOCPP_BUILD_NATIVE_MODEL_MANAGER:BOOL=ON'; if [ -n "$arch" ]; then echo "CMAKE_CUDA_ARCHITECTURES:STRING=$arch"; fi; } > "$dir/CMakeCache.txt" ;;
    whisper/models/download-ggml-model.sh) : > "models/ggml-$2.bin" ;;
  esac
}
`);
after(() => rmSync(root, { recursive: true, force: true }));

// The script finds only these programs: anything else it runs is "command not found", and not whatever this machine has,
// so a line added to it that installs or downloads something fails here instead of doing it.
const programs = path.join(root, 'bin');
mkdirSync(programs);
const where = (name: string) => spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
for (const name of ['basename', 'cat', 'cp', 'dirname', 'grep', 'head', 'mkdir', 'mv', 'paste', 'rm', 'sed', 'sleep', 'sort', 'touch', 'tr']) symlinkSync(where(name), path.join(programs, name));
// bash is named in full: the PATH it is run with does not have it.
const bash = where('bash');

/** Runs the script in the volume, as the container would. */
function run(env: Record<string, string> = {}) {
  mkdirSync(volume, { recursive: true });
  writeFileSync(calls, '');
  const result = spawnSync(bash, ['--noprofile', '--norc', '-c', script], {
    env: { PATH: programs, BASH_ENV: stubs, CALLS: calls, VOLUME: volume, SERVER_STUB: serverStub, GGUF_STUB: ggufStub, ...env }, encoding: 'utf8', timeout: 30000,
  });
  // A program that is not in the list would not fail the script, only change what it does: it is said here instead.
  assert.doesNotMatch(result.stderr, /command not found/);
  const log = readFileSync(calls, 'utf8').split('\n').filter(Boolean);
  return { status: result.status, stderr: result.stderr, stdout: result.stdout, log };
}
/** The environment the portal gives the container for a choice: the very one it builds, not a copy of it. */
const environment = (c: VoiceChoice, threads?: number): Record<string, string> =>
  Object.fromEntries(containerSpec('', 'host', c, { threads }).Env.map(e => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
const fresh = () => { rmSync(volume, { recursive: true, force: true }); };
const built = (log: string[]) => log.filter(l => l.startsWith('bash scripts/build_linux.sh'));
const downloads = (log: string[]) => log.filter(l => l.startsWith('aria2c'));
const smi = (log: string[]) => log.filter(l => l.startsWith('nvidia-smi'));
// The services write their line as they start, in no fixed order.
const startedRaw = (log: string[]) => log.filter(l => /^(whisper-server|audiocpp_server) /.test(l)).sort();
const started = (log: string[]) => startedRaw(log).map(l => l.replace(/ cvd=.*$/, ''));
const NONE = (asr: VoiceChoice['asr'], asrModel: string): VoiceChoice => ({ tts: 'none', asr, asrModel });

test('the script reaches only the programs it is given: any other is not found', () => {
  for (const name of ['curl', 'pip', 'pip3', 'npm', 'wget', 'sudo']) {
    const result = spawnSync(bash, ['--noprofile', '--norc', '-c', `${name} --version`], { env: { PATH: programs }, encoding: 'utf8' });
    assert.equal(result.status, 127, name);
    assert.match(result.stderr, /not found/, name);
  }
});

test('the script is valid bash', () => {
  const result = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('without any choice the script makes the original combination: Breeze, Whisper base and the config it always wrote', () => {
  fresh();
  const { status, log, stderr } = run();
  assert.equal(status, 0, stderr);
  assert.match(built(log)[0], /--models breeze_tts --target audiocpp_server --target audiocpp_gguf/);
  assert.ok(log.some(l => l.startsWith('bash whisper/models/download-ggml-model.sh base /voice/models')));
  assert.equal(downloads(log).length, 1);
  assert.match(downloads(log)[0], /^aria2c a00c9f678b4c5ae03d1dcd228f636b329352cda200823faef4e01d3bd97c0a89 https:\/\/huggingface\.co\/audio-cpp\/audio\.cpp-gguf\/resolve\/056144d2744697c9439bd32647279674dba0c964\/Breeze-TTS-2-GGUF\/breeze-tts-2-bf16\.gguf/);
  assert.ok(log.some(l => l.startsWith('audiocpp_gguf --input models/breeze-bf16.gguf --output models/breeze-q8_0.partial.gguf --type q8_0')));
  assert.ok(existsSync(path.join(volume, 'models/breeze-q8_0.gguf')) && !existsSync(path.join(volume, 'models/breeze-bf16.gguf')));
  assert.deepEqual(JSON.parse(readFileSync(path.join(volume, 'server.json'), 'utf8')), serverConfig(DEFAULT_CHOICE));
  assert.deepEqual(started(log), ['audiocpp_server --config /voice/server.json', 'whisper-server --host 127.0.0.1 --port 8188 --model /voice/models/ggml-base.bin --language auto --threads 4']);
  // No second server, and nothing built for the CPU.
  assert.equal(existsSync(path.join(volume, 'server-cpu.json')), false);
  assert.equal(existsSync(path.join(volume, 'audio/build/portal-cpu')), false);
});

/** Every choice the installer can make: each speech engine, on each device it runs on, or none, with each recognition model on each device it runs on. */
const everyChoice = (): VoiceChoice[] => (['breeze', 'chatterbox', 'kokoro', 'none'] as const).flatMap(tts =>
  (tts === 'none' ? [undefined] : ttsDevices(tts) as (Device | undefined)[]).flatMap(ttsDevice => ASR_MODELS.flatMap(o =>
    asrDevices({ tts, asr: o.asr, ttsDevice }).map(device => parseChoice({ tts, ttsDevice, asr: o.asr, asrModel: o.model, asrDevice: device })))));

test('every engine, model size and device the page offers is built, downloaded and started by the script', () => {
  const sums: Record<string, string> = {
    '0.6b': '6c44ec2fb4cee513892d7863c1fcc3ea6b699ffa4d899b0ef4ab19956d9544f7', '1.7b': 'da4fc2ac7f24dee784d1684eb1f35836cdbf559519452ae11777670734c0a4f8',
  };
  const choices = everyChoice();
  // Speech on the GPU: 3 engines; Whisper in 2 sizes on the CPU only, Qwen3-ASR in 2 on the CPU, and on the GPU too beside it.
  // Kokoro on the CPU, and no speech: recognition on the CPU only.
  assert.equal(choices.length, 3 * (2 + 2 * 2) + (2 + 2) + (2 + 2));
  for (const choice of choices) {
    fresh();
    const name = `${choice.tts}${choice.ttsDevice === 'cpu' ? ' on the CPU' : ''} + ${choice.asr}:${choice.asrModel} on the ${asrDevice(choice)}`;
    const qwen = choice.asr === 'qwen3-asr', qwenCpu = qwen && asrDevice(choice) === 'cpu', gpu = usesGpu(choice), speechCpu = ttsDevice(choice) === 'cpu';
    // The portal gives what runs on the CPU the threads of the host; what is on the GPU keeps the script's four.
    const threads = !gpu || qwenCpu ? 6 : undefined;
    const { status, log, stderr } = run(environment(choice, threads));
    assert.equal(status, 0, `${name}: ${stderr}`);
    // Build: CUDA wherever the GPU is used, for the card's architecture and with the quantizer; else a CPU build of its own with no
    // CUDA and no nvidia-smi; and no audio.cpp at all for Whisper alone.
    if (gpu) {
      const families = [{ breeze: 'breeze_tts', chatterbox: 'chatterbox', kokoro: 'kokoro_tts', none: '' }[choice.tts], ...(qwen ? ['qwen3_asr'] : [])].filter(Boolean).sort().join(',');
      assert.equal(built(log).length, 1, name);
      assert.match(built(log)[0], new RegExp(`--cuda on --cuda-arch 86 --build-dir /voice/audio/build/portal --build-type Release --model-set custom --models ${families} --target audiocpp_server --target audiocpp_gguf`), name);
      assert.equal(smi(log).length, 1, name);
    } else if (qwen || speechCpu) {
      const families = [...(speechCpu ? ['kokoro_tts'] : []), ...(qwen ? ['qwen3_asr'] : [])].join(',');
      assert.equal(built(log).length, 1, name);
      assert.match(built(log)[0], new RegExp(`--cuda off --build-dir /voice/audio/build/portal-cpu --build-type Release --model-set custom --models ${families} --target audiocpp_server --jobs 4$`), name);
      assert.ok(!built(log)[0].includes('audiocpp_gguf') && !built(log)[0].includes('--cuda on') && !built(log)[0].includes('--cuda-arch'), `${name}: a CPU build has no CUDA`);
      assert.deepEqual(smi(log), [], `${name}: nothing is asked of a GPU there is none of`);
    } else {
      assert.deepEqual([built(log), smi(log), log.filter(l => l.startsWith('git clone') && l.includes('audio.cpp'))], [[], [], []], `${name}: no audio.cpp for Whisper alone`);
    }
    // Downloads.
    const names = downloads(log).map(l => l.split(' -> ')[1]);
    if (choice.tts === 'chatterbox') assert.ok(downloads(log).some(l => l.startsWith('aria2c d586dd1aa59613cab8046176fb7ca5ba191c02a9b10ffa5b0d892ed22b470656 https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/6d5436fc85f7a20c2e9f4e472b7f3a532f686444/Chatterbox-GGUF/chatterbox-q8_0.gguf')), name);
    assert.equal(names.includes('models/chatterbox-q8_0.gguf.part'), choice.tts === 'chatterbox', name);
    assert.equal(names.includes('models/breeze-bf16.gguf.part'), choice.tts === 'breeze', name);
    if (choice.tts === 'kokoro') assert.ok(downloads(log).some(l => l.startsWith('aria2c 5d800fd204029302c10313daeafdb31c875c7c29ae31974d0d156cc7f512d1d0 https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/351dbab8d8534675ee29440bb402e348b09e55e2/Kokoro-82M-GGUF/kokoro-82m-q8_0.gguf')), name);
    assert.equal(names.includes('models/kokoro-82m-q8_0.gguf.part'), choice.tts === 'kokoro', name);
    // eSpeak NG turns Kokoro's text into phonemes; nothing else needs it.
    assert.equal(log.some(l => l === 'apt-get install -y --no-install-recommends libespeak-ng1 espeak-ng-data'), choice.tts === 'kokoro', name);
    if (qwen) {
      const folder = `Qwen3-ASR-${choice.asrModel.toUpperCase()}-GGUF`;
      assert.ok(downloads(log).some(l => l.startsWith(`aria2c ${sums[choice.asrModel]} https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/6d5436fc85f7a20c2e9f4e472b7f3a532f686444/${folder}/qwen3-asr-${choice.asrModel}-q8_0.gguf`)), name);
      assert.ok(existsSync(path.join(volume, `models/qwen3-asr-${choice.asrModel}-q8_0.gguf`)), name);
      assert.ok(!log.some(l => l.includes('download-ggml-model') || l.startsWith('cmake')), `${name} needs no Whisper`);
    } else {
      assert.ok(log.some(l => l.startsWith(`bash whisper/models/download-ggml-model.sh ${choice.asrModel} /voice/models`)), name);
    }
    // The processes: Whisper if chosen, the GPU server if anything is on the GPU, and the CPU server for Qwen3-ASR on the CPU.
    const expected = [
      ...(qwen ? [] : [`whisper-server --host 127.0.0.1 --port 8188 --model /voice/models/ggml-${choice.asrModel}.bin --language auto --threads ${threads ?? 4}`]),
      ...(gpu ? ['audiocpp_server --config /voice/server.json'] : []),
      ...(qwenCpu || speechCpu ? ['audiocpp_server --config /voice/server-cpu.json'] : []),
    ].sort();
    assert.deepEqual(started(log).map(l => l.replace(/ bin=.*$/, '')), expected, name);
    // The configs the portal sent are the ones audio.cpp is started with, and every model they name is on disk by then.
    const server = serverConfig(choice), cpuServer = cpuServerConfig(choice, threads);
    assert.equal(existsSync(path.join(volume, 'server.json')), Boolean(server), name);
    assert.equal(existsSync(path.join(volume, 'server-cpu.json')), Boolean(cpuServer), name);
    for (const [file, config] of [['server.json', server], ['server-cpu.json', cpuServer]] as const) {
      if (!config) continue;
      assert.deepEqual(JSON.parse(readFileSync(path.join(volume, file), 'utf8')), config, `${name}: ${file}`);
      for (const model of config.models) assert.ok(existsSync(path.join(volume, model.path.replace('/voice/', ''))), `${name}: ${model.path}`);
    }
    // The CPU server never sees a GPU, next to a GPU one or without; the GPU one is given what it had.
    for (const line of startedRaw(log)) {
      if (line.includes('server-cpu.json')) assert.match(line, / cvd= /, `${name}: no CUDA context for the CPU server`);
      if (line.includes('--config /voice/server.json')) assert.match(line, / cvd=unset /, name);
    }
  }
});

test('Qwen3-ASR on the CPU beside a speech engine runs from the GPU build, and without a CPU build there is none', () => {
  fresh();
  const choice: VoiceChoice = { tts: 'breeze', asr: 'qwen3-asr', asrModel: '0.6b', asrDevice: 'cpu' };
  const { status, log, stderr } = run(environment(choice, 6));
  assert.equal(status, 0, stderr);
  assert.equal(built(log).length, 1);
  assert.match(built(log)[0], /--models breeze_tts,qwen3_asr /, 'the family of the CPU server is in the GPU build');
  const cpuLine = startedRaw(log).find(l => l.includes('server-cpu.json'))!;
  assert.match(cpuLine, /bin=audio\/build\/portal\/bin\/audiocpp_server$/);
  assert.equal(existsSync(path.join(volume, 'audio/build/portal-cpu')), false);
  assert.deepEqual(JSON.parse(readFileSync(path.join(volume, 'server.json'), 'utf8')).models.map((m: any) => m.id), ['breeze']);
});

test('a CPU build and a GPU build live side by side in the volume, each built once and neither asking the other', () => {
  fresh();
  const cpu = NONE('qwen3-asr', '0.6b');
  const first = run(environment(cpu, 6));
  assert.equal(built(first.log).length, 1);
  assert.deepEqual(smi(first.log), []);
  assert.deepEqual([built(run(environment(cpu, 6)).log), downloads(run(environment(cpu, 6)).log)], [[], []], 'nothing rebuilt or downloaded for the same choice');
  // A GPU is added: its build is its own, in its own directory, and the CPU one is left as it is.
  const gpu: VoiceChoice = { tts: 'breeze', asr: 'qwen3-asr', asrModel: '0.6b' };
  const added = run(environment(gpu));
  assert.match(built(added.log)[0], /--cuda on .*--build-dir \/voice\/audio\/build\/portal --/);
  assert.deepEqual(downloads(added.log).map(l => l.split(' -> ')[1]), ['models/breeze-bf16.gguf.part'], 'the recognition model is already there');
  assert.ok(existsSync(path.join(volume, 'audio/build/portal-cpu/bin/audiocpp_server')) && existsSync(path.join(volume, 'audio/build/portal/bin/audiocpp_gguf')));
  // And back to the CPU: nothing is built again, the GPU build does not count for it.
  const back = run(environment(cpu, 6));
  assert.deepEqual([built(back.log), downloads(back.log), smi(back.log)], [[], [], []]);
  // Each keeps its own families: more recognition for the CPU is built into the CPU directory alone.
  const other = run(environment(NONE('qwen3-asr', '1.7b'), 6));
  assert.deepEqual(built(other.log), [], 'the family is the same, only the model file differs');
  assert.deepEqual(downloads(other.log).map(l => l.split(' -> ')[1]), ['models/qwen3-asr-1.7b-q8_0.gguf.part']);
});

test('a second run reuses the volume, and switching engines builds only what is new, once', () => {
  fresh();
  const chatterbox: VoiceChoice = { tts: 'chatterbox', asr: 'qwen3-asr', asrModel: '0.6b' };
  assert.equal(run(environment(DEFAULT_CHOICE)).status, 0);
  const again = run(environment(DEFAULT_CHOICE));
  assert.deepEqual([built(again.log), downloads(again.log)], [[], []], 'nothing rebuilt or downloaded for the same choice');
  const switched = run(environment(chatterbox));
  assert.match(built(switched.log)[0], /--models breeze_tts,chatterbox,qwen3_asr /, 'the family Breeze needed is kept');
  assert.equal(downloads(switched.log).length, 2, 'only the two new models');
  // Back again: the build already holds Breeze, and so does the volume.
  const back = run(environment(DEFAULT_CHOICE));
  assert.deepEqual([built(back.log), downloads(back.log)], [[], []]);
  assert.deepEqual(JSON.parse(readFileSync(path.join(volume, 'server.json'), 'utf8')), serverConfig(DEFAULT_CHOICE));
});

test('a card of another architecture rebuilds the runtime, because its kernels are compiled for one card only', () => {
  fresh();
  const arch = (log: string[]) => /--cuda-arch (\d+)/.exec(built(log)[0] ?? '')?.[1];
  const first = run({ ...environment(DEFAULT_CHOICE), ARCH: '8.9' });
  assert.equal(arch(first.log), '89');
  // The same families on a card of another architecture: only Whisper changes, yet the kernels are for the other card.
  const other: VoiceChoice = { tts: 'breeze', asr: 'whisper', asrModel: 'small' };
  const moved = run({ ...environment(other), ARCH: '8.6' });
  assert.equal(arch(moved.log), '86');
  assert.match(moved.log.find(l => l.startsWith('bash scripts/build_linux.sh'))!, /--models breeze_tts /);
  // Built for it: the same card again builds nothing, and going back to the first card builds once more.
  assert.deepEqual(built(run({ ...environment(other), ARCH: '8.6' }).log), []);
  assert.equal(arch(run({ ...environment(other), ARCH: '8.9' }).log), '89');
  // The marker, not the CMake cache, is what is compared once a build wrote it: a cache that spells the architecture differently does not loop.
  writeFileSync(path.join(volume, 'audio/build/portal/CMakeCache.txt'), 'AUDIOCPP_BUILD_NATIVE_MODEL_MANAGER:BOOL=ON\nCMAKE_CUDA_ARCHITECTURES:STRING=89-real\n');
  assert.deepEqual(built(run({ ...environment(other), ARCH: '8.9' }).log), []);
  // A CPU build has no architecture: the card changing does not rebuild it.
  run(environment(NONE('qwen3-asr', '0.6b'), 6));
  assert.deepEqual(built(run({ ...environment(NONE('qwen3-asr', '0.6b'), 6), ARCH: '9.0' }).log), []);
});

test('a volume from before engines could be chosen is built once for the pinned release, and nothing is downloaded again', () => {
  fresh();
  // What the old installer left: Breeze-only binaries without a families file, the quantized model, Whisper.
  const bin = path.join(volume, 'audio/build/portal/bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(path.join(volume, 'audio/.git'), { recursive: true });
  mkdirSync(path.join(volume, 'whisper/build/bin'), { recursive: true });
  mkdirSync(path.join(volume, 'whisper/.git'), { recursive: true });
  mkdirSync(path.join(volume, 'models'), { recursive: true });
  for (const [f, from] of [['audio/build/portal/bin/audiocpp_server', serverStub], ['audio/build/portal/bin/audiocpp_gguf', ggufStub], ['whisper/build/bin/whisper-server', serverStub]]) {
    copyFileSync(from, path.join(volume, f));
  }
  writeFileSync(path.join(volume, 'audio/build/portal/CMakeCache.txt'), 'AUDIOCPP_BUILD_NATIVE_MODEL_MANAGER:BOOL=ON\nCMAKE_CUDA_ARCHITECTURES:STRING=86\n');
  writeFileSync(path.join(volume, 'models/breeze-q8_0.gguf'), 'weights');
  const { status, log, stderr } = run();
  assert.equal(status, 0, stderr);
  // Its build is from an earlier audio.cpp: built again, for Breeze alone, as it was.
  assert.equal(built(log).length, 1);
  assert.match(built(log)[0], /--models breeze_tts --target/);
  assert.deepEqual([downloads(log), log.filter(l => l.startsWith('cmake'))], [[], []]);
  assert.equal(started(log).length, 2);
  assert.deepEqual(built(run().log), [], 'and once only');
  // Another card still rebuilds it.
  assert.match(built(run({ ARCH: '8.9' }).log)[0], /--cuda-arch 89 /);
  // The same volume grows when another engine is chosen: Breeze stays in the build.
  const next = run(environment({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '1.7b' }));
  assert.match(built(next.log)[0], /--models breeze_tts,qwen3_asr /);
});

test('a build from another audio.cpp revision is built again, and a clone that has not seen the pinned one fetches it first', () => {
  fresh();
  assert.equal(run(environment(DEFAULT_CHOICE)).status, 0);
  const marker = path.join(volume, 'audio/build/portal/pithagoras-revision');
  const pinned = readFileSync(marker, 'utf8').trim();
  assert.match(script, new RegExp(`audio_revision=${pinned}\n`));
  const again = run(environment(DEFAULT_CHOICE)).log;
  assert.ok(!again.some(l => l.includes('fetch')), 'a clone that has the revision does not fetch');
  // Its submodule is named by an SSH address, and the container has no SSH.
  assert.ok(again.includes('git -C audio -c url.https://github.com/.insteadOf=git@github.com: submodule update --init --recursive'), again.join('\n'));
  writeFileSync(marker, 'efb04233dab73aeee4b2912042a90e7b36329061\n');
  const upgraded = run({ ...environment(DEFAULT_CHOICE), MISSING_REVISION: '1' });
  assert.equal(upgraded.status, 0, upgraded.stderr);
  const fetched = upgraded.log.indexOf('git -C audio fetch origin'), checkedOut = upgraded.log.indexOf(`git -C audio checkout ${pinned}`);
  assert.ok(fetched >= 0 && fetched < checkedOut, upgraded.log.join('\n'));
  assert.equal(built(upgraded.log).length, 1);
  assert.equal(readFileSync(marker, 'utf8').trim(), pinned);
  assert.deepEqual(downloads(upgraded.log), [], 'the models are the same files');
});

test('eSpeak NG is installed for Kokoro only where it is not there yet', () => {
  fresh();
  const kokoro: VoiceChoice = { tts: 'kokoro', asr: 'whisper', asrModel: 'base' };
  const { status, log, stderr } = run(environment(kokoro));
  assert.equal(status, 0, stderr);
  assert.ok(log.includes('dpkg -s libespeak-ng1 espeak-ng-data'));
  assert.ok(log.includes('apt-get install -y --no-install-recommends libespeak-ng1 espeak-ng-data'));
  // The volume has the model and the build: only eSpeak, which lives in the container, is asked about again.
  const again = run(environment(kokoro));
  assert.deepEqual([built(again.log), downloads(again.log)], [[], []]);
});

test('a choice the script does not know, or a config it was not sent, stops it before anything is built', () => {
  fresh();
  for (const [env, message] of [
    [{ VOICE_TTS: 'piper' }, /unknown speech engine 'piper'/],
    // Only Kokoro runs on the CPU, and recognition beside it is there too.
    [{ VOICE_TTS: 'breeze', VOICE_TTS_DEVICE: 'cpu' }, /speech engine 'breeze' runs on the GPU/],
    [{ VOICE_TTS: 'kokoro', VOICE_TTS_DEVICE: 'tpu' }, /unknown speech device 'tpu'/],
    [{ VOICE_TTS: 'kokoro', VOICE_TTS_DEVICE: 'cpu', VOICE_ASR: 'qwen3-asr', VOICE_ASR_MODEL: '0.6b', VOICE_ASR_DEVICE: 'gpu' }, /without speech synthesis on the GPU runs on the CPU/],
    [{ VOICE_ASR: 'qwen3-asr', VOICE_ASR_MODEL: 'base' }, /unknown speech recognition model 'qwen3-asr:base'/],
    [{ VOICE_ASR: 'whisper', VOICE_ASR_MODEL: '1.7b' }, /unknown speech recognition model 'whisper:1\.7b'/],
    [{ VOICE_ASR_DEVICE: 'tpu' }, /unknown recognition device 'tpu'/],
    // Whisper is never on the GPU, and without speech synthesis there is none to put recognition on.
    [{ VOICE_ASR_DEVICE: 'gpu' }, /runs on the CPU/],
    [{ VOICE_TTS: 'none', VOICE_ASR: 'qwen3-asr', VOICE_ASR_MODEL: '0.6b', VOICE_ASR_DEVICE: 'gpu' }, /runs on the CPU/],
  ] as const) {
    const { status, stderr, log } = run(env);
    assert.equal(status, 2, stderr);
    assert.match(stderr, message);
    assert.deepEqual(log, []);
  }
  // Only the original combination has a config of its own here.
  const missing = run({ VOICE_TTS: 'chatterbox' });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /VOICE_SERVER_CONFIG is missing/);
  // Qwen3-ASR on the CPU has none of its own to fall back on.
  fresh();
  const noCpuConfig = run({ VOICE_TTS: 'none', VOICE_ASR: 'qwen3-asr', VOICE_ASR_MODEL: '0.6b' });
  assert.equal(noCpuConfig.status, 2);
  assert.match(noCpuConfig.stderr, /VOICE_CPU_CONFIG is missing/);
  // Nor has Kokoro on the CPU.
  fresh();
  const noKokoroConfig = run({ VOICE_TTS: 'kokoro', VOICE_TTS_DEVICE: 'cpu' });
  assert.equal(noKokoroConfig.status, 2);
  assert.match(noKokoroConfig.stderr, /VOICE_CPU_CONFIG is missing/);
  // A container made before the device could be chosen has none set: Qwen3-ASR next to a speech engine is on the GPU, as it was.
  fresh();
  const legacy = run({ VOICE_TTS: 'breeze', VOICE_ASR: 'qwen3-asr', VOICE_ASR_MODEL: '0.6b', VOICE_SERVER_CONFIG: JSON.stringify(serverConfig({ tts: 'breeze', asr: 'qwen3-asr', asrModel: '0.6b' })) });
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.deepEqual(started(legacy.log).map(l => l.replace(/ bin=.*$/, '')), ['audiocpp_server --config /voice/server.json']);
});

test('what the GPU check found is the first line of the setup log', () => {
  fresh();
  const { stdout } = run({ ...environment(DEFAULT_CHOICE), VOICE_PLAN: 'Detected Test GPU: Breeze speech with Whisper base needs about 4.5 GiB, which fits.' });
  assert.equal(stdout.split('\n')[0], 'VOICE_STAGE: Detected Test GPU: Breeze speech with Whisper base needs about 4.5 GiB, which fits.');
});
