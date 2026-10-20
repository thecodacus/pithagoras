import test from "node:test";
import assert from "node:assert/strict";
import { LIMITS, OUTPUT_FORMATS, appendPage, fieldsText, madeButNotListed, mergeTop, readFilter, readForm, sameList, settingsBody, sizeParts, tiles, viewerList, viewerPicture } from "../src/web/images-gallery.ts";
import { LIMITS as portalLimits, OUTPUT_FORMATS as portalFormats } from "../src/server/image-settings.ts";
import type { GalleryPicture, PictureJob } from "../src/web/api.ts";

/** Every field empty, as a form that was kept nothing starts. */
const noFields = () => readForm(null, 1).make;

let n = 0;
const picture = (over: Partial<GalleryPicture> = {}): GalleryPicture => {
  n++;
  return { id: n.toString(16).padStart(12, "0"), origin: "page", chat: null, folder: null, kind: "generated", prompt: `p${n}`, params: {}, from: null, createdAt: 1000 + n, bytes: 1, fileName: `f${n}.png`, ...over };
};
/** A list as the server gives it: newest first. */
const newestFirst = (...p: GalleryPicture[]) => [...p].sort((a, b) => b.createdAt - a.createdAt);
const ids = (p: { id: string }[]) => p.map((x) => x.id);
const job = (over: Partial<PictureJob> = {}): PictureJob => ({ id: `j${++n}`, kind: "generate", state: "running", prompt: "j", startedAt: 5000 + n, ...over });

test("the form's limits are the server half's own, so that raising one raises both and the form does not refuse what the server half takes", () => {
  assert.equal(LIMITS, portalLimits);
  assert.equal(OUTPUT_FORMATS, portalFormats);
  const wide = { ...noFields(), width: "9000", height: "9000" };
  assert.deepEqual(settingsBody(wide, false, false), { field: "width", problem: "size-range" });
  const side = portalLimits.side as { min: number; max: number };
  const was = side.max;
  side.max = 9000;
  try {
    assert.deepEqual(settingsBody(wide, false, false), { body: { size: "9000x9000" } });
  } finally {
    side.max = was;
  }
  // The seed's lowest and the strength's range are the portal's too.
  assert.deepEqual(settingsBody({ ...noFields(), seed: String(portalLimits.seed.min) }, false, true), { body: { seed: portalLimits.seed.min } });
  assert.ok("body" in settingsBody({ ...noFields(), strength: String(portalLimits.strength.max) }, true, true));
  assert.ok("field" in settingsBody({ ...noFields(), strength: String(portalLimits.strength.max + 0.5) }, true, true));
});

test("the filters are read from the address, and what is not a filter is none", () => {
  assert.deepEqual(readFilter(new URLSearchParams("origin=chat&kind=edited")), { origin: "chat", kind: "edited" });
  assert.deepEqual(readFilter(new URLSearchParams("kind=uploaded")), { kind: "uploaded" });
  assert.deepEqual(readFilter(new URLSearchParams("origin=folder&kind=unknown")), { origin: "folder", kind: "unknown" });
  assert.deepEqual(readFilter(new URLSearchParams("origin=elsewhere&kind=nonsense&other=1")), {});
  assert.deepEqual(readFilter(new URLSearchParams("")), {});
});

test("the top of the list asked for again takes the place of the head, and keeps what was loaded further down", () => {
  const all = Array.from({ length: 10 }, () => picture());
  const sorted = newestFirst(...all);
  // Loaded: the newest six. A page is four.
  const loaded = sorted.slice(0, 6);
  const fresh = picture();
  const page = { pictures: [fresh, ...sorted.slice(0, 3)], next: "more" };
  const merged = mergeTop(loaded, page);
  assert.deepEqual(ids(merged), [fresh.id, ...ids(sorted.slice(0, 3)), ...ids(sorted.slice(3, 6))]);
});

test("a picture taken away from the head goes from what is shown, and one deeper down stays where it is", () => {
  const sorted = newestFirst(...Array.from({ length: 8 }, () => picture()));
  const loaded = sorted.slice(0, 7);
  // The second newest was deleted; the page has the next three after it.
  const page = { pictures: [sorted[0], ...sorted.slice(2, 4)], next: "more" };
  assert.deepEqual(ids(mergeTop(loaded, page)), [sorted[0].id, ...ids(sorted.slice(2, 7))]);
});

test("a picture that came back as it was is the one that was shown, and one that changed is the new one", () => {
  const sorted = newestFirst(...Array.from({ length: 3 }, () => picture()));
  // The same pictures, made again from what the server said, as a second answer is.
  const answer = sorted.map((p) => JSON.parse(JSON.stringify(p)) as GalleryPicture);
  const merged = mergeTop(sorted, { pictures: answer, next: null });
  assert.ok(sameList(merged, sorted));
  answer[1].prompt = "changed";
  const again = mergeTop(sorted, { pictures: answer, next: null });
  assert.equal(again[0], sorted[0]);
  assert.equal(again[1], answer[1]);
  assert.equal(sameList(again, sorted), false);
});

test("a list that fits in the fresh page is that page", () => {
  const sorted = newestFirst(...Array.from({ length: 4 }, () => picture()));
  assert.deepEqual(ids(mergeTop(sorted, { pictures: sorted.slice(0, 3), next: null })), ids(sorted.slice(0, 3)));
  assert.deepEqual(mergeTop(sorted, { pictures: [], next: null }), []);
});

test("a page loaded further down joins the end, and what was already there is not drawn twice", () => {
  const sorted = newestFirst(...Array.from({ length: 6 }, () => picture()));
  assert.deepEqual(ids(appendPage(sorted.slice(0, 3), sorted.slice(2, 6))), ids(sorted));
});

test("an original that is further down than the gallery has gone is put in the viewer's list after the first edit that names it", () => {
  const original = picture();
  const other = picture();
  const edit = picture({ kind: "edited", from: original.id });
  const again = picture({ kind: "edited", from: original.id });
  const loaded = [again, edit, other];
  const list = viewerList(loaded, new Map([[original.id, original]]));
  assert.deepEqual(ids(list), [again.id, original.id, edit.id, other.id]);
  // Not twice, and not at all when it is not known or is loaded.
  assert.deepEqual(ids(viewerList(loaded, new Map())), ids(loaded));
  assert.deepEqual(ids(viewerList([...loaded, original], new Map([[original.id, original]]))), [...ids(loaded), original.id]);
});

test("the viewer is given a picture's file, its description and where it was made from", () => {
  const original = picture();
  const edit = picture({ kind: "edited", from: original.id, prompt: "make it blue", fileName: "blue.png" });
  assert.deepEqual(viewerPicture(edit, (id) => `/f/${id}`), { id: edit.id, src: `/f/${edit.id}`, alt: "make it blue", caption: "make it blue", fileName: "blue.png", from: original.id });
  // Nothing said of it: the file's name is what a screen reader has, and there is no caption.
  const bare = viewerPicture(picture({ prompt: "", fileName: "x.png" }), (id) => id);
  assert.equal(bare.alt, "x.png");
  assert.equal("caption" in bare, false);
  assert.equal("from" in bare, false);
});

test("the grid has the jobs that have no picture first, newest first, and then the gallery; a job whose picture is loaded holds that picture's place and the picture is not drawn twice", () => {
  const a = picture();
  const b = picture();
  const running = job({ startedAt: 100 });
  const failed = job({ state: "failed", startedAt: 300, error: "no" });
  const done = job({ state: "done", startedAt: 200, pictureId: a.id });
  const all = tiles([b, a], [running, failed, done], {});
  assert.deepEqual(all.map((t) => t.key), [`job:${failed.id}`, `job:${running.id}`, b.id, `job:${done.id}`]);
  assert.equal(all[3].picture?.id, a.id);
  // A job that is done and whose picture the list has not got yet still has its place in front, and the picture to show from the job.
  const early = tiles([b], [job({ state: "done", pictureId: "0000000000ff" })], {});
  assert.equal(early[0].picture, undefined);
  assert.equal(early[0].job?.pictureId, "0000000000ff");
});

test("a picture made on the page does not stay above pictures that came after it: the grid is in the order the viewer steps through", () => {
  const made = picture();
  const uploaded = picture({ kind: "uploaded" });
  const fromChat = picture({ origin: "chat", chat: { id: "c", title: "t" } });
  const done = job({ state: "done", pictureId: made.id });
  // The server's order: newest first, and the one made on the page is the oldest.
  const list = newestFirst(made, uploaded, fromChat);
  const all = tiles(list, [done], {});
  assert.deepEqual(ids(all.map((t) => t.picture!)), ids(viewerList(list, new Map())));
  assert.equal(all[all.length - 1].key, `job:${done.id}`, "it keeps its tile, and the place the list has for it");
  // The same tile from when it was being made to when it is in the list, so that it is not drawn again.
  const waiting = tiles([uploaded, fromChat], [done], {});
  assert.equal(waiting[0].key, `job:${done.id}`);
});

test("a picture that was deleted is not shown by its job, and a done job without one is nothing to show", () => {
  const a = picture();
  const done = job({ state: "done", pictureId: a.id });
  assert.deepEqual(tiles([a], [done], {}, new Set([a.id])).map((t) => t.key), [a.id]);
  assert.deepEqual(tiles([], [done], {}, new Set([a.id])), []);
  assert.deepEqual(tiles([], [job({ state: "done" })], {}), []);
});

test("a filter leaves out the jobs that make what it does not show", () => {
  const generating = job({ kind: "generate" });
  const editing = job({ kind: "edit" });
  const keys = (filter: Parameters<typeof tiles>[2]) => tiles([], [generating, editing], filter).map((t) => t.job?.kind);
  // Newest first: the edit was started after.
  assert.deepEqual(keys({}), ["edit", "generate"]);
  assert.deepEqual(keys({ kind: "edited" }), ["edit"]);
  assert.deepEqual(keys({ kind: "generated" }), ["generate"]);
  assert.deepEqual(keys({ kind: "uploaded" }), []);
  // What the page makes is of the page, not of a chat.
  assert.deepEqual(keys({ origin: "chat" }), []);
  assert.deepEqual(keys({ origin: "folder" }), []);
  assert.deepEqual(keys({ kind: "unknown" }), [], "what is made here is never one nothing is known of");
  assert.deepEqual(keys({ origin: "page", kind: "edited" }), ["edit"]);
});

test("a picture that a job made and the list has not got is asked for, unless the filter leaves the job out or it was deleted here", () => {
  const listed = picture();
  const there = job({ state: "done", pictureId: listed.id });
  const lost = job({ state: "done", pictureId: "0000000000aa" });
  const edit = job({ state: "done", kind: "edit", pictureId: "0000000000bb" });
  const removed = job({ state: "done", pictureId: "0000000000cc" });
  const running = job();
  const all = [there, lost, edit, removed, running, job({ state: "failed", error: "no" }), job({ state: "done" })];
  const have = new Set([listed.id]);
  assert.deepEqual(madeButNotListed(all, have, new Set(["0000000000cc"]), {}), ["0000000000aa", "0000000000bb"]);
  // What a filter does not show is not of the list it is looked for in.
  assert.deepEqual(madeButNotListed(all, have, new Set(["0000000000cc"]), { kind: "edited" }), ["0000000000bb"]);
  assert.deepEqual(madeButNotListed(all, have, new Set(), { origin: "chat" }), []);
});

test("what an older version sent as free fields is shown as it was, text that looks like a number or a switch keeping its quotes", () => {
  assert.equal(fieldsText({ quality: "high", seed: "42", steps: 30, hd: true, soft: "false" }), 'quality=high\nseed="42"\nsteps=30\nhd=true\nsoft="false"');
  assert.equal(fieldsText(undefined), "");
});

const fields = (over: Partial<ReturnType<typeof noFields>> = {}) => ({ ...noFields(), ...over });

test("a setting that is left empty is not sent, and nothing is sent for a form with none", () => {
  assert.deepEqual(settingsBody(noFields(), false, true), { body: {} });
  assert.deepEqual(settingsBody(noFields(), true, true), { body: {} });
  assert.deepEqual(settingsBody(fields({ model: "  ", width: " ", seed: " ", negativePrompt: "  \n" }), true, true), { body: {} });
  assert.deepEqual(
    settingsBody(fields({ model: " m ", width: "512", height: "768", outputFormat: "jpeg", outputCompression: "80", negativePrompt: " blurry ", seed: "42", sampleSteps: "20" }), false, true),
    { body: { model: "m", size: "512x768", outputFormat: "jpeg", outputCompression: 80, negativePrompt: "blurry", seed: 42, sampleSteps: 20 } },
  );
});

test("what only stable-diffusion.cpp reads is looked at, and sent, only while the switch for it is on", () => {
  const typed = fields({ width: "512", height: "512", negativePrompt: "blurry", seed: "7", sampleSteps: "20", strength: "0.5", fromNoise: true });
  assert.deepEqual(settingsBody(typed, true, false), { body: { size: "512x512" } }, "off: the OpenAI ones only");
  assert.deepEqual(settingsBody(typed, false, false), { body: { size: "512x512" } });
  // Off, a wrong value is not even looked at: it is not on the form, and not the person's to fix.
  assert.deepEqual(settingsBody(fields({ seed: "x", sampleSteps: "0", strength: "9", negativePrompt: "x".repeat(5000) }), true, false), { body: {} });
  assert.deepEqual(settingsBody(fields({ seed: "7", sampleSteps: "20", negativePrompt: "blurry", strength: "0.5" }), false, true), { body: { negativePrompt: "blurry", seed: 7, sampleSteps: 20 } }, "a new picture has no strength");
  assert.deepEqual(settingsBody(fields({ strength: "0,75" }), true, true), { body: { strength: 0.75 } }, "a comma is a decimal point");
  assert.deepEqual(settingsBody(fields({ strength: ".5" }), true, true), { body: { strength: 0.5 } });
  assert.deepEqual(settingsBody(fields({ strength: "1" }), true, true), { body: { strength: 1 } });
  assert.deepEqual(settingsBody(fields({ strength: "0" }), true, true), { body: { strength: 0 } });
  assert.deepEqual(settingsBody(fields({ seed: "-1" }), false, true), { body: { seed: -1 } });
  assert.deepEqual(settingsBody(fields({ seed: "0" }), false, true), { body: { seed: 0 } });
});

test("starting from noise is a setting of a change, and takes the strength away", () => {
  assert.deepEqual(settingsBody(fields({ fromNoise: true }), true, true), { body: { fromNoise: true } });
  assert.deepEqual(settingsBody(fields({ fromNoise: true, strength: "0.5", seed: "3" }), true, true), { body: { fromNoise: true, seed: 3 } }, "no strength with it, and not checked either");
  assert.deepEqual(settingsBody(fields({ fromNoise: true, strength: "nonsense" }), true, true), { body: { fromNoise: true } });
  assert.deepEqual(settingsBody(fields({ fromNoise: true }), false, true), { body: {} }, "a new picture has none to start from");
  assert.deepEqual(settingsBody(fields({ fromNoise: false, strength: "0.5" }), true, true), { body: { strength: 0.5 } });
});

test("a compression goes only with a format that has one, and a setting that is wrong is named, with why", () => {
  assert.deepEqual(settingsBody(fields({ outputFormat: "png", outputCompression: "50" }), false, true), { body: { outputFormat: "png" } });
  assert.deepEqual(settingsBody(fields({ outputCompression: "50" }), false, true), { body: {} }, "no format, no compression");
  assert.deepEqual(settingsBody(fields({ outputFormat: "webp", outputCompression: "0" }), false, true), { body: { outputFormat: "webp", outputCompression: 0 } });

  const wrong = (over: Partial<ReturnType<typeof noFields>>, field: string, problem: string, edit = false) =>
    assert.deepEqual(settingsBody(fields(over), edit, true), { field, problem }, JSON.stringify(over));
  wrong({ width: "512" }, "height", "size-pair");
  wrong({ height: "512" }, "width", "size-pair");
  wrong({ width: "63", height: "512" }, "width", "size-range");
  wrong({ width: "512", height: "8193" }, "height", "size-range");
  wrong({ width: "5.5", height: "512" }, "width", "size-range");
  wrong({ width: "abc", height: "512" }, "width", "size-range");
  wrong({ outputFormat: "jpeg", outputCompression: "101" }, "outputCompression", "compression-range");
  wrong({ outputFormat: "jpeg", outputCompression: "-1" }, "outputCompression", "compression-range");
  wrong({ outputFormat: "jpeg", outputCompression: "1.5" }, "outputCompression", "compression-range");
  wrong({ seed: "1.5" }, "seed", "seed");
  wrong({ seed: "-2" }, "seed", "seed");
  wrong({ seed: "abc" }, "seed", "seed");
  wrong({ sampleSteps: "0" }, "sampleSteps", "steps");
  wrong({ sampleSteps: "101" }, "sampleSteps", "steps");
  wrong({ sampleSteps: "2.5" }, "sampleSteps", "steps");
  wrong({ strength: "1.1" }, "strength", "strength", true);
  wrong({ strength: "-0.1" }, "strength", "strength", true);
  wrong({ strength: "high" }, "strength", "strength", true);
  wrong({ strength: "0.5.5" }, "strength", "strength", true);
  wrong({ negativePrompt: "x".repeat(4001) }, "negativePrompt", "negative-long");
});

test("a size of the add-on is shown in the fields as what is used while they are empty", () => {
  assert.deepEqual(sizeParts("1024x768"), { width: "1024", height: "768" });
  assert.deepEqual(sizeParts("auto"), { width: "auto", height: "auto" });
  assert.deepEqual(sizeParts(""), { width: "", height: "" });
  assert.deepEqual(sizeParts("huge"), { width: "", height: "" });
});

test("what the form kept is read back as far as it still makes sense, a seed never", () => {
  const kept = JSON.stringify({
    make: { model: "draw-2", width: "768", height: "512", negativePrompt: "blurry", outputFormat: "webp", outputCompression: "70", seed: "42", sampleSteps: "20", strength: "0.5" },
    edit: { model: "edit-2", width: "", height: "", fromNoise: true },
    count: 3,
    open: true,
  });
  const got = readForm(kept, 4);
  assert.deepEqual(got.make, { model: "draw-2", width: "768", height: "512", negativePrompt: "blurry", outputFormat: "webp", outputCompression: "70", seed: "", sampleSteps: "20", strength: "0.5", fromNoise: false });
  assert.deepEqual(got.edit, { ...noFields(), model: "edit-2" }, "making and changing keep their own, and not starting from noise");
  assert.equal(got.count, 3);
  assert.equal(got.open, true);
  // Fewer may be made at once now than when it was kept.
  assert.equal(readForm(kept, 2).count, 2);
  // Nothing, or what is not it: the form as it starts.
  const start = { make: noFields(), edit: noFields(), count: 1, open: false };
  assert.deepEqual(readForm(null, 4), start);
  assert.deepEqual(readForm("not json", 4), start);
  assert.deepEqual(readForm('"text"', 4), start);
  assert.deepEqual(readForm(JSON.stringify({ make: 5, edit: "x", count: -2, open: "yes" }), 4), start);
  assert.deepEqual(readForm(JSON.stringify({ make: { outputFormat: "gif", width: 512 } }), 4).make, noFields());
});

test("what an older page kept is still the model and the size for making, and its free fields are gone", () => {
  const old = JSON.stringify({ model: "draw-2", size: "768x512", count: 3, extra: "quality=high", open: true });
  assert.deepEqual(readForm(old, 4), { make: { ...noFields(), model: "draw-2", width: "768", height: "512" }, edit: noFields(), count: 3, open: true });
  assert.deepEqual(readForm(JSON.stringify({ model: "m", size: "auto" }), 4).make, { ...noFields(), model: "m" });
});
