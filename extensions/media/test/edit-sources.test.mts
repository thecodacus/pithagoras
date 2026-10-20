import test from "node:test";
import assert from "node:assert/strict";
import type { Portal } from "@pithagoras/extension-api";
import { MAX_SOURCES, addSources, galleryIdsIn, moveTo, moved, refusal, roomFor, sourceName } from "../src/web/edit-sources.ts";
import type { GalleryPicture } from "../src/web/api.ts";
import { setPortal } from "../src/portal.tsx";
import * as editing from "../src/server/image-editing.ts";

// The routes of Media's server half are where the portal says they are: the package's own.
setPortal({ extension: "pithagoras-media", api: { url: (path: string) => `/api/x/pithagoras-media${path}` } } as unknown as Portal);

let n = 0;
const picture = (over: Partial<GalleryPicture> = {}): GalleryPicture => {
  n++;
  return { id: n.toString(16).padStart(12, "0"), origin: "page", chat: null, folder: null, kind: "uploaded", prompt: `p${n}`, params: {}, from: null, createdAt: 1000 + n, bytes: 1000, fileName: `f${n}.png`, ...over };
};
const some = (count: number) => Array.from({ length: count }, () => picture());
const ids = (list: { id: string }[]) => list.map((p) => p.id);

test("pictures added to an edit that takes several come after the ones there, in the order given", () => {
  const [a, b, c] = some(3);
  assert.deepEqual(ids(addSources([a], [b, c], true).list), ids([a, b, c]));
  assert.equal(addSources([a], [b, c], true).left, 0);
  assert.deepEqual(ids(addSources([], [c, a], true).list), ids([c, a]), "the order they came in, not the gallery's");
});

test("an edit takes no more pictures than the portal does, and says how many did not fit instead of dropping them without a word", () => {
  const have = some(MAX_SOURCES - 2);
  const more = some(5);
  const { list, left } = addSources(have, more, true);
  assert.equal(list.length, MAX_SOURCES);
  assert.deepEqual(ids(list), ids([...have, ...more.slice(0, 2)]), "the first that fit are kept, in order");
  assert.equal(left, 3);
  // Full: nothing is taken, and all of them are counted.
  assert.deepEqual(addSources(list, some(2), true), { list, left: 2 });
});

test("a picture that is in the edit already is not taken twice, and is no loss", () => {
  const [a, b] = some(2);
  const { list, left } = addSources([a], [a, b, b], true);
  assert.deepEqual(ids(list), ids([a, b]));
  assert.equal(left, 0);
});

test("where the endpoint takes one picture, a picture put in takes the place of the one there is, and the others put in with it are counted", () => {
  const [a, b, c] = some(3);
  assert.deepEqual(addSources([a], [b], false), { list: [b], left: 0 });
  assert.deepEqual(ids(addSources([], [b, c], false).list), ids([b]));
  assert.equal(addSources([], [b, c], false).left, 1);
  assert.deepEqual(addSources([a], [], false), { list: [], left: 0 }, "nothing added is nothing, not a clear");
});

test("how many more can be put in at once is what is left of the limit, and one where the endpoint takes one", () => {
  assert.equal(roomFor(0, true), MAX_SOURCES);
  assert.equal(roomFor(3, true), MAX_SOURCES - 3);
  assert.equal(roomFor(MAX_SOURCES, true), 0);
  assert.equal(roomFor(MAX_SOURCES + 2, true), 0);
  assert.equal(roomFor(0, false), 1);
  assert.equal(roomFor(1, false), 1, "it replaces");
});

test("a picture moves one place earlier or later, and not past either end", () => {
  const list = ["a", "b", "c"];
  assert.deepEqual(moved(list, 1, -1), ["b", "a", "c"]);
  assert.deepEqual(moved(list, 1, 1), ["a", "c", "b"]);
  assert.deepEqual(moved(list, 0, -1), ["a", "b", "c"]);
  assert.deepEqual(moved(list, 2, 1), ["a", "b", "c"]);
  assert.deepEqual(moved(list, 5, -1), ["a", "b", "c"], "no such place");
  assert.deepEqual(list, ["a", "b", "c"], "the list that was given is not changed");
  assert.notEqual(moved(list, 0, -1), list);
});

test("pictures that cannot go together are said so: several for an endpoint that takes one, and no weight is too much (the portal scales it down)", () => {
  const [a, b] = some(2);
  assert.equal(refusal([a], false), undefined);
  assert.equal(refusal([a, b], true), undefined);
  assert.equal(refusal([a, b], false), "one");
  const heavy = picture({ bytes: editing.MAX_EDIT_TOTAL_BYTES });
  assert.equal(refusal([heavy, a], true), undefined, "more than an edit takes together is not refused: it is scaled down");
  assert.equal(refusal([heavy, a], false), "one", "the endpoint's own limit is named");
});

test("a picture is called by what it was made from, or its file, on one line and not longer than there is room for", () => {
  assert.equal(sourceName(picture({ prompt: "A fox\nin the snow", fileName: "f.png" })), "A fox in the snow");
  assert.equal(sourceName(picture({ prompt: "", fileName: "cat.png" })), "cat.png");
  const long = sourceName(picture({ prompt: "x".repeat(200) }));
  assert.equal(long.length, 60);
  assert.ok(long.endsWith("…"));
});

test("the form's limits are the ones the portal checks", () => {
  assert.equal(MAX_SOURCES, editing.MAX_EDIT_PICTURES);
});

test("a picture dragged to another place takes that place, and the others keep their order", () => {
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const ids = (l: { id: string }[]) => l.map((p) => p.id);
  assert.deepEqual(ids(moveTo(list, "a", 2)), ["b", "c", "a", "d"], "later");
  assert.deepEqual(ids(moveTo(list, "d", 0)), ["d", "a", "b", "c"], "to the first place, which is the one that counts most");
  assert.deepEqual(ids(moveTo(list, "c", 1)), ["a", "c", "b", "d"], "earlier");
  assert.deepEqual(ids(moveTo(list, "b", 3)), ["a", "c", "d", "b"], "to the last");
  // Nowhere to go, or nothing to move: the list as it is, and not the same array.
  for (const same of [moveTo(list, "b", 1), moveTo(list, "x", 0), moveTo(list, "a", 9), moveTo(list, "a", -1)]) {
    assert.deepEqual(ids(same), ["a", "b", "c", "d"]);
    assert.notEqual(same, list);
  }
  assert.deepEqual(ids(list), ["a", "b", "c", "d"], "the list given is not changed");
});

test("a drag or a paste that names a picture of the gallery by its address is that picture, and not a file to upload", () => {
  const origin = "https://portal.example";
  const a = "0123456789ab";
  const b = "ba9876543210";
  // As a browser drags an <img>: the link, and the picture it was.
  assert.deepEqual(galleryIdsIn({ uris: `${origin}/api/x/pithagoras-media/images/${a}/file` }, origin), [a]);
  assert.deepEqual(galleryIdsIn({ html: `<meta charset='utf-8'><img src="${origin}/api/x/pithagoras-media/images/${a}/file" alt="x">` }, origin), [a]);
  assert.deepEqual(galleryIdsIn({ html: `<IMG class="x" SRC='/api/x/pithagoras-media/images/${b}/file'>` }, origin), [b], "an address without its origin is this portal's");
  // Both of them name the same one: once, in the order named, with comments of a link list left out.
  assert.deepEqual(galleryIdsIn({ uris: `# a picture\r\n${origin}/api/x/pithagoras-media/images/${b}/file\r\n${origin}/api/x/pithagoras-media/images/${a}/file`, html: `<img src="${origin}/api/x/pithagoras-media/images/${b}/file">` }, origin), [b, a]);
  // What is no picture of this gallery is a file like any other.
  assert.deepEqual(galleryIdsIn({}, origin), []);
  assert.deepEqual(galleryIdsIn({ uris: `https://elsewhere.example/api/x/pithagoras-media/images/${a}/file` }, origin), [], "another site, with the same path");
  assert.deepEqual(galleryIdsIn({ html: `<img src="http://portal.example/api/x/pithagoras-media/images/${a}/file">` }, origin), [], "another origin: the scheme counts");
  assert.deepEqual(galleryIdsIn({ uris: `${origin}/api/x/pithagoras-media/images/${a}/file?download=1`, html: `<a href="${origin}/api/x/pithagoras-media/images/${a}/file">x</a>` }, origin), [a], "a query does not change what it is; a link that is no picture is nothing");
  assert.deepEqual(galleryIdsIn({ uris: `${origin}/api/x/pithagoras-media/images/${a}`, html: `<img src="${origin}/api/x/pithagoras-media/images/xyz/file"><img src="${origin}/logo.png">` }, origin), []);
  assert.deepEqual(galleryIdsIn({ uris: "not a url at all" }, origin), []);
});
