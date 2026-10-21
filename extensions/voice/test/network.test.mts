import test from 'node:test';
import assert from 'node:assert/strict';
import { voiceService } from './service.mts';

// The voice container shares the portal's loopback (Docker's sharedNetwork): `container:<id>` of the portal's own
// container, which changes when the portal's container is made again. Docker's fake daemon stands in for the host.
const v = await voiceService();
const { service: voice, daemon } = v;

test('a running container on another network, or on the portal\'s old container, rejoins the portal\'s; a stopped one is left as it is', async () => {
  v.reset(); v.hostGpus(null);
  v.putVoice({ Labels: { 'pithagoras.addon': 'voice' }, HostConfig: { NetworkMode: 'bridge' }, State: 'running' });
  daemon.volumes.push({ Name: 'pithagoras_voice-models', Labels: null });
  assert.equal((await voice.status()).state, 'installing');
  await v.settle();
  const made = () => v.voice()!.made as any;
  assert.equal(made().HostConfig.NetworkMode, 'container:portal-one');
  assert.equal(made().HostConfig.PortBindings, undefined);
  assert.deepEqual(made().HostConfig.Binds, ['pithagoras_voice-models:/voice']);
  assert.equal(made().Labels['pithagoras.voice-network'], 'shared-v1');
  assert.equal((await voice.status()).state, 'running');
  assert.deepEqual(daemon.volumes.map(volume => volume.Name), ['pithagoras_voice-models'], 'the downloads are kept');
  // The portal's container is made again, with a new id: the voice container that still runs rejoins it.
  v.portalIs('portal-two');
  assert.equal((await voice.status()).state, 'installing');
  await v.settle();
  assert.equal(made().HostConfig.NetworkMode, 'container:portal-two');
  // Stopped, it is not touched: it is made again when it is next started.
  await v.docker.containers.stop('pithagoras-voice');
  v.portalIs('portal-three');
  daemon.created.length = 0;
  assert.equal((await voice.status()).state, 'stopped');
  assert.deepEqual(daemon.created, []);
  assert.equal(made().HostConfig.NetworkMode, 'container:portal-two');
});
