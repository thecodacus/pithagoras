import { test } from "node:test";
import assert from "node:assert/strict";
import { MATROSKA, MP4, WEBM } from "./video-fixtures.mts";

// What a clip is, by its first bytes, which decides whether the portal plays it in the page or sends it to be saved
// (video-files.ts), and the parts of it a player asks for (http-range.ts).
const { ebmlDocType, sniffVideo, videoType } = await import("../core/server/src/video-files.ts");
const { parseRange } = await import("../core/server/src/http-range.ts");

/** An EBML element: its id, the size of its payload (short enough for one byte), and the payload. */
const element = (id: number[], payload: Buffer) => Buffer.concat([Buffer.from(id), Buffer.from([0x80 | payload.length]), payload]);
/** The start of a file of the EBML family, built element by element: the header, the document type among its children, and what a writer puts after it. */
const ebml = (docType: string, { before = [] as Buffer[], after = [] as Buffer[] } = {}) => {
  const children = Buffer.concat([...before, element([0x42, 0x82], Buffer.from(docType, "latin1")), ...after]);
  return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80 | children.length]), children, Buffer.alloc(24)]);
};

test("a clip whose document type is matroska, as stable-diffusion.cpp writes it, is a WebM; another type, or a type found by chance, is not", () => {
  assert.equal(videoType(MATROSKA.subarray(0, 64))?.ext, "webm");
  assert.equal(videoType(MATROSKA.subarray(0, 64))?.mimeType, "video/webm");
  assert.equal(ebmlDocType(MATROSKA.subarray(0, 64)), "matroska");
  assert.equal(ebmlDocType(WEBM.subarray(0, 64)), "webm");
  for (const type of ["webm", "matroska"]) assert.equal(videoType(ebml(type))?.ext, "webm", type);
  // The type is the one the header names, whole.
  for (const type of ["foo", "webmx", "xmatroska", "matroska2", "Matroska", "", "mp4"]) assert.equal(videoType(ebml(type)), undefined, `type "${type}"`);
  // Not found by looking for a word: another element that says webm or matroska is not the type, and the type is read where the format puts it.
  const version = element([0x42, 0x86], Buffer.from([1]));
  assert.equal(videoType(ebml("foo", { before: [element([0x42, 0x87], Buffer.from("webm"))] })), undefined, "webm in another element");
  assert.equal(videoType(ebml("foo", { after: [element([0x42, 0x87], Buffer.from("matroska"))] })), undefined, "matroska in another element");
  assert.equal(videoType(ebml("matroska", { before: [version, element([0x42, 0xf7], Buffer.from([1]))], after: [element([0x42, 0x87], Buffer.from([4]))] }))?.ext, "webm", "among the elements a writer puts in a header");
  // A header without a type, cut off before it, or that does not add up has none.
  const without = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x83]), version, Buffer.from("webm"), Buffer.alloc(30)]);
  assert.equal(videoType(without), undefined, "no type element, though the word is there");
  assert.equal(videoType(MATROSKA.subarray(0, 12)), undefined, "cut off before the type");
  assert.equal(videoType(MATROSKA.subarray(0, 18)), undefined, "cut off inside the type");
  assert.equal(videoType(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0xff]), Buffer.from("matroska"), Buffer.alloc(40)])), undefined, "a header of unknown size");
  assert.equal(videoType(Buffer.concat([Buffer.from("xx"), MATROSKA.subarray(0, 62)])), undefined, "not at the start of the file");
  // And the MP4 path is as it was.
  assert.equal(videoType(MP4.subarray(0, 64))?.ext, "mp4");
  assert.equal(videoType(MP4.subarray(0, 64))?.mimeType, "video/mp4");
});

test("what a file is is told by its first bytes, with its real type, and only a WebM and an MP4 are played", () => {
  const riff = (tag: string) => Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from(tag), Buffer.alloc(20)]);
  const is = (head: Buffer) => {
    const f = sniffVideo(head);
    return [f.id, f.label, f.mimeType, f.playable];
  };
  assert.deepEqual(is(WEBM.subarray(0, 64)), ["webm", "WebM", "video/webm", true]);
  assert.deepEqual(is(MATROSKA.subarray(0, 64)), ["webm", "WebM", "video/webm", true]);
  assert.deepEqual(is(MP4.subarray(0, 64)), ["mp4", "MP4", "video/mp4", true]);
  assert.deepEqual(is(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypqt  "), Buffer.alloc(20)])), ["mov", "QuickTime", "video/quicktime", false]);
  assert.deepEqual(is(riff("AVI LIST")), ["avi", "AVI", "video/x-msvideo", false]);
  assert.deepEqual(is(riff("WEBPVP8X")), ["webp", "WebP", "image/webp", false]);
  assert.deepEqual(is(Buffer.from("GIF89a-anything")), ["gif", "GIF", "image/gif", false]);
  assert.deepEqual(is(Buffer.from("OggS-anything")), ["ogg", "Ogg", "video/ogg", false]);
  assert.deepEqual(is(ebml("foo")), ["mkv", "EBML (foo)", "video/x-matroska", false], "the document type is what it says");
  assert.deepEqual(is(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80])), ["mkv", "EBML", "video/x-matroska", false], "an EBML header that names none");
  assert.deepEqual(is(Buffer.from("<html>")), ["bin", "Unknown", "application/octet-stream", false]);
  assert.deepEqual(is(Buffer.alloc(0)), ["bin", "Unknown", "application/octet-stream", false]);
  // A document type is shown as text a person can read, and short.
  assert.equal(sniffVideo(ebml("a\u0000b" + "x".repeat(40))).label.length <= "EBML ()".length + 24, true);
});

test("the container of a clip is told by its bytes: WebM and MP4, nothing a name or a server can claim", () => {
  assert.equal(videoType(WEBM.subarray(0, 64))?.ext, "webm");
  assert.equal(videoType(MP4.subarray(0, 64))?.ext, "mp4");
  assert.equal(videoType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>")), undefined);
  assert.equal(videoType(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypqt  "), Buffer.alloc(20)])), undefined, "a QuickTime movie is not played by a browser");
  // An EBML header that is none, or of another kind of document, is not a WebM.
  assert.equal(videoType(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("matroska"), Buffer.alloc(40)])), undefined);
  assert.equal(videoType(ebml("html")), undefined);
  assert.equal(videoType(Buffer.alloc(0)), undefined);
});

test("a range is the bytes a player asks for, or the whole file, or a refusal", () => {
  const r = (header: string | undefined, size = 100) => parseRange(header, size);
  assert.deepEqual(r(undefined), { kind: "all" });
  assert.deepEqual(r("bytes=0-9"), { kind: "range", start: 0, end: 9 });
  assert.deepEqual(r("bytes=10-"), { kind: "range", start: 10, end: 99 });
  assert.deepEqual(r("bytes=-10"), { kind: "range", start: 90, end: 99 });
  assert.deepEqual(r("bytes=-1000"), { kind: "range", start: 0, end: 99 }, "a suffix longer than the file is the file");
  assert.deepEqual(r("bytes=90-1000"), { kind: "range", start: 90, end: 99 }, "an end past the file is its end");
  assert.deepEqual(r("bytes=100-"), { kind: "unsatisfiable" });
  assert.deepEqual(r("bytes=-0"), { kind: "unsatisfiable" });
  // Several ranges, other units and nonsense are no range: the whole file is an answer to all of them.
  for (const header of ["bytes=0-1,5-6", "items=0-1", "bytes=5-2", "bytes=", "bytes=-", "bytes=a-b", "0-9"]) assert.deepEqual(r(header), { kind: "all" }, header);
});
