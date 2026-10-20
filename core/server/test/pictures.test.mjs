import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

const home = inProcessHome("pithagoras-pictures-");

const { default: express } = await import("express");
const { filesRouter } = await import("../dist/api/files.js");
const { createSession } = await import("../dist/db.js");
const { baseDir, readPicture, setAgentAccess } = await import("../dist/workspace-files.js");
const { readVideo } = await import("../dist/video-files.js");

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom"), Buffer.alloc(20)]);
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

test("a clip in the folder is played as what its bytes say it is, in the parts a player asks for, and only from the folder", async () => {
  mkdirSync(path.join(work, "clips"));
  writeFileSync(path.join(work, "clips", "a.mp4"), MP4);
  writeFileSync(path.join(work, "fake.mp4"), "<html></html>");
  writeFileSync(path.join(outside, "secret.mp4"), MP4);
  symlinkSync(path.join(outside, "secret.mp4"), path.join(work, "out.mp4"));
  await withApi(async (base) => {
    const video = base.replace("/picture?", "/video?");
    const ask = (name, headers = {}) => fetch(video + encodeURIComponent(name), { headers });
    const played = await ask("clips/a.mp4");
    assert.equal(played.status, 200);
    assert.equal(played.headers.get("content-type"), "video/mp4");
    assert.deepEqual(Buffer.from(await played.arrayBuffer()), MP4);
    assert.equal((await ask("clips/a.mp4", { range: "bytes=0-9" })).status, 206);
    assert.equal((await ask("clips/a.mp4", { range: "bytes=999999-" })).status, 416);
    assert.equal((await ask("fake.mp4")).status, 400);
    assert.equal((await ask("plots/chart.png")).status, 400, "a picture is not a clip");
    assert.equal((await ask("../outside/secret.mp4")).status, 400);
    assert.ok((await ask("out.mp4")).status >= 400, "no link is followed out of the folder");
    assert.equal((await ask("nothing.mp4")).status, 404);
    assert.equal((await fetch(video.replace("/sessions/pic/", "/sessions/no-such-chat/") + "x")).status, 404);
  });
});

test("what the agent names is read for it: a picture or a clip the sandbox closed to the agent is not read for it, and the person sees it as ever", async () => {
  // The folders above the chat's are open to everyone, as a sandbox has them; what is closed to the agent is a folder, and a file, of its own.
  chmodSync(home, 0o755);
  mkdirSync(path.join(work, "closed"));
  writeFileSync(path.join(work, "closed", "secret.png"), PNG);
  writeFileSync(path.join(work, "closed", "clip.mp4"), MP4);
  chmodSync(path.join(work, "closed"), 0o700);
  writeFileSync(path.join(work, "plots", "private.png"), PNG);
  chmodSync(path.join(work, "plots", "private.png"), 0o600);
  // The agent is another user than the one the files are the portal's for: everyone, to them.
  setAgentAccess(() => [{ uid: 61234, groups: [61234] }]);
  try {
    const as = { likeParent: true, chats: ["pic"] };
    assert.equal(readPicture(baseDir(work), "plots/chart.png", as).mimeType, "image/png");
    assert.throws(() => readPicture(baseDir(work), "closed/secret.png", as), /closed to the agent/);
    assert.throws(() => readPicture(baseDir(work), "plots/private.png", as), /closed to the agent/);
    assert.throws(() => readVideo(baseDir(work), "closed/clip.mp4", as), /closed to the agent/);
    // For the person: the page's route, and a read for no agent.
    assert.equal(readPicture(baseDir(work), "closed/secret.png").mimeType, "image/png");
    assert.equal(readVideo(baseDir(work), "closed/clip.mp4").mimeType, "video/mp4");
    await withApi(async (base) => assert.equal((await fetch(base + "closed/secret.png")).status, 200));
  } finally {
    setAgentAccess(() => undefined);
  }
});

test("a file a call gave that is no picture or clip is sent to be saved, as bytes, whatever its name says; and only from the folder", async () => {
  writeFileSync(path.join(work, "plots", "sales.csv"), "a,b\n1,2\n");
  await withApi(async (base) => {
    const file = base.replace("/picture?", "/file?");
    for (const [name, body] of [["plots/sales.csv", "a,b\n1,2\n"], ["evil.png", "<html><script>alert(1)</script></html>"]]) {
      const res = await fetch(file + encodeURIComponent(name));
      assert.equal(res.status, 200, name);
      assert.equal(res.headers.get("content-type"), "application/octet-stream");
      assert.match(res.headers.get("content-disposition"), new RegExp(`^attachment; filename="${path.basename(name)}"`));
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.match(res.headers.get("content-security-policy"), /sandbox/);
      assert.equal(await res.text(), body);
    }
    for (const [name, status] of [["link.png", 400], ["../outside/secret.png", 400], ["gone.csv", 404], ["plots", 400]]) {
      assert.equal((await fetch(file + encodeURIComponent(name))).status, status, name);
    }
  });
});
