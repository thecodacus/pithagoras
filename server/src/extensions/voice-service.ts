import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { containerState, dockerAvailable, imagePresent, pullImage, request } from './docker.js';

export const CONTAINER = 'pithagoras-voice';
export const IMAGE = 'nvidia/cuda:12.4.1-devel-ubuntu22.04';
const VOLUME = 'pithagoras_voice-models';
export const whisperUrl = 'http://127.0.0.1:8188/inference';
export const breezeUrl = 'http://127.0.0.1:7862/v1/audio/speech';
let pending = false;
let progress = '';
let error = '';
async function checked(method: string, path: string, body?: unknown) {
  const result = await request<{ message?: string }>(method, path, body);
  if (result.status >= 400) throw new Error(result.body?.message || `Docker returned ${result.status}`);
  return result;
}
async function healthy(url: string) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}
export async function status() {
  if (!dockerAvailable()) return { available: false, state: 'unavailable', busy: false, progress: '', error: 'Automatic voice setup requires Docker with NVIDIA GPU support.' };
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
  const ready = state.running && (await Promise.all([healthy('http://127.0.0.1:8188/health'), healthy('http://127.0.0.1:7862/health')])).every(Boolean);
  const detail = state.exists ? await request<{ State?: { ExitCode?: number; Error?: string } }>('GET', `/containers/${CONTAINER}/json`) : null;
  const failed = !state.running && Boolean(detail?.body?.State?.ExitCode);
  return { available: true, state: pending ? 'installing' : ready ? 'running' : state.running ? 'starting' : failed ? 'failed' : state.exists ? 'stopped' : 'absent', busy: pending, progress: pending ? progress : logs, error: error || (failed ? detail?.body?.State?.Error || 'Voice setup or service exited. Review the log, then retry.' : '') };
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
export function containerSpec(script: string, networkMode: string) {
  return { Image: IMAGE, Tty: true, Cmd: ['bash', '-c', script], Labels: { 'pithagoras.addon': 'voice', 'pithagoras.voice-network': 'shared-v1' },
    HostConfig: { Binds: [`${VOLUME}:/voice`], NetworkMode: networkMode,
      DeviceRequests: [{ Driver: 'nvidia', Count: 1, Capabilities: [['gpu']] }],
      RestartPolicy: { Name: 'no' }, LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '2' } } } };
}
async function ensureContainer(script: string) {
  const networkMode = await voiceNetworkMode();
  const existing = await request<{Config?: {Labels?: Record<string,string>}; HostConfig?: {NetworkMode?: string}; State?: {Running?: boolean}}>('GET', `/containers/${CONTAINER}/json`);
  if (existing.status !== 404) {
    if (existing.status >= 400) throw new Error(`Cannot inspect voice container: Docker ${existing.status}`);
    if (existing.body.Config?.Labels?.['pithagoras.addon'] !== 'voice') throw new Error('The pithagoras-voice container is not a managed voice add-on. Rename it before installing.');
    const current = existing.body.Config.Labels['pithagoras.voice-network'] === 'shared-v1' && existing.body.HostConfig?.NetworkMode === networkMode;
    if (current) { await checked('POST', `/containers/${CONTAINER}/start`); return; }
    // Container config is immutable. Retain /voice and the cached model/build
    // files while replacing the old published-port container or stale namespace.
    if (existing.body.State?.Running) await checked('POST', `/containers/${CONTAINER}/stop?t=10`);
    await checked('DELETE', `/containers/${CONTAINER}`);
  }
  await checked('POST', '/volumes/create', { Name: VOLUME });
  await checked('POST', `/containers/create?name=${CONTAINER}`, containerSpec(script, networkMode));
  await checked('POST', `/containers/${CONTAINER}/start`);
}
export async function install() {
  if (pending) throw new Error('Voice setup is already in progress');
  if (!dockerAvailable()) throw new Error('Docker is unavailable');
  pending = true; error = ''; progress = 'Preparing voice setup';
  // Read before returning so a packaging error is reported immediately.
  let script: string;
  try { script = await readFile(new URL('../../../deploy/voice/setup.sh', import.meta.url), 'utf8'); }
  catch (e) { pending = false; throw e; }
  void (async () => {
    try {
      if (!(await imagePresent(IMAGE))) await pullImage(IMAGE, line => { progress = line; });
      await ensureContainer(script);
    } catch (e) { error = (e as Error).message; }
    finally { pending = false; }
  })();
}
export async function start() {
  await install();
}
export async function stop() {
  if (pending) throw new Error('Wait for the image download to finish before stopping');
  await checked('POST', `/containers/${CONTAINER}/stop?t=10`);
  error = '';
}

const managedModel = {id:'breeze',family:'breeze_tts',path:'/voice/models/breeze-q8_0.gguf',task:'tts',mode:'streaming',session_options:{'breeze_tts.reference_cache_slots':'1'}};
export async function modelAction(action:'load'|'unload') {
  const response=await fetch(`http://127.0.0.1:7862/v1/models/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(action==='load'?managedModel:{id:'breeze'}),signal:AbortSignal.timeout(120000)});
  if(!response.ok)throw new Error(`Voice model ${action} failed (${response.status}): ${(await response.text()).slice(0,300)}`);
}
