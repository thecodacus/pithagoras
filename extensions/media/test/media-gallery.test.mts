import test from "node:test";
import assert from "node:assert/strict";
import { behind, feedFilters, filterParams, horizon, joinTiles, kindOptions, readFilter, selectionKey, shownKinds, splitSelection, tileSelection } from "../src/web/media-gallery.ts";
import { tiles as pictureTiles } from "../src/web/images-gallery.ts";
import { tiles as videoTiles } from "../src/web/videos-gallery.ts";
import type { GalleryPicture, GalleryVideo, PictureJob, VideoJob } from "../src/web/api.ts";

let n = 0;
const hex = (k: number) => k.toString(16).padStart(12, "0");
const picture = (createdAt: number, over: Partial<GalleryPicture> = {}): GalleryPicture => {
  n++;
  return { id: hex(n), origin: "page", chat: null, folder: null, kind: "generated", prompt: `p${n}`, params: {}, from: null, createdAt, bytes: 1, fileName: `f${n}.png`, thumb: false, ...over };
};
const video = (createdAt: number, over: Partial<GalleryVideo> = {}): GalleryVideo => {
  n++;
  return { id: hex(n), origin: "page", chat: null, folder: null, kind: "generated", prompt: `v${n}`, params: {}, createdAt, bytes: 1, fileName: `f${n}.webm`, poster: false, ...over };
};
const newestFirst = <T extends { createdAt: number; id: string }>(...items: T[]) => [...items].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
const pictureJob = (over: Partial<PictureJob> = {}): PictureJob => ({ id: `pj${++n}`, kind: "generate", state: "running", prompt: "j", startedAt: 0, ...over });
const videoJob = (over: Partial<VideoJob> = {}): VideoJob => ({ id: `vj${++n}`, kind: "generate", state: "running", prompt: "j", startedAt: 0, ...over });

/** What the page hands over for a list: its tiles, and what it has loaded and whether the portal has more. */
const pictures = (items: GalleryPicture[], more: boolean, jobs: PictureJob[] = []) => ({ tiles: pictureTiles(items, jobs, {}), view: { items, more } });
const videos = (items: GalleryVideo[], more: boolean, jobs: VideoJob[] = []) => ({ tiles: videoTiles(items, jobs, {}), view: { items, more } });
const ids = (tilesOf: ReturnType<typeof joinTiles>) => tilesOf.map((m) => (m.kind === "picture" ? m.tile.picture?.id ?? m.tile.job?.id : m.tile.video?.id ?? m.tile.job?.id));

test("the filters are read from the address: both kinds unless one is named, and what is not a filter is none", () => {
  assert.deepEqual(readFilter(new URLSearchParams("")), { show: "all" });
  assert.deepEqual(readFilter(new URLSearchParams("show=videos&origin=chat&kind=animated")), { show: "videos", origin: "chat", kind: "animated" });
  assert.deepEqual(readFilter(new URLSearchParams("show=images&kind=edited")), { show: "images", kind: "edited" });
  // A link that is out of date shows everything.
  assert.deepEqual(readFilter(new URLSearchParams("show=clips&origin=elsewhere&kind=weird&other=1")), { show: "all" });
  // And what is set is what the address gets back, nothing more.
  assert.deepEqual(filterParams({ show: "all" }), {});
  assert.deepEqual(filterParams({ show: "videos", origin: "folder", kind: "unknown" }), { show: "videos", origin: "folder", kind: "unknown" });
});

test("only one kind is shown where the portal makes only that one, whatever the address says", () => {
  assert.equal(shownKinds("all", true, true), "all");
  assert.equal(shownKinds("videos", true, true), "videos");
  assert.equal(shownKinds("all", true, false), "images");
  assert.equal(shownKinds("videos", true, false), "images");
  assert.equal(shownKinds("all", false, true), "videos");
  assert.equal(shownKinds("images", false, true), "videos");
});

test("each list is asked for what the filters say of it, and a kind that only one list has leaves the other out", () => {
  assert.deepEqual(feedFilters({ show: "all" }, "all"), { pictures: {}, videos: {} });
  assert.deepEqual(feedFilters({ show: "all", origin: "chat" }, "all"), { pictures: { origin: "chat" }, videos: { origin: "chat" } });
  // Made is both lists', and so is not knowing.
  assert.deepEqual(feedFilters({ show: "all", kind: "generated" }, "all"), { pictures: { kind: "generated" }, videos: { kind: "generated" } });
  assert.deepEqual(feedFilters({ show: "all", kind: "unknown", origin: "folder" }, "all"), { pictures: { origin: "folder", kind: "unknown" }, videos: { origin: "folder", kind: "unknown" } });
  // Changed and from this computer are pictures'; from a picture is videos'.
  assert.deepEqual(feedFilters({ show: "all", kind: "edited" }, "all"), { pictures: { kind: "edited" }, videos: null });
  assert.deepEqual(feedFilters({ show: "all", kind: "uploaded" }, "all"), { pictures: { kind: "uploaded" }, videos: null });
  assert.deepEqual(feedFilters({ show: "all", kind: "animated" }, "all"), { pictures: null, videos: { kind: "animated" } });
  // One kind alone: the other list is left out, and a kind it has not is no filter, as in a link that is out of date.
  assert.deepEqual(feedFilters({ show: "images", origin: "page" }, "images"), { pictures: { origin: "page" }, videos: null });
  assert.deepEqual(feedFilters({ show: "videos", kind: "edited" }, "videos"), { pictures: null, videos: {} });
  assert.deepEqual(feedFilters({ show: "images", kind: "animated" }, "images"), { pictures: {}, videos: null });
});

test("the choices of how it was made are the kinds there are of what is shown", () => {
  const ids = (show: Parameters<typeof kindOptions>[0]) => kindOptions(show).map((o) => o.id);
  assert.deepEqual(ids("images"), ["", "generated", "edited", "uploaded", "unknown"]);
  assert.deepEqual(ids("videos"), ["", "generated", "animated", "unknown"]);
  assert.deepEqual(ids("all"), ["", "generated", "edited", "animated", "uploaded", "unknown"]);
});

test("the gallery is known down to the newest of the lists' last items, where a list has more", () => {
  const ps = newestFirst(picture(100), picture(80), picture(50));
  const vs = newestFirst(video(90), video(70));
  // Both are whole: all of it is known.
  assert.equal(horizon([{ items: ps, more: false }, { items: vs, more: false }]), undefined);
  // The videos have more: nothing below their last item (70) is known, though the pictures are loaded further.
  assert.equal(horizon([{ items: ps, more: false }, { items: vs, more: true }]), vs[1]);
  // Both have more: the one that reaches the less far sets it, which is the one whose last item is newer.
  assert.equal(horizon([{ items: ps, more: true }, { items: vs, more: true }]), vs[1]);
  assert.equal(horizon([null, { items: vs, more: true }]), vs[1]);
});

test("the next page is asked of the lists that hold the horizon", () => {
  const ps = newestFirst(picture(100), picture(60));
  const vs = newestFirst(video(95), video(70));
  assert.deepEqual(behind({ items: ps, more: true }, { items: vs, more: true }), ["videos"], "the videos stop at 70, the pictures go on to 60");
  assert.deepEqual(behind({ items: ps, more: true }, { items: vs, more: false }), ["pictures"]);
  assert.deepEqual(behind({ items: ps, more: false }, { items: vs, more: false }), []);
  assert.deepEqual(behind(null, { items: vs, more: true }), ["videos"]);
  assert.deepEqual(behind({ items: ps, more: true }, null), ["pictures"]);
});

test("the two lists are one gallery, newest first", () => {
  const ps = newestFirst(picture(100), picture(80), picture(50));
  const vs = newestFirst(video(90), video(75), video(60));
  const joined = joinTiles(pictures(ps, false), videos(vs, false));
  assert.deepEqual(ids(joined), [ps[0].id, vs[0].id, ps[1].id, vs[1].id, vs[2].id, ps[2].id]);
  // A tile is told from the other kind's by its key, whatever the ids.
  assert.equal(new Set(joined.map((m) => m.key)).size, 6);
});

test("made in the same moment, the greater id comes first, as the portal orders them", () => {
  const p = picture(500);
  const v = video(500);
  const first = p.id > v.id ? p.id : v.id;
  assert.equal(ids(joinTiles(pictures([p], false), videos([v], false)))[0], first);
});

test("nothing older than the horizon is shown, and it comes as the list that holds it is read further", () => {
  const ps = newestFirst(picture(100), picture(80), picture(50));
  const vs = newestFirst(video(90), video(70));
  // The videos have more beyond 70: there may be videos between 70 and the picture of 50, not yet loaded.
  assert.deepEqual(ids(joinTiles(pictures(ps, false), videos(vs, true))), [ps[0].id, vs[0].id, ps[1].id, vs[1].id]);
  // Both whole: the picture of 50 is there.
  assert.deepEqual(ids(joinTiles(pictures(ps, false), videos(vs, false))), [ps[0].id, vs[0].id, ps[1].id, vs[1].id, ps[2].id]);
  // The pictures have more beyond 50 and the videos none: all that is loaded is known, and shown.
  assert.deepEqual(ids(joinTiles(pictures(ps, true), videos(vs, false))), [ps[0].id, vs[0].id, ps[1].id, vs[1].id, ps[2].id]);
  // Both have more: down to the pictures' 50, which is newer than the video of 40, which is held back.
  const late = video(40);
  assert.deepEqual(ids(joinTiles(pictures(ps, true), videos([late], true))), [ps[0].id, ps[1].id, ps[2].id]);
  // The item that is the horizon itself is shown.
  assert.ok(ids(joinTiles(pictures(ps, true), videos(vs, true))).includes(vs[1].id));
});

test("a list that is left out has no tiles", () => {
  const ps = newestFirst(picture(100), picture(80));
  assert.deepEqual(ids(joinTiles(pictures(ps, false), null)), ps.map((p) => p.id));
  assert.deepEqual(ids(joinTiles(null, videos([], false))), []);
  assert.deepEqual(joinTiles(null, null), []);
});

test("jobs that have nothing to show yet come first, newest started first, whichever kind; a job that made one holds its place", () => {
  const ps = newestFirst(picture(100), picture(60));
  const vs = newestFirst(video(90));
  const earlier = pictureJob({ startedAt: 1000 });
  const later = videoJob({ startedAt: 2000 });
  const held = videoJob({ state: "done", startedAt: 500, videoId: vs[0].id });
  const joined = joinTiles(pictures(ps, false, [earlier]), videos(vs, false, [later, held]));
  const describe = (m: (typeof joined)[number]) => `${m.kind}:${m.tile.job?.id ?? ""}:${m.kind === "picture" ? (m.tile.picture?.id ?? "") : (m.tile.video?.id ?? "")}`;
  assert.deepEqual(joined.map(describe), [`video:${later.id}:`, `picture:${earlier.id}:`, `picture::${ps[0].id}`, `video:${held.id}:${vs[0].id}`, `picture::${ps[1].id}`]);
});

test("a selection keeps the kind of each, so that a picture and a video of the same id are two", () => {
  const same = hex(7);
  assert.notEqual(selectionKey("picture", same), selectionKey("video", same));
  assert.deepEqual(splitSelection([selectionKey("picture", "a1"), selectionKey("video", "b2"), selectionKey("picture", "c3"), "stray"]), { pictures: ["a1", "c3"], videos: ["b2"] });
  const p = picture(1);
  const v = video(2);
  const joined = joinTiles(pictures([p], false, [pictureJob()]), videos([v], false));
  // The job has made nothing to select yet.
  assert.deepEqual(joined.map(tileSelection), [undefined, selectionKey("video", v.id), selectionKey("picture", p.id)]);
});
