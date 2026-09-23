import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { containerSpec } from '../server/src/extensions/voice-service.js';
test('voice container shares portal networking without publishing host ports',()=>{
 const spec=containerSpec('echo test', 'container:portal-id');
 assert.equal(spec.HostConfig.RestartPolicy.Name,'no');
 assert.deepEqual(spec.HostConfig.DeviceRequests[0].Capabilities,[['gpu']]);
 assert.ok(spec.HostConfig.Binds.includes('pithagoras_voice-models:/voice'));
 assert.equal(spec.HostConfig.NetworkMode,'container:portal-id');
 assert.equal('PortBindings' in spec.HostConfig,false);
 assert.equal('ExposedPorts' in spec,false);
 assert.equal(spec.Tty,true);
});
test('setup publishes only inspected quantized output and retains partial downloads for retry',()=>{
 const script=readFileSync('deploy/voice/setup.sh','utf8');
 assert.ok(script.indexOf('--inspect models/breeze-q8_0.partial.gguf') < script.indexOf('mv models/breeze-q8_0.partial.gguf models/breeze-q8_0.gguf'));
 assert.match(script,/--continue=true/);
 assert.match(script,/-DGGML_CUDA=OFF/);
 assert.doesNotMatch(script,/MODEL_REVISION/);
});

test('services listen on the portal loopback endpoints',()=>{
 const script=readFileSync('deploy/voice/setup.sh','utf8');
 assert.match(script,/--host 127\.0\.0\.1 --port 8188/);
 assert.match(script,/"host":"127\.0\.0\.1","port":7862/);
 assert.equal(containerSpec('', 'host').HostConfig.NetworkMode, 'host');
});
