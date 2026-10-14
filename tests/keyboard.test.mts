import test from 'node:test';
import assert from 'node:assert/strict';
import { keyboardInset } from '../core/web/src/keyboard.ts';

test('the keyboard covers what the visual viewport leaves at the bottom of the page', () => {
  assert.equal(keyboardInset(780, { height: 780, offsetTop: 0, scale: 1 }), 0);
  assert.equal(keyboardInset(780, { height: 460, offsetTop: 0, scale: 1 }), 320);
  // Pushed up to show the box: the keyboard is as tall as ever. It read 0 once
  // pushed all the way, and the app was not made shorter at all.
  assert.equal(keyboardInset(780, { height: 460, offsetTop: 100, scale: 1 }), 320);
  assert.equal(keyboardInset(780, { height: 460, offsetTop: 320, scale: 1 }), 320);
  // Chrome with resizes-content: the page itself got shorter, nothing is covered.
  assert.equal(keyboardInset(460, { height: 460, offsetTop: 0, scale: 1 }), 0);
  // Zoomed in with no keyboard: the page is all there, only larger.
  assert.equal(keyboardInset(780, { height: 390, offsetTop: 120, scale: 2 }), 0);
  // Zoomed in on the terminal's small field as the keyboard opened: the
  // keyboard, not nothing. It read 0, and the page was pushed up again.
  assert.equal(keyboardInset(780, { height: 230, offsetTop: 40, scale: 2 }), 320);
});
