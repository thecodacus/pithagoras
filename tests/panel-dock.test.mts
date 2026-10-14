import test from 'node:test';
import assert from 'node:assert/strict';
import { across, dockedFrameAmong, dockedSize, dropTarget, fitFrame, fitSides, groupPanels, isDock, readFrame, readFrames, readPlaceSizes, readPlaces, spreadFrames } from '../core/web/src/panel-dock.ts';

test('a floating window placed for the first time goes to the top right, inside the chat and above the composer', () => {
  // Ending 260px above the chat's foot, where the composer is: it reached down over Send and Stop.
  assert.deepEqual(fitFrame(null, { w: 1200, h: 700 }), { x: 664, y: 16, w: 520, h: 424 });
  assert.deepEqual(fitFrame(null, { w: 1200, h: 1000 }), { x: 664, y: 16, w: 520, h: 560 });
  // A short chat: no smaller than of use.
  assert.deepEqual(fitFrame(null, { w: 1200, h: 400 }), { x: 664, y: 16, w: 520, h: 200 });
  // Put somewhere by hand, it may go down there.
  assert.deepEqual(fitFrame({ x: 0, y: 100, w: 520, h: 560 }, { w: 1200, h: 700 }), { x: 0, y: 100, w: 520, h: 560 });
});

test('a floating window stays wholly inside the chat, however it was moved or the chat resized', () => {
  const area = { w: 1000, h: 600 };
  assert.deepEqual(fitFrame({ x: -300, y: 900, w: 400, h: 300 }, area), { x: 0, y: 300, w: 400, h: 300 });
  assert.deepEqual(fitFrame({ x: 900, y: -20, w: 400, h: 300 }, area), { x: 600, y: 0, w: 400, h: 300 });
  // Larger than the chat: the chat's size.
  assert.deepEqual(fitFrame({ x: 10, y: 10, w: 2000, h: 900 }, area), { x: 0, y: 0, w: 1000, h: 600 });
  // Smaller than of use: the least it may be.
  assert.deepEqual(fitFrame({ x: 10, y: 10, w: 50, h: 40 }, area), { x: 10, y: 10, w: 320, h: 200 });
  // In a chat smaller than that, the chat.
  assert.deepEqual(fitFrame({ x: 10, y: 10, w: 50, h: 40 }, { w: 300, h: 150 }), { x: 0, y: 0, w: 300, h: 150 });
});

test('where the panels go is read back only when it is a place they can go', () => {
  assert.equal(isDock('left'), true);
  assert.equal(isDock('float'), true);
  assert.equal(isDock('middle'), false);
  // Not at the top any more: stored there before, they go back to the right.
  assert.equal(isDock('top'), false);
  assert.equal(isDock(null), false);
  assert.deepEqual(readFrame('{"x":1,"y":2,"w":330,"h":240}'), { x: 1, y: 2, w: 330, h: 240 });
  for (const raw of [null, '', 'nope', '{"x":1}', '{"x":"1","y":2,"w":3,"h":4}', '{"x":null,"y":2,"w":3,"h":4}']) assert.equal(readFrame(raw), null);
  assert.deepEqual(['right', 'left', 'bottom', 'float'].map((d) => across(d as never)), [false, false, true, false]);
});

test('panels let go near an edge dock there; anywhere else, and at the top, they float', () => {
  const area = { w: 1200, h: 700 };
  assert.equal(dropTarget({ x: 30, y: 350 }, area), 'left');
  assert.equal(dropTarget({ x: 1170, y: 350 }, area), 'right');
  assert.equal(dropTarget({ x: 600, y: 680 }, area), 'bottom');
  assert.equal(dropTarget({ x: 600, y: 350 }, area), 'float');
  assert.equal(dropTarget({ x: 600, y: 5 }, area), 'float');
  // A corner: the side, not the bottom.
  assert.equal(dropTarget({ x: 10, y: 690 }, area), 'left');
  // A narrow chat keeps its middle for floating.
  assert.equal(dropTarget({ x: 90, y: 200 }, { w: 400, h: 700 }), 'float');
});

const tenths = (f: { x: number; y: number; w: number; h: number }) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, Math.round(v * 10) / 10]));

test('where docked panels would go is shown as the frame they take', () => {
  const area = { w: 1200, h: 700 }, size = { width: 560, height: 320 }, none = { left: 0, right: 0 };
  assert.deepEqual(dockedFrameAmong('left', area, size, none), { x: 0, y: 0, w: 560, h: 700 });
  assert.deepEqual(dockedFrameAmong('right', area, size, none), { x: 640, y: 0, w: 560, h: 700 });
  assert.deepEqual(dockedFrameAmong('bottom', area, size, none), { x: 0, y: 380, w: 1200, h: 320 });
  // As they are drawn: leaving the conversation its 320px of width, beside the edge that sizes them, and 260px of height.
  assert.deepEqual(dockedFrameAmong('right', { w: 800, h: 700 }, size, none), { x: 324, y: 0, w: 476, h: 700 });
  assert.deepEqual(dockedFrameAmong('bottom', { w: 1200, h: 500 }, size, none), { x: 0, y: 260, w: 1200, h: 240 });
  assert.deepEqual(dockedFrameAmong('right', { w: 300, h: 300 }, size, none), { x: 300, y: 0, w: 0, h: 300 });
});

test('a panel carried to a side with panels at the other shows the width both would be drawn at', () => {
  const area = { w: 1200, h: 700 }, size = { width: 400, height: 320 };
  // Room for both: as it was made, beside what is there.
  assert.deepEqual(dockedFrameAmong('left', area, size, { left: 0, right: 400 }), { x: 0, y: 0, w: 400, h: 700 });
  assert.deepEqual(dockedFrameAmong('right', area, size, { left: 400, right: 0 }), { x: 800, y: 0, w: 400, h: 700 });
  // Not: both give way, in proportion (872 of room, less two edges, for 1000).
  assert.deepEqual(tenths(dockedFrameAmong('left', area, size, { left: 0, right: 600 })), { x: 0, y: 0, w: 348.8, h: 700 });
  // At the bottom, under the conversation: between the sides and their edges, as they are drawn.
  assert.deepEqual(dockedFrameAmong('bottom', area, size, { left: 300, right: 400 }), { x: 304, y: 380, w: 492, h: 320 });
  assert.deepEqual(tenths(dockedFrameAmong('bottom', area, size, { left: 500, right: 600 })), { x: 400.4, y: 380, w: 320, h: 320 });
});

test('panels at both sides give way together only where they would leave the conversation less than its room', () => {
  assert.deepEqual(fitSides(400, 400, 1200), { left: 400, right: 400 });
  // 1000, less 320 and two edges of 4.
  assert.deepEqual(fitSides(560, 560, 1000), { left: 336, right: 336 });
  assert.deepEqual(fitSides(300, 600, 1000), { left: 224, right: 448 });
  // One side: held to the room, as before, beside its one edge.
  assert.deepEqual(fitSides(0, 900, 1000), { left: 0, right: 676 });
  assert.deepEqual(fitSides(560, 560, 200), { left: 0, right: 0 });
});

test('each panel goes to its own place, and those in one place are together, in their order', () => {
  const places: Record<string, 'left' | 'right' | 'bottom' | 'float'> = { terminal: 'left', files: 'right', browser: 'right', git: 'float' };
  assert.deepEqual(groupPanels(['browser', 'files', 'git', 'terminal'], (k) => places[k]), [
    { place: 'left', kinds: ['terminal'] },
    { place: 'right', kinds: ['browser', 'files'] },
    { place: 'float', kinds: ['git'] },
  ]);
  assert.deepEqual(groupPanels([], () => 'right'), []);
});

test('places and sizes are read back only where they are ones a panel can have', () => {
  assert.deepEqual(readPlaces('{"terminal":"left","files":"top","git":"float","browser":3}'), { terminal: 'left', git: 'float' });
  for (const raw of [null, '', 'nope', '[1]', '"left"', 'null']) assert.deepEqual(readPlaces(raw), {});
  // A side given way to may be narrower than of use, and is kept so; a height is not.
  assert.deepEqual(readPlaceSizes('{"left":400,"right":100,"bottom":200,"float":500}'), { left: 400, right: 100, bottom: 200 });
  assert.deepEqual(readPlaceSizes('{"left":"400","right":0,"bottom":40}'), {});
  assert.deepEqual(readPlaceSizes('{"left":-5,"right":null}'), {});
  assert.deepEqual(readPlaceSizes('{"left":400,"lead":"left"}'), { left: 400, lead: 'left' });
  assert.deepEqual(readPlaceSizes('{"lead":"bottom"}'), {});
  for (const raw of [null, '', 'nope', '[1]', 'null']) assert.deepEqual(readPlaceSizes(raw), {});
});

test('panels are dragged to no more than leaves the conversation its room, and never below the least', () => {
  assert.deepEqual(dockedSize({ width: 900, height: 600 }, { w: 1000, h: 800 }), { width: 680, height: 540 });
  assert.deepEqual(dockedSize({ width: 100, height: 50 }, { w: 1000, h: 800 }), { width: 320, height: 160 });
  // A chat too small for both: the least, never a height of 40 or below nothing, which was kept and drawn after a reload.
  assert.deepEqual(dockedSize({ width: 500, height: 320 }, { w: 500, h: 300 }), { width: 320, height: 160 });
  assert.deepEqual(dockedSize({ width: 500, height: 320 }, { w: 200, h: 200 }), { width: 320, height: 160 });
});

test('each floating panel has a window of its own, read back only where it is one', () => {
  assert.deepEqual(readFrames('{"terminal":{"x":1,"y":2,"w":330,"h":240},"files":{"x":1},"git":null}'), { terminal: { x: 1, y: 2, w: 330, h: 240 } });
  for (const raw of [null, '', 'nope', '[1]', 'null']) assert.deepEqual(readFrames(raw), {});
});

test('windows that would lie on one another are put aside, so that each is seen', () => {
  const area = { w: 1200, h: 700 }, f = { x: 664, y: 16, w: 520, h: 424 };
  assert.deepEqual(spreadFrames([f, f], area), [f, { ...f, x: 632, y: 48 }]);
  // Apart already: where they were put.
  const g = { x: 10, y: 10, w: 400, h: 300 };
  assert.deepEqual(spreadFrames([f, g], area), [f, g]);
  // Held at the chat's bottom left, the other way.
  const low = { x: 0, y: 400, w: 400, h: 300 };
  assert.deepEqual(spreadFrames([low, low], area), [low, { ...low, x: 32, y: 368 }]);
  // As large as the chat: nowhere else to go.
  const all = { x: 0, y: 0, w: 1200, h: 700 };
  assert.deepEqual(spreadFrames([all, all], area), [all, all]);
});

test('the side sized last keeps its width, and the other gives way first, as far as the least of use', () => {
  // Room for both (1000 less 328 is 672): as they were made.
  assert.deepEqual(fitSides(300, 300, 1000, 'left'), { left: 300, right: 300 });
  // Not: the other gives way.
  assert.deepEqual(fitSides(300, 560, 1000, 'left'), { left: 300, right: 372 });
  // As far as 320, then the one sized last too.
  assert.deepEqual(fitSides(500, 560, 1000, 'left'), { left: 352, right: 320 });
  assert.deepEqual(fitSides(560, 500, 1000, 'right'), { left: 320, right: 352 });
  // Made narrower than 320, it gives way no further than that; and never beyond the room.
  assert.deepEqual(fitSides(600, 200, 1000, 'left'), { left: 472, right: 200 });
  assert.deepEqual(fitSides(600, 560, 500, 'left'), { left: 0, right: 172 });
  // With nothing at the other side there is nothing to give way.
  assert.deepEqual(fitSides(900, 0, 1000, 'left'), { left: 676, right: 0 });
});
