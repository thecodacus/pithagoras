import test from "node:test";
import assert from "node:assert/strict";
import { chatPictures } from "../core/web/src/chat-pictures.ts";
import type { Item } from "../core/web/src/transcript.ts";

const folder = "/workspaces/proj";
const urls = { sent: (name: string) => `/sent/${name}`, shown: (p: string, v: string) => `/shown/${p}?v=${v}` };
const tool = (id: string, name: string, picture: { path: string; title?: string } | undefined, args?: unknown): Item => ({ kind: "tool", id, name, status: "done", ...(picture ? { picture } : {}), ...(args ? { args } : {}) });

test("a chat's pictures are what was sent and what the agent showed, in the order of the conversation", () => {
  const items: Item[] = [
    { kind: "user", id: "u1", seq: 1, text: "look", images: [{ name: "a.png", mimeType: "image/png" }, { name: "b.png", mimeType: "image/png" }] },
    { kind: "user", id: "u2", seq: 2, text: "no pictures" },
    tool("t3", "bash", undefined),
    tool("t4", "generate_image", { path: "generated-images/x.png", title: "A lighthouse" }),
    tool("t5", "show_image", { path: "docs/plain.png" }),
  ];
  const list = chatPictures(items, folder, urls);
  assert.deepEqual(list.map((p) => p.id), ["sent:u1:a.png", "sent:u1:b.png", "shown:t4", "shown:t5"]);
  assert.equal(list[0].src, "/sent/a.png");
  assert.equal(list[2].src, "/shown/generated-images/x.png?v=t4");
  // A title is the caption; a picture without one has none, and is described by its path.
  assert.equal(list[2].caption, "A lighthouse");
  assert.equal(list[3].caption, undefined);
  assert.equal(list[3].alt, "docs/plain.png");
  assert.equal(list[3].fileName, "plain.png");
});

test("a picture made by a call is asked for by the end that showed it, the address every other place draws it by", () => {
  // Voice mode's window and a card's tile version theirs by the end's seq, and the browser shares one download only between the same address.
  const [made, shown] = chatPictures([{ ...tool("t4", "generate_image", { path: "generated-images/x.png" }), pictureSeq: 9 }, tool("t5", "show_image", { path: "docs/plain.png" })], folder, urls);
  assert.equal(made.src, "/shown/generated-images/x.png?v=9");
  assert.equal(shown.src, "/shown/docs/plain.png?v=t5", "from an item that does not say, by the item");
});

test("an edit is tied to the latest picture of the file it was given, by a relative or an absolute path", () => {
  const items: Item[] = [
    tool("t1", "generate_image", { path: "generated-images/x.png" }),
    // The same file shown again is a newer picture, and what the edit after it starts from.
    tool("t2", "show_image", { path: "generated-images/x.png" }),
    tool("t3", "edit_image", { path: "generated-images/x-edited.png", title: "Blue" }, { path: `${folder}/generated-images/x.png`, prompt: "blue" }),
    tool("t4", "edit_image", { path: "generated-images/x-edited-2.png" }, { path: "./generated-images/x-edited.png" }),
    tool("t5", "edit_image", { path: "generated-images/y-edited.png" }, { path: "somewhere/else.png" }),
    // Not the portal's edit_image: its path is not read as one.
    tool("t6", "edit_image", undefined, { path: "generated-images/x.png" }),
    // Made from several pictures: it is tied to the first, which the result is named after.
    tool("t7", "edit_image", { path: "generated-images/x-edited-3.png" }, { paths: [`${folder}/generated-images/x-edited.png`, "generated-images/x.png"], prompt: "both" }),
  ];
  const list = chatPictures(items, folder, urls);
  assert.deepEqual(list.map((p) => p.from), [undefined, undefined, "shown:t2", "shown:t3", undefined, "shown:t3"]);
});
