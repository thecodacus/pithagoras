import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { shapeOf } from '../core/web/src/components/ImagePreview.tsx';

test('a frame is the shape of its picture, kept to one that is no sliver', () => {
  assert.equal(shapeOf(300, 200), 1.5);
  assert.equal(shapeOf(200, 300), 2 / 3);
  assert.equal(shapeOf(4000, 400), 3);
  assert.equal(shapeOf(400, 4000), 0.4);
  // Nothing to go by: the preview takes a square until the picture says otherwise.
  assert.equal(shapeOf(0, 200), undefined);
  assert.equal(shapeOf(NaN, 200), undefined);
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
