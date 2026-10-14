import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { inProcessHome, scratch } from "./server-harness.mjs";

const home = inProcessHome("pithagoras-images-");

const { parseImages, decodeBase64, saveImages, imagePath, loadImages, MAX_IMAGE_BYTES } = await import("../dist/prompt-images.js");
const { parseEdit } = await import("../dist/api/images.js");
const { MAX_PICTURE_BYTES } = await import("../dist/workspace-files.js");
const { createSession, eventsSince } = await import("../dist/db.js");
const { sessions, IMAGE_ROOT } = await import("../dist/session-manager.js");

// The smallest real PNG: one transparent pixel.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

test("a picture is typed by its bytes, not by what the browser said", () => {
  const [png] = parseImages([{ data: PNG, mimeType: "image/jpeg" }]);
  assert.equal(png.mimeType, "image/png");
  // A data: URL, which is what a browser has to hand, is taken too.
  assert.equal(parseImages([{ data: `data:image/png;base64,${PNG}` }])[0].data, PNG);
});

test("what is not a picture, or too big, or too many, is refused", () => {
  const html = Buffer.from("<html><script>alert(1)</script></html>").toString("base64");
  assert.throws(() => parseImages([{ data: html, mimeType: "image/png" }]), /not a PNG, JPEG, GIF or WebP/);
  assert.throws(() => parseImages([{ data: "not base64!" }]), /not base64/);
  assert.throws(() => parseImages([{ data: "A".repeat(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8) }]), /over 5 MB/);
  assert.throws(() => parseImages(Array.from({ length: 9 }, () => ({ data: PNG }))), /At most 8/);
  assert.throws(() => parseImages("x"), /must be a list/);
  assert.deepEqual(parseImages(undefined), []);
});

test("a picture that arrives as text is read by one set of rules, whether it is pasted, a mask, or what an endpoint sent", () => {
  // Wrapped base64, as some tools write it.
  const wrapped = PNG.replace(/(.{20})/g, "$1\r\n");
  assert.equal(parseImages([{ data: wrapped }])[0].data, PNG);
  assert.deepEqual(decodeBase64(`data:image/png;base64,${wrapped}`, 1024), { bytes: Buffer.from(PNG, "base64"), data: PNG });
  assert.deepEqual(decodeBase64("!!! no !!!", 1024), { error: "invalid" });
  assert.deepEqual(decodeBase64("", 1024), { error: "invalid" });

  // The limit is the picture's size, not what its length can tell: one byte over is over.
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const sized = (n) => {
    const bytes = Buffer.alloc(n);
    magic.copy(bytes);
    return bytes.toString("base64");
  };
  // Only short values are compared below: a failure that printed a 25 MB picture would take gigabytes to say so.
  const outcome = (fn) => {
    try {
      const got = fn();
      return Array.isArray(got) ? `${got.length} pictures` : typeof got === "string" ? got : "taken";
    } catch (e) {
      return e.message;
    }
  };
  assert.equal(outcome(() => parseImages([{ data: sized(MAX_IMAGE_BYTES) }])), "1 pictures");
  assert.equal(outcome(() => parseImages([{ data: sized(MAX_IMAGE_BYTES + 1) }])), "Picture 1 is over 5 MB");
  assert.equal(decodeBase64(sized(MAX_IMAGE_BYTES + 1), MAX_IMAGE_BYTES).error, "large");

  // The same for the mask of an edit.
  const edit = (mask) => parseEdit({ prompt: "p", sources: ["0123456789ab"], mask });
  assert.deepEqual(edit(wrapped).mask, Buffer.from(PNG, "base64"));
  assert.equal(edit("not base64!"), "The mask is not base64");
  // One byte over what an edit takes, 25 MB: the one big fixture of the test.
  assert.equal(outcome(() => edit(sized(MAX_PICTURE_BYTES + 1))), "The mask is over 25 MB");
});

test("only names made here lead to a file, and only in that chat's folder", () => {
  const root = scratch("images-");
  const [saved] = saveImages(root, "chat1", parseImages([{ data: PNG }]));
  assert.match(saved.name, /^[0-9a-f-]{36}\.png$/);
  assert.ok(imagePath(root, "chat1", saved.name));
  assert.equal(imagePath(root, "chat2", saved.name), undefined);
  for (const name of ["../chat1/" + saved.name, "x.png", saved.name.replace(".png", ".html")]) {
    assert.equal(imagePath(root, "chat1", name), undefined, name);
  }
  assert.equal(imagePath(root, "..", saved.name), undefined);
  assert.equal(loadImages(root, "chat1", [saved])[0].data, PNG);
});

/** A pi that remembers what it was sent. */
function fakeClient(input) {
  const sent = [];
  return {
    sent,
    client: {
      prompt: async (message, options) => void sent.push({ message, options }),
      getState: async () => ({ model: { id: "m", name: "Text Model", provider: "p", input }, thinkingLevel: "off" }),
      getCommands: async () => [],
      isIdle: () => true,
    },
  };
}

test("pictures reach pi, the log names them without their bytes, and a retry sends them again", async () => {
  createSession({ id: "pics", title: "pics", workspace: home, executor: "host" });
  const pi = fakeClient(["text", "image"]);
  sessions.ensureClient = async () => pi.client;

  const images = saveImages(IMAGE_ROOT, "pics", parseImages([{ data: PNG }]));
  await sessions.prompt("pics", "what is this?", { images });

  assert.deepEqual(pi.sent[0].options.images, [{ type: "image", data: PNG, mimeType: "image/png" }]);
  const prompt = eventsSince("pics").find((e) => e.type === "portal_prompt");
  const payload = JSON.parse(prompt.payload);
  assert.deepEqual(payload.images, [{ name: images[0].name, mimeType: "image/png" }]);
  assert.ok(!prompt.payload.includes(PNG), "the bytes stay out of the event log");
  // A model that sees pictures is not warned about.
  assert.ok(!eventsSince("pics").some((e) => e.type === "portal_notice"));

  // Retrying — editing without changing a word — keeps the picture.
  await sessions.editMessage("pics", prompt.seq, "what is this?");
  assert.equal(pi.sent.length, 2);
  assert.deepEqual(pi.sent[1].options.images, [{ type: "image", data: PNG, mimeType: "image/png" }]);

  // And the pictures go with the chat.
  assert.equal(readdirSync(path.join(IMAGE_ROOT, "pics")).length, 1);
  sessions.removeFiles("pics");
  assert.equal(existsSync(path.join(IMAGE_ROOT, "pics")), false);
});

test("a model that cannot see pictures is named, so the person can pick another", async () => {
  createSession({ id: "blind", title: "blind", workspace: home, executor: "host" });
  const pi = fakeClient(["text"]);
  sessions.ensureClient = async () => pi.client;
  await sessions.prompt("blind", "", { images: saveImages(IMAGE_ROOT, "blind", parseImages([{ data: PNG }])) });
  const notice = eventsSince("blind").find((e) => e.type === "portal_notice");
  assert.match(JSON.parse(notice.payload).text, /Text Model cannot see pictures/);
});

test("a message with neither words nor a picture cannot be retried into being", async () => {
  createSession({ id: "empty", title: "empty", workspace: home, executor: "host" });
  const pi = fakeClient(["text"]);
  sessions.ensureClient = async () => pi.client;
  await sessions.prompt("empty", "hello");
  const prompt = eventsSince("empty").find((e) => e.type === "portal_prompt");
  await assert.rejects(sessions.editMessage("empty", prompt.seq, "  "), /needs words or a picture/);
  assert.equal(pi.sent.length, 1);
});
