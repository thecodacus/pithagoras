import test from "node:test";
import assert from "node:assert/strict";
import { chatPictures } from "../core/web/src/chat-pictures.ts";
import type { Item, ShownFile } from "../core/web/src/transcript.ts";

const folder = "/workspaces/proj";
const urls = { sent: (name: string) => `/sent/${name}`, shown: (p: string, v: string) => `/shown/${p}?v=${v}` };
const picture = (path: string, more: Partial<ShownFile> = {}): ShownFile => ({ path, kind: "picture", ...more });
const tool = (id: string, name: string, files?: ShownFile[]): Item => ({ kind: "tool", id, name, status: "done", ...(files ? { files } : {}) });

test("a chat's pictures are what was sent and the pictures calls gave, in the order of the conversation", () => {
  const items: Item[] = [
    { kind: "user", id: "u1", seq: 1, text: "look", images: [{ name: "a.png", mimeType: "image/png" }, { name: "b.png", mimeType: "image/png" }] },
    { kind: "user", id: "u2", seq: 2, text: "no pictures" },
    tool("t3", "bash"),
    tool("t4", "generate_image", [picture("generated-images/x.png", { title: "A lighthouse" })]),
    // Any tool's, and only its pictures: a clip and a file are not in the viewer.
    tool("t5", "plot", [picture("docs/plain.png"), { path: "docs/clip.webm", kind: "video" }, { path: "docs/data.csv", kind: "file" }, picture("docs/second.png")]),
  ];
  const list = chatPictures(items, folder, urls);
  assert.deepEqual(list.map((p) => p.id), ["sent:u1:a.png", "sent:u1:b.png", "shown:t4:generated-images/x.png", "shown:t5:docs/plain.png", "shown:t5:docs/second.png"]);
  assert.equal(list[0].src, "/sent/a.png");
  assert.equal(list[2].src, "/shown/generated-images/x.png?v=t4");
  // A title is the caption; a picture without one has none, and is described by its path.
  assert.equal(list[2].caption, "A lighthouse");
  assert.equal(list[3].caption, undefined);
  assert.equal(list[3].alt, "docs/plain.png");
  assert.equal(list[3].fileName, "plain.png");
});

test("a picture a call gave is asked for by the end that gave it, the address every other place draws it by", () => {
  // Voice mode's window and a card's tile version theirs by the end's seq, and the browser shares one download only between the same address.
  const [made, shown] = chatPictures([{ ...tool("t4", "generate_image", [picture("generated-images/x.png")]), filesSeq: 9 }, tool("t5", "show_image", [picture("docs/plain.png")])], folder, urls);
  assert.equal(made.src, "/shown/generated-images/x.png?v=9");
  assert.equal(shown.src, "/shown/docs/plain.png?v=t5", "from an item that does not say, by the item");
});

test("a changed picture is tied to the latest picture of the file it was made from, by a relative or an absolute path", () => {
  const items: Item[] = [
    tool("t1", "generate_image", [picture("generated-images/x.png")]),
    // The same file shown again is a newer picture, and what the edit after it starts from.
    tool("t2", "show_image", [picture("generated-images/x.png")]),
    tool("t3", "edit_image", [picture("generated-images/x-edited.png", { title: "Blue", from: [`${folder}/generated-images/x.png`] })]),
    tool("t4", "edit_image", [picture("generated-images/x-edited-2.png", { from: ["./generated-images/x-edited.png"] })]),
    // Made from a picture that was never shown here: nothing to tie it to.
    tool("t5", "edit_image", [picture("generated-images/y-edited.png", { from: ["somewhere/else.png"] })]),
    // Made from several pictures: it is tied to the first.
    tool("t7", "restyle", [picture("generated-images/x-edited-3.png", { from: ["generated-images/x-edited.png", "generated-images/x.png"] })]),
  ];
  const list = chatPictures(items, folder, urls);
  assert.deepEqual(list.map((p) => p.from), [undefined, undefined, "shown:t2:generated-images/x.png", "shown:t3:generated-images/x-edited.png", undefined, "shown:t3:generated-images/x-edited.png"]);
});
