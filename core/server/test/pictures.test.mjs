import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

const home = inProcessHome("pithagoras-pictures-");

const { default: express } = await import("express");
const { filesRouter } = await import("../dist/api/files.js");
const { createSession } = await import("../dist/db.js");
const { pictureIn, showImageTool } = await import("../dist/pi/show-image-tool.js");

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const work = path.join(home, "work");
const outside = path.join(home, "outside");
mkdirSync(path.join(work, "plots"), { recursive: true });
mkdirSync(outside);
writeFileSync(path.join(work, "plots", "chart.png"), PNG);
// Named like a picture, and is a page: served as one it would run in the portal's origin.
writeFileSync(path.join(work, "evil.png"), "<html><script>alert(1)</script></html>");
writeFileSync(path.join(outside, "secret.png"), PNG);
symlinkSync(path.join(outside, "secret.png"), path.join(work, "link.png"));
createSession({ id: "pic", title: "pic", workspace: work, executor: "host" });

async function withApi(fn) {
  const app = express();
  app.use("/api", filesRouter());
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/sessions/pic/picture?path=`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

test("a picture in the folder is served as what its bytes say it is, and cannot run anything", async () => {
  await withApi(async (base) => {
    const res = await fetch(base + encodeURIComponent("plots/chart.png"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("content-security-policy"), /sandbox/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  });
});

test("a picture already fetched and not changed since is not sent again", async () => {
  await withApi(async (base) => {
    const first = await fetch(base + encodeURIComponent("plots/chart.png"));
    const etag = first.headers.get("etag");
    assert.ok(etag);
    assert.ok(first.headers.get("last-modified"));
    await first.arrayBuffer();
    // As a browser revalidating its cache asks: fetch() alone would add "no-cache", which asks for the whole file.
    const again = await fetch(base + encodeURIComponent("plots/chart.png"), { headers: { "If-None-Match": etag, "Cache-Control": "max-age=0" } });
    assert.equal(again.status, 304);
    const changed = await fetch(base + encodeURIComponent("plots/chart.png"), { headers: { "If-None-Match": 'W/"0-0"', "Cache-Control": "max-age=0" } });
    assert.equal(changed.status, 200);
    assert.deepEqual(Buffer.from(await changed.arrayBuffer()), PNG);
  });
});

test("a file that only has a picture's name, or lies outside, or is not there, is refused", async () => {
  await withApi(async (base) => {
    assert.equal((await fetch(base + "evil.png")).status, 400);
    assert.equal((await fetch(base + "link.png")).status, 400);
    assert.equal((await fetch(base + encodeURIComponent("../outside/secret.png"))).status, 400);
    assert.equal((await fetch(base + "gone.png")).status, 404);
  });
});

test("show_image takes a picture by a path relative to the folder or absolute inside it", () => {
  assert.equal(pictureIn(work, "plots/chart.png"), "plots/chart.png");
  assert.equal(pictureIn(work, path.join(work, "plots", "chart.png")), "plots/chart.png");
  assert.throws(() => pictureIn(work, path.join(outside, "secret.png")), /chat's folder/);
  assert.throws(() => pictureIn(work, "evil.png"), /not a PNG/);
  assert.throws(() => pictureIn(work, "link.png"));
  // A name that only starts with two dots is in the folder.
  writeFileSync(path.join(work, "..preview.png"), PNG);
  assert.equal(pictureIn(work, "..preview.png"), "..preview.png");
  assert.equal(pictureIn(work, path.join(work, "..preview.png")), "..preview.png");
  assert.throws(() => pictureIn(work, "../outside/secret.png"), /chat's folder/);
});

test("show_image takes an absolute path through a link to the folder, as the agent sees it", () => {
  const linked = path.join(home, "linked-work");
  symlinkSync(work, linked);
  assert.equal(pictureIn(linked, path.join(linked, "plots", "chart.png")), "plots/chart.png");
  assert.equal(pictureIn(linked, path.join(work, "plots", "chart.png")), "plots/chart.png");
  assert.equal(pictureIn(linked, "plots/chart.png"), "plots/chart.png");
  assert.throws(() => pictureIn(linked, path.join(linked, "..", "outside", "secret.png")), /chat's folder/);
  assert.throws(() => pictureIn(linked, path.join(linked, "link.png")));
});

test("the tool answers with the path the page fetches the picture by", async () => {
  let tool;
  showImageTool(work)({ registerTool: (t) => (tool = t) });
  assert.equal(tool.name, "show_image");
  const result = await tool.execute("call", { path: "./plots/../plots/chart.png", title: "  Sales  " });
  assert.deepEqual(result.details, { path: "plots/chart.png", title: "Sales" });
  await assert.rejects(tool.execute("call", { path: "missing.png" }));
});
