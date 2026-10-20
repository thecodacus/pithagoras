import test from "node:test";
import assert from "node:assert/strict";
import { VIDEO_LIMITS, appendPage, clipSeconds, madeButNotListed, mergeTop, readFilter, readForm, sameList, secondsLabel, settingsBody, sizeParts, tiles } from "../src/web/videos-gallery.ts";
import { VIDEO_LIMITS as portalLimits } from "../src/server/video-settings.ts";
import type { GalleryVideo, VideoJob } from "../src/web/api.ts";

/** Every field empty, as a form that was kept nothing starts. */
const noFields = () => readForm(null, 1).fields;

let n = 0;
const video = (over: Partial<GalleryVideo> = {}): GalleryVideo => {
  n++;
  return { id: n.toString(16).padStart(12, "0"), origin: "page", chat: null, folder: null, kind: "generated", prompt: `p${n}`, params: {}, createdAt: 1000 + n, bytes: 1, fileName: `f${n}.webm`, poster: false, ...over };
};
/** A list as the server gives it: newest first. */
const newestFirst = (...v: GalleryVideo[]) => [...v].sort((a, b) => b.createdAt - a.createdAt);
const ids = (v: { id: string }[]) => v.map((x) => x.id);
const job = (over: Partial<VideoJob> = {}): VideoJob => ({ id: `j${++n}`, kind: "generate", state: "running", prompt: "j", startedAt: 5000 + n, ...over });

test("the form's limits are the server half's own, so that raising one raises both and the form does not refuse what the server half takes", () => {
  assert.equal(VIDEO_LIMITS, portalLimits);
  const wide = { ...noFields(), width: "5000", height: "5000" };
  assert.deepEqual(settingsBody(wide), { field: "width", problem: "size-range" });
  const side = portalLimits.side as { min: number; max: number };
  const was = side.max;
  side.max = 5000;
  try {
    assert.deepEqual(settingsBody(wide), { body: { size: "5000x5000" } });
  } finally {
    side.max = was;
  }
});

test("the filters are read from the address, and what is not a filter is none", () => {
  assert.deepEqual(readFilter(new URLSearchParams("origin=chat&kind=animated")), { origin: "chat", kind: "animated" });
  assert.deepEqual(readFilter(new URLSearchParams("kind=unknown")), { kind: "unknown" });
  // What pictures have (edited) is not a filter of clips.
  assert.deepEqual(readFilter(new URLSearchParams("origin=elsewhere&kind=edited&other=1")), {});
  assert.deepEqual(readFilter(new URLSearchParams("")), {});
});

test("the top of the list asked for again takes the place of the head, and keeps what was loaded further down", () => {
  const sorted = newestFirst(...Array.from({ length: 10 }, () => video()));
  const loaded = sorted.slice(0, 6);
  const fresh = video();
  const merged = mergeTop(loaded, { videos: [fresh, ...sorted.slice(0, 3)], next: "more" });
  assert.deepEqual(ids(merged), [fresh.id, ...ids(sorted.slice(0, 3)), ...ids(sorted.slice(3, 6))]);
  // A clip that is as it was is the very one that was shown, so that it is not drawn again.
  assert.equal(merged[1], sorted[0]);
  // A list that fits in the fresh page is that page.
  assert.deepEqual(ids(mergeTop(loaded, { videos: sorted.slice(1, 4), next: null })), ids(sorted.slice(1, 4)));
  assert.equal(sameList(merged, merged), true);
});

test("a page loaded further down joins the end, and a clip that is already there is not drawn twice", () => {
  const sorted = newestFirst(...Array.from({ length: 6 }, () => video()));
  assert.deepEqual(ids(appendPage(sorted.slice(0, 3), sorted.slice(2, 5))), ids(sorted.slice(0, 5)));
});

test("a job holds the place of its clip, and a clip is not drawn twice", () => {
  const older = video();
  const newer = video();
  const running = job({ state: "running" });
  const done = job({ state: "done", videoId: older.id });
  const failed = job({ state: "failed", error: "no memory" });
  const t = tiles([newer, older], [running, done, failed], {});
  // The jobs without a clip first, newest first; then the gallery, with the clip its job made in the job's tile.
  assert.deepEqual(t.map((x) => x.key), [`job:${failed.id}`, `job:${running.id}`, newer.id, `job:${done.id}`]);
  assert.deepEqual(t.filter((x) => x.video).map((x) => x.video!.id), [newer.id, older.id], "each clip once");
  assert.equal(t.find((x) => x.video?.id === older.id)!.job, done);
  assert.deepEqual(t.filter((x) => !x.video).map((x) => x.job!.id), [failed.id, running.id]);
  // A clip that was deleted here is not shown by its job either.
  assert.deepEqual(tiles([newer], [done], {}, new Set([older.id])).map((x) => x.key), [newer.id]);
  // A job that is done, whose clip the list does not have yet, is a tile of its own until it does.
  assert.deepEqual(tiles([], [done], {}).map((x) => x.key), [`job:${done.id}`]);
});

test("a filter leaves out the jobs it does not show", () => {
  const generating = job({ kind: "generate", state: "running" });
  const animating = job({ kind: "animate", state: "running" });
  const keys = (filter: Parameters<typeof tiles>[2]) => tiles([], [generating, animating], filter).map((x) => x.job!.kind).sort();
  assert.deepEqual(keys({}), ["animate", "generate"]);
  assert.deepEqual(keys({ kind: "generated" }), ["generate"]);
  assert.deepEqual(keys({ kind: "animated" }), ["animate"]);
  assert.deepEqual(keys({ kind: "unknown" }), []);
  assert.deepEqual(keys({ origin: "chat" }), [], "the page's jobs make the page's clips");
  assert.deepEqual(keys({ origin: "page" }), ["animate", "generate"]);
});

test("clips that jobs made and the list does not have are asked for, unless they were deleted here or the filter hides them", () => {
  const done = job({ state: "done", videoId: "aaaaaaaaaaaa" });
  const other = job({ state: "done", videoId: "bbbbbbbbbbbb", kind: "animate" });
  const running = job({ state: "running" });
  assert.deepEqual(madeButNotListed([done, other, running], new Set(), new Set(), {}), ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
  assert.deepEqual(madeButNotListed([done, other], new Set(["aaaaaaaaaaaa"]), new Set(), {}), ["bbbbbbbbbbbb"]);
  assert.deepEqual(madeButNotListed([done, other], new Set(), new Set(["bbbbbbbbbbbb"]), {}), ["aaaaaaaaaaaa"]);
  assert.deepEqual(madeButNotListed([done, other], new Set(), new Set(), { kind: "animated" }), ["bbbbbbbbbbbb"]);
});

test("the settings of the form are checked as the portal checks them, and what is empty is not sent", () => {
  assert.deepEqual(settingsBody(noFields()), { body: {} });
  assert.deepEqual(
    settingsBody({ model: " m ", width: "832", height: "480", frames: "33", fps: "16", negativePrompt: " blurry ", seed: "-1", sampleSteps: "20", strength: "" }),
    { body: { model: "m", size: "832x480", frames: 33, fps: 16, negativePrompt: "blurry", seed: -1, sampleSteps: 20 } },
  );
  // A strength is a number from 0 to 1, a comma a decimal point, 0 a strength; empty is none.
  for (const [typed, sent] of [["0.4", 0.4], [" 0,75 ", 0.75], ["0", 0], ["1", 1], [".5", 0.5]] as const) assert.deepEqual(settingsBody({ ...noFields(), strength: typed }), { body: { strength: sent } }, typed);
  assert.deepEqual(settingsBody({ ...noFields(), strength: "  " }), { body: {} });
  const bad = (over: object) => settingsBody({ ...noFields(), ...over });
  assert.deepEqual(bad({ width: "832" }), { field: "height", problem: "size-pair" });
  assert.deepEqual(bad({ height: "480" }), { field: "width", problem: "size-pair" });
  assert.deepEqual(bad({ width: "63", height: "480" }), { field: "width", problem: "size-range" });
  assert.deepEqual(bad({ width: "832", height: "4097" }), { field: "height", problem: "size-range" });
  assert.deepEqual(bad({ frames: "0" }), { field: "frames", problem: "frames" });
  assert.deepEqual(bad({ frames: "1001" }), { field: "frames", problem: "frames" });
  assert.deepEqual(bad({ frames: "33.5" }), { field: "frames", problem: "frames" });
  assert.deepEqual(bad({ fps: "121" }), { field: "fps", problem: "fps" });
  assert.deepEqual(bad({ seed: "-2" }), { field: "seed", problem: "seed" });
  assert.deepEqual(bad({ seed: "1.5" }), { field: "seed", problem: "seed" });
  assert.deepEqual(bad({ sampleSteps: "0" }), { field: "sampleSteps", problem: "steps" });
  for (const typed of ["1.1", "-0.1", "high", "0.5.5", "1e-1", "2"]) assert.deepEqual(bad({ strength: typed }), { field: "strength", problem: "strength" }, typed);
  assert.deepEqual(bad({ negativePrompt: "x".repeat(portalLimits.negativePrompt + 1) }), { field: "negativePrompt", problem: "negative-long" });
});

test("the form keeps its settings between visits, but not a seed, and survives what storage holds", () => {
  const kept = readForm(JSON.stringify({ fields: { model: "m", width: "832", height: "480", frames: "33", fps: "16", seed: "7", sampleSteps: "20", strength: "0.4", negativePrompt: "blurry" }, count: 3, open: true }), 4);
  assert.deepEqual(kept.fields, { model: "m", width: "832", height: "480", frames: "33", fps: "16", negativePrompt: "blurry", seed: "", sampleSteps: "20", strength: "0.4" });
  assert.deepEqual([kept.count, kept.open], [3, true]);
  assert.equal(readForm(JSON.stringify({ count: 9 }), 4).count, 4, "no more than may run at once");
  assert.equal(readForm(JSON.stringify({ count: 0 }), 4).count, 1);
  for (const stored of [null, "", "not json", "[]", "5", JSON.stringify({ fields: 5, count: "x", open: "yes" })]) {
    assert.deepEqual(readForm(stored, 4), { fields: noFields(), count: 1, open: false }, String(stored));
  }
});

test("a clip's length is what the server says it made, else what was asked for, and nothing when neither is known", () => {
  assert.equal(clipSeconds({ madeFrames: 33, madeFps: 16, frames: 49, fps: 8 }), 33 / 16);
  assert.equal(clipSeconds({ frames: 48, fps: 24 }), 2);
  assert.equal(clipSeconds({ madeFrames: 33 }), undefined);
  assert.equal(clipSeconds({}), undefined);
  assert.equal(secondsLabel(2.0625), "2.1 s");
  assert.equal(secondsLabel(12.4), "12 s");
  assert.equal(secondsLabel(65), "1:05");
  assert.equal(secondsLabel(600), "10:00");
});

test("the sides of the saved size are what the empty fields show", () => {
  assert.deepEqual(sizeParts("832x480"), { width: "832", height: "480" });
  assert.deepEqual(sizeParts(""), { width: "", height: "" });
  assert.deepEqual(sizeParts("auto"), { width: "", height: "" });
});
