import assert from 'node:assert/strict';
import test from 'node:test';
import { inProcessHome } from './server-harness.mjs';

inProcessHome('pithagoras-source-label-');
const { SdkPiClient } = await import('../dist/pi/sdk-client.js');

/** The source labels getTools gives for tools with these sourceInfo values. */
async function labels(infos) {
  const client = Object.create(SdkPiClient.prototype);
  client.wanted = new Set();
  client.taken = new Set();
  client.switchedOff = new Set();
  client.session = { getAllTools: () => infos.map((sourceInfo, i) => ({ name: `t${i}`, sourceInfo })), getToolDefinition: (name) => ({ name }) };
  return (await client.getTools()).map((t) => t.source);
}

test('built-in tools are labelled "built in" in the form pi 1.1 sends and the older one', async () => {
  assert.deepEqual(
    await labels([
      { path: 'builtin:bash', source: 'builtin' },
      { path: '<builtin:read>', source: 'builtin' },
    ]),
    ['built in', 'built in'],
  );
});

test('other sources keep their labels', async () => {
  assert.deepEqual(
    await labels([
      { path: '<inline:canvases>', source: 'inline' },
      { path: '/h/node_modules/@scope/pkg/index.js', source: 'auto' },
      { path: '/h/ext/notes/index.ts', source: 'auto' },
    ]),
    ['canvases', '@scope/pkg', 'notes'],
  );
});
