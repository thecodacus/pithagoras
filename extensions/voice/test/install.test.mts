import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BASE_IMAGE, IMAGE, containerSpec, imageFor } from '../src/server/service.ts';
test('voice container shares portal networking without publishing host ports',()=>{
 const spec=containerSpec('echo test', 'container:portal-id');
 assert.deepEqual(spec.HostConfig.RestartPolicy,{Name:'unless-stopped'});
 assert.deepEqual(spec.HostConfig.DeviceRequests![0].Capabilities,[['gpu']]);
 assert.ok(spec.HostConfig.Binds.includes('pithagoras_voice-models:/voice'));
 assert.equal(spec.HostConfig.NetworkMode,'container:portal-id');
 assert.equal('PortBindings' in spec.HostConfig,false);
 assert.equal('ExposedPorts' in spec,false);
 assert.equal(spec.Tty,true);
});
test('setup publishes only inspected quantized output and retains partial downloads for retry',()=>{
 const script=readFileSync(new URL('../setup.sh',import.meta.url),'utf8');
 assert.ok(script.indexOf('--inspect models/breeze-q8_0.partial.gguf') < script.indexOf('mv models/breeze-q8_0.partial.gguf models/breeze-q8_0.gguf'));
 assert.match(script,/--continue=true/);
 assert.match(script,/-DGGML_CUDA=OFF/);
 assert.doesNotMatch(script,/MODEL_REVISION/);
});

test('services listen on the portal loopback endpoints',()=>{
 const script=readFileSync(new URL('../setup.sh',import.meta.url),'utf8');
 assert.match(script,/--host 127\.0\.0\.1 --port 8188/);
 assert.match(script,/"host":"127\.0\.0\.1","port":7862/);
 assert.equal(containerSpec('', 'host').HostConfig.NetworkMode, 'host');
});

test('the portal settings the voice service reads reach a portal run with the shipped Compose files',()=>{
 // Compose passes the portal only what it lists: a variable left out is never set in the portal, whatever .env says.
 for(const file of ['docker-compose.yml','docker-compose.portainer.yml']){
  const text=readFileSync(new URL(`../../../${file}`,import.meta.url),'utf8');
  const portal=text.slice(text.indexOf('environment:'),text.lastIndexOf('\nvolumes:'));
  assert.match(portal,/^ {6}VOICE_GPU: \$\{VOICE_GPU:-\}$/m,file);
  assert.match(portal,/^ {6}VOICE_VRAM_RESERVE_MIB: \$\{VOICE_VRAM_RESERVE_MIB:-\}$/m,file);
 }
 const env=readFileSync(new URL('../../../.env.example',import.meta.url),'utf8');
 assert.match(env,/^# VOICE_GPU=\d+$/m);
 assert.match(env,/^# VOICE_VRAM_RESERVE_MIB=\d+$/m);
});

test('a choice with nothing on the GPU asks for none and runs in the small image; the rest is as it was',()=>{
 // The CUDA image is many gigabytes, and a host without a GPU has no use for it.
 assert.equal(BASE_IMAGE,'ubuntu:22.04');
 assert.equal(IMAGE,'nvidia/cuda:12.4.1-devel-ubuntu22.04');
 for(const [choice,image,gpu] of [
  [{tts:'breeze',asr:'whisper',asrModel:'base'},IMAGE,true],
  [{tts:'chatterbox',asr:'qwen3-asr',asrModel:'1.7b'},IMAGE,true],
  [{tts:'breeze',asr:'qwen3-asr',asrModel:'0.6b',asrDevice:'cpu'},IMAGE,true],
  [{tts:'none',asr:'qwen3-asr',asrModel:'0.6b'},BASE_IMAGE,false],
  [{tts:'none',asr:'whisper',asrModel:'small'},BASE_IMAGE,false],
 ] as const){
  const spec=containerSpec('echo test','container:portal-id',choice as any,{threads:6});
  const name=JSON.stringify(choice);
  assert.equal(spec.Image,image,name);
  assert.equal(imageFor(choice as any),image,name);
  assert.equal('DeviceRequests' in spec.HostConfig,gpu,name);
  // Shared with every recipe: the volume, the namespace, the restart policy and the way the script is run.
  assert.deepEqual(spec.HostConfig.Binds,['pithagoras_voice-models:/voice'],name);
  assert.equal(spec.HostConfig.NetworkMode,'container:portal-id',name);
  assert.deepEqual(spec.HostConfig.RestartPolicy,{Name:'unless-stopped'},name);
  assert.deepEqual(spec.Cmd,['bash','-c','echo test'],name);
  assert.equal(spec.Labels['pithagoras.addon'],'voice',name);
 }
 // What the script is told for recognition on the CPU: which device, how many threads, and the config of the server that runs it.
 const env=Object.fromEntries(containerSpec('','host',{tts:'none',asr:'qwen3-asr',asrModel:'1.7b'},{threads:6}).Env.map(e=>[e.slice(0,e.indexOf('=')),e.slice(e.indexOf('=')+1)]));
 assert.deepEqual([env.VOICE_TTS,env.VOICE_ASR_DEVICE,env.VOICE_THREADS],['none','cpu','6']);
 assert.equal('VOICE_SERVER_CONFIG' in env,false);
 assert.deepEqual([JSON.parse(env.VOICE_CPU_CONFIG).backend,JSON.parse(env.VOICE_CPU_CONFIG).threads],['cpu',6]);
 // The original combination's environment has no threads and no CPU server, as before.
 const original=Object.fromEntries(containerSpec('','host').Env.map(e=>[e.slice(0,e.indexOf('=')),e.slice(e.indexOf('=')+1)]));
 assert.deepEqual([original.VOICE_ASR_DEVICE,'VOICE_THREADS' in original,'VOICE_CPU_CONFIG' in original],['cpu',false,false]);
});
