import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTranscript, shownPicture } from '../web/src/transcript.ts';
import { describeCall } from '../web/src/tool-activity.ts';
import { isPictureCall, pictureCall } from '../web/src/picture-call.ts';
import { chatPictures } from '../web/src/chat-pictures.ts';
import { latestBrowserActivity, latestTerminalActivity } from '../web/src/voice-browser.ts';
import { GENERATED_PICTURE_MARK } from '../server/src/generated-picture.ts';
import { CALLED_TOOL_KEY } from '../server/src/pi/tools-gateway-names.ts';

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

test('a lazy show_image shows the picture a direct one does, in the chat and in voice mode', () => {
  const shown = { path: 'p.png', title: 't' };
  const direct = shownPicture(end('show_image', shown).payload);
  assert.deepEqual(direct, shown);
  assert.deepEqual(shownPicture(lazyEnd('show_image', shown).payload), direct);

  const items = buildTranscript([start('tools', via('show_image', shown)), lazyEnd('show_image', shown)]);
  const line = items.find((i) => i.kind === 'tool') as any;
  assert.deepEqual(line.picture, shown, 'under the tool line, as for a direct call');
  assert.equal(line.pictureSeq, 2);
  // The line reads as the call of the tool it made, as one through the MCP adapter does.
  assert.equal(describeCall(start('tools', via('show_image', shown)).payload, '/work').label, 'Showing a picture');
  assert.equal(describeCall(start('tools', via('show_image', shown)).payload, '/work').target, 'pictures');
});

test('a call through tools shows a picture only when it was a call of a picture tool that succeeded', () => {
  const shown = { path: 'p.png' };
  assert.equal(shownPicture(lazyEnd('show_image', shown, { isError: true }).payload), undefined, 'a failed call shows nothing');
  assert.equal(shownPicture(lazyEnd('docs_open', shown).payload), undefined, 'another tool is not taken for one');
  assert.equal(shownPicture(end('tools', shown).payload), undefined, 'a search names no tool, so shows nothing');
  // The end says which tool only for the tool that reaches the others: anywhere else it is nothing to go by.
  assert.equal(shownPicture(end('docs_open', shown, { [CALLED_TOOL_KEY]: 'show_image' }).payload), undefined);
  // And as for a direct call, a generated picture is the portal's own only with the mark its tool sets.
  const generated = { path: 'generated-images/a.png', title: 'A', [GENERATED_PICTURE_MARK]: true };
  assert.deepEqual(shownPicture(lazyEnd('generate_image', generated).payload), { path: generated.path, title: 'A' });
  assert.equal(shownPicture(lazyEnd('generate_image', { path: 'cat.png' }).payload), undefined);
  assert.equal(shownPicture(lazyEnd('edit_image', { ...generated, [GENERATED_PICTURE_MARK]: 'yes' }).payload), undefined);
});

test('a lazy generate_image is the preview of a picture being made, as a direct one is', () => {
  const asked = { prompt: 'A lighthouse\n at dusk', size: '1024x1536' };
  const own = { [GENERATED_PICTURE_MARK]: true };
  const running = buildTranscript([start('tools', via('generate_image', asked), own)]).find((i) => i.kind === 'tool') as any;
  assert.equal(running.portalPicture, true, 'its start says whose it is');
  assert.equal(isPictureCall(running), true);
  assert.deepEqual(pictureCall(running.name, running.args, '/work'), pictureCall('generate_image', asked, '/work'));
  assert.deepEqual(pictureCall(running.name, running.args, '/work'), { edit: false, title: 'A lighthouse at dusk', ratio: 2 / 3 });

  const made = { path: 'generated-images/a.png', title: 'A', ...own };
  const done = buildTranscript([start('tools', via('generate_image', asked), own), lazyEnd('generate_image', made)]).find((i) => i.kind === 'tool') as any;
  assert.deepEqual(done.picture, { path: made.path, title: 'A' });
  assert.equal(isPictureCall(done), true);
  // The arguments may come as the JSON text of an object, as the gateway takes them.
  assert.equal(pictureCall('tools', via('generate_image', JSON.stringify(asked)), '/work').ratio, 2 / 3);

  // Another extension's generate_image, called the same way, is the plain card it always was.
  const theirs = buildTranscript([start('tools', via('generate_image', asked)), lazyEnd('generate_image', { path: 'cat.png' })]).find((i) => i.kind === 'tool') as any;
  assert.equal(isPictureCall(theirs), false);
  // And a call that is no call of a picture tool is none either.
  assert.equal(isPictureCall(buildTranscript([start('tools', { action: 'search', query: 'generate_image' }, own)]).find((i) => i.kind === 'tool') as any), false);
});

test('a lazy edit_image is tied to the picture it changed, as a direct one is', () => {
  const urls = { sent: (name: string) => `/sent/${name}`, shown: (path: string, version: string) => `/shown/${path}?v=${version}` };
  const own = { [GENERATED_PICTURE_MARK]: true };
  const edited = { path: 'generated-images/photo-edited.png', title: 'Snow', ...own };
  const list = (events: any[]) => chatPictures(buildTranscript(events), '/work', urls);
  const first = [start('show_image', { path: 'photo.png' }, {}, 1, 'a'), end('show_image', { path: 'photo.png' }, {}, 2, 'a')];
  const direct = list([...first, start('edit_image', { path: 'photo.png', prompt: 'snow' }, own, 3, 'b'), end('edit_image', edited, {}, 4, 'b')]);
  const through = list([...first, start('tools', via('edit_image', { path: 'photo.png', prompt: 'snow' }), own, 3, 'b'), lazyEnd('edit_image', edited, {}, 4, 'b')]);
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
  // The same for a shell tool that is lazy.
  assert.equal(latestTerminalActivity([at(11, via('exec_command', { cmd: 'ls' }))]), 11);
  assert.equal(latestTerminalActivity([at(12, { action: 'search', query: 'exec_command' })]), 0);
});
