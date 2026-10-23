import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { asrDevice, ttsDevice, choiceFromKey, choiceKey, cpuServerConfig, cpuThreads, DEFAULT_CHOICE, healthUrls, parseChoice, pickGpu, sameChoice, serverConfig, SPEECH_PORT, suggestChoice, suggestCpuChoice, ttsModel, usesGpu, type Gpu, type Host, type TtsEngine, type VoiceChoice } from '../engines';
import { CHATTERBOX_LANGUAGES } from '../languages';
import { NoGpu, askedCard, cardOf, decide, detectGpus, deviceId, explain, holds, hostProbe, isNoGpu, readHost, SMI_ARGS, type Card, type Detected, type Probe } from './gpu';
import { docker, portal } from './host';
import { putSettings, setting, speech } from './store';

/**
 * The voice service: speech recognition and speech synthesis, built and run in a container of their own. Docker runs
 * the container (`pithagoras-docker`, which Voice requires), and what Voice may do with it is what Docker lets any
 * extension do with its own. The container and the volume the portal made before Voice was an extension carry no
 * extension's name, and are taken over by their names (`adoptKept`, and again before Voice acts on them).
 */

export const CONTAINER = 'pithagoras-voice';
export const IMAGE = 'nvidia/cuda:12.4.1-devel-ubuntu22.04';
/** What a choice with nothing on the GPU runs in, and what the GPU check asks nvidia-smi with: no CUDA toolchain, so no multi-GB download. */
export const BASE_IMAGE = 'ubuntu:22.04';
/** The image a choice runs in: the CUDA one wherever the GPU is used, else the small base. */
export const imageFor = (choice: VoiceChoice) => usesGpu(choice) ? IMAGE : BASE_IMAGE;
const VOLUME = 'pithagoras_voice-models';
/** The short-lived container the GPU check runs nvidia-smi in: shown in Settings → Docker while it runs. */
const PROBE = 'pithagoras-voice-probe';
/** The setup script, which the package ships beside its server half as it is built (server.js). Replaceable, so that the half can be run from its source. */
export const setupScript = { url: new URL('./setup.sh', import.meta.url) };
/** A container by the voice container's name that is not the voice service's: it is left alone. */
class NotVoices extends Error {
  constructor() { super('The pithagoras-voice container is not the voice service\'s, so it is left alone. Rename it before installing.'); }
}
let pending = false;
let progress = '';
let error = '';
/** The GPU chosen on the page, by UUID (`gpu` in the store); empty leaves it to `VOICE_GPU` and then to the card with the most room. */
const chosenGpu = () => setting('gpu') ?? '';
async function healthy(url: string) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}
/** Of Docker's inspect body, what is read here. */
type Inspected = { Config?: { Labels?: Record<string, string> | null }; HostConfig?: { NetworkMode?: string; DeviceRequests?: { DeviceIDs?: string[] | null }[] | null; RestartPolicy?: { Name?: string } }; State?: { Running?: boolean; Restarting?: boolean; ExitCode?: number; Error?: string; StartedAt?: string }; RestartCount?: number };
/**
 * How Docker restarts the voice container, as it does Browser's and Understory's: after it exits, and as Docker starts
 * after the host restarts, unless the person stopped it (Stop on the page, or in Settings → Docker), which it then stays.
 */
const RESTART = { Name: 'unless-stopped' };
/** Docker's answer that there is no such container or volume, which is no failure where nothing has to be there. */
function absent(e: unknown): void {
  if ((e as { status?: number }).status !== 404) throw e;
}
/**
 * How the voice container was made and how it stands, where there is one: one the portal made before Voice was an
 * extension is taken over first. One by its name that is not the voice service's is refused, and left alone. One made
 * with another restart policy, as Voice made them before, is given Voice's (`RESTART`).
 */
async function inspected(): Promise<Inspected | undefined> {
  const d = docker();
  const found = await d.containers.get(CONTAINER);
  if (!found) return undefined;
  if (found.owner !== portal().extension) {
    if (found.owner || found.labels['pithagoras.addon'] !== 'voice') throw new NotVoices();
    // One removed since it was looked at, as a setup that makes it again does, is not there to take over; what is there now is read below.
    await d.containers.adopt(CONTAINER).catch(absent);
  }
  const detail = (await d.containers.inspect(CONTAINER)) as Inspected | undefined;
  // Changed in place, not made again: Docker does not restart it for that, its downloads and its setup stay as they are,
  // and one the person stopped stays stopped. One removed since it was looked at has nothing to change. One Docker will
  // not change now (one being removed, say) is changed at the next look: reading it, stopping it or removing it does not
  // wait on that.
  if (detail && detail.HostConfig?.RestartPolicy?.Name !== RESTART.Name)
    await d.containers.update(CONTAINER, { RestartPolicy: RESTART }).catch((e) => {
      if ((e as { status?: number }).status !== 404) portal().log(`could not give the voice container the ${RESTART.Name} restart policy: ${(e as Error).message}`);
    });
  return detail;
}
/**
 * When the run of the container that its services last all answered in began (Docker's `State.StartedAt`), as `status`
 * found since the half started. Docker goes on counting a start it made by itself (`RestartCount`) for as long as the
 * run it began lasts, so a run they answered in is one that came back, and no longer one of Docker's tries (`retrying`).
 */
let answered: string | undefined;
/**
 * Docker is starting the container again by itself, after its setup or a service exited (`RESTART`), and goes on doing
 * so, with the wait between the tries that Docker sets: it is running to Docker while it waits for the next try
 * (`Restarting`), and in a try it is a run Docker began (`RestartCount`, from none again at each start it is asked for,
 * and at the one it makes itself as the host starts) that its services have not answered in (`answered`). One they
 * answered in came back: a health check that is slow once after that is not a try of Docker's. A stop ends the tries.
 */
const retrying = (found: Inspected | undefined) => found?.State?.Running === true && Boolean(found.State.Restarting || (found.RestartCount && found.State.StartedAt !== answered));
export interface ServiceStatus { available: boolean; state: string; busy: boolean; progress: string; error: string; /** The engines the container is built for, once there is one. */ choice?: VoiceChoice; /** Docker is starting it again after it failed (`retrying`), which a stop ends. */ retrying?: boolean }
/**
 * The engines of the running container, from when they were first found answering until the container is found stopped,
 * gone or being made again, as `status` last found: where voice mode listens and speaks is asked at each of its requests,
 * and has to be answered at once. A health check that is slow once, as an engine busy speaking may be, or a Docker slow
 * to answer, does not take them away from voice mode in the middle of a conversation.
 */
let served: VoiceChoice | undefined;
export const serving = () => served;
export async function status(): Promise<ServiceStatus> {
  const seen = await statusNow();
  if (seen.state === 'running') served = seen.choice;
  else if (seen.state !== 'starting' && seen.state !== 'unavailable') served = undefined;
  return seen;
}
async function statusNow(): Promise<ServiceStatus> {
  const d = docker();
  if (!(await d.available())) return { available: false, state: 'unavailable', busy: false, progress: '', error: 'Automatic voice setup requires access to Docker.' };
  let detail: Inspected | undefined;
  try { detail = await inspected(); }
  catch (e) { if (!(e instanceof NotVoices)) throw e; return { available: true, state: 'failed', busy: false, progress: '', error: e.message }; }
  // One Docker waits to start again is running to Docker, with nothing running in it.
  const running = detail?.State?.Running === true && !detail.State.Restarting;
  // A running container rejoins the portal's loopback after the portal's own container was made again; stopped ones stay stopped.
  if (running && !pending) {
    const target = await d.sharedNetwork();
    if (detail!.Config?.Labels?.['pithagoras.voice-network'] !== 'shared-v1' || detail!.HostConfig?.NetworkMode !== target) {
      await install();
      return {available:true, state:'installing', busy:true, progress:'Updating managed voice networking; keeping downloaded models', error:''};
    }
  }
  // Tty=true in the container spec makes logs plain text, without Docker multiplex frames. One removed since it was
  // looked at, as a setup that makes it again does, has none.
  const written = detail ? await d.containers.logs(CONTAINER, { tail: 25 }).catch((e) => { absent(e); return ''; }) : '';
  const logs = written.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').slice(-6000);
  // A container made before engines could be chosen has no recipe label, and is the original combination.
  const choice = detail ? choiceFromKey(detail.Config?.Labels?.['pithagoras.voice-recipe']) : undefined;
  const ready = running && (await Promise.all(healthUrls(choice ?? DEFAULT_CHOICE).map(healthy))).every(Boolean);
  if (ready) answered = detail!.State!.StartedAt;
  // A container Docker is starting again by itself is one whose setup or service failed, until its services answer:
  // between the tries, and in one, which is Docker's and not a start of the person's. Its exit code is the last
  // failure's only between the tries, as Docker clears it when each begins.
  const retried = retrying(detail);
  const failed = !ready && (retried || (!running && Boolean(detail?.State?.ExitCode)));
  return { available: true, state: pending ? 'installing' : ready ? 'running' : failed ? 'failed' : running ? 'starting' : detail ? 'stopped' : 'absent', busy: pending, progress: pending ? progress : logs, error: error || (failed ? explain(detail?.State?.Error || (retried ? 'Voice setup or service exited, and Docker is starting it again. Review the log, or retry now.' : 'Voice setup or service exited. Review the log, then retry.')) : ''), choice, retrying: retried };
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
      RestartPolicy: RESTART, LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '2' } } } };
}
/** The card a container was given. One made before a card was named asked Docker for any one GPU, and has none. */
const heldCard = (requests?: { DeviceIDs?: string[] | null }[] | null): Card | undefined => {
  const id = requests?.flatMap(r => r.DeviceIDs ?? [])[0];
  return id === undefined ? undefined : cardOf(id);
};
async function ensureContainer(script: string, choice: VoiceChoice, plan: Plan) {
  const d = docker();
  const networkMode = await d.sharedNetwork();
  const existing = await inspected();
  if (existing) {
    const labels = existing.Config?.Labels ?? {};
    // A card that is asked for and is not the one it has makes it another container, so that Start moves it.
    const onCard = !usesGpu(choice) || !plan.card || holds(heldCard(existing.HostConfig?.DeviceRequests), plan.card);
    const current = labels['pithagoras.voice-network'] === 'shared-v1' && existing.HostConfig?.NetworkMode === networkMode && sameChoice(choiceFromKey(labels['pithagoras.voice-recipe']), choice) && onCard;
    if (current) {
      // One Docker is starting again is running to Docker, so a start would leave it to Docker's next try, or to the one
      // under way: it is stopped first, so that a retry runs the setup now, and the tries are counted from none. One that
      // came back is left running, as a start finds it.
      if (retrying(existing)) await d.containers.stop(CONTAINER);
      await d.containers.start(CONTAINER);
      return;
    }
  }
  // Container config is immutable: one with a stale namespace, or built for other engines or another card, is made
  // again below, which replaces it. /voice, with the cached model and build files, is kept. The volume the portal
  // made before Voice was an extension is taken over; one there is none of is made.
  await d.volumes.adopt(VOLUME).catch(absent);
  await d.volumes.create(VOLUME);
  await d.containers.create(CONTAINER, containerSpec(script, networkMode, choice, plan));
  await d.containers.start(CONTAINER);
}

/** The container as far as a recreation has to keep it: its engines and the card it was given. None when there is no voice container. */
async function installedContainer(): Promise<{ choice: VoiceChoice; card?: Card; running: boolean } | undefined> {
  const found = await inspected();
  const labels = found?.Config?.Labels;
  if (labels?.['pithagoras.addon'] !== 'voice') return undefined;
  return { choice: choiceFromKey(labels['pithagoras.voice-recipe']), card: heldCard(found!.HostConfig?.DeviceRequests), running: Boolean(found!.State?.Running) };
}

/** The image of a setup, with what the download says shown on the page; what Docker says before the first line comes ("starting") is not worth showing over what was there. */
const downloadImage = (image: string) => docker().images.ensure(image, state => { if (state.active && state.line !== 'starting') progress = state.line; });

/** `work`, or a failure that says `what` once `ms` have gone by. */
async function within<T>(ms: number, work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(what)), ms); })]); }
  finally { clearTimeout(timer); }
}
/**
 * nvidia-smi inside a short-lived container, for a portal that runs in a container itself and has no GPU
 * tool. The container is of the small base image, which the toolkit gives nvidia-smi to as it does to any
 * other: the CUDA image is many gigabytes, and a host without a GPU has no use for it. Docker refusing
 * to start a container that asks for a GPU is the answer "no GPU" here, and so is a Docker that does not answer.
 */
const dockerProbe: Probe = {
  name: 'docker',
  async run() {
    const d = docker();
    if (!(await d.available())) throw new NoGpu('Docker did not answer');
    await within(120000, d.images.ensure(BASE_IMAGE), `${BASE_IMAGE} was not downloaded in time`);
    await d.containers.create(PROBE, { Image: BASE_IMAGE, Tty: true, Cmd: ['nvidia-smi', ...SMI_ARGS],
      // nvidia-smi is a utility of the driver: the image says nothing of it, so it is asked for.
      Env: ['NVIDIA_DRIVER_CAPABILITIES=utility'], Labels: { 'pithagoras.addon': 'voice-probe' }, HostConfig: { DeviceRequests: [{ Driver: 'nvidia', Count: -1, Capabilities: [['gpu']] }] } });
    try {
      await d.containers.start(PROBE);
      // Until it has exited: Docker's own wait is not one an extension is given.
      const ended = Date.now() + 30000;
      let state: Inspected['State'];
      while ((state = ((await d.containers.inspect(PROBE)) as Inspected | undefined)?.State)?.Running) {
        if (Date.now() > ended) throw new Error('nvidia-smi did not end in time');
        await delay(200);
      }
      const text = await d.containers.logs(PROBE);
      if (state?.ExitCode) throw new Error(text.trim().split('\n').at(-1) || 'nvidia-smi failed');
      return text;
    } finally { await d.containers.remove(PROBE).catch(() => {}); }
  },
};
let probing: Promise<Detected> | undefined;
/**
 * The GPUs, and whether Docker can hand them to a container: the first probe that lists a card wins, but the
 * host listing a card is not Docker having a runtime for it, as on a desktop with the driver and without the
 * NVIDIA Container Toolkit. Where Docker refuses, those cards are no GPU for voice, and are said to be unusable.
 */
async function detectGpuUse(): Promise<Detected> {
  const found = await detectGpus([hostProbe, dockerProbe]);
  if (found.source !== 'host' || !(await docker().available())) return found;
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
/** The container as `installedContainer` reads it. */
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
  const existing = await docker().available() ? await installedContainer().catch(() => undefined) : undefined;
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
  const existing = await docker().available() ? await installedContainer().catch(() => undefined) : undefined;
  const found = await detect();
  const reserve = reserveMiB();
  const host = hostReader.read();
  const cpuOnly = found.checked && !found.gpus.length;
  const held = existing && usesGpu(existing.choice) ? found.gpus.find(g => holds(existing.card, g)) : undefined;
  const gpu = pickGpu(found.gpus, (askedCard(found.gpus, chosenGpu(), preferredGpu()) ?? held)?.index);
  // A choice for a card that is no longer there is not one: the page shows what is used.
  const chosen = found.gpus.find(g => g.uuid && g.uuid === chosenGpu())?.uuid ?? '';
  return { ...found, host, cpuOnly, selected: gpu?.index ?? null, chosen, reserveMiB: reserve, suggestion: cpuOnly ? suggestCpuChoice(host) : suggestChoice(gpu, reserve) };
}

/**
 * Installs the voice container, or starts it. `requested` is the engines to run: a new
 * installation without it takes what the GPU check suggests, and an existing container
 * without it keeps the engines it has. A different choice recreates the container; the
 * downloads and builds in the volume stay.
 */
export async function install(requested?: VoiceChoice) {
  if (pending) throw new Error('Voice setup is already in progress');
  const wanted = requested && parseChoice(requested);
  pending = true; error = ''; progress = 'Preparing voice setup';
  let script: string;
  try {
    if (!(await docker().available())) throw new Error('Docker is unavailable');
    // Read before returning so a packaging error is reported immediately.
    script = await readFile(setupScript.url, 'utf8');
  }
  catch (e) { pending = false; throw e; }
  void (async () => {
    const d = docker();
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
        if (stopped) await d.containers.stop(CONTAINER);
        try {
          progress = 'Checking the GPU';
          // Read after the stop, not from a check of the page that began while the service still held its memory.
          const found = await detect(true);
          const asked = askedCard(found.gpus, chosenGpu(), preferredGpu());
          // A host that was found to have no GPU gets recognition alone, on the CPU, in the small image.
          const decision = decide(wanted, found.gpus, { reserveMiB: reserveMiB(), preferredGpu: asked?.index, host: hostReader.read(), noGpu: found.checked && !found.gpus.length, unusable: found.unusable });
          choice = decision.choice;
          // With one card Docker's own pick is the card; only a choice among several needs naming. A choice with nothing on the GPU names none.
          plan = { card: !usesGpu(choice) ? undefined : found.gpus.length > 1 ? decision.gpu : found.gpus.length ? undefined : asked, note: decision.summary };
          progress = decision.summary;
          await downloadImage(imageFor(choice));
        } catch (e) {
          // Refused, or the image did not come: the service that was running goes on running.
          if (stopped) await d.containers.start(CONTAINER).catch(() => {});
          throw e;
        }
      } else {
        if (usesGpu(existing.choice) && (chosenGpu() || preferredGpu() !== undefined || existing.card)) {
          // A kept choice is not checked against the card it is on, but a move to another one is, and a card that is asked for has to be one that
          // is there, as an install insists. Where no GPU can be read it is taken as it is, as an install does.
          const { gpus } = await detect();
          const target = moveTo(existing, gpus, askedCard(gpus, chosenGpu(), preferredGpu()));
          if (target) plan = { card: target };
        }
        await downloadImage(imageFor(existing.choice));
      }
      const final = choice ?? DEFAULT_CHOICE;
      // What runs on the CPU gets the threads the host has, up to the ones its speeds were measured on; what is on the GPU keeps its four.
      if (!usesGpu(final) || (final.asr === 'qwen3-asr' && asrDevice(final) === 'cpu') || ttsDevice(final) === 'cpu') plan.threads = cpuThreads(hostReader.read().threads);
      // Chatterbox is told a language or it refuses, and has no detection mode: one it does not speak becomes English.
      if (final.tts === 'chatterbox' && !CHATTERBOX_LANGUAGES.includes(speech().language)) putSettings({ language: 'en' });
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
  if (await inspected()) await docker().containers.stop(CONTAINER);
  error = '';
}

/** The container is gone, and the volume with the downloads is not: what the caller has to go on with is the same, and what it says is not. */
export class DataNotRemoved extends Error {}
/**
 * Removes the voice container, and with `removeData` the volume that holds its downloads and builds (the engines and
 * models), which a reinstall would otherwise reuse. Nothing there is not an error: the container may have been removed by hand.
 * The image is left, as other containers may be made from it. A volume that cannot be removed is a `DataNotRemoved`, thrown
 * when the container is already gone.
 */
export async function uninstall(removeData = false) {
  if (pending) throw new Error('Wait for voice setup to finish before uninstalling');
  // Held like a setup: the page shows it as under way, and no start or install begins in the middle of it.
  pending = true; error = ''; progress = 'Removing the voice service';
  try {
    const d = docker();
    if (!(await d.available())) throw new Error('Docker is unavailable');
    if (await inspected()) await d.containers.remove(CONTAINER);
    if (removeData) {
      progress = 'Removing the downloaded engines and models';
      try {
        // Taken over first, as the container is; one that is gone already is gone.
        await d.volumes.adopt(VOLUME).catch(absent);
        await d.volumes.remove(VOLUME);
      } catch (e) { throw new DataNotRemoved(`The voice container is removed, but its downloaded engines and models could not be deleted: ${(e as Error).message}`); }
    }
  } finally { pending = false; }
}

/**
 * Takes over the container and the volume the portal made before Voice was an extension, by their names, so that Voice
 * may start, stop and remove them as its own: as the half starts, every time, so that a record of them Docker lost is
 * made again. A container made with another restart policy, as Voice made them before, is given Voice's here too
 * (`inspected`). Nothing is made or started here. One that is not there is not taken over, and one that is not the voice service's is
 * not Voice's to take, which the portal's log says.
 */
export async function adoptKept(): Promise<void> {
  const d = docker();
  if (!(await d.available())) return;
  const take = (what: string, adopt: () => Promise<unknown>) =>
    adopt().catch((e) => {
      if ((e as { status?: number }).status !== 404) portal().log(`could not take over ${what}: ${(e as Error).message}`);
    });
  await take(`the voice service's downloads, the volume ${VOLUME}`, () => d.volumes.adopt(VOLUME));
  await take(`the voice container ${CONTAINER}`, inspected);
}

/** `port` is the audio.cpp process the engine is in: the GPU one, unless speech is put on the CPU. */
export async function modelAction(action:'load'|'unload', engine: TtsEngine = 'breeze', port = SPEECH_PORT) {
  const model = ttsModel(engine);
  const response=await fetch(`http://127.0.0.1:${port}/v1/models/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(action==='load'?model:{id:model.id}),signal:AbortSignal.timeout(120000)});
  if(!response.ok)throw new Error(`Voice model ${action} failed (${response.status}): ${(await response.text()).slice(0,300)}`);
}
