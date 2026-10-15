import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settlePanels } from '../core/web/src/use-work-panels.js';

test('two panels stay open as they are', () => {
  assert.deepEqual(settlePanels([], ['terminal', 'files']), { order: ['terminal', 'files'], close: [] });
});

test('a third closes the one that has been open longest', () => {
  const first = settlePanels([], ['browser', 'terminal']);
  const second = settlePanels(first.order, ['browser', 'terminal', 'files']);
  assert.deepEqual(second, { order: ['terminal', 'files'], close: ['browser'] });
});

test('a panel that was closed drops out of the order, and comes back as the newest', () => {
  const opened = settlePanels([], ['files', 'pictures']);
  const closed = settlePanels(opened.order, ['pictures']);
  assert.deepEqual(closed, { order: ['pictures'], close: [] });
  assert.deepEqual(settlePanels(closed.order, ['pictures', 'files']).order, ['pictures', 'files']);
});

test('files and pictures count like the others', () => {
  const a = settlePanels(['pictures', 'files'], ['pictures', 'files', 'browser']);
  assert.deepEqual(a, { order: ['files', 'browser'], close: ['pictures'] });
});

test('a panel with something in it that would be lost stays, and another goes instead', () => {
  const opened = settlePanels([], ['files', 'browser']);
  assert.deepEqual(settlePanels(opened.order, ['files', 'browser', 'terminal'], ['files']), { order: ['files', 'terminal'], close: ['browser'] });
  // Without the wish to keep it, the one open the longest goes.
  assert.deepEqual(settlePanels(opened.order, ['files', 'browser', 'terminal']).close, ['files']);
});

test('if every older panel is to be kept, the one just opened is the one that goes', () => {
  assert.deepEqual(settlePanels(['files', 'browser'], ['files', 'browser', 'terminal'], ['files', 'browser']).close, ['terminal']);
});
