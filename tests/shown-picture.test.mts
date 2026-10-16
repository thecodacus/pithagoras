import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTranscript } from '../core/web/src/transcript.ts';
import { describeCall } from '../core/web/src/tool-activity.ts';
import { isPictureCall } from '../core/web/src/picture-call.ts';
import { GENERATED_PICTURE_MARK } from '../core/server/src/generated-picture.ts';
import { FILES_KEY } from '../core/server/src/file-outputs.ts';

// What generate_image answers with, and what the portal found of it when the call ended (see file-outputs.ts).
const made = { path: 'generated-images/image-20261001-101500-a1b2c3.png', title: 'A lighthouse at dusk' };
const found = { [FILES_KEY]: [{ ...made, kind: 'picture' }] };
const start = (toolName: string, input: any, extra: any = {}, toolCallId = 'c1') => ({ seq: 1, type: 'tool_execution_start', payload: { toolName, toolCallId, input, ...extra } });
const end = (toolName: string, details: any, extra: any = {}, toolCallId = 'c1') => ({ seq: 2, type: 'tool_execution_end', payload: { toolName, toolCallId, result: { content: [{ type: 'text', text: 'Generated and shown to the user' }], details }, ...extra } });
const own = { [GENERATED_PICTURE_MARK]: true };

test('the chat puts a made picture under the tool line that made it, by the end that gave it', () => {
  const items = buildTranscript([start('generate_image', { prompt: 'a lighthouse at dusk' }, own), end('generate_image', { files: [made] }, found)]);
  const tool = items.find((i) => i.kind === 'tool') as any;
  assert.equal(tool.name, 'generate_image');
  assert.deepEqual(tool.files, [{ ...made, kind: 'picture' }]);
  // The picture window in voice mode versions its address by the end's seq. The chat's preview and a card's tile take the same one, so that the file is fetched once, not once for each.
  assert.equal(tool.filesSeq, 2);
  assert.equal(isPictureCall(tool), true);
});

test("a picture tool's call is the portal's preview by the mark on its start, and one that an extension brings is its plain card while it runs", () => {
  const running = (extra: any) => buildTranscript([start('edit_image', { path: 'photo.png', prompt: 'snow' }, extra)]).find((i) => i.kind === 'tool') as any;
  assert.equal(isPictureCall(running(own)), true);
  assert.equal(isPictureCall(running({})), false);
  assert.equal(isPictureCall(running({ [GENERATED_PICTURE_MARK]: 'yes' })), false, 'the mark is true, not just there');
  // A failed call of the portal's own gave nothing, and is still its preview, which says why.
  const failed = buildTranscript([start('generate_image', { prompt: 'x' }, own), end('generate_image', undefined, { isError: true })]).find((i) => i.kind === 'tool') as any;
  assert.equal(failed.files, undefined);
  assert.equal(isPictureCall(failed), true);
});

test('the tool line says a picture is being made; what tapping it opens is settled when the call ends', () => {
  // Not here: the start cannot tell the portal's tool from an extension's of the same name, whose card must open nothing.
  assert.deepEqual(describeCall(start('generate_image', { prompt: 'a lighthouse\nat dusk' }).payload, '/work'), { label: 'Making a picture', detail: 'a lighthouse at dusk' });
  assert.equal(describeCall(start('generate_image', { prompt: 'x', title: 'Lighthouse' }).payload, '/work').detail, 'Lighthouse');
  assert.equal(describeCall(start('show_image', { path: 'a.png' }).payload, '/work').target, 'pictures');
});

test('the tool line says a picture is being edited, with what was asked or the title', () => {
  assert.deepEqual(describeCall(start('edit_image', { path: 'photo.png', prompt: 'make the\nsky purple' }).payload, '/work'), { label: 'Editing a picture', detail: 'make the sky purple' });
  assert.equal(describeCall(start('edit_image', { path: 'photo.png', prompt: 'x', title: 'Purple sky' }).payload, '/work').detail, 'Purple sky');
  assert.equal(describeCall(start('edit_image', { path: 'photo.png', prompt: 'x' }).payload, '/work').target, undefined, 'what tapping it opens is settled when the call ends');
});
