import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { request } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { inProcessHome } from "../../../tests/helpers.mts";
import { startMedia } from "./portal.mts";
import { KEY, MATROSKA, MP4, PNG, TAKES_END_IMAGE, WEBM, completed, fakeSd } from "./video-fixtures.mts";
import * as gen from "../src/server/video-generation.ts";
import * as gallery from "../src/server/video-gallery.ts";
import * as jobsModule from "../src/server/video-jobs.ts";
import * as posters from "../src/server/video-posters.ts";
import * as copies from "../src/server/video-copies.ts";
import * as images from "../src/server/image-gallery.ts";
import { videoIn } from "../src/server/pi/show-video-tool.ts";
import { MAX_RUNNING_VIDEOS } from "../src/server/video-settings.ts";
import { MAX_VIDEO_BYTES } from "../src/server/video-files.ts";
import { portal } from "../src/server/host.ts";
import { getDb } from "../src/server/store.ts";

// The clips of the Media page: the gallery, its jobs, its API, the agent's tool and the posters.
const temp = realpathSync(inProcessHome("pitha-vgallery-"));
const root = process.env.WORKSPACE_ROOT!;
mkdirSync(root, { recursive: true });

// Media's routes as the portal serves them, beside the portal's own routes of a chat's files.
const media = await startMedia();
const { GENERATED_VIDEOS_DIR } = gallery;
const at = media.at;

/** A call to the API, and what it answered; none ever has the key in it. */
async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${at}${p}`, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const bytes = Buffer.from(await r.arrayBuffer());
  assert.ok(!bytes.includes(KEY), `${method} ${p} gave the key back`);
  const type = r.headers.get("content-type") ?? "";
  return { status: r.status, headers: r.headers, bytes, body: type.includes("json") ? JSON.parse(bytes.toString("utf8")) : undefined };
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Waits until none of the jobs is running, and returns them. */
async function settled(): Promise<any[]> {
  for (let i = 0; i < 400; i++) {
    const { jobs } = (await call("GET", "/videos/jobs")).body;
    if (jobs.every((j: any) => j.state !== "running")) return jobs;
    await pause(25);
  }
  assert.fail("a job never ended");
}
/** No job of an earlier test is left to be told apart from this one's. */
async function clearJobs() {
  for (const job of (await call("GET", "/videos/jobs")).body.jobs) await call("DELETE", `/videos/jobs/${job.id}`);
}
const setup = (origin: string, more: Parameters<typeof gen.saveVideoGeneration>[0] = {}) =>
  gen.saveVideoGeneration({ enabled: true, baseUrl: origin, apiKey: KEY, model: "", size: "", frames: null, fps: null, storageLimitMb: null, ...more });
const off = () => gen.saveVideoGeneration({ enabled: false });
const listed = async (query = "") => (await call("GET", `/videos${query}`)).body;
/** A chat with a folder of its own. */
function chat(id: string, title = "A chat") {
  const folder = mkdtempSync(path.join(temp, "chat-"));
  media.chat(id, folder, title);
  return folder;
}
/** A project: a folder under the workspace root, with a folder of generated clips if asked. */
const project = (name: string, generated = true) => {
  const folder = path.join(root, name);
  mkdirSync(generated ? path.join(folder, GENERATED_VIDEOS_DIR) : folder, { recursive: true });
  return folder;
};
const put = (folder: string, name: string, bytes: Buffer = WEBM) => {
  mkdirSync(path.join(folder, GENERATED_VIDEOS_DIR), { recursive: true });
  const file = path.join(folder, GENERATED_VIDEOS_DIR, name);
  writeFileSync(file, bytes);
  return file;
};
/** A clip as a server may finish one that a browser does not play: an AVI, which is a RIFF file with the AVI tag. */
const AVI = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("AVI LIST"), Buffer.alloc(40)]);
/** An AVI in the gallery as a clip of the page. */
const aviClip = (prompt: string, bytes = AVI) => gallery.addPageVideo({ bytes, ext: "avi", kind: "generated", prompt, params: {} });
/** A clip of a different content, as a file: the bytes of the real one with a tail that tells two apart. */
const clip = (tag: string) => Buffer.concat([WEBM, Buffer.from(tag)]);

test("a clip is made without any chat: a job, a clip in the gallery that is sent, and the key stays on the server", async () => {
  const sd = await fakeSd();
  await clearJobs();
  try {
    setup(sd.origin, { model: "saved" });
    const start = await call("POST", "/videos/generate", { prompt: "  a fox in the snow  ", size: "832x480", frames: 33, fps: 16, seed: 7, sampleSteps: 20, negativePrompt: "blurry", count: 2 });
    assert.equal(start.status, 202, "answered at once, without waiting for the endpoint");
    assert.equal(start.body.jobs.length, 2);
    assert.deepEqual(start.body.jobs.map((j: any) => [j.kind, j.size, j.state]), [["generate", "832x480", "running"], ["generate", "832x480", "running"]]);
    const done = await settled();
    assert.deepEqual(done.map((j) => j.state), ["done", "done"]);

    const bodies = sd.to("POST", "/sdcpp/v1/vid_gen").map((s) => s.body);
    assert.deepEqual(bodies.map((b) => b.seed).sort(), [7, 8], "each clip takes the next seed");
    assert.deepEqual(bodies[0], { prompt: "a fox in the snow", model: "saved", negative_prompt: "blurry", width: 832, height: 480, video_frames: 33, fps: 16, seed: bodies[0].seed, sample_params: { sample_steps: 20 }, output_format: "webm" });
    assert.ok(sd.seen.every((s) => s.auth === `Bearer ${KEY}`));

    const list = await listed();
    assert.equal(list.total, 2);
    assert.equal(list.videos.length, 2);
    const first = list.videos[0];
    assert.deepEqual(
      { origin: first.origin, kind: first.kind, prompt: first.prompt, chat: first.chat, folder: first.folder, bytes: first.bytes },
      { origin: "page", kind: "generated", prompt: "a fox in the snow", chat: null, folder: null, bytes: WEBM.length },
    );
    assert.deepEqual(
      { model: first.params.model, size: first.params.size, frames: first.params.frames, fps: first.params.fps, madeFrames: first.params.madeFrames, madeFps: first.params.madeFps, negativePrompt: first.params.negativePrompt },
      { model: "saved", size: "832x480", frames: 33, fps: 16, madeFrames: 33, madeFps: 16, negativePrompt: "blurry" },
    );
    assert.match(first.fileName, /^video-\d{8}-\d{6}-[0-9a-f]{4}\.webm$/);
    assert.equal(list.pageBytes, WEBM.length * 2);
    // Both jobs say which clip they made.
    assert.deepEqual(new Set(done.map((j) => j.videoId)), new Set(list.videos.map((v: any) => v.id)));

    const file = await call("GET", `/videos/${first.id}/file`);
    assert.equal(file.status, 200);
    assert.deepEqual(file.bytes, WEBM);
    assert.equal(file.headers.get("content-type"), "video/webm");
    assert.equal(file.headers.get("accept-ranges"), "bytes");
    assert.equal(file.headers.get("x-content-type-options"), "nosniff");
    assert.match(file.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.equal(file.headers.get("cache-control"), "private, max-age=86400");
  } finally {
    sd.server.close();
    await clearJobs();
  }
});

test("a player is sent the part of a clip it asks for, and the whole one when the range does not hold", async () => {
  const sd = await fakeSd();
  await clearJobs();
  try {
    setup(sd.origin);
    const { jobs } = (await call("POST", "/videos/generate", { prompt: "range" })).body;
    await settled();
    const { videoId } = (await call("GET", "/videos/jobs")).body.jobs.find((j: any) => j.id === jobs[0].id);
    const file = `/videos/${videoId}/file`;
    const size = WEBM.length;

    const part = await call("GET", file, undefined, { range: "bytes=10-19" });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), `bytes 10-19/${size}`);
    assert.equal(part.headers.get("content-length"), "10");
    assert.deepEqual(part.bytes, WEBM.subarray(10, 20));
    assert.equal(part.headers.get("content-type"), "video/webm");

    const open = await call("GET", file, undefined, { range: "bytes=100-" });
    assert.equal(open.status, 206);
    assert.deepEqual(open.bytes, WEBM.subarray(100));
    const tail = await call("GET", file, undefined, { range: "bytes=-16" });
    assert.equal(tail.headers.get("content-range"), `bytes ${size - 16}-${size - 1}/${size}`);
    assert.deepEqual(tail.bytes, WEBM.subarray(size - 16));

    const past = await call("GET", file, undefined, { range: `bytes=${size}-` });
    assert.equal(past.status, 416);
    assert.equal(past.headers.get("content-range"), `bytes */${size}`);
    // Several ranges, or nonsense, are answered with the whole clip, as is a range of a version the player does not have.
    assert.deepEqual((await call("GET", file, undefined, { range: "bytes=0-1,5-6" })).bytes, WEBM);
    assert.equal((await call("GET", file, undefined, { range: "items=1-2" })).status, 200);
    const etag = part.headers.get("etag")!;
    assert.equal((await call("GET", file, undefined, { range: "bytes=0-3", "if-range": etag })).status, 206, "the version it has");
    const other = await call("GET", file, undefined, { range: "bytes=0-3", "if-range": '"not-this-one"' });
    assert.equal(other.status, 200, "another version: the whole of this one");
    assert.deepEqual(other.bytes, WEBM);
    // A player that has the clip is told so (not through fetch, which asks for a fresh one whenever it asks with a validator).
    const asked = await new Promise<number>((resolve, reject) => {
      const req = request(`${at}${file}`, { headers: { "if-none-match": etag } }, (res) => (res.resume(), resolve(res.statusCode ?? 0)));
      req.on("error", reject).end();
    });
    assert.equal(asked, 304);
  } finally {
    sd.server.close();
    await clearJobs();
  }
});

test("while a clip is made the job says whether it waits its turn on the server or is being made, and a stop leaves the queue and makes no clip", async () => {
  const sd = await fakeSd({ jobs: [{ status: "queued", queue_position: 3 }, { status: "generating" }] });
  await clearJobs();
  try {
    setup(sd.origin);
    const before = (await listed()).total;
    const { jobs } = (await call("POST", "/videos/generate", { prompt: "slow" })).body;
    let seen: any;
    for (let i = 0; i < 200 && seen?.stage !== "waiting"; i++) {
      seen = (await call("GET", "/videos/jobs")).body.jobs.find((j: any) => j.id === jobs[0].id);
      await pause(20);
    }
    assert.deepEqual([seen.state, seen.stage, seen.queuePosition], ["running", "waiting", 3]);
    // The server moves it on (the next question is one second after the first).
    for (let i = 0; i < 200 && seen?.stage !== "making"; i++) {
      seen = (await call("GET", "/videos/jobs")).body.jobs.find((j: any) => j.id === jobs[0].id);
      await pause(25);
    }
    assert.deepEqual([seen.state, seen.stage, seen.queuePosition], ["running", "making", undefined]);

    assert.equal((await call("DELETE", `/videos/jobs/${jobs[0].id}`)).status, 200);
    assert.equal((await call("GET", "/videos/jobs")).body.jobs.length, 0, "forgotten");
    for (let i = 0; i < 100 && !sd.to("POST", `/sdcpp/v1/jobs/job_1/cancel`).length; i++) await pause(20);
    assert.equal(sd.to("POST", "/sdcpp/v1/jobs/job_1/cancel").length, 1, "the server is told to drop it");
    assert.equal((await listed()).total, before, "no clip comes of it");
    assert.equal((await call("DELETE", `/videos/jobs/${jobs[0].id}`)).status, 404);
  } finally {
    sd.server.close();
    await clearJobs();
  }
});

test("a clip that is not made says why in the endpoint's words, and Dismiss clears it", async () => {
  const sd = await fakeSd({ jobs: [{ status: "failed", error: { code: "generation_failed", message: "out of memory" } }] });
  await clearJobs();
  try {
    setup(sd.origin);
    await call("POST", "/videos/generate", { prompt: "fails" });
    const [job] = await settled();
    assert.equal(job.state, "failed");
    assert.match(job.error, /could not make the clip: out of memory/);
    assert.equal(job.videoId, undefined);
    assert.equal((await call("DELETE", `/videos/jobs/${job.id}`)).status, 200);
    assert.deepEqual((await call("GET", "/videos/jobs")).body.jobs, []);
  } finally {
    sd.server.close();
  }
});

test("a clip the server finishes as an AVI is kept, listed as an AVI that a browser does not play, and downloadable, and the job is done", async () => {
  const sd = await fakeSd({ jobs: [completed({ output_format: "avi", mime_type: "video/x-msvideo", frame_count: 33, b64_json: AVI.toString("base64") })] });
  await clearJobs();
  try {
    setup(sd.origin);
    await call("POST", "/videos/generate", { prompt: "an avi" });
    const [job] = await settled();
    assert.equal(job.state, "done", job.error);
    assert.equal(job.error, undefined);
    const made = (await call("GET", `/videos?ids=${job.videoId}`)).body.videos[0];
    assert.deepEqual(made.format, { id: "avi", label: "AVI", mimeType: "video/x-msvideo", playable: false });
    assert.equal(made.poster, false, "a clip that is not played has no poster");
    assert.match(made.fileName, /^video-\d{8}-\d{6}-[0-9a-f]{4}\.avi$/, "named for what it is");
    assert.equal(made.params.madeFrames, 33);
    // It is a file on the disk, in the page's own folder, whole.
    assert.deepEqual(readFileSync(path.join(media.data, "videos", `${made.id}.avi`)), AVI);
    // Sent to be saved, as the type its bytes say, and never shown.
    const file = await call("GET", `/videos/${made.id}/file`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("content-type"), "video/x-msvideo");
    assert.match(file.headers.get("content-disposition") ?? "", new RegExp(`^attachment; filename="${made.fileName}"; filename\\*=UTF-8''${made.fileName}$`));
    assert.equal(file.headers.get("x-content-type-options"), "nosniff");
    assert.match(file.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.deepEqual(file.bytes, AVI);
    assert.equal((await call("GET", `/videos/${made.id}/poster`)).status, 404);
    assert.equal((await listed("?limit=100")).videos.find((v: any) => v.id === made.id)?.format.playable, false);
    await call("DELETE", `/videos/jobs/${job.id}`);
  } finally {
    sd.server.close();
  }
});

test("a clip of a kind nobody knows is kept as bytes, listed as unknown, and only ever offered to be saved", async () => {
  const odd = Buffer.from("<html><script>alert(1)</script></html>");
  const sd = await fakeSd({ jobs: [completed({ output_format: "webm", mime_type: "video/webm", b64_json: odd.toString("base64") })] });
  await clearJobs();
  try {
    setup(sd.origin);
    await call("POST", "/videos/generate", { prompt: "something else" });
    const [job] = await settled();
    assert.equal(job.state, "done", job.error);
    const made = (await call("GET", `/videos?ids=${job.videoId}`)).body.videos[0];
    // What the server calls it is not what it is: the bytes say nothing, so it is unknown, and it is kept under a name that says so.
    assert.deepEqual(made.format, { id: "bin", label: "Unknown", mimeType: "application/octet-stream", playable: false });
    assert.deepEqual(readFileSync(path.join(media.data, "videos", `${made.id}.bin`)), odd);
    const file = await call("GET", `/videos/${made.id}/file`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("content-type"), "application/octet-stream");
    assert.match(file.headers.get("content-disposition") ?? "", /^attachment;/);
    assert.equal(file.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(file.bytes, odd);
    await call("DELETE", `/videos/jobs/${job.id}`);
  } finally {
    sd.server.close();
  }
});

test("a request that is wrong is refused with the reason, and makes nothing", async () => {
  const sd = await fakeSd();
  await clearJobs();
  try {
    setup(sd.origin);
    const refuse = async (body: unknown, status: number, why: RegExp) => {
      const r = await call("POST", "/videos/generate", body);
      assert.equal(r.status, status, JSON.stringify(body));
      assert.match(r.body.error, why, JSON.stringify(body));
    };
    await refuse({}, 400, /A prompt is required/);
    await refuse({ prompt: "  " }, 400, /A prompt is required/);
    await refuse({ prompt: "x".repeat(4001) }, 400, /over 4000 characters/);
    await refuse({ prompt: "x", count: 0 }, 400, /from 1 to 4/);
    await refuse({ prompt: "x", count: 5 }, 400, /from 1 to 4/);
    await refuse({ prompt: "x", size: "63x480" }, 400, /size looks like/);
    await refuse({ prompt: "x", frames: 0 }, 400, /frames/);
    await refuse({ prompt: "x", fps: 500 }, 400, /frame rate/);
    await refuse({ prompt: "x", seed: -5 }, 400, /seed/);
    await refuse({ prompt: "x", firstFrame: "../etc/passwd" }, 400, /named by its id/);
    await refuse({ prompt: "x", firstFrame: 5 }, 400, /named by its id/);
    await refuse({ prompt: "x", firstFrame: "aaaaaaaaaaaa" }, 400, /The first frame: There is no such picture/);
    await refuse({ prompt: "x", lastFrame: "../etc/passwd" }, 400, /The last frame is a picture, named by its id/);
    await refuse({ prompt: "x", lastFrame: 5 }, 400, /The last frame is a picture, named by its id/);
    await refuse({ prompt: "x", lastFrame: "aaaaaaaaaaaa" }, 400, /The last frame: There is no such picture/);
    await refuse({ prompt: "x", strength: 1.5 }, 400, /strength is a number from 0 to 1/);
    await refuse({ prompt: "x", strength: "high" }, 400, /strength is a number from 0 to 1/);
    assert.equal(sd.seen.length, 0, "nothing was asked of the endpoint");
    assert.deepEqual((await call("GET", "/videos/jobs")).body.jobs, []);

    off();
    await refuse({ prompt: "x" }, 409, /switched off, or has no address.*Media in Settings/);
    gen.saveVideoGeneration({ baseUrl: "" });
    await refuse({ prompt: "x" }, 409, /switched off/);
  } finally {
    sd.server.close();
  }
});

test("only a few clips are made at once, and the guard says how many", async () => {
  const sd = await fakeSd({ jobs: [{ status: "generating" }] });
  await clearJobs();
  try {
    setup(sd.origin);
    assert.equal(MAX_RUNNING_VIDEOS, 4);
    assert.equal((await call("POST", "/videos/generate", { prompt: "a", count: 3 })).status, 202);
    const more = await call("POST", "/videos/generate", { prompt: "b", count: 2 });
    assert.equal(more.status, 429);
    assert.match(more.body.error, /Only 1 more can be made now, as 4 are made at a time/);
    assert.equal((await call("POST", "/videos/generate", { prompt: "c" })).status, 202);
    const full = await call("POST", "/videos/generate", { prompt: "d" });
    assert.equal(full.status, 429);
    assert.match(full.body.error, /4 clips are being made already/);
    assert.equal((await call("GET", "/videos/jobs")).body.limit, 4);
  } finally {
    await clearJobs();
    sd.server.close();
  }
});

test("the clips made on the page stop when they take the disk the person allowed", async () => {
  const sd = await fakeSd();
  await clearJobs();
  try {
    setup(sd.origin, { storageLimitMb: 1 });
    // A clip of a little over a megabyte: its head is a clip's, the rest is padding.
    const big = gallery.addPageVideo({ bytes: Buffer.concat([WEBM, Buffer.alloc(1024 * 1024)]), ext: "webm", kind: "generated", prompt: "big", params: {} });
    const refused = await call("POST", "/videos/generate", { prompt: "one more" });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /take 1 MB, which is the limit set under Media in Settings\. Delete some clips, or raise the limit/);
    assert.equal(sd.seen.length, 0);
    // Raised, or the clip deleted, it goes ahead.
    setup(sd.origin, { storageLimitMb: 10 });
    assert.equal((await call("POST", "/videos/generate", { prompt: "one more" })).status, 202);
    await settled();
    setup(sd.origin, { storageLimitMb: 1 });
    assert.equal((await call("DELETE", `/videos/${big.id}`)).status, 200);
    assert.equal((await call("POST", "/videos/generate", { prompt: "and another" })).status, 202);
    await settled();
    // Only the page's own clips are counted: the agent's are in the folders of its chats.
    const folder = chat("limit-chat");
    gallery.recordChatVideo({ sessionId: "limit-chat", path: `${GENERATED_VIDEOS_DIR}/x.webm`, kind: "generated", prompt: "chat", params: {}, bytes: 500 * 1024 * 1024 });
    assert.ok(folder);
    assert.equal((await call("POST", "/videos/generate", { prompt: "still room" })).status, 202);
  } finally {
    await settled();
    sd.server.close();
    setup("http://unused.example", { storageLimitMb: null });
    off();
  }
});

test("a clip can start from a picture of the gallery, which goes to the server as the first frame", async () => {
  const sd = await fakeSd();
  await clearJobs();
  try {
    setup(sd.origin);
    const picture = images.addPagePicture({ bytes: PNG, ext: "png", kind: "uploaded", prompt: "start.png", params: {} });
    const start = await call("POST", "/videos/generate", { prompt: "it starts to rain", firstFrame: picture.id });
    assert.equal(start.status, 202);
    assert.deepEqual([start.body.jobs[0].kind, start.body.jobs[0].from], ["animate", picture.id]);
    await settled();
    assert.equal(sd.to("POST", "/sdcpp/v1/vid_gen")[0].body.init_image, `data:image/png;base64,${PNG.toString("base64")}`);
    const [video] = (await listed("?kind=animated")).videos;
    assert.equal(video.kind, "animated");
    assert.deepEqual(video.params.firstFrame, { picture: picture.id });
    assert.equal((await listed("?kind=generated")).videos.filter((v: any) => v.id === video.id).length, 0, "filtered by how it was made");
    // The picture it was made from can be gone: the clip does not depend on it.
    await images.deletePicture(picture.id);
    assert.equal((await call("GET", `/videos/${video.id}/file`)).status, 200);
    assert.deepEqual((await listed(`?ids=${video.id}`)).videos.map((v: any) => v.params.firstFrame), [{ picture: picture.id }]);
  } finally {
    sd.server.close();
    await clearJobs();
  }
});

test("a clip can end on a picture of the gallery, with a strength, and a server that does not take a last frame fails the job in words", async () => {
  const sd = await fakeSd({ capabilities: TAKES_END_IMAGE });
  const bare = await fakeSd();
  await clearJobs();
  try {
    setup(sd.origin);
    const first = images.addPagePicture({ bytes: PNG, ext: "png", kind: "uploaded", prompt: "start.png", params: {} });
    const last = images.addPagePicture({ bytes: Buffer.concat([PNG, Buffer.from("end")]), ext: "png", kind: "uploaded", prompt: "end.png", params: {} });
    const data = (bytes: Buffer) => `data:image/png;base64,${bytes.toString("base64")}`;

    const both = await call("POST", "/videos/generate", { prompt: "from one to the other", firstFrame: first.id, lastFrame: last.id, strength: 0.4 });
    assert.equal(both.status, 202);
    assert.deepEqual([both.body.jobs[0].kind, both.body.jobs[0].from], ["animate", first.id]);
    await settled();
    const [sent] = sd.to("POST", "/sdcpp/v1/vid_gen");
    assert.equal(sent.body.init_image, data(PNG));
    assert.equal(sent.body.end_image, data(Buffer.concat([PNG, Buffer.from("end")])));
    assert.equal(sent.body.strength, 0.4);
    const [video] = (await listed("?kind=animated")).videos;
    assert.equal(video.kind, "animated");
    assert.deepEqual([video.params.firstFrame, video.params.lastFrame, video.params.strength], [{ picture: first.id }, { picture: last.id }, 0.4]);
    // The pictures can be gone: the clip does not depend on them.
    await images.deletePicture(last.id);
    assert.deepEqual((await listed(`?ids=${video.id}`)).videos.map((v: any) => v.params.lastFrame), [{ picture: last.id }]);

    // A last frame alone makes an animated clip too, and a request with no last frame sends none to a server that takes one.
    const end = images.addPagePicture({ bytes: PNG, ext: "png", kind: "uploaded", prompt: "end.png", params: {} });
    await clearJobs();
    const alone = await call("POST", "/videos/generate", { prompt: "it ends here", lastFrame: end.id });
    assert.equal(alone.status, 202);
    assert.equal(alone.body.jobs[0].kind, "animate");
    await settled();
    const aloneBody = sd.to("POST", "/sdcpp/v1/vid_gen")[1].body;
    assert.deepEqual([aloneBody.end_image, "init_image" in aloneBody], [data(PNG), false]);
    await clearJobs();
    await call("POST", "/videos/generate", { prompt: "no frames", strength: 0 });
    await settled();
    const plain = sd.to("POST", "/sdcpp/v1/vid_gen")[2].body;
    assert.deepEqual([plain.strength, "end_image" in plain, "init_image" in plain], [0, false, false]);

    // A server that does not say its model takes one: the job fails and says so, and nothing is made or sent.
    setup(bare.origin);
    await clearJobs();
    assert.equal((await call("POST", "/videos/generate", { prompt: "x", lastFrame: end.id })).status, 202);
    const [failed] = await settled();
    assert.equal(failed.state, "failed");
    assert.match(failed.error, /did not say whether it takes a last frame/);
    assert.equal(bare.to("POST", "/sdcpp/v1/vid_gen").length, 0);
  } finally {
    sd.server.close();
    bare.server.close();
    await clearJobs();
  }
});

test("the gallery is filtered, paged and looked up by id, and what is asked wrong is said", async () => {
  const sd = await fakeSd();
  try {
    setup(sd.origin);
    for (let i = 0; i < 3; i++) gallery.addPageVideo({ bytes: clip(`p${i}`), ext: "webm", kind: "generated", prompt: `paged ${i}`, params: {} });
    const all = await listed("?limit=100");
    const mine = all.videos.filter((v: any) => v.prompt.startsWith("paged"));
    assert.equal(mine.length, 3);
    const first = await listed("?limit=2");
    assert.equal(first.videos.length, 2);
    assert.match(first.next, /^\d+:[0-9a-f]+$/);
    const second = await listed(`?limit=2&before=${first.next}`);
    assert.equal(first.videos.at(-1).id === second.videos[0].id, false, "the next page starts after the first");
    assert.ok(first.videos.every((v: any, i: number) => i === 0 || v.createdAt <= first.videos[i - 1].createdAt), "newest first");
    assert.deepEqual((await listed(`?ids=${mine[0].id},aaaaaaaaaaaa,${mine[1].id}`)).videos.map((v: any) => v.id), [mine[0].id, mine[1].id], "those that there are, in the order given");
    assert.equal((await listed("?origin=chat")).videos.filter((v: any) => v.origin !== "chat").length, 0);
    for (const bad of ["origin=elsewhere", "kind=edited", "before=oops", "limit=0", "limit=101", "limit=x", "ids=nope"]) {
      assert.equal((await call("GET", `/videos?${bad}`)).status, 400, bad);
    }
  } finally {
    sd.server.close();
  }
});

test("a clip is deleted with its file, singly or several at once, and what could not be is said", async () => {
  const page = gallery.addPageVideo({ bytes: clip("a"), ext: "webm", kind: "generated", prompt: "mine", params: {} });
  const second = gallery.addPageVideo({ bytes: clip("b"), ext: "webm", kind: "generated", prompt: "mine too", params: {} });
  const third = gallery.addPageVideo({ bytes: clip("c"), ext: "webm", kind: "generated", prompt: "and this", params: {} });
  const dir = path.join(media.data, "videos");
  assert.ok(readdirSync(dir).some((f) => f.startsWith(page.id)));
  assert.equal((await call("DELETE", `/videos/${page.id}`)).status, 200);
  assert.ok(!readdirSync(dir).some((f) => f.startsWith(page.id)), "the file went with the clip");
  assert.equal((await call("GET", `/videos/${page.id}/file`)).status, 404);
  assert.equal((await call("DELETE", `/videos/${page.id}`)).status, 404);
  const bulk = await call("POST", "/videos/delete", { ids: [second.id, third.id, "aaaaaaaaaaaa", second.id] });
  assert.deepEqual(bulk.body.deleted, [second.id, third.id]);
  assert.deepEqual(bulk.body.failed, [{ id: "aaaaaaaaaaaa", error: "There is no such video" }]);
  assert.equal((await call("POST", "/videos/delete", { ids: [] })).status, 400);
  assert.equal((await call("POST", "/videos/delete", { ids: ["x"] })).status, 400);
  assert.equal((await call("POST", "/videos/delete", { ids: Array.from({ length: 201 }, (_, i) => i.toString(16).padStart(12, "0")) })).status, 400);
});

test("a clip of a stable-diffusion.cpp server, whose document type is matroska, is listed, and served as the WebM it is", async () => {
  const made = gallery.addPageVideo({ bytes: MATROSKA, ext: "webm", kind: "generated", prompt: "from sd.cpp", params: {} });
  assert.deepEqual(made.format, { id: "webm", label: "WebM", mimeType: "video/webm", playable: true });
  const served = await call("GET", `/videos/${made.id}/file`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "video/webm");
  assert.equal(served.headers.get("content-disposition"), null, "it plays, it is not a download");
  assert.deepEqual(served.bytes, MATROSKA);
  assert.ok((await listed("?limit=100")).videos.some((v: any) => v.id === made.id));
  // An EBML file of another document type is kept as what it is, and offered to be saved: it is no clip a browser plays.
  const other = gallery.addPageVideo({ bytes: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x86, 0x42, 0x82, 0x83]), Buffer.from("foo"), Buffer.alloc(40)]), ext: "mkv", kind: "generated", prompt: "other", params: {} });
  assert.equal(other.format.playable, false);
  assert.equal(other.format.label, "EBML (foo)");
  const sent = await call("GET", `/videos/${other.id}/file`);
  assert.equal(sent.status, 200);
  assert.equal(sent.headers.get("content-type"), "video/x-matroska");
  assert.match(sent.headers.get("content-disposition") ?? "", /^attachment;/);
});

test("a file that has stopped being a clip is never shown, only offered to be saved, and a file that is gone leaves the list", async () => {
  const kept = gallery.addPageVideo({ bytes: clip("k"), ext: "webm", kind: "generated", prompt: "keep", params: {} });
  const swapped = gallery.addPageVideo({ bytes: clip("s"), ext: "webm", kind: "generated", prompt: "swapped", params: {} });
  const lost = gallery.addPageVideo({ bytes: clip("l"), ext: "webm", kind: "generated", prompt: "lost", params: {} });
  const dir = path.join(media.data, "videos");
  writeFileSync(path.join(dir, `${swapped.id}.webm`), '<html><script>alert(1)</script></html>');
  rmSync(path.join(dir, `${lost.id}.webm`));
  // A page is a file like any other: sent as bytes to be saved, under a policy that would stop it running anything, never as the page it is.
  const sent = await call("GET", `/videos/${swapped.id}/file`);
  assert.equal(sent.status, 200);
  assert.equal(sent.headers.get("content-type"), "application/octet-stream");
  assert.match(sent.headers.get("content-disposition") ?? "", /^attachment;/);
  assert.equal(sent.headers.get("x-content-type-options"), "nosniff");
  assert.match(sent.headers.get("content-security-policy") ?? "", /sandbox/);
  assert.equal((await listed("?limit=100")).videos.find((v: any) => v.id === swapped.id)?.format.playable, false);
  assert.equal((await call("GET", `/videos/${lost.id}/file`)).status, 404);
  assert.equal((await call("GET", `/videos/${kept.id}/file`)).status, 200);
  const ids = (await listed("?limit=100")).videos.map((v: any) => v.id);
  assert.ok(ids.includes(kept.id));
  assert.ok(!ids.includes(lost.id), "a clip whose file is gone is dropped from the list");
  // A file too large for a clip is not played either.
  const huge = gallery.addPageVideo({ bytes: clip("h"), ext: "webm", kind: "generated", prompt: "huge", params: {} });
  // A sparse file: its size is what is looked at, and nothing is read or held.
  writeFileSync(path.join(dir, `${huge.id}.webm`), WEBM);
  truncateSync(path.join(dir, `${huge.id}.webm`), MAX_VIDEO_BYTES + 1);
  const big = await call("GET", `/videos/${huge.id}/file`);
  assert.equal(big.status, 413);
  rmSync(path.join(dir, `${huge.id}.webm`));
});

// --- the agent ---

/** The tool as pi gets it in the chat `id`, and a way to call it. */
function load(id: string) {
  const tool = media.tools(id).generate_video;
  return { tool, run: (p: any, signal?: AbortSignal) => tool.execute("id", p, signal) };
}

test("while video generation is off, or has no address, neither tool is there at all", () => {
  off();
  chat("tool-off");
  const videos = () => Object.keys(media.tools("tool-off")).filter((name) => /video/.test(name));
  assert.deepEqual(videos(), []);

  gen.saveVideoGeneration({ baseUrl: "https://video.example.com", enabled: true });
  assert.deepEqual(videos(), ["generate_video", "show_video"]);
  // Loaded again after a switch, as pi does on a reload: it follows.
  off();
  assert.deepEqual(videos(), []);
});

test("the tool keeps a clip a browser cannot play, says so to the agent, lists it in the gallery as the file it is, and shows no player", async () => {
  const folder = chat("tool-avi", "The AVI chat");
  const sd = await fakeSd({ jobs: [completed({ output_format: "avi", b64_json: AVI.toString("base64") })] });
  try {
    setup(sd.origin);
    const { run } = load("tool-avi");
    const result = await run({ prompt: "an avi", title: "Old format" });
    assert.match(result.details.files[0].path, new RegExp(`^${GENERATED_VIDEOS_DIR}/video-\\d{8}-\\d{6}-[0-9a-f]{6}\\.avi$`));
    assert.deepEqual(result.details, { files: [{ path: result.details.files[0].path, title: "Old format" }], notPlayable: "AVI" });
    assert.match(result.content[0].text, /^Generated and saved: .*\.avi\. Its format is AVI, which a browser cannot play in the chat\. It is kept as it is and listed in the Media gallery, where the person can download it\./);
    assert.deepEqual(readFileSync(path.join(folder, result.details.files[0].path)), AVI, "kept whole");
    const [video] = (await listed("?origin=chat&limit=100")).videos.filter((v: any) => v.chat?.id === "tool-avi");
    assert.deepEqual([video.format.id, video.format.playable, video.prompt], ["avi", false, "an avi"]);
    // The chat's own player route does not play it; the gallery's file route gives it to be saved.
    assert.equal((await fetch(`${media.api}/sessions/tool-avi/video?path=${encodeURIComponent(result.details.files[0].path)}`)).status, 400);
    const file = await call("GET", `/videos/${video.id}/file`);
    assert.match(file.headers.get("content-disposition") ?? "", /^attachment;/);
    assert.deepEqual(file.bytes, AVI);
  } finally {
    sd.server.close();
  }
});

test("the tool makes a clip in the chat's folder, answers as show_image does, and lists it in the gallery", async () => {
  const folder = chat("tool-chat", "The tool's chat");
  const sd = await fakeSd({ capabilities: { supported_modes: ["vid_gen"], output_formats_by_mode: { vid_gen: ["webm"] }, defaults_by_mode: { vid_gen: { fps: 20 } } } });
  try {
    setup(sd.origin, { model: "video-model", size: "640x384" });
    const { run, tool } = load("tool-chat");
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["lastFrame", "path", "prompt", "seconds", "size", "title"]);
    assert.ok(!JSON.stringify(tool).includes(KEY));

    const result = await run({ prompt: "  a fox in the snow  ", title: "Fox", size: "832x480", seconds: 2 });
    assert.match(result.details.files[0].path, new RegExp(`^${GENERATED_VIDEOS_DIR}/video-\\d{8}-\\d{6}-[0-9a-f]{6}\\.webm$`));
    assert.deepEqual(result.details, { files: [{ path: result.details.files[0].path, title: "Fox" }] });
    assert.ok(!path.isAbsolute(result.details.files[0].path), "a path in the chat's folder, which is what the page asks for");
    assert.match(result.content[0].text, /shown to the user/i);
    assert.deepEqual(readFileSync(path.join(folder, result.details.files[0].path)), WEBM);
    assert.deepEqual(readdirSync(folder), [GENERATED_VIDEOS_DIR], "nothing else was made in the folder");
    assert.deepEqual(sd.to("POST", "/sdcpp/v1/vid_gen")[0].body, { prompt: "a fox in the snow", model: "video-model", width: 832, height: 480, video_frames: 40, fps: 20, output_format: "webm" });

    // Listed with what it was asked for, as a clip of this chat.
    const [video] = (await listed("?origin=chat&limit=100")).videos.filter((v: any) => v.chat?.id === "tool-chat");
    assert.deepEqual([video.origin, video.kind, video.prompt, video.chat, video.fileName], ["chat", "generated", "a fox in the snow", { id: "tool-chat", title: "The tool's chat" }, path.basename(result.details.files[0].path)]);
    assert.deepEqual([video.params.model, video.params.size, video.params.madeFrames, video.params.madeFps], ["video-model", "832x480", 33, 16]);
    assert.equal((await call("GET", `/videos/${video.id}/file`)).status, 200);

    // The page plays it from the chat's folder, by its path.
    const played = await fetch(`${media.api}/sessions/tool-chat/video?path=${encodeURIComponent(result.details.files[0].path)}`, { headers: { range: "bytes=0-3" } });
    assert.equal(played.status, 206);
    assert.deepEqual(Buffer.from(await played.arrayBuffer()), WEBM.subarray(0, 4));
    assert.equal(played.headers.get("content-type"), "video/webm");

    // Without a title the prompt is the caption; a second one never takes the first's place.
    const again = await run({ prompt: "a fox\nin   the snow" });
    assert.equal(again.details.files[0].title, "a fox in the snow");
    assert.notEqual(again.details.files[0].path, result.details.files[0].path);
    assert.equal(readdirSync(path.join(folder, GENERATED_VIDEOS_DIR)).length, 2);
  } finally {
    sd.server.close();
  }
});

test("the tool starts from a picture of the chat's folder, and only from one", async () => {
  const folder = chat("tool-frame");
  const sd = await fakeSd();
  try {
    setup(sd.origin);
    writeFileSync(path.join(folder, "start.png"), PNG);
    mkdirSync(path.join(folder, "sub"));
    writeFileSync(path.join(folder, "sub", "later.png"), PNG);
    writeFileSync(path.join(folder, "notes.txt"), "not a picture");
    const outside = path.join(temp, "outside.png");
    writeFileSync(outside, PNG);
    const { run } = load("tool-frame");

    const made = await run({ prompt: "it moves", path: "sub/../start.png" });
    assert.equal(sd.to("POST", "/sdcpp/v1/vid_gen")[0].body.init_image, `data:image/png;base64,${PNG.toString("base64")}`);
    const [video] = (await listed("?limit=100")).videos.filter((v: any) => v.chat?.id === "tool-frame");
    assert.deepEqual([video.kind, video.params.firstFrame], ["animated", { path: "start.png" }]);
    assert.equal(made.details.files[0].path, video.fileName ? `${GENERATED_VIDEOS_DIR}/${video.fileName}` : "");
    await run({ prompt: "absolute", path: path.join(folder, "sub", "later.png") });
    assert.equal(sd.to("POST", "/sdcpp/v1/vid_gen").length, 2);

    const before = sd.to("POST", "/sdcpp/v1/vid_gen").length;
    await assert.rejects(run({ prompt: "x", path: outside }), /Only a picture in the chat's folder can be used as the first frame/);
    await assert.rejects(run({ prompt: "x", path: "../outside.png" }), /Only a picture in the chat's folder/);
    await assert.rejects(run({ prompt: "x", path: "notes.txt" }), /not a PNG, JPEG, GIF or WebP picture/);
    await assert.rejects(run({ prompt: "x", path: "missing.png" }), /no such file/i);
    assert.equal(sd.to("POST", "/sdcpp/v1/vid_gen").length, before, "nothing was sent for any of them");
  } finally {
    sd.server.close();
  }
});

test("the tool's description does not promise that a model which cannot use a last frame refuses it", () => {
  // stable-diffusion.cpp reports end_image for every video model it runs, and some models never read it, so the check on the
  // capabilities cannot tell the agent more than "asked for": it must not report a clip as ending on the picture.
  gen.saveVideoGeneration({ baseUrl: "https://video.example.com", enabled: true });
  chat("tool-description");
  const { tool } = load("tool-description");
  const description: string = tool.description + JSON.stringify(tool.parameters);
  assert.match(tool.parameters.properties.lastFrame.description, /a model may ignore it silently, so tell the person you asked for it, not that the clip ends on it/);
  assert.doesNotMatch(description, /only some video models take one/);
  assert.doesNotMatch(description, /where the model does not/);
});

test("the tool ends on a picture of the chat's folder, and only on one, and only where the server's model takes one", async () => {
  const folder = chat("tool-last");
  const sd = await fakeSd({ capabilities: TAKES_END_IMAGE });
  const bare = await fakeSd();
  try {
    setup(sd.origin);
    writeFileSync(path.join(folder, "start.png"), PNG);
    writeFileSync(path.join(folder, "end.png"), PNG);
    writeFileSync(path.join(folder, "notes.txt"), "not a picture");
    const outside = path.join(temp, "outside-last.png");
    writeFileSync(outside, PNG);
    const { run } = load("tool-last");

    await run({ prompt: "it ends", path: "start.png", lastFrame: "./end.png" });
    const png = `data:image/png;base64,${PNG.toString("base64")}`;
    assert.deepEqual([sd.to("POST", "/sdcpp/v1/vid_gen")[0].body.init_image, sd.to("POST", "/sdcpp/v1/vid_gen")[0].body.end_image], [png, png]);
    const [video] = (await listed("?limit=100")).videos.filter((v: any) => v.chat?.id === "tool-last");
    assert.deepEqual([video.kind, video.params.firstFrame, video.params.lastFrame], ["animated", { path: "start.png" }, { path: "end.png" }]);
    // The last frame alone.
    await run({ prompt: "it ends alone", lastFrame: path.join(folder, "end.png") });
    const alone = sd.to("POST", "/sdcpp/v1/vid_gen")[1].body;
    assert.deepEqual([alone.end_image, "init_image" in alone], [png, false]);

    const before = sd.to("POST", "/sdcpp/v1/vid_gen").length;
    await assert.rejects(run({ prompt: "x", lastFrame: outside }), /Only a picture in the chat's folder can be used as the last frame/);
    await assert.rejects(run({ prompt: "x", lastFrame: "../outside-last.png" }), /Only a picture in the chat's folder can be used as the last frame/);
    await assert.rejects(run({ prompt: "x", lastFrame: "notes.txt" }), /not a PNG, JPEG, GIF or WebP picture/);
    await assert.rejects(run({ prompt: "x", lastFrame: "missing.png" }), /no such file/i);
    assert.equal(sd.to("POST", "/sdcpp/v1/vid_gen").length, before, "nothing was sent for any of them");

    // A server whose model does not take one: the call fails with the reason, and leaves no clip.
    setup(bare.origin);
    const clips = readdirSync(path.join(folder, GENERATED_VIDEOS_DIR)).length;
    await assert.rejects(run({ prompt: "x", lastFrame: "end.png" }), /did not say whether it takes a last frame/);
    assert.equal(bare.to("POST", "/sdcpp/v1/vid_gen").length, 0);
    assert.equal(readdirSync(path.join(folder, GENERATED_VIDEOS_DIR)).length, clips);
  } finally {
    sd.server.close();
    bare.server.close();
  }
});

test("what the tool is given is checked before anything is sent, and a call that fails leaves no file and no folder behind", async () => {
  const folder = chat("tool-bad");
  const sd = await fakeSd({ jobs: [{ status: "failed", error: { message: "no memory" } }] });
  try {
    setup(sd.origin);
    const { run } = load("tool-bad");
    for (const [p, why] of [
      [{ prompt: "" }, /A prompt is required/],
      [{ prompt: "x".repeat(4001) }, /over 4000 characters/],
      [{ prompt: "x", size: "auto" }, /size looks like/],
      [{ prompt: "x", seconds: 0 }, /number of seconds/],
      [{ prompt: "x", seconds: -2 }, /number of seconds/],
      [{ prompt: "x", seconds: 601 }, /number of seconds/],
      [{ prompt: "x", seconds: "long" }, /number of seconds/],
    ] as const) await assert.rejects(run(p), why);
    assert.equal(sd.seen.length, 0);
    await assert.rejects(run({ prompt: "fails" }), /could not make the clip: no memory/);
    assert.deepEqual(readdirSync(folder), [], "no folder was made for a clip that did not come");
    off();
    await assert.rejects(run({ prompt: "x" }), /switched off, or has no address now/);
  } finally {
    sd.server.close();
  }
});

test("the time limit of the settings is the one a call of the tool is held to, and stopping the chat stops the wait", async () => {
  const folder = chat("tool-slow");
  const sd = await fakeSd({ jobs: [{ status: "generating" }] });
  try {
    setup(sd.origin);
    // 30 seconds is the least a limit may be: a call is stopped with the chat long before that.
    const stop = new AbortController();
    const { run } = load("tool-slow");
    const running = run({ prompt: "slow" }, stop.signal);
    for (let i = 0; i < 100 && sd.to("GET", "/sdcpp/v1/jobs/job_1").length < 1; i++) await pause(10);
    stop.abort();
    await assert.rejects(running, (e: Error) => !(e instanceof gen.VideoGenerationError));
    assert.deepEqual(readdirSync(folder), []);
  } finally {
    sd.server.close();
  }
});

test("show_video shows a clip of the chat's folder by its bytes, and nothing else", async () => {
  const folder = chat("tool-show");
  gen.saveVideoGeneration({ baseUrl: "https://video.example.com", enabled: true });
  mkdirSync(path.join(folder, "clips"));
  writeFileSync(path.join(folder, "clips", "a.webm"), WEBM);
  writeFileSync(path.join(folder, "b.mp4"), MP4);
  writeFileSync(path.join(folder, "c.webm"), "<script>alert(1)</script>");
  writeFileSync(path.join(folder, "d.png"), PNG);
  writeFileSync(path.join(temp, "outside.webm"), WEBM);
  symlinkSync(path.join(temp, "outside.webm"), path.join(folder, "link.webm"));
  const show = (p: any) => media.tools("tool-show").show_video.execute("id", p);
  assert.deepEqual((await show({ path: "clips/a.webm", title: " A clip " })).details, { files: [{ path: "clips/a.webm", title: "A clip" }] });
  assert.deepEqual((await show({ path: path.join(folder, "b.mp4") })).details, { files: [{ path: "b.mp4" }] });
  await assert.rejects(show({ path: "c.webm" }), /not a WebM or MP4/);
  await assert.rejects(show({ path: "d.png" }), /not a WebM or MP4/);
  await assert.rejects(show({ path: path.join(temp, "outside.webm") }), /Only a video in the chat's folder/);
  await assert.rejects(show({ path: "link.webm" }), /./, "a link out of the folder is not followed");
  assert.equal(videoIn(portal().chats.get("tool-show")!, "b.mp4", {}), "b.mp4");
  off();
});

// --- the folders ---

test("every clip in the folders the tool writes into is listed, recorded or not, and nothing else is", async () => {
  const alpha = project("alpha");
  const gamma = project("gamma", false);
  const outside = path.join(temp, "outside-folder");
  mkdirSync(path.join(outside, "videos"), { recursive: true });
  writeFileSync(path.join(outside, "secret.webm"), clip("secret"));
  writeFileSync(path.join(outside, "videos", "linked-dir.webm"), clip("linked-dir"));

  put(alpha, "video-20260102-120000-abc123.webm", clip("g"));
  put(alpha, "clip.mp4", MP4);
  put(alpha, "no extension", clip("w"));
  put(alpha, "disguised.txt", clip("d"));
  // What is not: nothing its bytes say is a kind of clip and no name of the tool's, an empty file, a hidden one, a picture, one too large, one that only has the tool's name.
  put(alpha, "notes.txt", Buffer.from("hello"));
  put(alpha, "fake.webm", Buffer.from("<html><script>alert(1)</script></html>"));
  put(alpha, "empty.webm", Buffer.alloc(0));
  put(alpha, ".half-written.upload", clip("half"));
  truncateSync(put(alpha, "huge.webm", clip("huge")), MAX_VIDEO_BYTES + 1);
  put(alpha, "pic.png", PNG);
  // Named as the tool names a clip nobody could tell the kind of, but not `.bin`: not one the tool made, so not listed.
  put(alpha, "video-20260103-130002-abcdef.html", Buffer.from("<html><script>alert(1)</script></html>"));
  // What is, though a browser does not play it: a QuickTime movie, an AVI, and a file the tool named that no bytes say a kind of.
  put(alpha, "movie.mov", Buffer.concat([Buffer.alloc(4), Buffer.from("ftypqt  "), Buffer.alloc(40)]));
  put(alpha, "video-20260103-130001-aaaaaa.avi", AVI);
  put(alpha, "video-20260103-130000-def456.bin", Buffer.from("something else"));
  symlinkSync(path.join(outside, "secret.webm"), path.join(alpha, GENERATED_VIDEOS_DIR, "linked.webm"));
  symlinkSync(path.join(alpha, GENERATED_VIDEOS_DIR, "clip.mp4"), path.join(alpha, GENERATED_VIDEOS_DIR, "alias.mp4"));
  symlinkSync(path.join(outside, "videos"), path.join(gamma, GENERATED_VIDEOS_DIR));
  // Not where the tool writes: beside the folder, below it, and in a folder of the workspace that no chat works in.
  writeFileSync(path.join(alpha, "loose.webm"), clip("loose"));
  mkdirSync(path.join(alpha, GENERATED_VIDEOS_DIR, "sub"));
  writeFileSync(path.join(alpha, GENERATED_VIDEOS_DIR, "sub", "deep.webm"), clip("deep"));

  const found = (await listed("?origin=folder&limit=100")).videos;
  const names = found.map((v: any) => v.fileName).sort();
  assert.deepEqual(names, ["clip.mp4", "disguised.txt", "movie.mov", "no extension", "video-20260102-120000-abc123.webm", "video-20260103-130000-def456.bin", "video-20260103-130001-aaaaaa.avi"]);
  const byName = (name: string) => found.find((v: any) => v.fileName === name);
  assert.deepEqual([byName("movie.mov").format.label, byName("movie.mov").format.playable], ["QuickTime", false]);
  assert.deepEqual([byName("video-20260103-130001-aaaaaa.avi").format.id, byName("video-20260103-130001-aaaaaa.avi").format.playable], ["avi", false]);
  assert.deepEqual([byName("video-20260103-130000-def456.bin").format.id, byName("video-20260103-130000-def456.bin").kind], ["bin", "generated"]);
  assert.ok(found.every((v: any) => v.origin === "folder" && v.chat === null && v.folder.name === "alpha" && v.prompt === ""));
  assert.deepEqual(found.map((v: any) => [v.fileName, v.kind]).sort(), [
    ["clip.mp4", "unknown"],
    ["disguised.txt", "unknown"],
    ["movie.mov", "unknown"],
    ["no extension", "unknown"],
    ["video-20260102-120000-abc123.webm", "generated"],
    ["video-20260103-130000-def456.bin", "generated"],
    ["video-20260103-130001-aaaaaa.avi", "generated"],
  ]);
  // The ones a browser plays play, whatever they are called.
  const one = found.find((v: any) => v.fileName === "clip.mp4");
  const played = await call("GET", `/videos/${one.id}/file`);
  assert.deepEqual([played.status, played.headers.get("content-type")], [200, "video/mp4"]);
  assert.deepEqual(played.bytes, MP4);
  assert.equal(one.params && Object.keys(one.params).length, 0);

  // Looked at again, nothing is listed twice; a clip that is added since is found when the page looks.
  put(alpha, "added-later.webm", clip("later"));
  const again = (await listed("?origin=folder&limit=100")).videos;
  assert.equal(again.length, found.length + 1);
  assert.equal(new Set(again.map((v: any) => v.id)).size, again.length);
  // A page that asks again for a list it has does not look through the files within the minute.
  put(alpha, "too-soon.webm", clip("soon"));
  assert.equal((await listed("?origin=folder&limit=100&again=1")).videos.length, again.length);
  assert.equal((await listed("?origin=folder&limit=100")).videos.length, again.length + 1);
  for (const f of ["added-later.webm", "too-soon.webm"]) rmSync(path.join(alpha, GENERATED_VIDEOS_DIR, f));
});

test("a clip the agent made is the same file as the one a look through the folder finds: one entry, with what it was asked for", async () => {
  const alpha = project("recorded");
  const rel = `${GENERATED_VIDEOS_DIR}/video-20260103-100000-aaaaaa.webm`;
  put(alpha, path.basename(rel), clip("rec"));
  const found = (await listed("?origin=folder&limit=100")).videos.find((v: any) => v.fileName === path.basename(rel));
  assert.ok(found, "found by the look");
  const chatId = "recorded-chat";
  media.chat(chatId, alpha, "Recorded");
  gallery.recordChatVideo({ sessionId: chatId, path: rel, kind: "generated", prompt: "what it was asked", params: { model: "m" }, bytes: 80 });
  const all = (await listed("?limit=100")).videos.filter((v: any) => v.fileName === path.basename(rel));
  assert.equal(all.length, 1, "one entry for one file");
  assert.deepEqual([all[0].origin, all[0].prompt, all[0].chat], ["chat", "what it was asked", { id: chatId, title: "Recorded" }]);
  // A name that comes back is a new clip: its file was taken away by something that did not tell the list.
  rmSync(path.join(alpha, rel));
  put(alpha, path.basename(rel), clip("rec again"));
  gallery.recordChatVideo({ sessionId: chatId, path: rel, kind: "generated", prompt: "the second time", params: {}, bytes: 90 });
  const renewed = (await listed("?limit=100")).videos.filter((v: any) => v.fileName === path.basename(rel));
  assert.deepEqual(renewed.map((v: any) => v.prompt), ["the second time"]);
});

test("the clips of a chat that is deleted stay, as clips of its folder with what they were asked for", async () => {
  // A folder the portal looks in: a project's, which a chat works in.
  const folder = project("gone-project");
  media.chat("gone-chat", folder, "Soon gone");
  put(folder, "video-20260104-100000-bbbbbb.webm", clip("kept"));
  gallery.recordChatVideo({ sessionId: "gone-chat", path: `${GENERATED_VIDEOS_DIR}/video-20260104-100000-bbbbbb.webm`, kind: "generated", prompt: "remember me", params: { size: "832x480" }, bytes: 80 });
  media.deleteChat("gone-chat");
  const kept = (await listed("?limit=100")).videos.filter((v: any) => v.fileName === "video-20260104-100000-bbbbbb.webm");
  assert.equal(kept.length, 1);
  assert.deepEqual([kept[0].origin, kept[0].chat, kept[0].prompt, kept[0].params.size], ["folder", null, "remember me", "832x480"]);
  assert.equal((await call("GET", `/videos/${kept[0].id}/file`)).status, 200);
  // Deleting the clip takes the file from the folder, the chat being gone or not.
  assert.equal((await call("DELETE", `/videos/${kept[0].id}`)).status, 200);
  assert.equal(existsSync(path.join(folder, GENERATED_VIDEOS_DIR, "video-20260104-100000-bbbbbb.webm")), false);
});

test("a clip of a folder that is out of reach for the moment stays in the list, and one whose file is gone does not", async () => {
  const folder = chat("away-chat", "Away");
  put(folder, "video-20260105-100000-cccccc.webm", clip("away"));
  put(folder, "video-20260105-100001-dddddd.webm", clip("lost"));
  for (const name of ["video-20260105-100000-cccccc.webm", "video-20260105-100001-dddddd.webm"]) {
    gallery.recordChatVideo({ sessionId: "away-chat", path: `${GENERATED_VIDEOS_DIR}/${name}`, kind: "generated", prompt: name, params: {}, bytes: 80 });
  }
  rmSync(path.join(folder, GENERATED_VIDEOS_DIR, "video-20260105-100001-dddddd.webm"));
  const there = async () => (await listed("?limit=100")).videos.filter((v: any) => v.chat?.id === "away-chat").map((v: any) => v.fileName);
  assert.deepEqual(await there(), ["video-20260105-100000-cccccc.webm"], "the file that is gone is dropped");
  // The folder is moved away, as a drive that is not mounted: its clips are not gone.
  const moved = `${folder}-moved`;
  renameSync(folder, moved);
  assert.deepEqual(await there(), ["video-20260105-100000-cccccc.webm"]);
  const id = (await listed("?limit=100")).videos.find((v: any) => v.chat?.id === "away-chat").id;
  assert.equal((await call("DELETE", `/videos/${id}`)).status, 404, "a delete does not claim the file is gone");
  assert.equal(((await listed("?limit=100")).videos.filter((v: any) => v.chat?.id === "away-chat")).length, 1);
  renameSync(moved, folder);
  assert.equal((await call("GET", `/videos/${id}/file`)).status, 200, "back, it plays again");
});

test("a clip that cannot be opened when the list is made keeps the kind it has, and says why: out of reach, or too large", async () => {
  const folder = chat("unopened-chat", "Unopened");
  const names = { webm: "video-20260106-100000-aaaaaa.webm", avi: "video-20260106-100001-bbbbbb.avi" };
  put(folder, names.webm, clip("unopened"));
  put(folder, names.avi, AVI);
  for (const name of Object.values(names)) gallery.recordChatVideo({ sessionId: "unopened-chat", path: `${GENERATED_VIDEOS_DIR}/${name}`, kind: "generated", prompt: name, params: {}, bytes: 80 });
  const mine = async () => (await listed("?limit=100")).videos.filter((v: any) => v.chat?.id === "unopened-chat");
  const byName = (list: any[], name: string) => list.find((v: any) => v.fileName === name);
  // Opened, they are what their bytes say, and nothing is wrong with them.
  const before = await mine();
  assert.deepEqual([byName(before, names.webm).format.id, byName(before, names.webm).unavailable], ["webm", undefined]);
  assert.deepEqual([byName(before, names.avi).format.id, byName(before, names.avi).unavailable], ["avi", undefined]);

  // The folder is not there, as a drive that is not mounted: the clips are the kind they were, not "unknown", and the reason is out of reach.
  const moved = `${folder}-away`;
  renameSync(folder, moved);
  const away = await mine();
  const webm = byName(away, names.webm);
  const avi = byName(away, names.avi);
  assert.deepEqual([webm.format.id, webm.format.playable, webm.unavailable, webm.poster], ["webm", true, "unreachable", false]);
  assert.deepEqual([avi.format.id, avi.format.playable, avi.unavailable], ["avi", false, "unreachable"]);
  assert.equal((await call("GET", `/videos/${webm.id}/file`)).status, 404);
  assert.equal((await call("GET", `/videos/${avi.id}/file`)).status, 404);
  renameSync(moved, folder);
  assert.equal(byName(await mine(), names.webm).unavailable, undefined, "back, it is as it was");

  // A file that has grown past the size of a clip: what it is is still read from its start, and it is said to be too large.
  const own = path.join(media.data, "videos");
  const big = gallery.addPageVideo({ bytes: clip("big"), ext: "webm", kind: "generated", prompt: "big", params: {} });
  const bigAvi = aviClip("big avi");
  for (const [id, ext] of [[big.id, "webm"], [bigAvi.id, "avi"]]) truncateSync(path.join(own, `${id}.${ext}`), MAX_VIDEO_BYTES + 1);
  const [grownWebm, grownAvi] = (await listed(`?ids=${big.id},${bigAvi.id}`)).videos;
  assert.deepEqual([grownWebm.format.id, grownWebm.format.playable, grownWebm.unavailable, grownWebm.poster], ["webm", true, "too_large", false]);
  assert.deepEqual([grownAvi.format.id, grownAvi.format.playable, grownAvi.unavailable], ["avi", false, "too_large"]);
  assert.equal((await call("GET", `/videos/${big.id}/file`)).status, 413);

  // A file that is gone is told as the kind it was named for; the next look at the list drops it.
  rmSync(path.join(own, `${bigAvi.id}.avi`));
  const [gone] = (await listed(`?ids=${bigAvi.id}`)).videos;
  assert.deepEqual([gone.format.id, gone.unavailable], ["avi", "unreachable"]);
  for (const id of [big.id, webm.id, avi.id]) await call("DELETE", `/videos/${id}`);
});

test("the clips of a folder the portal removes go with it, those of its chats included", async () => {
  const doomed = project("doomed");
  put(doomed, "video-20260106-100000-eeeeee.webm", clip("doomed"));
  media.chat("doomed-chat", doomed, "In the doomed project");
  gallery.recordChatVideo({ sessionId: "doomed-chat", path: `${GENERATED_VIDEOS_DIR}/video-20260106-100000-eeeeee.webm`, kind: "generated", prompt: "doomed", params: {}, bytes: 80 });
  put(doomed, "found.webm", clip("found"));
  const names = async () => (await listed("?limit=100")).videos.filter((v: any) => /doomed|found\.webm/.test(`${v.prompt}${v.fileName}`)).map((v: any) => v.fileName).sort();
  assert.deepEqual(await names(), ["found.webm", "video-20260106-100000-eeeeee.webm"]);
  rmSync(doomed, { recursive: true });
  media.folderRemoved(doomed);
  assert.deepEqual(await names(), []);
});

// --- the settings, as the page reads and writes them ---

test("the page reads the settings without the key, and writes them with every change checked", async () => {
  gen.saveVideoGeneration({ enabled: false, baseUrl: "", apiKey: "" });
  const sd = await fakeSd();
  try {
    const flags = async () => (await call("GET", "/state")).body;
    assert.deepEqual((await flags()).videos, { enabled: false });
    assert.equal((await call("PUT", "/settings/videos", { enabled: true })).status, 400, "no address to ask yet");
    const saved = await call("PUT", "/settings/videos", { baseUrl: sd.origin, apiKey: KEY, model: "m", enabled: true, timeoutSeconds: 600, frames: 33, fps: 16, storageLimitMb: 500 });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.videos, {
      enabled: true, backend: "sdcpp", baseUrl: sd.origin, model: "m", size: "", frames: 33, fps: 16, timeoutSeconds: 600, storageLimitMb: 500,
      keySet: true, ready: true, backends: [{ id: "sdcpp", label: "stable-diffusion.cpp" }],
    });
    assert.equal(saved.body.changed, true, "the chats that are idle learn of the tools");
    assert.deepEqual((await flags()).videos, { enabled: true });
    const read = await call("GET", "/settings/videos");
    assert.equal(read.body.videos.keySet, true);
    assert.equal((await call("PUT", "/settings/videos", { model: "n" })).body.changed, false, "no reload for what is read at each call");
    assert.equal((await call("PUT", "/settings/videos", { fps: 500 })).status, 400);
    assert.equal((await call("PUT", "/settings/videos", { baseUrl: "ftp://x" })).status, 400);
    assert.equal((await call("PUT", "/settings/videos", { apiKey: "" })).body.videos.keySet, false, "an empty key takes the saved one away");
  } finally {
    sd.server.close();
    off();
  }
});

// --- the posters ---

/** A stand-in for ffmpeg: it says it is there, records how it was run, and answers with a frame. */
function fakeFfmpeg(dir: string, frame: Buffer) {
  mkdirSync(dir, { recursive: true });
  const log = path.join(dir, "args.log");
  const png = path.join(dir, "frame.png");
  writeFileSync(png, frame);
  const script = path.join(dir, "ffmpeg");
  writeFileSync(script, `#!/bin/sh\nif [ "$1" = "-version" ]; then echo fake; exit 0; fi\necho "$@" >> ${JSON.stringify(log)}\ncat > /dev/null\ncat ${JSON.stringify(png)}\n`);
  chmodSync(script, 0o755);
  return { script, log };
}
const HAVE_FFMPEG = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

test("without ffmpeg there are no posters, and the clips are listed and played as they were", async () => {
  process.env.FFMPEG_PATH = path.join(temp, "no-such-ffmpeg");
  posters.forgetPosterProbe();
  try {
    const video = gallery.addPageVideo({ bytes: clip("no poster"), ext: "webm", kind: "generated", prompt: "no ffmpeg", params: {} });
    assert.equal(posters.posterAvailable(), false);
    assert.equal((await listed(`?ids=${video.id}`)).videos[0].poster, false);
    const poster = await call("GET", `/videos/${video.id}/poster`);
    assert.equal(poster.status, 404);
    assert.equal((await call("GET", `/videos/${video.id}/file`)).status, 200);
    assert.equal((await call("GET", "/videos/aaaaaaaaaaaa/poster")).status, 404);
  } finally {
    delete process.env.FFMPEG_PATH;
    posters.forgetPosterProbe();
  }
});

test("a poster is made once from the first frame, small, and kept; it is made again when the file changes, and goes with the clip", async () => {
  const frame = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer();
  const tool = fakeFfmpeg(path.join(temp, "fake-ffmpeg"), frame);
  process.env.FFMPEG_PATH = tool.script;
  posters.forgetPosterProbe();
  try {
    const video = gallery.addPageVideo({ bytes: clip("poster"), ext: "webm", kind: "generated", prompt: "with poster", params: {} });
    assert.equal(posters.posterAvailable(), true);
    assert.equal((await listed(`?ids=${video.id}`)).videos[0].poster, true);

    const first = await call("GET", `/videos/${video.id}/poster`);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("content-type"), "image/webp");
    const meta = await sharp(first.bytes).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ["webp", posters.POSTER_SIDE, 270], "a frame of 1600 by 900, small, with its shape");
    assert.ok(first.bytes.length < 30 * 1024);
    // ffmpeg took the clip on its standard input and may open nothing else.
    const runs = readFileSync(tool.log, "utf8").trim().split("\n");
    assert.equal(runs.length, 1);
    assert.match(runs[0], /-protocol_whitelist pipe -i pipe:0 -frames:v 1 -f image2pipe -vcodec png pipe:1$/);
    assert.ok(!runs[0].includes(video.id) && !runs[0].includes(temp), "no path of the clip is given to it");

    // Kept: the second time ffmpeg is not run.
    assert.equal((await call("GET", `/videos/${video.id}/poster`)).status, 200);
    assert.equal(readFileSync(tool.log, "utf8").trim().split("\n").length, 1);
    const dir = posters.postersDir();
    assert.equal(readdirSync(dir).filter((n) => n.startsWith(video.id)).length, 1);

    // The file written over gets a poster of its own, and the old one goes.
    writeFileSync(path.join(media.data, "videos", `${video.id}.webm`), clip("a different poster"));
    assert.equal((await call("GET", `/videos/${video.id}/poster`)).status, 200);
    assert.equal(readFileSync(tool.log, "utf8").trim().split("\n").length, 2);
    assert.equal(readdirSync(dir).filter((n) => n.startsWith(video.id)).length, 1);

    // Gone with its clip.
    assert.equal((await call("DELETE", `/videos/${video.id}`)).status, 200);
    assert.equal(readdirSync(dir).filter((n) => n.startsWith(video.id)).length, 0);
  } finally {
    delete process.env.FFMPEG_PATH;
    posters.forgetPosterProbe();
  }
});

test("a frame that ffmpeg cannot make is no poster, and only a few are made at the same time", async () => {
  const dir = path.join(temp, "failing-ffmpeg");
  mkdirSync(dir, { recursive: true });
  const script = path.join(dir, "ffmpeg");
  const runs = path.join(dir, "runs.log");
  writeFileSync(script, `#!/bin/sh\nif [ "$1" = "-version" ]; then echo fake; exit 0; fi\necho run >> ${JSON.stringify(runs)}\ncat > /dev/null\necho "Invalid data found when processing input" >&2\nexit 1\n`);
  chmodSync(script, 0o755);
  process.env.FFMPEG_PATH = script;
  posters.forgetPosterProbe();
  try {
    const video = gallery.addPageVideo({ bytes: clip("broken"), ext: "webm", kind: "generated", prompt: "broken", params: {} });
    const failed = await call("GET", `/videos/${video.id}/poster`);
    assert.equal(failed.status, 404, "the page falls back to the clip's own first frame");
    assert.equal(existsSync(posters.postersDir()) ? readdirSync(posters.postersDir()).filter((n) => n.startsWith(video.id)).length : 0, 0);
    // Not tried again for every tile that asks: ffmpeg would stream the whole file through its pipe each time.
    for (let i = 0; i < 3; i++) assert.equal((await call("GET", `/videos/${video.id}/poster`)).status, 404);
    assert.equal(readFileSync(runs, "utf8").trim().split("\n").length, 1, "ffmpeg was run once for a clip it cannot make a frame of");
    // A file that is written over is another file, and is tried once more.
    writeFileSync(path.join(media.data, "videos", `${video.id}.webm`), clip("broken, but written over"));
    assert.equal((await call("GET", `/videos/${video.id}/poster`)).status, 404);
    assert.equal(readFileSync(runs, "utf8").trim().split("\n").length, 2);

    // Many asked at once: ffmpeg is run for at most two of them at a time.
    const slow = path.join(dir, "slow");
    mkdirSync(slow);
    const frame = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#123456" } }).png().toBuffer();
    writeFileSync(path.join(slow, "frame.png"), frame);
    writeFileSync(path.join(slow, "ffmpeg"), `#!/bin/sh\nif [ "$1" = "-version" ]; then echo fake; exit 0; fi\ncat > /dev/null\nsleep 0.3\ncat ${JSON.stringify(path.join(slow, "frame.png"))}\n`);
    chmodSync(path.join(slow, "ffmpeg"), 0o755);
    process.env.FFMPEG_PATH = path.join(slow, "ffmpeg");
    posters.forgetPosterProbe();
    const many = Array.from({ length: 6 }, (_, i) => gallery.addPageVideo({ bytes: clip(`many ${i}`), ext: "webm", kind: "generated", prompt: `many ${i}`, params: {} }));
    const answers = await Promise.all(many.map((v) => call("GET", `/videos/${v.id}/poster`)));
    assert.ok(answers.every((a) => a.status === 200));
    assert.ok(posters.posterJobsPeak() <= posters.POSTER_JOBS, `${posters.posterJobsPeak()} at once`);
    assert.equal(posters.posterJobsPeak(), posters.POSTER_JOBS, "and they did run side by side");
  } finally {
    delete process.env.FFMPEG_PATH;
    posters.forgetPosterProbe();
  }
});

test("a poster that could not be made for a reason that is not the clip's is tried again: ffmpeg gone for a moment, a disk that cannot be written", async () => {
  const frame = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#336699" } }).png().toBuffer();
  const tool = fakeFfmpeg(path.join(temp, "moving-ffmpeg"), frame);
  const away = `${tool.script}.away`;
  process.env.FFMPEG_PATH = tool.script;
  posters.forgetPosterProbe();
  try {
    const gone = gallery.addPageVideo({ bytes: clip("ffmpeg gone"), ext: "webm", kind: "generated", prompt: "ffmpeg gone", params: {} });
    const full = gallery.addPageVideo({ bytes: clip("disk full"), ext: "webm", kind: "generated", prompt: "disk full", params: {} });
    // The probe has said it runs (and is not asked again for a minute) when ffmpeg is replaced: the run cannot start.
    assert.equal(posters.posterAvailable(), true);
    renameSync(tool.script, away);
    assert.equal((await call("GET", `/videos/${gone.id}/poster`)).status, 404);
    renameSync(away, tool.script);
    assert.equal((await call("GET", `/videos/${gone.id}/poster`)).status, 200, "ffmpeg is back: the poster is made, and was not given up for good");

    // A disk that cannot be written to: the folder of the posters is a file for a moment.
    const dir = posters.postersDir();
    const kept = `${dir}.kept`;
    if (existsSync(dir)) renameSync(dir, kept);
    writeFileSync(dir, "not a folder");
    try {
      assert.equal((await call("GET", `/videos/${full.id}/poster`)).status, 404);
    } finally {
      rmSync(dir, { force: true });
      if (existsSync(kept)) renameSync(kept, dir);
    }
    assert.equal((await call("GET", `/videos/${full.id}/poster`)).status, 200, "the disk is fine again: the poster is made");
  } finally {
    if (existsSync(away)) renameSync(away, tool.script);
    delete process.env.FFMPEG_PATH;
    posters.forgetPosterProbe();
  }
});

test("a poster run that is ended by a signal (the time, a kill) is tried again by the next request, and is not taken for a clip ffmpeg cannot read", async () => {
  const dir = path.join(temp, "killed-ffmpeg");
  mkdirSync(dir, { recursive: true });
  const frame = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#996633" } }).png().toBuffer();
  writeFileSync(path.join(dir, "frame.png"), frame);
  const runs = path.join(dir, "runs.log");
  const script = path.join(dir, "ffmpeg");
  // Its first run kills itself, as the portal's kill after the time limit would end it; the second makes the frame.
  writeFileSync(script, `#!/bin/sh\nif [ "$1" = "-version" ]; then echo fake; exit 0; fi\necho run >> ${JSON.stringify(runs)}\nif [ "$(wc -l < ${JSON.stringify(runs)})" -eq 1 ]; then kill -KILL $$; fi\ncat > /dev/null\ncat ${JSON.stringify(path.join(dir, "frame.png"))}\n`);
  chmodSync(script, 0o755);
  process.env.FFMPEG_PATH = script;
  posters.forgetPosterProbe();
  try {
    const video = gallery.addPageVideo({ bytes: clip("killed"), ext: "webm", kind: "generated", prompt: "killed", params: {} });
    assert.equal((await call("GET", `/videos/${video.id}/poster`)).status, 404, "ended by a signal: no poster this time");
    assert.equal(readFileSync(runs, "utf8").trim().split("\n").length, 1);
    const again = await call("GET", `/videos/${video.id}/poster`);
    assert.equal(again.status, 200, "run again, not given up for good");
    assert.equal(readFileSync(runs, "utf8").trim().split("\n").length, 2);
    assert.equal((await sharp(again.bytes).metadata()).format, "webp");
  } finally {
    delete process.env.FFMPEG_PATH;
    posters.forgetPosterProbe();
  }
});

test("a poster is made from a real clip by the ffmpeg that is installed", { skip: HAVE_FFMPEG ? false : "ffmpeg is not installed here" }, async () => {
  delete process.env.FFMPEG_PATH;
  posters.forgetPosterProbe();
  const webm = gallery.addPageVideo({ bytes: WEBM, ext: "webm", kind: "generated", prompt: "real webm", params: {} });
  const mp4 = gallery.addPageVideo({ bytes: MP4, ext: "mp4", kind: "generated", prompt: "real mp4", params: {} });
  for (const video of [webm, mp4]) {
    const poster = await call("GET", `/videos/${video.id}/poster`);
    assert.equal(poster.status, 200, video.prompt);
    const meta = await sharp(poster.bytes).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ["webp", 64, 64], video.prompt);
  }
  // A clip that ffmpeg cannot read gets none, and the page its own first frame.
  const damaged = gallery.addPageVideo({ bytes: Buffer.concat([WEBM.subarray(0, 64), Buffer.alloc(200, 7)]), ext: "webm", kind: "generated", prompt: "damaged", params: {} });
  assert.equal((await call("GET", `/videos/${damaged.id}/poster`)).status, 404);
});

test("the schema keeps a clip's place once, in the folder of the chat or in the folder it was found in", () => {
  const d = getDb();
  const insert = (id: string, session: string | null, folder: string | null, p: string) =>
    d.prepare("INSERT INTO videos (id, origin, session_id, folder, path, kind, created_at) VALUES (?, ?, ?, ?, ?, 'unknown', 1)").run(id, folder ? "folder" : "chat", session, folder, p);
  insert("a1a1a1a1a1a1", "unique-chat", null, "generated-videos/x.webm");
  assert.throws(() => insert("a2a2a2a2a2a2", "unique-chat", null, "generated-videos/x.webm"), /UNIQUE/);
  insert("b1b1b1b1b1b1", null, "/some/folder", "generated-videos/x.webm");
  assert.throws(() => insert("b2b2b2b2b2b2", null, "/some/folder", "generated-videos/x.webm"), /UNIQUE/);
  d.prepare("DELETE FROM videos WHERE id IN ('a1a1a1a1a1a1', 'b1b1b1b1b1b1')").run();
  assert.ok(jobsModule.listJobs);
});

// --- the playable copies ---

/**
 * A stand-in for ffmpeg that converts: it says it is there, records how it was run, answers a look at a clip with a picture
 * of `size`, and writes a WebM (or `output`) to the file it is given last. `fail` makes it fail both ways; `grow` makes
 * the file that many bytes long; `hold` makes it wait, once it has begun to convert, for the test to let it go.
 */
function convertingFfmpeg(dir: string, { fail = false, size = "640x360", output = WEBM, grow = 0, hold = false }: { fail?: boolean; size?: string; output?: Buffer; grow?: number; hold?: boolean } = {}) {
  mkdirSync(dir, { recursive: true });
  const log = path.join(dir, "args.log");
  const limits = path.join(dir, "limits.log");
  const started = path.join(dir, "started");
  const go = path.join(dir, "go");
  for (const stale of [log, limits, started, go]) rmSync(stale, { force: true });
  const webm = path.join(dir, "out.webm");
  writeFileSync(webm, output);
  const script = path.join(dir, "ffmpeg");
  const q = (x: string) => JSON.stringify(x);
  writeFileSync(
    script,
    `#!/bin/sh\nif [ "$1" = "-version" ]; then echo fake; exit 0; fi\necho "$@" >> ${q(log)}\necho "ulimit $(ulimit -v)" >> ${q(limits)}\ncat > /dev/null\n` +
      // A look at the clip has no output file; a conversion has one, and is a WebM.
      `case "$*" in *" -f webm "*) ;; *)\n` +
      (fail ? `echo "Invalid data found when processing input" >&2\n` : size ? `echo "  Stream #0:0: Video: ffv1 (FFV1 / 0x31564646), yuv420p, ${size}, SAR 1:1 DAR 16:9, 5 fps, 5 tbr, 5 tbn" >&2\necho "At least one output file must be specified" >&2\n` : `echo "At least one output file must be specified" >&2\n`) +
      `exit 1;; esac\n` +
      (hold ? `touch ${q(started)}\ni=0; while [ ! -e ${q(go)} ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done\n` : "") +
      `for last; do :; done\ncat ${q(webm)} > "$last"\n` +
      (grow ? `truncate -s ${grow} "$last"\n` : ""),
  );
  chmodSync(script, 0o755);
  return { script, log, limits, started, go };
}
const copyFiles = () => (existsSync(path.join(media.data, "video-copies")) ? readdirSync(path.join(media.data, "video-copies")) : []);

test("without ffmpeg a clip a browser cannot play has no playable copy to offer or to make, and is downloadable as it is", async () => {
  process.env.FFMPEG_PATH = path.join(temp, "no-such-ffmpeg");
  posters.forgetPosterProbe();
  try {
    const avi = gallery.addPageVideo({ bytes: AVI, ext: "avi", kind: "generated", prompt: "an avi", params: {} });
    assert.equal(avi.copy, undefined);
    assert.equal((await listed(`?ids=${avi.id}`)).videos[0].copy, undefined);
    const made = await call("POST", `/videos/${avi.id}/copy`);
    assert.equal(made.status, 409);
    assert.match(made.body.error, /ffmpeg is not installed.*original can be downloaded/);
    assert.equal((await call("GET", `/videos/${avi.id}/copy`)).status, 404);
    assert.deepEqual(copyFiles(), []);
    const file = await call("GET", `/videos/${avi.id}/file`);
    assert.equal(file.status, 200);
    assert.deepEqual(file.bytes, AVI);
  } finally {
    delete process.env.FFMPEG_PATH;
    posters.forgetPosterProbe();
  }
});

test("with ffmpeg a playable WebM copy of a clip a browser cannot play is made on request, kept, and sent to be played; the original is always kept", async () => {
  const tool = convertingFfmpeg(path.join(temp, "converting-ffmpeg"));
  process.env.FFMPEG_PATH = tool.script;
  posters.forgetPosterProbe();
  try {
    const avi = gallery.addPageVideo({ bytes: AVI, ext: "avi", kind: "generated", prompt: "an avi", params: {} });
    // Offered, not made: nothing is converted until someone asks.
    assert.equal(avi.copy, "available");
    assert.equal((await listed(`?ids=${avi.id}`)).videos[0].copy, "available");
    assert.equal((await call("GET", `/videos/${avi.id}/copy`)).status, 404);
    assert.deepEqual(copyFiles(), []);
    assert.equal(existsSync(tool.log), false, "ffmpeg was not run for a clip nobody asked a copy of");

    const made = await call("POST", `/videos/${avi.id}/copy`);
    assert.equal(made.status, 200);
    assert.deepEqual(made.body, { ok: true });
    // Run on the clip from its standard input, and allowed to open nothing else.
    const args = readFileSync(tool.log, "utf8");
    assert.match(args, /-protocol_whitelist pipe -threads 1 -i pipe:0 /);
    assert.match(args, /-f webm -y .*video-copies/);
    assert.equal(copyFiles().length, 1);
    assert.match(copyFiles()[0], new RegExp(`^${avi.id}-[0-9a-f]+-[0-9a-f]+\\.webm$`));

    const listedNow = (await listed(`?ids=${avi.id}`)).videos[0];
    assert.equal(listedNow.copy, "ready");
    assert.equal(listedNow.format.playable, false, "the clip is still the AVI it is");
    const copy = await call("GET", `/videos/${avi.id}/copy`);
    assert.equal(copy.status, 200);
    assert.equal(copy.headers.get("content-type"), "video/webm");
    assert.equal(copy.headers.get("content-disposition"), null, "to be played");
    assert.deepEqual(copy.bytes, WEBM);
    // Asked for again, it is not made again.
    const runs = readFileSync(tool.log, "utf8").trim().split("\n").length;
    assert.equal((await call("POST", `/videos/${avi.id}/copy`)).status, 200);
    assert.equal(readFileSync(tool.log, "utf8").trim().split("\n").length, runs);
    // The original is kept, whole, and still downloadable.
    const original = await call("GET", `/videos/${avi.id}/file`);
    assert.deepEqual(original.bytes, AVI);
    assert.match(original.headers.get("content-disposition") ?? "", /^attachment;/);
    assert.deepEqual(readFileSync(path.join(media.data, "videos", `${avi.id}.avi`)), AVI);

    // A clip that plays has no use for one.
    const plays = gallery.addPageVideo({ bytes: clip("plays"), ext: "webm", kind: "generated", prompt: "plays", params: {} });
    assert.equal(plays.copy, undefined);
    assert.equal((await call("POST", `/videos/${plays.id}/copy`)).status, 400);
    assert.equal((await call("GET", `/videos/${plays.id}/copy`)).status, 404);
    assert.equal((await call("POST", "/videos/aaaaaaaaaaaa/copy")).status, 404);

    // The copy goes with the clip.
    assert.equal((await call("DELETE", `/videos/${avi.id}`)).status, 200);
    assert.deepEqual(copyFiles(), []);
  } finally {
    delete process.env.FFMPEG_PATH;
    posters.forgetPosterProbe();
    rmSync(path.join(media.data, "video-copies"), { recursive: true, force: true });
  }
});

test("a copy that ffmpeg cannot make says so, and leaves the original and no file behind", async () => {
  const tool = convertingFfmpeg(path.join(temp, "failing-ffmpeg"), { fail: true });
  process.env.FFMPEG_PATH = tool.script;
  posters.forgetPosterProbe();
  try {
    const odd = gallery.addPageVideo({ bytes: Buffer.from("not a video at all"), ext: "bin", kind: "generated", prompt: "odd", params: {} });
    assert.equal(odd.copy, "available");
    const made = await call("POST", `/videos/${odd.id}/copy`);
    assert.equal(made.status, 502);
    assert.match(made.body.error, /could not be made.*original can be downloaded/);
    assert.deepEqual(copyFiles(), []);
    assert.deepEqual((await call("GET", `/videos/${odd.id}/file`)).bytes, Buffer.from("not a video at all"));
    assert.equal((await listed(`?ids=${odd.id}`)).videos[0].copy, "available", "it can be asked for again");
  } finally {
    delete process.env.FFMPEG_PATH;
    posters.forgetPosterProbe();
    rmSync(path.join(media.data, "video-copies"), { recursive: true, force: true });
  }
});

/** Runs a test with this ffmpeg in place of the installed one; the copies it made are gone after it. */
async function withFfmpeg(script: string, body: () => Promise<void>) {
  process.env.FFMPEG_PATH = script;
  posters.forgetPosterProbe();
  try {
    await body();
  } finally {
    delete process.env.FFMPEG_PATH;
    posters.forgetPosterProbe();
    rmSync(path.join(media.data, "video-copies"), { recursive: true, force: true });
  }
}
/** What ffmpeg was run with, a line for each run. */
const runsOf = (tool: { log: string }) => (existsSync(tool.log) ? readFileSync(tool.log, "utf8").trim().split("\n") : []);

test("a copy is made within limits: a large picture is scaled down, never up, the output and the memory are capped, and ffmpeg is told so", async () => {
  const tool = convertingFfmpeg(path.join(temp, "bounded-ffmpeg"), { size: "4096x4096" });
  await withFfmpeg(tool.script, async () => {
    const avi = aviClip("bounded");
    const made = await call("POST", `/videos/${avi.id}/copy`);
    // The largest picture there is room for is converted.
    assert.equal(made.status, 200);
    const [look, conversion] = runsOf(tool);
    assert.equal(runsOf(tool).length, 2, "one look at the clip, one conversion");
    assert.doesNotMatch(look, / -f webm /, "the look converts nothing");
    assert.match(conversion, / -f webm -y /);
    // Scaled down to fit, as 4:2:0 that every browser plays; the encoder looks few frames ahead, with few threads; the file stops at a byte over the size of a clip.
    assert.match(conversion, /-vf scale=w='min\(1280,iw\)':h='min\(1280,ih\)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p /);
    assert.match(conversion, / -threads 2 -lag-in-frames 5 -fs 104857601 /);
    // No block of memory beyond what one frame needs, in the look as in the conversion.
    for (const line of [look, conversion]) assert.match(line, /-max_alloc 536870912 /);
    // And the address space capped, where the platform can: the stand-in says what its shell gave it.
    if (process.platform !== "win32") assert.deepEqual(readFileSync(tool.limits, "utf8").trim().split("\n"), ["ulimit 4194304", "ulimit 4194304"]);
  });
});

test("a clip that declares a picture over the limit is refused before it is converted, and nothing is left behind", async () => {
  for (const size of ["8192x8192", "4097x100", "100x4097"]) {
    const tool = convertingFfmpeg(path.join(temp, "oversized-ffmpeg"), { size });
    await withFfmpeg(tool.script, async () => {
      const avi = aviClip(`oversized ${size}`);
      const made = await call("POST", `/videos/${avi.id}/copy`);
      assert.equal(made.status, 502, size);
      assert.match(made.body.error, /could not be made.*original can be downloaded/);
      // Only the look at the clip ran: no conversion was begun, and no file was made.
      const runs = runsOf(tool);
      assert.equal(runs.length, 1, size);
      assert.doesNotMatch(runs[0], / -f webm /);
      assert.deepEqual(copyFiles(), []);
      assert.equal((await listed(`?ids=${avi.id}`)).videos[0].copy, "available", "it is still the original that is there");
      assert.deepEqual((await call("GET", `/videos/${avi.id}/file`)).bytes, AVI);
    });
  }
});

test("a clip whose picture ffmpeg cannot name is not converted either", async () => {
  const tool = convertingFfmpeg(path.join(temp, "nameless-ffmpeg"), { size: "" });
  await withFfmpeg(tool.script, async () => {
    const avi = aviClip("nameless");
    assert.equal((await call("POST", `/videos/${avi.id}/copy`)).status, 502);
    assert.equal(runsOf(tool).length, 1);
    assert.deepEqual(copyFiles(), []);
  });
});

test("a copy is only ever sent when its bytes say it is a WebM", async () => {
  const tool = convertingFfmpeg(path.join(temp, "serving-ffmpeg"));
  await withFfmpeg(tool.script, async () => {
    const avi = aviClip("served");
    // A file in the place of this clip's copy that is something else: put there, as a copy that was made is not.
    const file = statSync(path.join(media.data, "videos", `${avi.id}.avi`));
    mkdirSync(path.join(media.data, "video-copies"), { recursive: true });
    writeFileSync(path.join(media.data, "video-copies", copies.copyName(avi.id, file.size, file.mtimeMs)), "<html><script>alert(1)</script></html>");
    const sent = await call("GET", `/videos/${avi.id}/copy`);
    assert.equal(sent.status, 404);
    assert.doesNotMatch(sent.bytes.toString("utf8"), /<script>/);
    assert.equal(runsOf(tool).length, 0, "asking for a copy makes none");
  });
});

test("what ffmpeg makes that is not a WebM, or is over the size of a clip, is thrown away and is no copy", async () => {
  const cases: [string, Parameters<typeof convertingFfmpeg>[1]][] = [
    ["a page", { output: Buffer.from("<html><script>alert(1)</script></html>") }],
    ["a WebM stopped at the limit", { grow: MAX_VIDEO_BYTES + 1 }],
  ];
  for (const [what, options] of cases) {
    const tool = convertingFfmpeg(path.join(temp, "wrong-ffmpeg"), options);
    await withFfmpeg(tool.script, async () => {
      const avi = aviClip(what);
      const made = await call("POST", `/videos/${avi.id}/copy`);
      assert.equal(made.status, 502, what);
      assert.equal(runsOf(tool).length, 2, `${what}: it was converted`);
      assert.deepEqual(copyFiles(), [], `${what}: nothing is kept, not even the part`);
      assert.equal((await call("GET", `/videos/${avi.id}/copy`)).status, 404, what);
      assert.equal((await listed(`?ids=${avi.id}`)).videos[0].copy, "available", what);
    });
  }
});

test("a clip that changed or was deleted while it was converted gets no copy", async () => {
  const waitFor = async (file: string) => {
    for (let i = 0; i < 400 && !existsSync(file); i++) await pause(25);
    assert.ok(existsSync(file), "ffmpeg never began to convert");
  };
  // The clip has a time of a whole second, so that a file written over can be given the very same one back: only its size tells.
  const stamp = new Date("2026-01-01T00:00:00Z");
  const changes: [string, (id: string, file: string) => Promise<void>][] = [
    ["written over, its time as before", async (_id, file) => (writeFileSync(file, Buffer.concat([AVI, Buffer.from("more")])), utimesSync(file, stamp, stamp))],
    ["touched, its size as before", async (_id, file) => utimesSync(file, stamp, new Date(stamp.getTime() + 120_000))],
    ["deleted", async (id) => void assert.equal((await call("DELETE", `/videos/${id}`)).status, 200)],
  ];
  for (const [what, change] of changes) {
    const tool = convertingFfmpeg(path.join(temp, "held-ffmpeg"), { hold: true });
    await withFfmpeg(tool.script, async () => {
      const avi = aviClip(what);
      const file = path.join(media.data, "videos", `${avi.id}.avi`);
      utimesSync(file, stamp, stamp);
      const making = call("POST", `/videos/${avi.id}/copy`);
      await waitFor(tool.started);
      await change(avi.id, file);
      writeFileSync(tool.go, "");
      assert.equal((await making).status, 502, what);
      assert.deepEqual(copyFiles(), [], `${what}: the copy of what is not there is not kept`);
    });
  }
});

/** A clip of a size, as a real ffmpeg writes one: all black, so a few kilobytes whatever the picture measures. */
function realAvi(file: string, size: string): Buffer {
  const made = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `color=c=black:s=${size}:r=2:d=1`, "-c:v", "ffv1", "-y", file], { stdio: "ignore" });
  assert.equal(made.status, 0, "the test clip could not be made");
  const bytes = readFileSync(file);
  rmSync(file);
  return bytes;
}
const HAVE_VP9 = HAVE_FFMPEG && spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout.includes("libvpx-vp9");
const sizeOf = (file: string) => /Video: .*?, (\d+x\d+)[ ,]/.exec(spawnSync("ffmpeg", ["-hide_banner", "-i", file], { encoding: "utf8" }).stderr)?.[1];

test("the ffmpeg that is installed refuses a clip of a huge picture, scales a large one down and keeps a small one's size", { skip: HAVE_VP9 ? false : "ffmpeg with libvpx-vp9 is not installed here" }, async () => {
  posters.forgetPosterProbe();
  try {
    const dir = path.join(temp, "real-avi");
    mkdirSync(dir, { recursive: true });
    // Five thousand by five thousand: a few kilobytes of file that a conversion would take gigabytes for.
    const huge = aviClip("huge", realAvi(path.join(dir, "huge.avi"), "5000x5000"));
    const refused = await call("POST", `/videos/${huge.id}/copy`);
    assert.equal(refused.status, 502);
    assert.deepEqual(copyFiles(), []);
    // Two thousand by a thousand is converted, to fit twelve hundred and eighty on a side.
    const wide = aviClip("wide", realAvi(path.join(dir, "wide.avi"), "2000x1000"));
    const made = await call("POST", `/videos/${wide.id}/copy`);
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const copy = copyFiles().find((f) => f.startsWith(wide.id));
    assert.ok(copy, "a copy was made");
    assert.equal(sizeOf(path.join(media.data, "video-copies", copy)), "1280x640");
    const sent = await call("GET", `/videos/${wide.id}/copy`);
    assert.equal(sent.status, 200);
    assert.equal(sent.headers.get("content-type"), "video/webm");
    // A smaller picture is not enlarged to fill the box: it keeps its size, an odd side rounded down to an even one.
    for (const [size, kept] of [["320x240", "320x240"], ["481x321", "480x320"]]) {
      const small = aviClip(`small ${size}`, realAvi(path.join(dir, `small-${size}.avi`), size));
      assert.equal((await call("POST", `/videos/${small.id}/copy`)).status, 200, size);
      const smallCopy = copyFiles().find((f) => f.startsWith(small.id));
      assert.ok(smallCopy, `${size}: a copy was made`);
      assert.equal(sizeOf(path.join(media.data, "video-copies", smallCopy)), kept, size);
    }
  } finally {
    rmSync(path.join(media.data, "video-copies"), { recursive: true, force: true });
    posters.forgetPosterProbe();
  }
});
