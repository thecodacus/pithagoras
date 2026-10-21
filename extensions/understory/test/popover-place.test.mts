import { test } from "node:test";
import assert from "node:assert/strict";
import { placePopover } from "../src/web/popover-place.ts";

const view = { width: 390, height: 800 };
const size = { width: 232, height: 150 };

test("a popover goes under its button, its right edge on the button's", () => {
  const at = placePopover({ left: 200, right: 300, top: 60, bottom: 90 }, size, { width: 1280, height: 800 });
  assert.deepEqual(at, { left: 68, top: 96, width: 232, above: false });
});

test("at the right edge of a narrow window it is shifted in, never past either edge", () => {
  for (const right of [380, 390, 400]) {
    const at = placePopover({ left: right - 30, right, top: 60, bottom: 90 }, size, view);
    assert.ok(at.left >= 8 && at.left + at.width <= view.width - 8, `${right}: ${at.left}`);
  }
  // At the left edge too.
  assert.equal(placePopover({ left: 0, right: 30, top: 60, bottom: 90 }, size, view).left, 8);
  // Wider than the window: as wide as it is, less the margins.
  const wide = placePopover({ left: 0, right: 30, top: 60, bottom: 90 }, { width: 600, height: 100 }, view);
  assert.deepEqual([wide.left, wide.width], [8, 374]);
});

test("near the bottom it opens above the button, and it is never off the top or the bottom", () => {
  const low = placePopover({ left: 100, right: 200, top: 740, bottom: 770 }, size, view);
  assert.equal(low.above, true);
  assert.equal(low.top, 740 - 6 - 150);
  const cramped = placePopover({ left: 100, right: 200, top: 100, bottom: 130 }, { width: 200, height: 760 }, view);
  assert.ok(cramped.top >= 8 && cramped.top + 760 <= 800 - 8 + 1e-9 || cramped.top === 8);
});
