import { test } from "node:test";
import assert from "node:assert/strict";
import { copyText } from "../core/web/src/clipboard.ts";

test("uses the clipboard API where the page is allowed to", async () => {
  const written: string[] = [];
  const ok = await copyText("hello", {
    clipboard: { writeText: async (t) => void written.push(t) },
    secure: true,
    legacy: () => assert.fail("not needed"),
  });
  assert.equal(ok, true);
  assert.deepEqual(written, ["hello"]);
});

test("falls back over plain HTTP, where there is no clipboard API", async () => {
  const copied: string[] = [];
  const ok = await copyText("hello", {
    clipboard: undefined,
    secure: false,
    legacy: (t) => (copied.push(t), true),
  });
  assert.equal(ok, true);
  assert.deepEqual(copied, ["hello"]);
});

test("falls back when the API refuses", async () => {
  const ok = await copyText("hello", {
    clipboard: { writeText: async () => Promise.reject(new Error("NotAllowedError")) },
    secure: true,
    legacy: () => true,
  });
  assert.equal(ok, true);
});

test("says so when nothing worked", async () => {
  assert.equal(await copyText("x", { clipboard: undefined, secure: false, legacy: () => false }), false);
});

test("an API that exists but is not for this page is not trusted", async () => {
  const ok = await copyText("x", {
    clipboard: { writeText: async () => assert.fail("insecure page must not use it") },
    secure: false,
    legacy: () => true,
  });
  assert.equal(ok, true);
});
