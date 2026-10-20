import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { scratch } from "../../../tests/helpers.mts";
import { KEY, MATROSKA, MP4, PNG, TAKES_END_IMAGE, WEBM, completed, fakeSd, type FakeSd } from "./video-fixtures.mts";
import * as gen from "../src/server/video-generation.ts";
import { sdcppRoot } from "../src/server/video-sdcpp.ts";
import { ebmlDocType, sniffVideo } from "../src/server/video-files.ts";
import { VIDEO_LIMITS, VIDEO_TIMEOUT_SECONDS, forClip, framesFor, parseVideoSettings, parseVideoSize } from "../src/server/video-settings.ts";
import { getSetting, openStore, putSetting } from "../src/server/store.ts";

// The settings are Media's own, in its store.
openStore(path.join(scratch("media-videos-"), "media.db"));

const config = (baseUrl: string, more: Partial<ReturnType<typeof gen.videoGenerationConfig>> = {}) => ({ ...gen.videoGenerationConfig(), enabled: true, baseUrl, apiKey: KEY, ...more });
/** Fast polling, so that a test does not wait for the pace a real server is asked at. */
const FAST = { pollMs: 5 };

test("a clip is asked for as a job of the native API, with the fields it names, and comes back as the file", async () => {
  const sd = await fakeSd({ jobs: [{ status: "queued", queue_position: 2 }, { status: "queued", queue_position: 1 }, { status: "generating" }, completed()] });
  try {
    const progress: unknown[] = [];
    const made = await gen.generateVideo(
      config(sd.origin, { model: "saved-model", size: "640x384" }),
      { prompt: "a fox in snow", model: "other", size: "832x480", frames: 33, fps: 16, seed: 7, sampleSteps: 20, negativePrompt: "blurry", firstFrame: { bytes: PNG, mimeType: "image/png" } },
      { ...FAST, onProgress: (p) => progress.push(p) },
    );
    assert.deepEqual(made.bytes, WEBM);
    assert.equal(made.ext, "webm");
    assert.deepEqual({ frames: made.frames, fps: made.fps }, { frames: 33, fps: 16 }, "what the server says it made");

    const [submitted] = sd.to("POST", "/sdcpp/v1/vid_gen");
    assert.equal(submitted.type, "application/json");
    assert.equal(submitted.auth, `Bearer ${KEY}`);
    assert.deepEqual(submitted.body, {
      prompt: "a fox in snow",
      model: "other",
      negative_prompt: "blurry",
      width: 832,
      height: 480,
      video_frames: 33,
      fps: 16,
      seed: 7,
      sample_params: { sample_steps: 20 },
      init_image: `data:image/png;base64,${PNG.toString("base64")}`,
      output_format: "webm",
    });
    assert.deepEqual(progress, [{ stage: "waiting", queuePosition: 2 }, { stage: "waiting", queuePosition: 1 }, { stage: "making" }]);
    // Asked how it was doing by the id the server gave, with the key, and the address in the answer was not followed.
    assert.equal(sd.to("GET", "/sdcpp/v1/jobs/job_1").length, 4);
    assert.ok(sd.seen.every((s) => s.auth === `Bearer ${KEY}`));
  } finally {
    sd.server.close();
  }
});

test("without a setting nothing is sent for it: the server's own applies, and the settings stand in for what the request leaves out", async () => {
  const sd = await fakeSd();
  try {
    await gen.generateVideo(config(sd.origin), { prompt: "plain" }, FAST);
    assert.deepEqual(sd.to("POST", "/sdcpp/v1/vid_gen")[0].body, { prompt: "plain", output_format: "webm" });
    await gen.generateVideo(config(sd.origin, { model: "m", size: "512x512", frames: 17, fps: 8 }), { prompt: "settings", size: "", model: "" }, FAST);
    assert.deepEqual(sd.to("POST", "/sdcpp/v1/vid_gen")[1].body, { prompt: "settings", model: "m", width: 512, height: 512, video_frames: 17, fps: 8, output_format: "webm" });
  } finally {
    sd.server.close();
  }
});

test("a last frame goes as end_image, with the first, alone, and never to a server that does not say its model takes one", async () => {
  const sd = await fakeSd({ capabilities: TAKES_END_IMAGE });
  const jpeg = { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), mimeType: "image/jpeg" };
  try {
    const body = async (request: Parameters<typeof gen.generateVideo>[1]) => {
      await gen.generateVideo(config(sd.origin), request, FAST);
      return sd.to("POST", "/sdcpp/v1/vid_gen").at(-1)!.body;
    };
    const png = `data:image/png;base64,${PNG.toString("base64")}`;
    const jpg = `data:image/jpeg;base64,${jpeg.bytes.toString("base64")}`;
    assert.deepEqual(await body({ prompt: "both", firstFrame: { bytes: PNG, mimeType: "image/png" }, lastFrame: jpeg }), { prompt: "both", init_image: png, end_image: jpg, output_format: "webm" });
    assert.deepEqual(await body({ prompt: "last only", lastFrame: { bytes: PNG, mimeType: "image/png" } }), { prompt: "last only", end_image: png, output_format: "webm" });
    // A server that takes one is not sent one nobody asked for.
    assert.deepEqual(await body({ prompt: "first only", firstFrame: { bytes: PNG, mimeType: "image/png" } }), { prompt: "first only", init_image: png, output_format: "webm" });
    assert.deepEqual(await body({ prompt: "none" }), { prompt: "none", output_format: "webm" });
  } finally {
    sd.server.close();
  }

  const refused: [string, unknown, RegExp][] = [
    ["it lists end_image as false", { supported_modes: ["vid_gen"], features_by_mode: { vid_gen: { init_image: true, end_image: false } } }, /server does not take a last frame \(its capabilities do not list end_image for video\): make the clip without one, or use a stable-diffusion\.cpp build that reports it$/],
    ["it lists features and not this one", { supported_modes: ["vid_gen"], features_by_mode: { vid_gen: { init_image: true } } }, /server does not take a last frame \(its capabilities do not list end_image for video\): make the clip without one, or use a stable-diffusion\.cpp build that reports it$/],
    ["it lists one for pictures only", { supported_modes: ["vid_gen"], features_by_mode: { img_gen: { end_image: true } } }, /server does not take a last frame \(its capabilities do not list end_image for video\): make the clip without one, or use a stable-diffusion\.cpp build that reports it$/],
    ["it says nothing of features", { supported_modes: ["vid_gen"] }, /server does not take a last frame \(its capabilities do not list end_image for video\): make the clip without one, or use a stable-diffusion\.cpp build that reports it$/],
    ["it does not answer", undefined, /did not say whether it takes a last frame/],
  ];
  for (const [name, capabilities, why] of refused) {
    const other = await fakeSd({ capabilities });
    try {
      await assert.rejects(
        gen.generateVideo(config(other.origin), { prompt: "x", firstFrame: { bytes: PNG, mimeType: "image/png" }, lastFrame: { bytes: PNG, mimeType: "image/png" } }, FAST),
        (e: Error) => why.test(e.message) && e instanceof gen.VideoGenerationError && !e.message.includes(KEY),
        name,
      );
      assert.equal(other.to("POST", "/sdcpp/v1/vid_gen").length, 0, `${name}: nothing was sent, not even without the picture`);
      // The same server makes the clip when no last frame is asked for.
      await gen.generateVideo(config(other.origin), { prompt: "x", firstFrame: { bytes: PNG, mimeType: "image/png" } }, FAST);
      assert.equal("end_image" in other.to("POST", "/sdcpp/v1/vid_gen")[0].body, false, name);
    } finally {
      other.server.close();
    }
  }
});

test("a last frame asked of a server that cannot be reached, or answers an error, is told as that, not as a server that did not say", async () => {
  const both = { prompt: "x", firstFrame: { bytes: PNG, mimeType: "image/png" }, lastFrame: { bytes: PNG, mimeType: "image/png" } };
  const down = await fakeSd();
  const closed = down.origin;
  await new Promise((r) => down.server.close(r));
  await assert.rejects(gen.generateVideo(config(closed), both, FAST), (e: Error) => e instanceof gen.VideoGenerationError && /Could not reach the video endpoint at .*ECONNREFUSED/.test(e.message) && !/did not say|without one/.test(e.message));
  // Without a last frame the request itself says it, as before.
  await assert.rejects(gen.generateVideo(config(closed), { prompt: "x" }, FAST), /Could not reach the video endpoint/);

  for (const status of [500, 502, 503]) {
    const sd = await fakeSd({ capabilitiesStatus: status });
    try {
      await assert.rejects(gen.generateVideo(config(sd.origin), both, FAST), (e: Error) => e instanceof gen.VideoGenerationError && e.message.includes(`answered ${status}`) && !/did not say|without one/.test(e.message), String(status));
      assert.equal(sd.to("POST", "/sdcpp/v1/vid_gen").length, 0, `${status}: nothing was sent`);
    } finally {
      sd.server.close();
    }
  }
});

test("a strength is sent as strength when it is set, 0 included, and not when it is not", async () => {
  const sd = await fakeSd();
  try {
    for (const strength of [0, 0.4, 1]) {
      await gen.generateVideo(config(sd.origin), { prompt: "s", strength }, FAST);
      assert.equal(sd.to("POST", "/sdcpp/v1/vid_gen").at(-1)!.body.strength, strength);
    }
    await gen.generateVideo(config(sd.origin), { prompt: "none" }, FAST);
    assert.equal("strength" in sd.to("POST", "/sdcpp/v1/vid_gen").at(-1)!.body, false);
  } finally {
    sd.server.close();
  }
});

test("the address of the image endpoint can be given again: the /v1 it ends in is not part of the server's own", () => {
  for (const given of ["http://host:1234", "http://host:1234/", "http://host:1234/v1", "http://host:1234/v1/", "http://host:1234/sdcpp/v1"]) {
    assert.equal(sdcppRoot(given).pathname, "/", given);
  }
  assert.equal(sdcppRoot("https://gateway.example.com/sd/v1").pathname, "/sd");
});

test("a length in seconds is frames at the frame rate: the request's, the settings', the server's own, and then a usual one", async () => {
  const caps = { supported_modes: ["vid_gen"], output_formats_by_mode: { vid_gen: ["webm", "avi"] }, defaults_by_mode: { vid_gen: { fps: 24 } } };
  const sd = await fakeSd({ capabilities: caps });
  const bare = await fakeSd();
  try {
    const ask = async (server: FakeSd, c: ReturnType<typeof config>, request: Parameters<typeof gen.generateVideo>[1]) => {
      await gen.generateVideo(c, request, FAST);
      return server.to("POST", "/sdcpp/v1/vid_gen").at(-1)!.body;
    };
    assert.deepEqual(pick(await ask(sd, config(sd.origin), { prompt: "a", seconds: 2 })), { video_frames: 48, fps: 24 }, "the server's own rate");
    assert.deepEqual(pick(await ask(sd, config(sd.origin, { fps: 8 }), { prompt: "b", seconds: 2 })), { video_frames: 16, fps: 8 }, "the settings'");
    assert.deepEqual(pick(await ask(sd, config(sd.origin, { fps: 8 }), { prompt: "c", seconds: 2, fps: 10 })), { video_frames: 20, fps: 10 }, "the request's");
    assert.deepEqual(pick(await ask(bare, config(bare.origin), { prompt: "d", seconds: 2 })), { video_frames: 32, fps: 16 }, "a server that does not say, a usual one");
    assert.deepEqual(pick(await ask(sd, config(sd.origin, { frames: 9 }), { prompt: "e", seconds: 1000, fps: 120 })), { video_frames: VIDEO_LIMITS.frames.max, fps: 120 }, "never more frames than a clip may have");
    assert.equal(framesFor(0.01, 1), 1);
  } finally {
    sd.server.close();
    bare.server.close();
  }
  function pick(body: any) {
    return { video_frames: body.video_frames, fps: body.fps };
  }
});

test("a server with no video model is told so before anything is sent; one that cannot make a WebM is asked for the format it makes, and its clip is kept", async () => {
  const noVideo = await fakeSd({ capabilities: { supported_modes: ["img_gen"] } });
  const AVI = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("AVI LIST"), Buffer.alloc(40)]);
  const noWebm = await fakeSd({ capabilities: { supported_modes: ["vid_gen"], output_formats_by_mode: { vid_gen: ["avi", "webp"] } }, jobs: [completed({ output_format: "avi", b64_json: AVI.toString("base64") })] });
  const webmToo = await fakeSd({ capabilities: { supported_modes: ["vid_gen"], output_formats_by_mode: { vid_gen: ["avi", "webm"] } } });
  try {
    await assert.rejects(gen.generateVideo(config(noVideo.origin), { prompt: "x" }, FAST), /has no video model loaded/);
    assert.equal(noVideo.to("POST", "/sdcpp/v1/vid_gen").length, 0);
    const made = await gen.generateVideo(config(noWebm.origin), { prompt: "x" }, FAST);
    assert.equal(noWebm.to("POST", "/sdcpp/v1/vid_gen")[0].body.output_format, "avi", "the first it makes");
    assert.equal(made.ext, "avi");
    assert.deepEqual(made.bytes, AVI);
    // A WebM, where the server makes one, is what is asked for.
    await gen.generateVideo(config(webmToo.origin), { prompt: "x" }, FAST);
    assert.equal(webmToo.to("POST", "/sdcpp/v1/vid_gen")[0].body.output_format, "webm");
  } finally {
    noVideo.server.close();
    noWebm.server.close();
    webmToo.server.close();
  }
});

test("what the server refuses, fails or loses is told in its words, and no key is in them", async () => {
  const echo = (message: string) => `${message} (${KEY})`;
  const cases: { name: string; options: Parameters<typeof fakeSd>[0]; message: RegExp }[] = [
    { name: "a request it refuses", options: { submit: { status: 400, body: { error: "invalid generation parameters" } } }, message: /answered 400: invalid generation parameters/ },
    { name: "a full queue", options: { submit: { status: 429, body: { error: "job queue is full" } } }, message: /queue is full \(job queue is full\)/ },
    { name: "a server with no such route", options: { submit: { status: 404, body: { error: "not found" } } }, message: /no video route/ },
    { name: "a job that fails", options: { jobs: [{ status: "generating" }, { status: "failed", error: { code: "generation_failed", message: echo("generate_video returned no results") } }] }, message: /could not make the clip: generate_video returned no results \(\[key\]\)/ },
    { name: "a job that was cancelled there", options: { jobs: [{ status: "cancelled", error: { code: "cancelled", message: "job cancelled by client" } }] }, message: /cancelled on the video endpoint/ },
    { name: "a job it forgot", options: { poll: (_n, res) => (res.writeHead(410, { "content-type": "application/json" }).end('{"error":"job expired"}'), true) }, message: /no longer has the job/ },
    { name: "a state it does not have", options: { jobs: [{ status: "dancing" }] }, message: /state the portal does not know: dancing/ },
    { name: "a finished job with no clip", options: { jobs: [{ status: "completed", result: { output_format: "webm" } }] }, message: /no video in its answer/ },
    { name: "a clip that is not base64", options: { jobs: [completed({ b64_json: "not base64!" })] }, message: /not base64/ },
  ];
  for (const { name, options, message } of cases) {
    const sd = await fakeSd(options);
    try {
      const failed = await gen.generateVideo(config(sd.origin), { prompt: "x" }, FAST).then(() => undefined, (e) => e as Error);
      assert.ok(failed instanceof gen.VideoGenerationError, `${name}: ${failed?.message}`);
      assert.match(failed.message, message, name);
      assert.ok(!failed.message.includes(KEY), `${name} gave the key back`);
    } finally {
      sd.server.close();
    }
  }
});

test("a finished clip is never failed by its format: whatever it is is kept, as the kind its first bytes say, whatever the server calls it", async () => {
  const riff = (tag: string) => Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from(tag), Buffer.alloc(40)]);
  const cases: { name: string; bytes: Buffer; ext: string; says?: string }[] = [
    { name: "an AVI", bytes: riff("AVI LIST"), ext: "avi" },
    { name: "an animated WebP", bytes: riff("WEBPVP8X"), ext: "webp" },
    { name: "a GIF", bytes: Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(30)]), ext: "gif" },
    { name: "an Ogg file", bytes: Buffer.concat([Buffer.from("OggS"), Buffer.alloc(30)]), ext: "ogg" },
    { name: "a QuickTime movie", bytes: Buffer.concat([Buffer.alloc(4), Buffer.from("ftypqt  "), Buffer.alloc(40)]), ext: "mov" },
    { name: "an EBML file of another document type", bytes: ebml("foo"), ext: "mkv" },
    { name: "a file that is nothing it knows", bytes: Buffer.from("<html><script>alert(1)</script></html>"), ext: "bin" },
    { name: "a few bytes", bytes: Buffer.from([1, 2, 3]), ext: "bin" },
    { name: "a Matroska file, as stable-diffusion.cpp writes a WebM", bytes: MATROSKA, ext: "webm" },
    { name: "an MP4", bytes: MP4, ext: "mp4" },
  ];
  for (const { name, bytes, ext } of cases) {
    // Whatever the server calls it.
    const sd = await fakeSd({ jobs: [completed({ output_format: "webm", mime_type: "video/webm", b64_json: bytes.toString("base64") })] });
    try {
      const made = await gen.generateVideo(config(sd.origin), { prompt: "x" }, FAST);
      assert.equal(made.ext, ext, name);
      assert.deepEqual(made.bytes, bytes, `${name}: kept whole`);
      assert.equal(made.frames, 33, name);
    } finally {
      sd.server.close();
    }
  }
});

test("a finished clip is still failed by what is wrong with the answer, and not by what the clip is: no clip, not base64, over the limit", async () => {
  const none = await fakeSd({ jobs: [{ status: "completed", result: { output_format: "webm" } }] });
  const bad = await fakeSd({ jobs: [completed({ b64_json: "not base64!" })] });
  const small = await fakeSd();
  try {
    await assert.rejects(gen.generateVideo(config(none.origin), { prompt: "x" }, FAST), /no video in its answer/);
    await assert.rejects(gen.generateVideo(config(bad.origin), { prompt: "x" }, FAST), /not base64/);
    await assert.rejects(gen.generateVideo(config(small.origin), { prompt: "x" }, { ...FAST, maxBytes: WEBM.length - 1 }), /The clip is over/);
    // And an AVI is over the limit as a WebM is.
    const avi = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("AVI LIST"), Buffer.alloc(400)]);
    const big = await fakeSd({ jobs: [completed({ b64_json: avi.toString("base64") })] });
    try {
      await assert.rejects(gen.generateVideo(config(big.origin), { prompt: "x" }, { ...FAST, maxBytes: 100 }), /The clip is over/);
    } finally {
      big.server.close();
    }
  } finally {
    none.server.close();
    bad.server.close();
    small.server.close();
  }
});

test("what the server says when it refuses a request has no key in it and is cut, whichever status it refuses with", async () => {
  const long = "x".repeat(2000);
  for (const status of [400, 429, 500]) {
    const sd = await fakeSd({ submit: { status, body: { error: `rate limit for key ${KEY}`, message: long } } });
    try {
      const failed = await gen.generateVideo(config(sd.origin), { prompt: "x" }, FAST).then(() => undefined, (e) => e as Error);
      assert.ok(failed instanceof gen.VideoGenerationError, String(status));
      assert.ok(!failed.message.includes(KEY), `${status} gave the key back`);
      assert.match(failed.message, /rate limit for key \[key\]/, String(status));
      assert.ok(failed.message.length < 450, `${status}: ${failed.message.length} characters`);
    } finally {
      sd.server.close();
    }
  }
});

test("a clip over the limit is refused, and a MP4 is as good as a WebM", async () => {
  const small = await fakeSd();
  const mp4 = await fakeSd({ jobs: [completed({ output_format: "mp4", b64_json: MP4.toString("base64") })] });
  try {
    await assert.rejects(gen.generateVideo(config(small.origin), { prompt: "x" }, { ...FAST, maxBytes: WEBM.length - 1 }), /The clip is over/);
    const made = await gen.generateVideo(config(mp4.origin), { prompt: "x" }, FAST);
    assert.equal(made.ext, "mp4");
    assert.deepEqual(made.bytes, MP4);
  } finally {
    small.server.close();
    mp4.server.close();
  }
});

test("a blip of the network while it waits is not the job's end, but a server that stays away is", async () => {
  let breaks = 2;
  const flaky = await fakeSd({ jobs: [{ status: "generating" }, completed()], poll: (_n, res) => (breaks-- > 0 ? (res.destroy(), true) : false) });
  let always = true;
  const gone = await fakeSd({ jobs: [{ status: "generating" }], poll: (_n, res) => (always ? (res.destroy(), true) : false) });
  try {
    const made = await gen.generateVideo(config(flaky.origin), { prompt: "x" }, FAST);
    assert.deepEqual(made.bytes, WEBM);
    await assert.rejects(gen.generateVideo(config(gone.origin), { prompt: "x" }, FAST), /Could not reach the video endpoint at http:\/\/127\.0\.0\.1:\d+/);
    assert.equal(gone.to("GET", "/sdcpp/v1/jobs/job_1").length, 4, "tried again three times before giving up");
  } finally {
    flaky.server.close();
    gone.server.close();
    always = false;
  }
});

test("a clip that takes longer than the time limit says so and names the setting, and leaves the queue", async () => {
  const slow = await fakeSd({ jobs: [{ status: "queued", queue_position: 1 }] });
  try {
    const started = Date.now();
    await assert.rejects(
      gen.generateVideo(config(slow.origin), { prompt: "x" }, { ...FAST, timeoutMs: 300 }),
      /did not finish the clip within 0 seconds\. Raise the time limit under Media in Settings/,
    );
    assert.ok(Date.now() - started < 3000);
    // Told to drop the job: only one that is still queued can be, and the server says which.
    for (let i = 0; i < 100 && !slow.to("POST", "/sdcpp/v1/jobs/job_1/cancel").length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(slow.to("POST", "/sdcpp/v1/jobs/job_1/cancel").length, 1);
  } finally {
    slow.server.close();
  }
});

test("a clip that is stopped is dropped from the queue, and nobody is told it failed", async () => {
  const sd = await fakeSd({ jobs: [{ status: "queued", queue_position: 1 }] });
  try {
    const stop = new AbortController();
    const running = gen.generateVideo(config(sd.origin), { prompt: "x" }, { ...FAST, signal: stop.signal });
    for (let i = 0; i < 100 && sd.to("GET", "/sdcpp/v1/jobs/job_1").length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    stop.abort();
    const e = await running.then(() => undefined, (error) => error as Error);
    assert.ok(e && !(e instanceof gen.VideoGenerationError), "an abort, not a failure");
    for (let i = 0; i < 100 && !sd.to("POST", "/sdcpp/v1/jobs/job_1/cancel").length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(sd.to("POST", "/sdcpp/v1/jobs/job_1/cancel").length, 1);
  } finally {
    sd.server.close();
  }
});

test("a server that is not there says where the portal looked", async () => {
  const sd = await fakeSd();
  const origin = sd.origin;
  sd.server.close();
  await assert.rejects(gen.generateVideo(config(origin), { prompt: "x" }, FAST), (e: Error) => e instanceof gen.VideoGenerationError && e.message.includes(`Could not reach the video endpoint at ${origin}`) && e.message.includes("ECONNREFUSED") && !e.message.includes(KEY));
});

/** What the portal plays inline (its videoType): a file whose first bytes say it is a kind a browser plays, as Media's copy of the sniffing reads them. */
const videoType = (head: Buffer) => {
  const format = sniffVideo(head);
  return format.playable ? { ext: format.id, mimeType: format.mimeType } : undefined;
};
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

test("the clip of a stable-diffusion.cpp server, with its document type matroska, is taken as a WebM", async () => {
  const sd = await fakeSd({ jobs: [completed({ output_format: "webm", b64_json: MATROSKA.toString("base64") })] });
  try {
    const made = await gen.generateVideo(config(sd.origin), { prompt: "x" }, FAST);
    assert.equal(made.ext, "webm");
    assert.deepEqual(made.bytes, MATROSKA);
  } finally {
    sd.server.close();
  }
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

test("the settings of a clip are checked, and what is empty is not sent", () => {
  assert.deepEqual(parseVideoSettings({}), {});
  assert.deepEqual(parseVideoSettings({ model: " m ", size: " 832x480 ", frames: 33, fps: 16, seed: -1, sampleSteps: 20, negativePrompt: " blurry " }), {
    model: "m", size: "832x480", frames: 33, fps: 16, seed: -1, sampleSteps: 20, negativePrompt: "blurry",
  });
  assert.deepEqual(parseVideoSettings({ model: "", size: null, frames: "", fps: undefined, negativePrompt: "  " }), {});
  for (const bad of [
    { size: "63x480" }, { size: "832x4097" }, { size: "auto" }, { size: "832" },
    { frames: 0 }, { frames: 1001 }, { frames: 1.5 }, { frames: "33" },
    { fps: 0 }, { fps: 121 },
    { seed: -2 }, { seed: 1.5 }, { seed: Number.MAX_SAFE_INTEGER },
    { sampleSteps: 0 }, { sampleSteps: 101 },
    { negativePrompt: 5 }, { negativePrompt: "x".repeat(VIDEO_LIMITS.negativePrompt + 1) },
    { strength: -0.1 }, { strength: 1.01 }, { strength: "0.5" }, { strength: Number.NaN }, { strength: Infinity },
    { model: "x".repeat(201) },
  ]) assert.equal(typeof parseVideoSettings(bad, 4), "string", JSON.stringify(bad));
  assert.deepEqual(parseVideoSettings({ strength: 0 }), { strength: 0 }, "0 is a strength");
  assert.deepEqual(parseVideoSettings({ strength: 1 }), { strength: 1 });
  assert.deepEqual(parseVideoSettings({ strength: null }), {});
  assert.deepEqual(parseVideoSettings({ strength: "" }), {});
  assert.equal(typeof parseVideoSize("832x480"), "string");
  assert.deepEqual(forClip({ seed: 5 }, 2), { seed: 7 }, "each clip takes the next seed");
  assert.deepEqual(forClip({ seed: -1 }, 2), { seed: -1 }, "a random seed stays random");
  assert.deepEqual(forClip({}, 2), {});
});

// --- the settings ---

test("a fresh install has video generation off, with the defaults of a clip that takes minutes", () => {
  const fresh = gen.videoGenerationState();
  assert.deepEqual(fresh, {
    enabled: false, backend: "sdcpp", baseUrl: "", model: "", size: "", frames: null, fps: null, timeoutSeconds: VIDEO_TIMEOUT_SECONDS.default, storageLimitMb: 0,
    keySet: false, ready: false, backends: [{ id: "sdcpp", label: "stable-diffusion.cpp" }],
  });
  assert.equal(VIDEO_TIMEOUT_SECONDS.default, 1800);
});

test("a change to the settings is checked, and the key is never given back", () => {
  const patch = (body: unknown) => gen.parseVideoGenerationPatch(body);
  assert.deepEqual(patch({ baseUrl: " http://host:1234/ ", model: " m ", size: "832x480", frames: 33, fps: 16, timeoutSeconds: 600, storageLimitMb: 2048, apiKey: " k ", enabled: true, backend: "sdcpp" }), {
    baseUrl: "http://host:1234", model: "m", size: "832x480", frames: 33, fps: 16, timeoutSeconds: 600, storageLimitMb: 2048, apiKey: "k", enabled: true, backend: "sdcpp",
  });
  assert.deepEqual(patch({ frames: null, fps: null, timeoutSeconds: null, storageLimitMb: null }), { frames: null, fps: null, timeoutSeconds: null, storageLimitMb: null });
  for (const bad of [
    { enabled: "yes" }, { backend: "other" }, { backend: "toString" }, { backend: "__proto__" }, { backend: "constructor" }, { backend: "hasOwnProperty" }, { baseUrl: "ftp://host" }, { baseUrl: "http://user:pw@host" }, { baseUrl: "http://host?key=1" }, { baseUrl: 5 },
    { model: "x".repeat(201) }, { size: "auto" }, { size: 5 }, { frames: 0 }, { fps: 200 }, { timeoutSeconds: 29 }, { timeoutSeconds: 14401 }, { timeoutSeconds: 60.5 },
    { storageLimitMb: 0 }, { storageLimitMb: -5 }, { apiKey: "k".repeat(4001) },
  ]) assert.equal(typeof patch(bad), "string", JSON.stringify(bad));

  gen.saveVideoGeneration({ baseUrl: "http://one.example:1234", apiKey: KEY, enabled: true, model: "m" });
  const state = JSON.stringify(gen.videoGenerationState());
  assert.ok(!state.includes(KEY), "the key is not in what the page is told");
  assert.equal(gen.videoGenerationState().keySet, true);
  assert.equal(gen.videoGenerationReady(), true);
});

test("a backend that is not one of the portal's is never read from the settings, whatever Object has under that name", async () => {
  const before = getSetting("video_generation") ?? "{}";
  putSetting("video_generation", JSON.stringify({ enabled: true, baseUrl: "http://one.example:1234", backend: "toString" }));
  try {
    assert.equal(gen.videoGenerationConfig().backend, "sdcpp");
    assert.equal(gen.videoGenerationState().backend, "sdcpp");
    const sd = await fakeSd();
    try {
      // A clip is asked for through the backend there is, not through a function of Object.
      const made = await gen.generateVideo({ ...gen.videoGenerationConfig(), baseUrl: sd.origin }, { prompt: "x" }, FAST);
      assert.deepEqual(made.bytes, WEBM);
    } finally {
      sd.server.close();
    }
  } finally {
    putSetting("video_generation", before);
  }
});

test("switched on there must be an address, a key belongs to the server it was given for, and the default time limit is not saved as a choice", () => {
  assert.throws(() => gen.saveVideoGeneration({ baseUrl: "", enabled: true }), /Set the address of the video endpoint/);
  // The key stays while the address is the same server's, and goes with a move to another.
  gen.saveVideoGeneration({ baseUrl: "http://one.example:1234/", apiKey: KEY });
  gen.saveVideoGeneration({ baseUrl: "http://one.example:1234/other" });
  assert.equal(gen.videoGenerationConfig().apiKey, KEY);
  gen.saveVideoGeneration({ baseUrl: "http://two.example:1234" });
  assert.equal(gen.videoGenerationConfig().apiKey, "", "not sent to a server it was not given for");
  gen.saveVideoGeneration({ baseUrl: "http://three.example", apiKey: KEY });
  assert.equal(gen.videoGenerationConfig().apiKey, KEY, "a key given with the move stays");

  gen.saveVideoGeneration({ timeoutSeconds: 120 });
  assert.equal(gen.videoGenerationConfig().timeoutSeconds, 120);
  gen.saveVideoGeneration({ timeoutSeconds: null });
  assert.equal(gen.videoGenerationConfig().timeoutSeconds, VIDEO_TIMEOUT_SECONDS.default);
  gen.saveVideoGeneration({ frames: 33, fps: 16, storageLimitMb: 100 });
  assert.deepEqual([gen.videoGenerationConfig().frames, gen.videoGenerationConfig().fps, gen.videoGenerationConfig().storageLimitMb], [33, 16, 100]);
  gen.saveVideoGeneration({ frames: null, fps: null, storageLimitMb: null });
  assert.deepEqual([gen.videoGenerationConfig().frames, gen.videoGenerationConfig().fps, gen.videoGenerationConfig().storageLimitMb], [null, null, 0]);
});
