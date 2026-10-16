import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTranscript } from '../core/web/src/transcript.ts';
import { describeCall } from '../core/web/src/tool-activity.ts';
import { isPictureCall, pictureCall } from '../core/web/src/picture-call.ts';
import { chatPictures } from '../core/web/src/chat-pictures.ts';
import { latestBrowserActivity } from '../core/web/src/voice-browser.ts';
import { latestCommand } from '../extensions/terminal/src/runs.ts';
import { GENERATED_PICTURE_MARK } from '../core/server/src/generated-picture.ts';
import { CALLED_TOOL_KEY } from '../core/server/src/pi/tools-gateway-names.ts';
import { FILES_KEY } from '../core/server/src/file-outputs.ts';

/**
 * A lazy tool is called through the `tools` tool, and pi's events name that one: the pictures and the
 * browser, which the page finds by the name of the tool, have to see the tool that was called (#106).
 * The events are as the portal passes them on: the start has the call in its arguments, the end names
 * the tool it was of.
 */
const via = (name: string, args: unknown) => ({ action: 'call', name, args });
const start = (toolName: string, input: any, extra: any = {}, seq = 1, toolCallId = 'c1') => ({ seq, type: 'tool_execution_start', payload: { toolName, toolCallId, args: input, ...extra } });
const end = (toolName: string, details: any, extra: any = {}, seq = 2, toolCallId = 'c1') => ({ seq, type: 'tool_execution_end', payload: { toolName, toolCallId, result: { content: [{ type: 'text', text: 'ok' }], details }, ...extra } });
/** The end of a call of `name` through `tools`, as the portal passes it on. */
const lazyEnd = (name: string, details: any, extra: any = {}, seq = 2, toolCallId = 'c1') => end('tools', details, { [CALLED_TOOL_KEY]: name, ...extra }, seq, toolCallId);

/** What the portal found of the files a call gave, on its end: see file-outputs.ts. */
const gave = (...files: any[]) => ({ [FILES_KEY]: files });

test('a lazy show_image gives the picture a direct one does, in the chat, and reads as a call of the tool it made', () => {
  const shown = { path: 'p.png', title: 't' };
  const file = { ...shown, kind: 'picture' };
  const items = buildTranscript([start('tools', via('show_image', shown)), lazyEnd('show_image', { files: [shown] }, gave(file))]);
  const line = items.find((i) => i.kind === 'tool') as any;
  assert.deepEqual(line.files, [file], 'under the tool line, as for a direct call');
  assert.equal(line.filesSeq, 2);
  // The line reads as the call of the tool it made, as one through the MCP adapter does.
  assert.equal(describeCall(start('tools', via('show_image', shown)).payload, '/work').label, 'Showing a picture');
  assert.equal(describeCall(start('tools', via('show_image', shown)).payload, '/work').target, 'pictures');
});

test('a lazy generate_image is the preview of a picture being made, as a direct one is', () => {
  const asked = { prompt: 'A lighthouse\n at dusk', size: '1024x1536' };
  const own = { [GENERATED_PICTURE_MARK]: true };
  const running = buildTranscript([start('tools', via('generate_image', asked), own)]).find((i) => i.kind === 'tool') as any;
  assert.equal(running.portalPicture, true, 'its start says whose it is');
  assert.equal(isPictureCall(running), true);
  assert.deepEqual(pictureCall(running.name, running.args, '/work'), pictureCall('generate_image', asked, '/work'));
  assert.deepEqual(pictureCall(running.name, running.args, '/work'), { edit: false, title: 'A lighthouse at dusk', ratio: 2 / 3 });

  const made = { path: 'generated-images/a.png', title: 'A' };
  const done = buildTranscript([start('tools', via('generate_image', asked), own), lazyEnd('generate_image', { files: [made] }, gave({ ...made, kind: 'picture' }))]).find((i) => i.kind === 'tool') as any;
  assert.deepEqual(done.files, [{ ...made, kind: 'picture' }]);
  assert.equal(isPictureCall(done), true);
  // The arguments may come as the JSON text of an object, as the gateway takes them.
  assert.equal(pictureCall('tools', via('generate_image', JSON.stringify(asked)), '/work').ratio, 2 / 3);

  // Another extension's generate_image, called the same way, is the plain card it always was: with what it gave under it.
  const theirs = buildTranscript([start('tools', via('generate_image', asked)), lazyEnd('generate_image', { path: 'cat.png' })]).find((i) => i.kind === 'tool') as any;
  assert.equal(isPictureCall(theirs), false);
  // And a call that is no call of a picture tool is none either.
  assert.equal(isPictureCall(buildTranscript([start('tools', { action: 'search', query: 'generate_image' }, own)]).find((i) => i.kind === 'tool') as any), false);
});

test('a lazy edit_image is tied to the picture it changed, as a direct one is', () => {
  const urls = { sent: (name: string) => `/sent/${name}`, shown: (path: string, version: string) => `/shown/${path}?v=${version}` };
  const own = { [GENERATED_PICTURE_MARK]: true };
  const edited = gave({ path: 'generated-images/photo-edited.png', title: 'Snow', kind: 'picture', from: ['photo.png'] });
  const list = (events: any[]) => chatPictures(buildTranscript(events), '/work', urls);
  const first = [start('show_image', { path: 'photo.png' }, {}, 1, 'a'), end('show_image', {}, gave({ path: 'photo.png', kind: 'picture' }), 2, 'a')];
  const direct = list([...first, start('edit_image', { path: 'photo.png', prompt: 'snow' }, own, 3, 'b'), end('edit_image', {}, edited, 4, 'b')]);
  const through = list([...first, start('tools', via('edit_image', { path: 'photo.png', prompt: 'snow' }), own, 3, 'b'), lazyEnd('edit_image', {}, edited, 4, 'b')]);
  assert.equal(direct.length, 2);
  assert.ok(direct[1].from, 'a direct edit is linked to its original');
  assert.deepEqual(through.map((p) => p.from), direct.map((p) => p.from));
  assert.equal(pictureCall('tools', via('edit_image', { path: 'photo.png', prompt: 'snow' }), '/work').original, 'photo.png');
});

test('a lazy browser tool called through tools is browser activity, and a search of the tools is not', () => {
  const at = (seq: number, input: unknown) => ({ seq, type: 'tool_execution_start', payload: { toolName: 'tools', toolCallId: `c${seq}`, args: input } }) as any;
  const direct = [{ seq: 4, type: 'tool_execution_start', payload: { toolName: 'browser_navigate', args: { url: 'https://example.com' } } }] as any;
  assert.equal(latestBrowserActivity(direct), 4);
  assert.equal(latestBrowserActivity([at(5, via('browser_navigate', { url: 'https://example.com' }))]), 5);
  assert.equal(latestBrowserActivity([at(6, via('browser_navigate', JSON.stringify({ url: 'https://example.com' })))]), 6, 'arguments as JSON text');
  // The newest browser call is the one that counts, direct or lazy.
  assert.equal(latestBrowserActivity([...direct, at(7, via('browser_click', {}))]), 7);
  // Searching for or describing a browser tool uses none, and another lazy tool is no browser.
  assert.equal(latestBrowserActivity([at(8, { action: 'search', query: 'browser' })]), 0);
  assert.equal(latestBrowserActivity([at(9, { action: 'describe', name: 'browser_navigate' })]), 0);
  assert.equal(latestBrowserActivity([at(10, via('docs_open', { id: 'browser' }))]), 0);
  // The same for a shell tool that is lazy, in the terminal extension.
  assert.equal(latestCommand([at(11, via('exec_command', { cmd: 'ls' }))]), 11);
  assert.equal(latestCommand([at(12, { action: 'search', query: 'exec_command' })]), 0);
});
