import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTranscript, shownPicture } from '../core/web/src/transcript.ts';
import { describeCall } from '../core/web/src/tool-activity.ts';

import { GENERATED_PICTURE_MARK } from '../core/server/src/generated-picture.ts';

// What generate_image answers with: the same details show_image's answer has, so one path draws both, and the mark that it is the portal's tool's.
const generated = { path: 'generated-images/image-20261001-101500-a1b2c3.png', title: 'A lighthouse at dusk', [GENERATED_PICTURE_MARK]: true };
const start = (toolName: string, input: any, toolCallId = 'c1') => ({ seq: 1, type: 'tool_execution_start', payload: { toolName, toolCallId, input } });
const end = (toolName: string, details: any, extra: any = {}, toolCallId = 'c1') => ({ seq: 2, type: 'tool_execution_end', payload: { toolName, toolCallId, result: { content: [{ type: 'text', text: 'Generated and shown to the user' }], details }, ...extra } });

test('a generated picture is a shown picture, as one named with show_image is', () => {
  assert.deepEqual(shownPicture(end('generate_image', generated).payload), { path: generated.path, title: generated.title });
  assert.deepEqual(shownPicture(end('show_image', { path: 'a.png' }).payload), { path: 'a.png' });
  assert.equal(shownPicture(end('generate_image', generated, { isError: true }).payload), undefined, 'a failed call shows nothing');
  assert.equal(shownPicture(end('generate_image', undefined).payload), undefined, 'nor one with no path');
  assert.equal(shownPicture(end('some_other_tool', generated).payload), undefined, 'another tool is not taken for one');
});

test('the chat puts a generated picture under the tool line that made it', () => {
  const items = buildTranscript([start('generate_image', { prompt: 'a lighthouse at dusk' }), end('generate_image', generated)]);
  const tool = items.find((i) => i.kind === 'tool') as any;
  assert.equal(tool.name, 'generate_image');
  assert.deepEqual(tool.picture, { path: generated.path, title: generated.title });
});

test('the call knows which end showed its picture: that is what versions the URL every place draws it from asks for', () => {
  // The picture window in voice mode versions its address by the end's seq. The chat's preview and a card's tile take the same one, so that the file is fetched once, not once for each.
  const items = buildTranscript([start('generate_image', { prompt: 'a lighthouse at dusk' }), end('generate_image', generated)]);
  const tool = items.find((i) => i.kind === 'tool') as any;
  assert.equal(tool.pictureSeq, 2);
  const failed = buildTranscript([start('generate_image', { prompt: 'a lighthouse at dusk' }), end('generate_image', generated, { isError: true })]);
  assert.equal((failed.find((i) => i.kind === 'tool') as any).pictureSeq, undefined, 'no picture, no address');
});

test('the tool line says a picture is being made; what tapping it opens is settled when the call ends', () => {
  // Not here: the start cannot tell the portal's tool from an extension's of the same name, whose card must open nothing.
  assert.deepEqual(describeCall(start('generate_image', { prompt: 'a lighthouse\nat dusk' }).payload, '/work'), { label: 'Making a picture', detail: 'a lighthouse at dusk' });
  assert.equal(describeCall(start('generate_image', { prompt: 'x', title: 'Lighthouse' }).payload, '/work').detail, 'Lighthouse');
  assert.equal(describeCall(start('show_image', { path: 'a.png' }).payload, '/work').target, 'pictures');
});

test("a generate_image that an extension brings is not taken for a picture of the chat's folder", () => {
  // Its path is its own kind: an absolute one, which the picture route would look for below the folder, or one relative to somewhere else.
  const theirs = [{ path: '/work/proj/cat.png' }, { path: 'cat.png' }, { path: 'out/cat.png', title: 'A cat' }];
  for (const details of theirs) {
    assert.equal(shownPicture(end('generate_image', details).payload), undefined, JSON.stringify(details));
    const items = buildTranscript([start('generate_image', { prompt: 'a cat' }), end('generate_image', details)]);
    assert.equal((items.find((i) => i.kind === 'tool') as any).picture, undefined, 'no thumbnail under its tool line');
  }
  assert.equal(shownPicture(end('generate_image', { ...generated, [GENERATED_PICTURE_MARK]: 'yes' }).payload), undefined, 'the mark is true, not just there');
  // show_image is the portal's alone to answer with a path in the folder, and is as it was.
  assert.deepEqual(shownPicture(end('show_image', { path: 'cat.png' }).payload), { path: 'cat.png' });
});

// What edit_image answers with: the same as generate_image's, for a new picture made from an old one.
const edited = { path: 'generated-images/photo-edited.png', title: 'Purple sky', [GENERATED_PICTURE_MARK]: true };

test('an edited picture is a shown picture, under the tool line that made it, and only with the mark of the portal\'s own tool', () => {
  assert.deepEqual(shownPicture(end('edit_image', edited).payload), { path: edited.path, title: edited.title });
  assert.equal(shownPicture(end('edit_image', edited, { isError: true }).payload), undefined, 'a failed call shows nothing');
  const items = buildTranscript([start('edit_image', { path: 'photo.png', prompt: 'make the sky purple' }), end('edit_image', edited)]);
  assert.deepEqual((items.find((i) => i.kind === 'tool') as any).picture, { path: edited.path, title: edited.title });
  // An extension's edit_image answers with a path of its own kind: no thumbnail, as for generate_image.
  for (const details of [{ path: '/work/proj/cat.png' }, { path: 'cat.png' }, { ...edited, [GENERATED_PICTURE_MARK]: 'yes' }]) {
    assert.equal(shownPicture(end('edit_image', details).payload), undefined, JSON.stringify(details));
  }
});

test('the tool line says a picture is being edited, with what was asked or the title', () => {
  assert.deepEqual(describeCall(start('edit_image', { path: 'photo.png', prompt: 'make the\nsky purple' }).payload, '/work'), { label: 'Editing a picture', detail: 'make the sky purple' });
  assert.equal(describeCall(start('edit_image', { path: 'photo.png', prompt: 'x', title: 'Purple sky' }).payload, '/work').detail, 'Purple sky');
  assert.equal(describeCall(start('edit_image', { path: 'photo.png', prompt: 'x' }).payload, '/work').target, undefined, 'what tapping it opens is settled when the call ends');
});
