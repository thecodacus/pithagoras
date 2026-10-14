import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { checked, containerAction, containerState, dockerAvailable, ensureImage, PULL_STARTING, request } from './docker.js';
import { asrDevice, ttsDevice, choiceFromKey, choiceKey, cpuServerConfig, cpuThreads, DEFAULT_CHOICE, healthUrls, parseChoice, pickGpu, sameChoice, serverConfig, SPEECH_PORT, suggestChoice, suggestCpuChoice, ttsModel, usesGpu, type Gpu, type Host, type TtsEngine, type VoiceChoice } from '../voice-engines.js';
import { NoGpu, askedCard, cardOf, decide, detectGpus, deviceId, explain, holds, hostProbe, isNoGpu, readHost, SMI_ARGS, type Card, type Detected, type Probe } from '../voice-gpu.js';

export const CONTAINER = 'pithagoras-voice';
export const IMAGE = 'nvidia/cuda:12.4.1-devel-ubuntu22.04';
/** What a choice with nothing on the GPU runs in, and what the GPU check asks nvidia-smi with: no CUDA toolchain, so no multi-GB download. */
export const BASE_IMAGE = 'ubuntu:22.04';
/** The image a choice runs in: the CUDA one wherever the GPU is used, else the small base. */
export const imageFor = (choice: VoiceChoice) => usesGpu(choice) ? IMAGE : BASE_IMAGE;
const VOLUME = 'pithagoras_voice-models';
let pending = false;
let progress = '';
let error = '';
/**
 * The GPU chosen on the page, by UUID; empty leaves it to `VOICE_GPU` and then to the card with the most room.
 *
 * Set by the API from the stored choice. A UUID rather than an index, because the index order is the driver's
 * and a UUID names the same card after a reboot or a card added beside it.
 */
let chosenGpu = '';
export function useGpu(id: string): void { chosenGpu = id; }
async function healthy(url: string) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}
export interface ServiceStatus { available: boolean; state: string; busy: boolean; progress: string; error: string; /** The engines the managed container is built for, once there is one. */ choice?: VoiceChoice }
export async function status(): Promise<ServiceStatus> {
  if (!dockerAvailable()) return { available: false, state: 'unavailable', busy: false, progress: '', error: 'Automatic voice setup requires access to Docker.' };
  const state = await containerState(CONTAINER);
  if (state.running && !pending) {
    const detail = await request<{Config?: {Labels?: Record<string,string>}; HostConfig?: {NetworkMode?: string}}>('GET', `/containers/${CONTAINER}/json`);
    if (detail.body?.Config?.Labels?.['pithagoras.addon'] === 'voice') {
      const target = await voiceNetworkMode();
      if (detail.body.Config.Labels['pithagoras.voice-network'] !== 'shared-v1' || detail.body.HostConfig?.NetworkMode !== target) {
        await install();
        return {available:true, state:'installing', busy:true, progress:'Updating managed voice networking; keeping downloaded models', error:''};
      }
    }
  }
  let logs = '';
  if (state.exists) {
    // Tty=true in the container spec makes logs plain text, without Docker multiplex frames.
    const result = await request<string>('GET', `/containers/${CONTAINER}/logs?stdout=1&stderr=1&tail=25`);
    if (result.status === 200) logs = String(result.body ?? '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').slice(-6000);
  }
  const detail = state.exists ? await request<{ Config?: { Labels?: Record<string, string> }; State?: { ExitCode?: number; Error?: string } }>('GET', `/containers/${CONTAINER}/json`) : null;
  // A container made before engines could be chosen has no recipe label, and is the original combination.
  const labels = detail?.body?.Config?.Labels;
  const choice = labels?.['pithagoras.addon'] === 'voice' ? choiceFromKey(labels['pithagoras.voice-recipe']) : undefined;
  const ready = state.running && (await Promise.all(healthUrls(choice ?? DEFAULT_CHOICE).map(healthy))).every(Boolean);
  const failed = !state.running && Boolean(detail?.body?.State?.ExitCode);
  return { available: true, state: pending ? 'installing' : ready ? 'running' : state.running ? 'starting' : failed ? 'failed' : state.exists ? 'stopped' : 'absent', busy: pending, progress: pending ? progress : logs, error: error || (failed ? explain(detail?.body?.State?.Error || 'Voice setup or service exited. Review the log, then retry.') : ''), choice };
}
/** Share loopback with the portal; no published host ports or gateway lookup. */
export async function voiceNetworkMode(): Promise<string> {
  if (!existsSync('/.dockerenv') && !process.env.PORTAL_CONTAINER_NAME) {
    if (process.platform !== 'linux') throw new Error('Native managed voice requires Linux. Run the portal in Docker on this platform.');
    return 'host';
  }
  const name = process.env.PORTAL_CONTAINER_NAME || process.env.HOSTNAME;
  if (!name) throw new Error('Set PORTAL_CONTAINER_NAME to the portal Docker container name.');
  const detail = await request<{Id?: string; State?: {Running?: boolean}}>('GET', `/containers/${encodeURIComponent(name)}/json`);
  if (detail.status !== 200 || !detail.body?.Id || !detail.body.State?.Running) {
    throw new Error('Cannot identify the running portal container. Set PORTAL_CONTAINER_NAME to its Docker name.');
  }
  return `container:${detail.body.Id}`;
}
/** What a container is set up with besides its engines: the card, the threads of recognition on the CPU, and what the check found. */
interface Plan { card?: Card; note?: string; threads?: number }
/**
 * `plan.card` names the card when the host has several, or when one was chosen; without it Docker gives the
 * container one, as it has always done. Inside the container that card is the only one, so it is CUDA device 0
 * and server.json does not change with the choice. A choice with nothing on the GPU asks for none, and runs in
 * the small base image. `plan.threads` is what recognition on the CPU gets, and `plan.note` is what the check
 * found, which the script prints as the first line of the setup log.
 */
export function containerSpec(script: string, networkMode: string, choice: VoiceChoice = DEFAULT_CHOICE, plan: Plan = {}) {
  const gpu = plan.card ? { DeviceIDs: [deviceId(plan.card)] } : { Count: 1 };
  const server = serverConfig(choice), cpuServer = cpuServerConfig(choice, plan.threads);
  return { Image: imageFor(choice), Tty: true, Cmd: ['bash', '-c', script],
    Env: [`VOICE_TTS=${choice.tts}`, ...(ttsDevice(choice) ? [`VOICE_TTS_DEVICE=${ttsDevice(choice)}`] : []), `VOICE_ASR=${choice.asr}`, `VOICE_ASR_MODEL=${choice.asrModel}`, `VOICE_ASR_DEVICE=${asrDevice(choice)}`,
      ...(server ? [`VOICE_SERVER_CONFIG=${JSON.stringify(server)}`] : []), ...(cpuServer ? [`VOICE_CPU_CONFIG=${JSON.stringify(cpuServer)}`] : []),
      ...(plan.threads ? [`VOICE_THREADS=${plan.threads}`] : []), ...(plan.note ? [`VOICE_PLAN=${plan.note}`] : [])],
    Labels: { 'pithagoras.addon': 'voice', 'pithagoras.voice-network': 'shared-v1', 'pithagoras.voice-recipe': choiceKey(choice) },
    HostConfig: { Binds: [`${VOLUME}:/voice`], NetworkMode: networkMode,
      ...(usesGpu(choice) ? { DeviceRequests: [{ Driver: 'nvidia', ...gpu, Capabilities: [['gpu']] }] } : {}),
      RestartPolicy: { Name: 'no' }, LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '2' } } } };
}
/** The card a container was given. One made before a card was named asked Docker for any one GPU, and has none. */
const heldCard = (requests?: { DeviceIDs?: string[] | null }[] | null): Card | undefined => {
  const id = requests?.flatMap(r => r.DeviceIDs ?? [])[0];
  return id === undefined ? undefined : cardOf(id);
};
async function ensureContainer(script: string, choice: VoiceChoice, plan: Plan) {
  const networkMode = await voiceNetworkMode();
  const existing = await request<{Config?: {Labels?: Record<string,string>}; HostConfig?: {NetworkMode?: string; DeviceRequests?: { DeviceIDs?: string[] | null }[] | null}; State?: {Running?: boolean}}>('GET', `/containers/${CONTAINER}/json`);
  if (existing.status !== 404) {
    if (existing.status >= 400) throw new Error(`Cannot inspect voice container: Docker ${existing.status}`);
    if (existing.body.Config?.Labels?.['pithagoras.addon'] !== 'voice') throw new Error('The pithagoras-voice container is not a managed voice add-on. Rename it before installing.');
    const labels = existing.body.Config.Labels;
    // A card that is asked for and is not the one it has makes it another container, so that Start moves it.
    const onCard = !usesGpu(choice) || !plan.card || holds(heldCard(existing.body.HostConfig?.DeviceRequests), plan.card);
    const current = labels['pithagoras.voice-network'] === 'shared-v1' && existing.body.HostConfig?.NetworkMode === networkMode && sameChoice(choiceFromKey(labels['pithagoras.voice-recipe']), choice) && onCard;
    if (current) { await containerAction(CONTAINER, 'start'); return; }
    // Container config is immutable. Retain /voice and the cached model/build
    // files while replacing the old published-port container, a stale namespace
    // or one built for other engines.
    await containerAction(CONTAINER, 'remove');
  }
  await checked('POST', '/volumes/create', { Name: VOLUME });
  await checked('POST', `/containers/create?name=${CONTAINER}`, containerSpec(script, networkMode, choice, plan));
  await containerAction(CONTAINER, 'start');
}

/** The managed container as far as a recreation has to keep it: its engines and the card it was given. None when there is no managed container. */
async function installedContainer(): Promise<{ choice: VoiceChoice; card?: Card; running: boolean } | undefined> {
  const found = await request<{Config?: {Labels?: Record<string,string>}; HostConfig?: {DeviceRequests?: {DeviceIDs?: string[] | null}[] | null}; State?: {Running?: boolean}}>('GET', `/containers/${CONTAINER}/json`);
  const labels = found.status === 200 ? found.body?.Config?.Labels : undefined;
  if (labels?.['pithagoras.addon'] !== 'voice') return undefined;
  return { choice: choiceFromKey(labels['pithagoras.voice-recipe']), card: heldCard(found.body.HostConfig?.DeviceRequests), running: Boolean(found.body.State?.Running) };
}

/** The image of a setup, with what the download says shown on the page; what is said before the first line comes is not worth showing over what was there. */
const downloadImage = (image: string) => ensureImage(image, state => { if (state.active && state.line !== PULL_STARTING) progress = state.line; });

/**
 * nvidia-smi inside a short-lived container, for a portal that runs in a container itself and has no GPU
 * tool. The container is of the small base image, which the toolkit gives nvidia-smi to as it does to any
 * other: the CUDA image is many gigabytes, and a host without a GPU has no use for it. Docker refusing
 * to start a container that asks for a GPU is the answer "no GPU" here.
 */
const dockerProbe: Probe = {
  name: 'docker',
  async run() {
    if (!dockerAvailable()) throw new NoGpu('Docker is unavailable');
    await ensureImage(BASE_IMAGE, undefined, 120000).catch(unanswered);
    const created = await checked<{ Id: string }>('POST', '/containers/create', { Image: BASE_IMAGE, Tty: true, Cmd: ['nvidia-smi', ...SMI_ARGS],
      // nvidia-smi is a utility of the driver: the image says nothing of it, so it is asked for.
      Env: ['NVIDIA_DRIVER_CAPABILITIES=utility'], Labels: { 'pithagoras.addon': 'voice-probe' }, HostConfig: { DeviceRequests: [{ Driver: 'nvidia', Count: -1, Capabilities: [['gpu']] }] } }).catch(unanswered);
    const id = created.body.Id;
    try {
      await checked('POST', `/containers/${id}/start`);
      const done = await request<{ StatusCode?: number }>('POST', `/containers/${id}/wait`, undefined, 30000);
      const logs = await request<string>('GET', `/containers/${id}/logs?stdout=1&stderr=1`);
      const text = String(logs.body ?? '');
      if (done.body?.StatusCode) throw new Error(text.trim().split('\n').at(-1) || 'nvidia-smi failed');
      return text;
    } finally { await request('DELETE', `/containers/${id}?force=1`).catch(() => {}); }
  },
};
/** A Docker that does not answer at all, a socket error rather than a refusal, is no GPU either. */
const unanswered = (e: unknown): never => { throw typeof (e as NodeJS.ErrnoException).code === 'string' ? new NoGpu('Docker did not answer') : e; };
let probing: Promise<Detected> | undefined;
/**
 * The GPUs, and whether Docker can hand them to a container: the first probe that lists a card wins, but the
 * host listing a card is not Docker having a runtime for it, as on a desktop with the driver and without the
 * NVIDIA Container Toolkit. Where Docker refuses, those cards are no GPU for voice, and are said to be unusable.
 */
async function detectGpuUse(): Promise<Detected> {
  const found = await detectGpus([hostProbe, dockerProbe]);
  if (found.source !== 'host' || !dockerAvailable()) return found;
  try { await dockerProbe.run(); }
  catch (e) {
    // Only Docker saying there is no GPU for it counts; not being able to ask leaves the host's word.
    if (isNoGpu((e as Error).message)) return { gpus: [], source: 'none', error: 'docker: no GPU available', checked: true, unusable: found.gpus.map(g => g.name) };
  }
  return found;
}
/**
 * One probe at a time: the page asks as it opens, and an install asks too. A `fresh` answer is one that was
 * not begun before the caller did something that changes what is read, such as stopping the service whose memory
 * would count as taken: it waits for a probe that is running to end, and takes its own.
 */
async function detect(fresh = false): Promise<Detected> {
  if (fresh && probing) await probing.catch(() => {});
  probing ??= detectGpuUse().finally(() => { probing = undefined; });
  return probing;
}
/** The managed container as `installedContainer` reads it. */
type Installed = NonNullable<Awaited<ReturnType<typeof installedContainer>>>;
/**
 * The card an installed service is to be moved to: the one asked for, or another where the one it was given is no longer
 * on the host (a container is pinned to its card, and Docker refuses one that was taken out). The engines it has were never
 * checked against that card, so it is held to what a new install is: refused, with what would fit, where the card cannot
 * hold them. Nothing where the service stays; where no card could be read, what is asked for is taken as it is.
 */
function moveTo(existing: Installed, gpus: readonly Gpu[], asked: Card | undefined): Card | undefined {
  if (!gpus.length) return asked;
  const gone = !!existing.card && !gpus.some(g => holds(existing.card, g));
  const target = asked ?? (gone ? pickGpu(gpus) : undefined);
  if (target && !holds(existing.card, target)) decide(existing.choice, gpus, { reserveMiB: reserveMiB(), preferredGpu: target.index, host: hostReader.read() });
  return target;
}
/** Throws where this GPU cannot be chosen: it is not on the host, or the engines installed cannot be held by it. */
export async function checkGpu(uuid: string) {
  const { gpus } = await detect();
  const card = gpus.find(g => g.uuid === uuid);
  if (!card) throw new Error('That GPU is not on this host');
  const existing = dockerAvailable() ? await installedContainer().catch(() => undefined) : undefined;
  if (existing && usesGpu(existing.choice)) moveTo(existing, gpus, card);
}
/**
 * `VOICE_GPU` picks the card, as it does for the Compose service, where none was chosen on the page;
 * `VOICE_VRAM_RESERVE_MIB` keeps memory on it free for something else.
 */
const preferredGpu = () => /^\d+$/.test(process.env.VOICE_GPU ?? '') ? Number(process.env.VOICE_GPU) : undefined;
const reserveMiB = () => { const n = Math.round(Number(process.env.VOICE_VRAM_RESERVE_MIB)); return n > 0 ? n : 0; };

/** What recognition on the CPU has to run on. Replaceable, so that what a host has can be told without being that host. */
export const hostReader = { read: (): Host => readHost() };

/**
 * What the GPU check finds, and what it would suggest, for the page to show before anything is installed.
 * `cpuOnly` is that the check found there is no GPU: what is suggested is then Kokoro on the CPU, or recognition alone on the CPU where the host is too small for it.
 * `selected` is the card it would use: the one asked for, by the choice on the page (`chosen`, a UUID) or by `VOICE_GPU`; else, with a container,
 * the one it is on and not the one with the most room, as the memory the service holds is what makes its own card look full.
 */
export async function hardware() {
  // No Docker, or one that does not answer, is no container: the GPUs can still be read from the host.
  const existing = dockerAvailable() ? await installedContainer().catch(() => undefined) : undefined;
  const found = await detect();
  const reserve = reserveMiB();
  const host = hostReader.read();
  const cpuOnly = found.checked && !found.gpus.length;
  const held = existing && usesGpu(existing.choice) ? found.gpus.find(g => holds(existing.card, g)) : undefined;
  const gpu = pickGpu(found.gpus, (askedCard(found.gpus, chosenGpu, preferredGpu()) ?? held)?.index);
  // A choice for a card that is no longer there is not one: the page shows what is used.
  const chosen = found.gpus.find(g => g.uuid && g.uuid === chosenGpu)?.uuid ?? '';
  return { ...found, host, cpuOnly, selected: gpu?.index ?? null, chosen, reserveMiB: reserve, suggestion: cpuOnly ? suggestCpuChoice(host) : suggestChoice(gpu, reserve) };
}

/**
 * Installs the managed container, or starts it. `requested` is the engines to run: a new
 * installation without it takes what the GPU check suggests, and an existing container
 * without it keeps the engines it has. A different choice recreates the container; the
 * downloads and builds in the volume stay.
 */
export async function install(requested?: VoiceChoice) {
  if (pending) throw new Error('Voice setup is already in progress');
  if (!dockerAvailable()) throw new Error('Docker is unavailable');
  const wanted = requested && parseChoice(requested);
  pending = true; error = ''; progress = 'Preparing voice setup';
  // Read before returning so a packaging error is reported immediately.
  let script: string;
  try { script = await readFile(new URL('../../../../deploy/voice/setup.sh', import.meta.url), 'utf8'); }
  catch (e) { pending = false; throw e; }
  void (async () => {
    try {
      const existing = await installedContainer();
      let choice = wanted ?? existing?.choice;
      // Recreated with the engines it has, the container stays on the card it was given, if it was given one.
      let plan: Plan = { card: existing && usesGpu(existing.choice) ? existing.card : undefined };
      // An installed choice that is kept ran before this check existed, and a restart must not be refused for it.
      if (!existing || (wanted && !sameChoice(wanted, existing.choice))) {
        // The running container is about to be replaced. Left up, the memory it holds would count as used by other programs,
        // and the card with the most room could be another one than its own.
        const stopped = existing?.running;
        if (stopped) await containerAction(CONTAINER, 'stop');
        try {
          progress = 'Checking the GPU';
          // Read after the stop, not from a check of the page that began while the service still held its memory.
          const found = await detect(true);
          const asked = askedCard(found.gpus, chosenGpu, preferredGpu());
          // A host that was found to have no GPU gets recognition alone, on the CPU, in the small image.
          const decision = decide(wanted, found.gpus, { reserveMiB: reserveMiB(), preferredGpu: asked?.index, host: hostReader.read(), noGpu: found.checked && !found.gpus.length, unusable: found.unusable });
          choice = decision.choice;
          // With one card Docker's own pick is the card; only a choice among several needs naming. A choice with nothing on the GPU names none.
          plan = { card: !usesGpu(choice) ? undefined : found.gpus.length > 1 ? decision.gpu : found.gpus.length ? undefined : asked, note: decision.summary };
          progress = decision.summary;
          await downloadImage(imageFor(choice));
        } catch (e) {
          // Refused, or the image did not come: the service that was running goes on running.
          if (stopped) await request('POST', `/containers/${CONTAINER}/start`).catch(() => {});
          throw e;
        }
      } else {
        if (usesGpu(existing.choice) && (chosenGpu || preferredGpu() !== undefined || existing.card)) {
          // A kept choice is not checked against the card it is on, but a move to another one is, and a card that is asked for has to be one that
          // is there, as an install insists. Where no GPU can be read it is taken as it is, as an install does.
          const { gpus } = await detect();
          const target = moveTo(existing, gpus, askedCard(gpus, chosenGpu, preferredGpu()));
          if (target) plan = { card: target };
        }
        await downloadImage(imageFor(existing.choice));
      }
      const final = choice ?? DEFAULT_CHOICE;
      // What runs on the CPU gets the threads the host has, up to the ones its speeds were measured on; what is on the GPU keeps its four.
      if (!usesGpu(final) || (final.asr === 'qwen3-asr' && asrDevice(final) === 'cpu') || ttsDevice(final) === 'cpu') plan.threads = cpuThreads(hostReader.read().threads);
      await ensureContainer(script, final, plan);
    } catch (e) { error = explain((e as Error).message); }
    finally { pending = false; }
  })();
}
export async function start() {
  await install();
}
export async function stop() {
  if (pending) throw new Error('Wait for the image download to finish before stopping');
  await containerAction(CONTAINER, 'stop');
  error = '';
}

/** The container is gone, and the volume with the downloads is not: what the caller has to go on with is the same, and what it says is not. */
export class DataNotRemoved extends Error {}
/**
 * Removes the managed container, and with `removeData` the volume that holds its downloads and builds (the engines and
 * models), which a reinstall would otherwise reuse. Nothing there is not an error: the container may have been removed by hand.
 * The image is left, as other containers may be made from it. A volume that cannot be removed is a `DataNotRemoved`, thrown
 * when the container is already gone.
 */
export async function uninstall(removeData = false) {
  if (pending) throw new Error('Wait for voice setup to finish before uninstalling');
  if (!dockerAvailable()) throw new Error('Docker is unavailable');
  // Held like a setup: the page shows it as under way, and no start or install begins in the middle of it.
  pending = true; error = ''; progress = 'Removing the voice service';
  try {
    const found = await request<{Config?: {Labels?: Record<string,string>}; State?: {Running?: boolean}}>('GET', `/containers/${CONTAINER}/json`);
    if (found.status !== 404) {
      if (found.status >= 400) throw new Error(`Cannot inspect voice container: Docker ${found.status}`);
      if (found.body.Config?.Labels?.['pithagoras.addon'] !== 'voice') throw new Error('The pithagoras-voice container is not a managed voice add-on, so it is left alone.');
      await containerAction(CONTAINER, 'remove');
    }
    if (removeData) {
      progress = 'Removing the downloaded engines and models';
      const volume = await request<{ message?: string }>('DELETE', `/volumes/${VOLUME}`);
      if (volume.status >= 400 && volume.status !== 404) throw new DataNotRemoved(`The voice container is removed, but its downloaded engines and models could not be deleted: ${volume.body?.message || `Docker returned ${volume.status}`}`);
    }
  } finally { pending = false; }
}

/** `port` is the audio.cpp process the engine is in: the GPU one, unless speech is put on the CPU. */
export async function modelAction(action:'load'|'unload', engine: TtsEngine = 'breeze', port = SPEECH_PORT) {
  const model = ttsModel(engine);
  const response=await fetch(`http://127.0.0.1:${port}/v1/models/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(action==='load'?model:{id:model.id}),signal:AbortSignal.timeout(120000)});
  if(!response.ok)throw new Error(`Voice model ${action} failed (${response.status}): ${(await response.text()).slice(0,300)}`);
}
