import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildTranscript } from '../core/web/src/transcript.ts';
import { failureReason, isPictureCall, isPictureTool, pictureCall, shapeOf, sizeRatio } from '../core/web/src/picture-call.ts';
import { GENERATED_PICTURE_MARK } from '../core/server/src/generated-picture.ts';

/** The start of a call as the portal's SDK client passes it on: a call of the portal's own picture tools has the mark, an extension's tool of that name does not. */
const start = (toolName: string, input: any, own = true, toolCallId = 'c1') => ({ seq: 1, type: 'tool_execution_start', payload: { toolName, toolCallId, input, ...(own ? { [GENERATED_PICTURE_MARK]: true } : {}) } });
const end = (toolName: string, details: any, extra: any = {}, toolCallId = 'c1') => ({ seq: 2, type: 'tool_execution_end', payload: { toolName, toolCallId, result: { content: [{ type: 'text', text: 'Generated and shown to the user' }], details }, ...extra } });
const tool = (events: any[]) => buildTranscript(events).find((i) => i.kind === 'tool') as Extract<ReturnType<typeof buildTranscript>[number], { kind: 'tool' }>;

test('the shape of a coming picture is the size asked for, kept to a frame that is no sliver', () => {
  assert.equal(sizeRatio('1536x1024'), 1.5);
  assert.equal(sizeRatio(' 1024X1536 '), 2 / 3);
  // Nothing to go by: the preview takes a square until the picture says otherwise.
  for (const none of [undefined, '', 'auto', 'big', '1024', '0x10', 5, null]) assert.equal(sizeRatio(none), undefined, String(none));
  assert.equal(sizeRatio('4000x400'), 3);
  assert.equal(sizeRatio('400x4000'), 0.4);
  assert.equal(shapeOf(300, 200), 1.5);
  assert.equal(shapeOf(0, 200), undefined);
  assert.equal(shapeOf(NaN, 200), undefined);
});

test('a call says what the preview needs of it: the shape, the original of an edit, and what it is of', () => {
  assert.deepEqual(pictureCall('generate_image', { prompt: 'A lighthouse\n at dusk', size: '1024x1536' }, '/work'), { edit: false, title: 'A lighthouse at dusk', ratio: 2 / 3 });
  assert.equal(pictureCall('generate_image', { prompt: 'x', title: 'Lighthouse' }, '/work').title, 'Lighthouse', 'the title the agent gave comes first');
  assert.equal(pictureCall('generate_image', { prompt: 'x', size: 'auto' }, '/work').ratio, undefined);
  assert.equal(pictureCall('generate_image', { prompt: 'x'.repeat(500) }, '/work').title.length, 120);
  // An edit is of the picture it changes, as the path in the chat's folder, however the agent wrote it; its size is the original's, not a request.
  assert.deepEqual(pictureCall('edit_image', { path: 'photos/dog.png', prompt: 'Make it snow', size: '1024x1536' }, '/work'), { edit: true, title: 'Make it snow', original: 'photos/dog.png' });
  assert.equal(pictureCall('edit_image', { path: '/work/photos/dog.png', prompt: 'x' }, '/work').original, 'photos/dog.png');
  assert.equal(pictureCall('edit_image', { path: '/elsewhere/dog.png', prompt: 'x' }, '/work').original, undefined, 'one outside the folder is not fetched');
  // Several pictures: the first is the one shown, as the result is named after it.
  assert.equal(pictureCall('edit_image', { paths: ['photos/dog.png', 'styles/snow.png'], prompt: 'x' }, '/work').original, 'photos/dog.png');
  assert.equal(pictureCall('edit_image', { paths: [], prompt: 'x' }, '/work').original, undefined);
  assert.equal(pictureCall('edit_image', { paths: [3, 'a.png'], prompt: 'x' }, '/work').original, undefined);
  // Whatever the agent sent, it does not break the page.
  for (const args of [undefined, null, 'text', 3, [], {}]) assert.doesNotThrow(() => pictureCall('edit_image', args, '/work'), String(args));
});

test('what went wrong is the first of it, on one line', () => {
  assert.equal(failureReason('The image endpoint answered 401:\n  the key was refused'), 'The image endpoint answered 401: the key was refused');
  assert.equal(failureReason(undefined), '');
  assert.equal(failureReason('x'.repeat(1000)).length, 240);
});

test('a call of the portal’s picture tools is a preview in every state; another extension’s tool of that name is always its plain card', () => {
  const mark = { path: 'generated-images/a.png', title: 'A', [GENERATED_PICTURE_MARK]: true };
  assert.equal(isPictureTool('generate_image'), true);
  assert.equal(isPictureTool('edit_image'), true);
  assert.equal(isPictureTool('show_image'), false, 'show_image is a picture shown, not made');
  assert.equal(isPictureTool('bash'), false);

  const running = tool([start('generate_image', { prompt: 'a' })]);
  assert.equal(running.status, 'running');
  assert.equal(running.portalPicture, true, 'its start says whose it is');
  assert.equal(isPictureCall(running), true);
  assert.equal(isPictureCall(tool([start('edit_image', { path: 'a.png', prompt: 'a' })])), true);

  const made = tool([start('generate_image', { prompt: 'a' }), end('generate_image', mark)]);
  assert.equal(made.status, 'done');
  assert.equal(isPictureCall(made), true);

  const failed = tool([start('generate_image', { prompt: 'a' }), end('generate_image', undefined, { isError: true })]);
  assert.equal(failed.status, 'error');
  assert.equal(isPictureCall(failed), true);

  // A run that went on without the call ever ending.
  const cut = tool([start('generate_image', { prompt: 'a' }), { seq: 2, type: 'agent_start', payload: {} }]);
  assert.equal(cut.interrupted, true);
  assert.equal(isPictureCall(cut), true);

  // A picture made before the start said so: its end does.
  assert.equal(isPictureCall(tool([start('generate_image', { prompt: 'a' }, false), end('generate_image', mark)])), true);

  // Another extension's tool of the name, which pi may keep in the portal's place: no mark at its start, and in no state a preview.
  const theirs = (events: any[]) => tool([start('generate_image', { prompt: 'a' }, false), ...events]);
  assert.equal(theirs([]).portalPicture, undefined);
  assert.equal(isPictureCall(theirs([])), false, 'while it runs');
  assert.equal(isPictureCall(theirs([end('generate_image', undefined, { isError: true })])), false, 'when it failed');
  assert.equal(isPictureCall(theirs([{ seq: 2, type: 'agent_start', payload: {} }])), false, 'when it was cut off');
  assert.equal(isPictureCall(theirs([end('generate_image', { path: '/out/cat.png' })])), false, 'when it answered with a path of its own kind');
  assert.equal(isPictureCall(tool([start('bash', { command: 'ls' }, false)])), false);
});

test('the look of a picture being made is still in its own sheet, and moves only in the one the animations switch', () => {
  const css = fs.readFileSync(path.resolve(import.meta.dirname, '../core/web/src/styles/preview.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(css.includes('.image-preview-making'));
  assert.ok(css.includes('.image-preview-loading'), 'a picture on its way after the call is over has its own, still, look');
  assert.doesNotMatch(css, /animation|@keyframes/, 'with the animations off, the placeholder is still');
  const motion = fs.readFileSync(path.resolve(import.meta.dirname, '../core/web/src/styles/motion.css'), 'utf8');
  for (const name of ['fx-preview-drift', 'fx-preview-sheen', 'fx-preview-breathe']) assert.match(motion, new RegExp(`@keyframes ${name}\\b`));
  // The wait is moved with transform and opacity, never resized, so that a long chat of them costs the compositor only.
  for (const name of ['fx-preview-drift', 'fx-preview-sheen', 'fx-preview-breathe']) {
    const from = motion.indexOf(`@keyframes ${name} {`);
    let depth = 0, at = motion.indexOf('{', from);
    const open = at;
    do depth += motion[at] === '{' ? 1 : motion[at] === '}' ? -1 : 0; while (depth > 0 && ++at < motion.length);
    assert.doesNotMatch(motion.slice(open, at + 1), /width|height|top|left|margin|padding|filter/, name);
  }
});
