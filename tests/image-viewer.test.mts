import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { MAX_ZOOM, clampView, fitScale, fitted, isFitted, linked, stepped, toggled, zoomAt, type ViewerPicture } from "../core/web/src/image-viewer.ts";

const stage = { w: 1000, h: 600 };
const big = { w: 2000, h: 1200 };
const small = { w: 300, h: 200 };

test("a picture is fitted whole in the stage, and a small one is not blown up", () => {
  assert.equal(fitScale(big, stage), 0.5);
  assert.equal(fitScale({ w: 1000, h: 3000 }, stage), 0.2);
  assert.equal(fitScale(small, stage), 1);
  // Nothing measured yet: a size that changes nothing.
  assert.equal(fitScale({ w: 0, h: 0 }, stage), 1);
  assert.deepEqual(fitted(big, stage), { k: 0.5, x: 0, y: 0 });
  assert.deepEqual(fitted(small, stage), { k: 1, x: 350, y: 200 });
});

test("a view stays inside what is allowed: no smaller than fitted, no larger than the limit, and not off the edge", () => {
  assert.equal(clampView({ k: 0.01, x: 0, y: 0 }, big, stage).k, 0.5);
  assert.equal(clampView({ k: 100, x: 0, y: 0 }, big, stage).k, MAX_ZOOM);
  // Wider than the stage: it cannot be pulled away from either edge.
  const zoomed = clampView({ k: 1, x: 500, y: -9999 }, big, stage);
  assert.deepEqual(zoomed, { k: 1, x: 0, y: -600 });
  // Narrower than the stage on one axis: centred on it, wherever it was put.
  const tall = clampView({ k: 1, x: -50, y: 0 }, { w: 400, h: 2000 }, stage);
  assert.equal(tall.x, 300);
});

test("zooming keeps the spot under the pointer where it is", () => {
  const start = fitted(big, stage);
  const at = { x: 700, y: 200 };
  // The point of the picture under `at` before, in the picture's own pixels.
  const before = { x: (at.x - start.x) / start.k, y: (at.y - start.y) / start.k };
  const next = zoomAt(start, 1, at, big, stage);
  assert.equal(next.k, 1);
  assert.ok(Math.abs((at.x - next.x) / next.k - before.x) < 1e-6);
  assert.ok(Math.abs((at.y - next.y) / next.k - before.y) < 1e-6);
  // And never past the ends.
  assert.equal(zoomAt(start, 50, at, big, stage).k, MAX_ZOOM);
  assert.equal(zoomAt(next, 0.001, at, big, stage).k, 0.5);
});

test("a double tap goes from the whole picture to its own size and back, and a picture that is whole at its own size goes to twice that", () => {
  const whole = fitted(big, stage);
  assert.equal(isFitted(whole, big, stage), true);
  const full = toggled(whole, { x: 500, y: 300 }, big, stage);
  assert.equal(full.k, 1);
  assert.equal(isFitted(full, big, stage), false);
  assert.deepEqual(toggled(full, { x: 500, y: 300 }, big, stage), whole);
  assert.equal(toggled(fitted(small, stage), { x: 500, y: 300 }, small, stage).k, 2);
});

test("stepping goes to the next or the one before, and stops at the ends", () => {
  assert.equal(stepped(1, 4, 1), 2);
  assert.equal(stepped(1, 4, -1), 0);
  assert.equal(stepped(0, 4, -1), undefined);
  assert.equal(stepped(3, 4, 1), undefined);
  assert.equal(stepped(0, 1, 1), undefined);
});

const picture = (id: string, from?: string): ViewerPicture => ({ id, src: `/${id}.png`, alt: id, ...(from ? { from } : {}) });

test("a picture and the one it was edited from reach each other, where both are in the list", () => {
  const list = [picture("a"), picture("b", "a"), picture("c", "b"), picture("d", "gone"), picture("e", "a")];
  assert.equal(linked(list, list[0]).original, undefined);
  assert.deepEqual(linked(list, list[0]).edits.map((p) => p.id), ["b", "e"]);
  assert.equal(linked(list, list[1]).original?.id, "a");
  assert.deepEqual(linked(list, list[1]).edits.map((p) => p.id), ["c"]);
  // Edited from something that is not there: nothing to go to.
  assert.equal(linked(list, list[3]).original, undefined);
  // A picture is not its own original.
  assert.deepEqual(linked([picture("x", "x")], picture("x", "x")), { original: undefined, edits: [] });
});

test("the viewer's own motion steps aside for reduced motion, and the flourish waits for the Animations switch", () => {
  const css = fs.readFileSync(path.resolve(import.meta.dirname, "../core/web/src/styles/viewer.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\}\s*$/)?.[1] ?? "";
  assert.match(reduced, /\.image-viewer-frame\s*\{\s*animation:\s*none/);
  // Every rule that starts an `fx-` animation is under the page's own say-so.
  const loose = [...css.matchAll(/([^{}]+)\{[^{}]*animation:[^;}]*\bfx-[\w-]+/g)].map((m) => m[1].trim()).filter((s) => !s.startsWith('[data-motion="fancy"]'));
  assert.deepEqual(loose, []);
});
