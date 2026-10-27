import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer, get } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { inProcessHome } from "../../../tests/helpers.mts";
import { startMedia } from "./portal.mts";
import * as gen from "../src/server/image-generation.ts";
import * as gallery from "../src/server/image-gallery.ts";
import { MAX_RUNNING } from "../src/server/image-jobs.ts";
import { parseEdit } from "../src/server/api/images.ts";
import { MAX_PICTURE_BYTES } from "../src/server/picture-files.ts";
import { getDb } from "../src/server/store.ts";

const temp = inProcessHome("pitha-gallery-");
const { GENERATED_DIR } = gallery;

// The first bytes of each kind a browser draws, padded: that is all the check reads. `tag` tells two apart.
const pad = (head: number[], tag = "", to = 64) => Buffer.concat([Buffer.from(head), Buffer.from(tag), Buffer.alloc(to)]);
const png = (tag = "") => pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], tag);
const PNG = png();
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const KEY = "sk-test-0123456789";

interface Seen { method?: string; url?: string; auth?: string; body?: any; type?: string; raw?: Buffer; closed?: boolean }
/** A fake image endpoint: `handler` answers, and every request it gets is kept. */
async function fake(handler: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void): Promise<{ origin: string; seen: Seen[]; server: Server }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const whole = Buffer.concat(chunks);
      const text = whole.toString("utf8");
      let body: any;
      try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
      const one: Seen = { method: req.method, url: req.url, auth: req.headers.authorization, body, type: req.headers["content-type"], raw: whole };
      seen.push(one);
      res.on("close", () => { one.closed = !res.writableFinished; });
      handler(req, res, one);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, server };
}
/** The parts of a multipart request as an endpoint reads them, in the order they were sent. */
function partList(seen: Seen): { name: string; filename?: string; bytes: Buffer }[] {
  const boundary = /boundary=(.+)$/.exec(seen.type ?? "")?.[1];
  assert.ok(boundary, `a multipart form, not ${seen.type}`);
  const found: { name: string; filename?: string; bytes: Buffer }[] = [];
  const delimiter = Buffer.from(`--${boundary}`);
  let at = seen.raw!.indexOf(delimiter);
  while (at >= 0) {
    const next = seen.raw!.indexOf(delimiter, at + delimiter.length);
    if (next < 0) break;
    const part = seen.raw!.subarray(at + delimiter.length + 2, next - 2);
    const split = part.indexOf("\r\n\r\n");
    const head = part.subarray(0, split).toString("utf8");
    found.push({ name: /name="([^"]*)"/.exec(head)![1], filename: /filename="([^"]*)"/.exec(head)?.[1], bytes: part.subarray(split + 4) });
    at = next;
  }
  return found;
}
const json = (res: ServerResponse, body: unknown, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
const b64 = (bytes: Buffer) => bytes.toString("base64");
/** Answers every request with a picture. */
const answering = (bytes: Buffer = PNG) => fake((_req, res) => json(res, { data: [{ b64_json: b64(bytes) }] }));

// Media's routes the page talks to, as the portal serves them: each reads its own body.
const media = await startMedia();
const at = media.at;

/** A call to the API, and what it answered; none ever has the key in it. */
async function call(method: string, p: string, body?: unknown, init: { raw?: Buffer; type?: string; headers?: Record<string, string> } = {}) {
  const r = await fetch(`${at}${p}`, {
    method,
    headers: { ...(init.raw ? { "content-type": init.type ?? "image/png" } : body !== undefined ? { "content-type": "application/json" } : {}), ...init.headers },
    body: init.raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const bytes = Buffer.from(await r.arrayBuffer());
  assert.ok(!bytes.includes(KEY), `${method} ${p} gave the key back`);
  const type = r.headers.get("content-type") ?? "";
  return { status: r.status, headers: r.headers, bytes, body: type.includes("json") ? JSON.parse(bytes.toString("utf8")) : undefined };
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Waits until none of the jobs is running, and returns them. */
async function settled(): Promise<any[]> {
  for (let i = 0; i < 200; i++) {
    const { jobs } = (await call("GET", "/images/jobs")).body;
    if (jobs.every((j: any) => j.state !== "running")) return jobs;
    await pause(25);
  }
  assert.fail("a job never ended");
}
/** No job of an earlier test is left to be told apart from this one's. */
async function clearJobs() {
  for (const job of (await call("GET", "/images/jobs")).body.jobs) await call("DELETE", `/images/jobs/${job.id}`);
}
const settings = (more: Partial<ReturnType<typeof gen.imageGenerationConfig>> = {}) =>
  gen.saveImageGeneration({ enabled: true, model: "image-model", size: "", apiKey: KEY, editEnabled: false, editBaseUrl: "", editModel: "", editApiKey: "", editMultiple: false, sdExtras: false, ...more });
const gone = () => gen.saveImageGeneration({ enabled: false, editEnabled: false, sdExtras: false });
/** A chat with a folder of its own. */
function chat(id: string, title = "A chat") {
  const folder = mkdtempSync(path.join(temp, "chat-"));
  media.chat(id, folder, title);
  return folder;
}
/** Settings that are refused, each for its own reason: a request with one makes nothing. */
const BAD_SETTINGS = [
  { size: "63x512" },
  { outputFormat: "gif" },
  { outputCompression: 50 },
  { outputFormat: "png", outputCompression: 50 },
  { outputFormat: "jpeg", outputCompression: 101 },
  { seed: 1.5 },
  { seed: -2 },
  { sampleSteps: 0 },
  { sampleSteps: 101 },
  { negativePrompt: 5 },
].map((setting) => ({ prompt: "x", ...setting }));
const listed = async (query = "") => (await call("GET", `/images${query}`)).body;
const dir = path.join(media.data, "images");

/** What the OpenAI image format has for a request to make a picture, and for one to change a picture. Nothing else is a field. */
const OPENAI_GENERATE = ["model", "prompt", "n", "size", "output_format", "output_compression"];
const OPENAI_EDIT = ["image", "image[]", "mask", "prompt", "model", "n", "size", "output_format", "output_compression"];
/** The block as stable-diffusion.cpp's server cuts it out of a prompt: the description, and what the block says. */
const cutOut = (prompt: string): { prompt: string; args?: unknown } => {
  const found = /<sd_cpp_extra_args>(.*?)<\/sd_cpp_extra_args>/.exec(prompt);
  return found ? { prompt: prompt.replace(found[0], "").trim(), args: JSON.parse(found[1]) } : { prompt };
};

test("a request has the fields of the OpenAI image format, and what that format does not have goes in the prompt, only when it is set", async () => {
  const { origin, seen, server } = await answering();
  try {
    const config = gen.imageGenerationConfig();
    const base = { ...config, enabled: true, baseUrl: origin, model: "saved-model", size: "1024x1024", apiKey: KEY, sdExtras: true };
    await gen.generateImage(base, {
      prompt: "a",
      model: "other",
      size: "512x512",
      outputFormat: "jpeg",
      outputCompression: 70,
      native: { negativePrompt: 'no "text"\nor logos', seed: 7, sampleSteps: 20 },
    });
    const first = seen[0].body;
    assert.deepEqual(Object.keys(first).sort(), [...OPENAI_GENERATE].sort(), "the fields of the format, every one of them");
    assert.deepEqual({ ...first, prompt: undefined }, { model: "other", n: 1, size: "512x512", output_format: "jpeg", output_compression: 70, prompt: undefined });
    assert.deepEqual(cutOut(first.prompt), { prompt: "a", args: { negative_prompt: 'no "text"\nor logos', seed: 7, sample_params: { sample_steps: 20 } } });

    await gen.generateImage(base, { prompt: "b" });
    assert.deepEqual(seen[1].body, { model: "saved-model", prompt: "b", n: 1, size: "1024x1024" }, "without settings, what the tool sends: the prompt as it is, and no block");
    // Set but empty is not set, whatever the caller left in the object.
    await gen.generateImage(base, { prompt: "c", native: { negativePrompt: "", seed: undefined, sampleSteps: undefined, strength: undefined } });
    assert.equal(seen[2].body.prompt, "c");
    // With the switch for them off, nothing that only stable-diffusion.cpp reads is sent, whatever the request holds; the rest of it is.
    await gen.generateImage({ ...base, sdExtras: false }, { prompt: "d", outputFormat: "png", native: { negativePrompt: "blurry", seed: 7, sampleSteps: 20, strength: 0.5, fromNoise: true } });
    assert.deepEqual(seen[3].body, { model: "saved-model", prompt: "d", n: 1, size: "1024x1024", output_format: "png" }, "the prompt as it was typed, and no block");
  } finally {
    server.close();
  }
});

test("a picture is made without any chat: a job, a picture in the gallery that is sent, and the key stays on the server", async () => {
  const { origin, seen, server } = await answering();
  await clearJobs();
  try {
    settings({ baseUrl: origin, sdExtras: true });
    const start = await call("POST", "/images/generate", {
      prompt: "  a lighthouse at dusk  ",
      size: "512x512",
      model: "other-model",
      outputFormat: "webp",
      outputCompression: 60,
      negativePrompt: "blurry",
      seed: 7,
      sampleSteps: 25,
    });
    assert.equal(start.status, 202, "answered at once, without waiting for the endpoint");
    assert.equal(start.body.jobs.length, 1);
    assert.equal(start.body.jobs[0].kind, "generate");
    assert.equal(start.body.jobs[0].size, "512x512");
    const [job] = await settled();
    assert.equal(job.state, "done");
    assert.deepEqual(Object.keys(seen[0].body).sort(), [...OPENAI_GENERATE].sort(), "nothing that is not in the format is a field of the request");
    assert.deepEqual({ ...seen[0].body, prompt: undefined }, { model: "other-model", n: 1, size: "512x512", output_format: "webp", output_compression: 60, prompt: undefined });
    assert.deepEqual(cutOut(seen[0].body.prompt), { prompt: "a lighthouse at dusk", args: { negative_prompt: "blurry", seed: 7, sample_params: { sample_steps: 25 } } });
    assert.equal(seen[0].auth, `Bearer ${KEY}`);
    assert.match(seen[0].url!, /\/images\/generations$/);

    const all = await listed();
    const picture = all.pictures.find((p: any) => p.id === job.pictureId);
    assert.ok(picture, "the picture is in the gallery");
    assert.deepEqual({ ...picture, createdAt: 0, bytes: 0, fileName: "" }, {
      id: job.pictureId, origin: "page", chat: null, folder: null, kind: "generated", prompt: "a lighthouse at dusk",
      params: { model: "other-model", size: "512x512", outputFormat: "webp", outputCompression: 60, negativePrompt: "blurry", seed: 7, sampleSteps: 25 },
      from: null, createdAt: 0, bytes: 0, fileName: "", thumb: false,
    });
    assert.match(picture.fileName, /^image-\d{8}-\d{6}-[0-9a-f]{4}\.png$/);
    assert.equal(picture.bytes, PNG.length);
    assert.ok(Math.abs(picture.createdAt - Date.now()) < 60_000);

    const file = await call("GET", `/images/${picture.id}/file`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("content-type"), "image/png");
    assert.deepEqual(file.bytes, PNG);
    assert.match(file.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.equal(file.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(readFileSync(path.join(dir, `${picture.id}.png`)), PNG, "kept in Media's own folder");
    // The browser keeps what never changes, and asks again with what it has. Through http: fetch adds a no-cache to a conditional request, which is its own way of asking for everything again.
    const status = await new Promise<number>((resolve) => {
      get(`${at}/images/${picture.id}/file`, { headers: { "if-none-match": file.headers.get("etag")! } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
    });
    assert.equal(status, 304);
    assert.match(file.headers.get("cache-control") ?? "", /max-age=86400/);
  } finally {
    server.close();
    gone();
  }
});

test("several pictures are one request each, no more than the limit are made at once, and a request that is too much is refused whole", async () => {
  const held: ServerResponse[] = [];
  const { origin, seen, server } = await fake((_req, res) => void held.push(res));
  await clearJobs();
  try {
    settings({ baseUrl: origin });
    const before = (await listed()).total;
    assert.equal((await call("POST", "/images/generate", { prompt: "x", count: MAX_RUNNING + 1 })).status, 400);
    assert.equal((await call("POST", "/images/generate", { prompt: "x", count: 0 })).status, 400);
    const three = await call("POST", "/images/generate", { prompt: "three", count: 3 });
    assert.equal(three.status, 202);
    assert.equal(three.body.jobs.length, 3);
    for (let i = 0; i < 100 && seen.length < 3; i++) await pause(10);
    assert.equal(seen.length, 3, "one request for each, not one for three");
    assert.ok(seen.every((s) => s.body.n === 1), "each asks for one: an endpoint that makes one at a time is not asked for more");

    const two = await call("POST", "/images/generate", { prompt: "two", count: 2 });
    assert.equal(two.status, 429, "only one place is free");
    assert.match(two.body.error, /Only 1 more/);
    assert.equal(seen.length, 3, "none of the two was started");
    assert.equal((await call("POST", "/images/generate", { prompt: "one" })).status, 202);
    const full = await call("POST", "/images/generate", { prompt: "none" });
    assert.equal(full.status, 429);
    assert.match(full.body.error, /being made already/);

    for (let i = 0; i < 100 && held.length < 4; i++) await pause(10);
    for (const res of held) json(res, { data: [{ b64_json: b64(PNG) }] });
    const jobs = await settled();
    assert.equal(jobs.filter((j) => j.state === "done").length, 4);
    assert.equal((await listed()).total, before + 4);
    // Done, a place is free again.
    held.length = 0;
    assert.equal((await call("POST", "/images/generate", { prompt: "again" })).status, 202);
    for (let i = 0; i < 100 && !held.length; i++) await pause(10);
    json(held[0], { data: [{ b64_json: b64(PNG) }] });
    await settled();
    // A finished job is cleared when it has been seen.
    for (const job of (await call("GET", "/images/jobs")).body.jobs) assert.equal((await call("DELETE", `/images/jobs/${job.id}`)).status, 200);
    assert.deepEqual((await call("GET", "/images/jobs")).body.jobs, []);
    assert.equal((await call("DELETE", "/images/jobs/nothere")).status, 404);
  } finally {
    server.close();
    gone();
  }
});

test("a picture that is being made can be stopped: the request is dropped and no picture comes of it", async () => {
  const held: ServerResponse[] = [];
  const { origin, seen, server } = await fake((_req, res) => void held.push(res));
  await clearJobs();
  try {
    settings({ baseUrl: origin });
    const before = (await listed()).total;
    const { jobs } = (await call("POST", "/images/generate", { prompt: "slow" })).body;
    for (let i = 0; i < 100 && !seen.length; i++) await pause(10);
    assert.equal((await call("GET", "/images/jobs")).body.jobs[0].state, "running");
    assert.equal((await call("DELETE", `/images/jobs/${jobs[0].id}`)).status, 200);
    assert.deepEqual((await call("GET", "/images/jobs")).body.jobs, [], "nothing is left to show of it");
    for (let i = 0; i < 100 && !seen[0].closed; i++) await pause(10);
    assert.equal(seen[0].closed, true, "the endpoint was let go of");
    // Late or not, what the endpoint says is not wanted.
    for (const res of held) if (!res.destroyed) json(res, { data: [{ b64_json: b64(PNG) }] });
    await pause(50);
    assert.equal((await listed()).total, before);
    // The place is free again.
    assert.equal((await call("POST", "/images/generate", { prompt: "next", count: MAX_RUNNING })).status, 202);
    for (const j of (await call("GET", "/images/jobs")).body.jobs) await call("DELETE", `/images/jobs/${j.id}`);
  } finally {
    server.close();
    gone();
  }
});

test("a failure is said without the key, and a request that is no picture makes none", async () => {
  const answers: ((res: ServerResponse) => void)[] = [
    (res) => json(res, { error: { message: `bad key ${KEY} for this model` } }, 401),
    (res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ b64_json: b64(SVG) }] })),
    (res) => json(res, { data: [] }),
  ];
  let n = 0;
  const { origin, server } = await fake((_req, res) => answers[n++](res));
  await clearJobs();
  try {
    settings({ baseUrl: origin });
    const before = (await listed()).total;
    for (const expected of [/answered 401: bad key \[key\] for this model/, /is not a PNG, JPEG, GIF or WebP/, /no picture in it/]) {
      await call("POST", "/images/generate", { prompt: "x" });
      const [job] = await settled();
      assert.equal(job.state, "failed");
      assert.match(job.error, expected);
      assert.ok(!JSON.stringify(job).includes(KEY));
      assert.equal(job.pictureId, undefined);
      await call("DELETE", `/images/jobs/${job.id}`);
    }
    assert.equal((await listed()).total, before);
  } finally {
    server.close();
    gone();
  }
});

test("nothing is made while the add-on is off, and a request is checked before it is sent", async () => {
  const { origin, seen, server } = await answering();
  try {
    settings({ baseUrl: origin, enabled: false });
    const off = await call("POST", "/images/generate", { prompt: "x" });
    assert.equal(off.status, 409);
    assert.match(off.body.error, /Media in Settings/);
    assert.equal((await call("POST", "/images/edit", { prompt: "x", sources: ["0123456789ab"] })).status, 409);
    settings({ baseUrl: origin });
    for (const bad of [{}, { prompt: "   " }, { prompt: "x".repeat(gen.MAX_PROMPT + 1) }, { prompt: "x", size: "huge" }, { prompt: "x", model: "m".repeat(201) }, { prompt: "x", extra: { n: 4 } }, { prompt: "x", extra: [1] }, { prompt: "x", count: 1.5 }, { prompt: "x", count: "2" }, ...BAD_SETTINGS]) {
      assert.equal((await call("POST", "/images/generate", bad)).status, 400, JSON.stringify(bad).slice(0, 60));
    }
    assert.equal(seen.length, 0, "nothing went to the endpoint");
    // The edits a gallery cannot make: nothing to change, too many, not ids.
    settings({ baseUrl: origin, editEnabled: true });
    for (const bad of [{ prompt: "x" }, { prompt: "x", sources: [] }, { prompt: "x", sources: ["../etc/passwd"] }, { prompt: "x", sources: Array.from({ length: 9 }, () => "0123456789ab") }, { prompt: "", sources: ["0123456789ab"] }, { prompt: "x", sources: ["0123456789ab"], mask: 5 }, { prompt: "x", sources: ["0123456789ab"], mask: "not base64!" }]) {
      assert.equal((await call("POST", "/images/edit", bad)).status, 400, JSON.stringify(bad).slice(0, 80));
    }
  } finally {
    server.close();
    gone();
  }
});

test("a mask is read by the rules every picture that arrives as text is read by, and is no larger than an edit takes", () => {
  // The smallest real PNG, one transparent pixel, as base64 wrapped as some tools write it.
  const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const wrapped = pixel.replace(/(.{20})/g, "$1\r\n");
  // The limit is the picture's size, not what its length can tell: one byte over is over.
  const sized = (n: number) => {
    const bytes = Buffer.alloc(n);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
    return bytes.toString("base64");
  };
  // Only short values are compared: a failure that printed a 25 MB picture would take gigabytes to say so.
  const outcome = (got: unknown) => (typeof got === "string" ? got : "taken");
  const edit = (mask: unknown) => parseEdit({ prompt: "p", sources: ["0123456789ab"], mask });
  assert.deepEqual((edit(wrapped) as { mask: Buffer }).mask, Buffer.from(pixel, "base64"));
  assert.equal(edit("not base64!"), "The mask is not base64");
  // One byte over what an edit takes, 25 MB: the one big fixture of the test.
  assert.equal(outcome(edit(sized(MAX_PICTURE_BYTES + 1))), "The mask is over 25 MB");
});

test("an edit job carries what was done to make a too-large picture fit, and none when nothing was", async () => {
  const { origin, server } = await answering(png("edited"));
  await clearJobs();
  try {
    const flat = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer();
    const wide = (await call("POST", "/images/upload?name=wide.png", undefined, { raw: await flat(3000, 300) })).body.picture;
    const small = (await call("POST", "/images/upload?name=small.png", undefined, { raw: await flat(100, 100) })).body.picture;
    settings({ baseUrl: origin, editEnabled: true, editMaxSize: "1024x1024" });
    assert.equal((await call("POST", "/images/edit", { prompt: "brighter", sources: [wide.id] })).status, 202);
    const [scaled] = await settled();
    assert.equal(scaled.state, "done", scaled.error);
    assert.equal(scaled.notes.length, 1);
    assert.match(scaled.notes[0], /^The image was scaled down from 3000x300 pixels .* to 1024x102 pixels/);
    await clearJobs();
    assert.equal((await call("POST", "/images/edit", { prompt: "brighter", sources: [small.id] })).status, 202);
    const [kept] = await settled();
    assert.equal(kept.state, "done", kept.error);
    assert.equal("notes" in kept, false, "a picture that fit is not warned about");
  } finally {
    server.close();
    gen.saveImageGeneration({ editMaxSize: "" });
    gone();
  }
});

test("a picture from the person's own files is kept only if its bytes say it is one, and under a name with no place in it", async () => {
  const before = (await listed()).total;
  const bad = await call("POST", "/images/upload?name=x.png", undefined, { raw: SVG, type: "image/png" });
  assert.equal(bad.status, 400, "what it is called does not make it a picture");
  assert.equal((await call("POST", "/images/upload?name=x.png", undefined, { raw: Buffer.alloc(0) })).status, 400);
  assert.equal((await call("POST", "/images/upload", undefined, { raw: Buffer.from("MZ") })).status, 400);
  const ok = await call("POST", "/images/upload?name=" + encodeURIComponent("../../etc/My photo.png"), undefined, { raw: png("up") });
  assert.equal(ok.status, 201);
  const { picture } = ok.body;
  assert.equal(picture.kind, "uploaded");
  assert.equal(picture.origin, "page");
  assert.equal(picture.prompt, "My photo.png");
  assert.equal(picture.from, null);
  assert.deepEqual(readFileSync(path.join(dir, `${picture.id}.png`)), png("up"));
  assert.equal((await listed()).total, before + 1);
  // As large as an edit takes: a larger one is not read.
  const huge = await call("POST", "/images/upload?name=huge.png", undefined, { raw: Buffer.concat([png(), Buffer.alloc(26 * 1024 * 1024)]) });
  assert.equal(huge.status, 413);
  assert.equal((await listed()).total, before + 1);
});

test("an edit is made from pictures of the gallery, with a mask if one is given, and the result is tied to the first of them", async () => {
  const { origin, seen, server } = await answering(png("edited"));
  await clearJobs();
  try {
    const first = (await call("POST", "/images/upload?name=a.png", undefined, { raw: png("one") })).body.picture;
    const second = (await call("POST", "/images/upload?name=b.png", undefined, { raw: png("two") })).body.picture;
    settings({ baseUrl: origin, editEnabled: true, editModel: "edit-model" });
    const started = await call("POST", "/images/edit", { prompt: "  make it night  ", sources: [first.id] });
    assert.equal(started.status, 202);
    assert.equal(started.body.jobs[0].kind, "edit");
    assert.equal(started.body.jobs[0].from, first.id, "the picture the frame shows under the wait");
    const [job] = await settled();
    assert.equal(job.state, "done", job.error);
    assert.match(seen[0].url!, /\/images\/edits$/);
    assert.equal(seen[0].auth, `Bearer ${KEY}`);
    const parts = partList(seen[0]);
    assert.deepEqual(parts.map((p) => p.name), ["image", "prompt", "model", "n"]);
    assert.deepEqual(parts[0].bytes, png("one"));
    assert.equal(parts[1].bytes.toString(), "make it night");
    assert.equal(parts[2].bytes.toString(), "edit-model");
    const made = (await listed()).pictures.find((p: any) => p.id === job.pictureId);
    assert.equal(made.kind, "edited");
    assert.equal(made.origin, "page");
    assert.equal(made.from, first.id);
    assert.deepEqual(made.params, { model: "edit-model", sources: [first.id] });
    assert.equal(made.prompt, "make it night");
    assert.deepEqual(readFileSync(path.join(dir, `${made.id}.png`)), png("edited"));

    // With a mask: sent as `mask`, said to have been, and not kept.
    const mask = png("mask");
    const files = readdirSync(dir).length;
    await call("POST", "/images/edit", { prompt: "only the sky", sources: [first.id], mask: `data:image/png;base64,${b64(mask)}` });
    const [masked] = await settled();
    assert.equal(masked.state, "done", masked.error);
    const sent = partList(seen[1]);
    assert.deepEqual(sent.map((p) => p.name), ["image", "mask", "prompt", "model", "n"]);
    assert.deepEqual(sent[1].bytes, mask);
    const maskedPicture = (await listed()).pictures.find((p: any) => p.id === masked.pictureId);
    assert.equal(maskedPicture.params.masked, true);
    assert.equal(readdirSync(dir).length, files + 1, "the mask is not a picture in the folder");

    // A mask that is no picture is refused before anything is sent.
    const sentBefore = seen.length;
    await call("POST", "/images/edit", { prompt: "x", sources: [first.id], mask: b64(SVG) });
    const [bad] = await settled();
    assert.equal(bad.state, "failed");
    assert.match(bad.error, /mask is not a PNG, JPEG, GIF or WebP/);
    assert.equal(seen.length, sentBefore);

    // Several pictures only to an endpoint that takes them, and then in the order given.
    const refused = await call("POST", "/images/edit", { prompt: "x", sources: [first.id, second.id] });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /not set up to take several pictures/);
    settings({ baseUrl: origin, editEnabled: true, editMultiple: true });
    await call("POST", "/images/edit", { prompt: "the first like the second", sources: [second.id, first.id] });
    const [several] = await settled();
    assert.equal(several.state, "done", several.error);
    const list = partList(seen[seen.length - 1]);
    assert.deepEqual(list.filter((p) => p.name === "image[]").map((p) => p.bytes), [png("two"), png("one")]);
    const multi = (await listed()).pictures.find((p: any) => p.id === several.pictureId);
    assert.equal(multi.from, second.id);
    assert.deepEqual(multi.params.sources, [second.id, first.id]);

    const none = await call("POST", "/images/edit", { prompt: "x", sources: ["ffffffffffff"] });
    assert.equal(none.status, 400);
    assert.match(none.body.error, /no such picture/);
  } finally {
    server.close();
    gone();
  }
});

test("an edit has the settings of the form: the OpenAI ones as fields, the strength and the rest in the prompt, and each picture of several its own seed", async () => {
  const { origin, seen, server } = await answering(png("edited"));
  await clearJobs();
  try {
    const source = (await call("POST", "/images/upload?name=a.png", undefined, { raw: png("one") })).body.picture;
    settings({ baseUrl: origin, size: "1024x1024", editEnabled: true, editModel: "edit-model", sdExtras: true });
    const started = await call("POST", "/images/edit", {
      prompt: "make it night",
      sources: [source.id],
      model: "other-edit-model",
      size: "640x480",
      outputFormat: "jpeg",
      outputCompression: 85,
      negativePrompt: "blurry\nnoisy",
      seed: 100,
      sampleSteps: 12,
      strength: 0.6,
      count: 2,
    });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    assert.equal(started.body.jobs.length, 2, "one change each, as pictures are made");
    const jobs = await settled();
    assert.ok(jobs.every((j) => j.state === "done"), JSON.stringify(jobs.map((j) => j.error)));
    assert.equal(seen.length, 2);
    for (const one of seen) {
      const parts = partList(one);
      assert.deepEqual(parts.map((p) => p.name).sort(), [...OPENAI_EDIT.filter((name) => name !== "image[]" && name !== "mask")].sort(), "only the fields of the format");
      const field = (name: string) => parts.find((p) => p.name === name)!.bytes.toString();
      assert.equal(field("model"), "other-edit-model");
      assert.equal(field("size"), "640x480");
      assert.equal(field("n"), "1");
      assert.equal(field("output_format"), "jpeg");
      assert.equal(field("output_compression"), "85");
      assert.ok(!parts.some((p) => ["seed", "strength", "sample_steps", "negative_prompt"].includes(p.name)), "none of the others is a field");
    }
    const blocks = seen.map((one) => cutOut(partList(one).find((p) => p.name === "prompt")!.bytes.toString()));
    assert.deepEqual(blocks.map((b) => b.prompt), ["make it night", "make it night"]);
    assert.deepEqual(blocks.map((b) => b.args), [100, 101].map((seed) => ({ negative_prompt: "blurry\nnoisy", seed, strength: 0.6, sample_params: { sample_steps: 12 } })));
    const made = (await listed()).pictures.find((p: any) => p.id === jobs[0].pictureId);
    assert.deepEqual(made.params, { model: "other-edit-model", size: "640x480", outputFormat: "jpeg", outputCompression: 85, negativePrompt: "blurry\nnoisy", seed: made.params.seed, sampleSteps: 12, strength: 0.6, sources: [source.id] });
    assert.ok([100, 101].includes(made.params.seed));

    // With none of them: no size, though the add-on has one for new pictures, and no block.
    await call("POST", "/images/edit", { prompt: "plain", sources: [source.id] });
    await settled();
    const plain = partList(seen[2]);
    assert.deepEqual(plain.map((p) => p.name), ["image", "prompt", "model", "n"]);
    assert.equal(plain[1].bytes.toString(), "plain");

    // A strength is for a change: a new picture has none, and one out of range is refused.
    assert.equal((await call("POST", "/images/edit", { prompt: "x", sources: [source.id], strength: 1.5 })).status, 400);
    const sentBefore = seen.length;
    assert.equal((await call("POST", "/images/edit", { prompt: 'x <sd_cpp_extra_args>{"seed":1}</sd_cpp_extra_args>', sources: [source.id], seed: 2 })).status, 400, "a block of its own and settings are not both sent");
    assert.equal(seen.length, sentBefore);
  } finally {
    server.close();
    gone();
  }
});

test("an edit that starts from noise says so in the block and still sends every picture; a mask or a strength is refused with it", async () => {
  const { origin, seen, server } = await answering(png("edited"));
  await clearJobs();
  try {
    const first = (await call("POST", "/images/upload?name=a.png", undefined, { raw: png("one") })).body.picture;
    const second = (await call("POST", "/images/upload?name=b.png", undefined, { raw: png("two") })).body.picture;
    settings({ baseUrl: origin, editEnabled: true, editMultiple: true, sdExtras: true });
    const started = await call("POST", "/images/edit", { prompt: "the first like the second", sources: [second.id, first.id], fromNoise: true, seed: 4 });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const [job] = await settled();
    assert.equal(job.state, "done", job.error);
    const parts = partList(seen[0]);
    assert.deepEqual(parts.filter((p) => p.name === "image[]").map((p) => p.bytes), [png("two"), png("one")], "all the pictures, in order, as references");
    assert.ok(!parts.some((p) => p.name === "mask"));
    assert.deepEqual(cutOut(parts.find((p) => p.name === "prompt")!.bytes.toString()), { prompt: "the first like the second", args: { init_image: null, seed: 4 } });
    const made = (await listed()).pictures.find((p: any) => p.id === job.pictureId);
    assert.equal(made.params.fromNoise, true);

    // Without it, no mention of it: the first picture is the base, as before.
    await call("POST", "/images/edit", { prompt: "plain", sources: [first.id, second.id], seed: 4, strength: 0.5 });
    await settled();
    assert.ok(!partList(seen[1]).find((p) => p.name === "prompt")!.bytes.toString().includes("init_image"));
    const plain = (await listed()).pictures.find((p: any) => p.params.strength === 0.5);
    assert.equal(plain.params.fromNoise, undefined);

    const before = seen.length;
    const mask = await call("POST", "/images/edit", { prompt: "x", sources: [first.id], fromNoise: true, mask: b64(png("mask")) });
    assert.equal(mask.status, 400);
    assert.match(mask.body.error, /mask/);
    const strength = await call("POST", "/images/edit", { prompt: "x", sources: [first.id], fromNoise: true, strength: 0.5 });
    assert.equal(strength.status, 400);
    assert.match(strength.body.error, /strength/);
    assert.equal(seen.length, before, "nothing was sent");
  } finally {
    server.close();
    gone();
  }
});

test("while the Stable Diffusion switch is off, nothing that only stable-diffusion.cpp reads is sent: a request that has any is refused, and the rest is made as it was", async () => {
  const { origin, seen, server } = await answering(png("edited"));
  await clearJobs();
  try {
    const source = (await call("POST", "/images/upload?name=a.png", undefined, { raw: png("one") })).body.picture;
    settings({ baseUrl: origin, editEnabled: true });
    assert.equal(gen.imageGenerationConfig().sdExtras, false, "off unless it was switched on");
    assert.equal((await call("GET", "/settings/images")).body.images.sdExtras, false, "the page is told");
    const before = (await listed()).total;
    for (const sd of [{ negativePrompt: "blurry" }, { seed: 3 }, { sampleSteps: 10 }, { negativePrompt: "x", seed: 0 }]) {
      const refused = await call("POST", "/images/generate", { prompt: "a", ...sd });
      assert.equal(refused.status, 409, JSON.stringify(sd));
      assert.match(refused.body.error, /Stable Diffusion extra settings are switched off/);
    }
    for (const sd of [{ strength: 0.5 }, { fromNoise: true }, { seed: 3 }]) {
      const refused = await call("POST", "/images/edit", { prompt: "a", sources: [source.id], ...sd });
      assert.equal(refused.status, 409, JSON.stringify(sd));
    }
    assert.equal(seen.length, 0, "nothing was sent");
    assert.equal((await listed()).total, before);

    // What the OpenAI format has is not held back by it.
    assert.equal((await call("POST", "/images/generate", { prompt: "a", size: "512x512", outputFormat: "jpeg", outputCompression: 50 })).status, 202);
    assert.equal((await call("POST", "/images/edit", { prompt: "a", sources: [source.id], size: "512x512", outputFormat: "png" })).status, 202);
    await settled();
    assert.equal(seen.length, 2);
    assert.deepEqual({ ...seen[0].body, model: undefined }, { model: undefined, prompt: "a", n: 1, size: "512x512", output_format: "jpeg", output_compression: 50 });
    assert.equal(partList(seen[1]).find((p) => p.name === "prompt")!.bytes.toString(), "a", "no block");

    // On, they are sent; and the setting is the person's to change, and is kept as a boolean.
    assert.match(String(gen.parseImageGenerationPatch({ sdExtras: "yes" })), /sdExtras must be true or false/);
    settings({ baseUrl: origin, sdExtras: true });
    assert.equal((await call("POST", "/images/generate", { prompt: "a", seed: 3 })).status, 202);
    await settled();
    assert.deepEqual(cutOut(seen[2].body.prompt).args, { seed: 3 });
  } finally {
    server.close();
    gone();
  }
});

test("pictures made at once with a seed each have the next one, and settings that are refused make nothing", async () => {
  const { origin, seen, server } = await answering();
  await clearJobs();
  try {
    settings({ baseUrl: origin, sdExtras: true });
    assert.equal((await call("POST", "/images/generate", { prompt: "three", count: 3, seed: 10, sampleSteps: 8 })).status, 202);
    await settled();
    const seeds = seen.map((one) => (cutOut(one.body.prompt).args as { seed: number }).seed).sort();
    assert.deepEqual(seeds, [10, 11, 12]);
    for (const one of seen) assert.equal(one.body.n, 1);
    await clearJobs();

    const before = seen.length;
    const own = await call("POST", "/images/generate", { prompt: 'a <sd_cpp_extra_args>{"seed":1}</sd_cpp_extra_args>', negativePrompt: "x" });
    assert.equal(own.status, 400);
    assert.match(own.body.error, /block of its own/);
    // The same description alone is the person's own business: nothing is added to it.
    assert.equal((await call("POST", "/images/generate", { prompt: 'a <sd_cpp_extra_args>{"seed":1}</sd_cpp_extra_args>' })).status, 202);
    await settled();
    assert.equal(seen.length, before + 1);
    assert.equal(seen[before].body.prompt, 'a <sd_cpp_extra_args>{"seed":1}</sd_cpp_extra_args>');
    const old = await call("POST", "/images/generate", { prompt: "x", extra: { quality: "high" } });
    assert.equal(old.status, 400, "free fields are not sent any more, and not ignored either");
    assert.match(old.body.error, /Free extra fields are not sent any more/);
  } finally {
    server.close();
    gone();
  }
});

/** A picture of this many pixels, as far as its header says: the rest is padding. */
const pngOf = (w: number, h: number) => {
  const dim = (n: number) => Buffer.from([n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from("IHDR"), dim(w), dim(h), Buffer.alloc(16)]);
};

test("an edit of several pictures from the page scales the one over the maximum size down, and refuses one that cannot be, sending nothing", async () => {
  const { origin, seen, server } = await answering(png("edited"));
  await clearJobs();
  try {
    const real = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: "#c82828" } }).png().toBuffer();
    const small = (await call("POST", "/images/upload?name=small.png", undefined, { raw: await real(512, 512) })).body.picture;
    const wide = (await call("POST", "/images/upload?name=wide.png", undefined, { raw: await real(4000, 500) })).body.picture;
    const fine = (await call("POST", "/images/upload?name=fine.png", undefined, { raw: await real(1024, 768) })).body.picture;
    const fake = (await call("POST", "/images/upload?name=fake.png", undefined, { raw: pngOf(4000, 500) })).body.picture;
    settings({ baseUrl: origin, editEnabled: true, editMultiple: true, editMaxSize: "2048x2048" });

    // The second of three is over: it is scaled to fit and the three go in one request, in the order given.
    const started = await call("POST", "/images/edit", { prompt: "the first, in the style of the second", sources: [small.id, wide.id, fine.id] });
    assert.equal(started.status, 202);
    const [done] = await settled();
    assert.equal(done.state, "done", done.error);
    assert.equal(seen.length, 1);
    const sizes = await Promise.all(partList(seen[0]).filter((part) => part.name === "image[]").map(async (part) => { const m = await sharp(part.bytes).metadata(); return `${m.width}x${m.height}`; }));
    assert.deepEqual(sizes, ["512x512", "2048x256", "1024x768"]);

    // One that cannot be scaled (it is no picture that can be read) refuses the job with its place, and nothing is sent.
    await clearJobs();
    await call("POST", "/images/edit", { prompt: "the first, in the style of the second", sources: [small.id, fake.id, fine.id] });
    const [refused] = await settled();
    assert.equal(refused.state, "failed");
    assert.match(refused.error, /^Picture 2 cannot be made to fit an edit: .*Nothing was sent\./);
    assert.equal(seen.length, 1, "none of the three was sent");
  } finally {
    server.close();
    // The maximum is the setting of every test after this one, too.
    gen.saveImageGeneration({ editMaxSize: "", editMultiple: false });
    gone();
  }
});

test("the pictures of the page are made within the time limit of the settings, generated and edited alike", async () => {
  const { origin, server } = await answering();
  await clearJobs();
  const timeouts = mock.method(AbortSignal, "timeout");
  const limits = () => timeouts.mock.calls.map((c) => c.arguments[0]);
  try {
    const source = (await call("POST", "/images/upload?name=a.png", undefined, { raw: png("limit") })).body.picture;
    settings({ baseUrl: origin, editEnabled: true });
    await call("POST", "/images/generate", { prompt: "no limit saved" });
    await settled();
    await call("POST", "/images/edit", { prompt: "no limit saved", sources: [source.id] });
    await settled();
    assert.deepEqual(limits(), [300_000, 300_000], "five minutes without a setting");

    gen.saveImageGeneration({ timeoutSeconds: 900 });
    await call("POST", "/images/generate", { prompt: "limit saved" });
    await settled();
    await call("POST", "/images/edit", { prompt: "limit saved", sources: [source.id] });
    await settled();
    assert.deepEqual(limits().slice(2), [900_000, 900_000], "the limit of the settings, read at each request");
  } finally {
    timeouts.mock.restore();
    server.close();
    gen.saveImageGeneration({ timeoutSeconds: null });
    gone();
  }
});

test("the agent's pictures are in the gallery with the chat they came from, and an edit is tied to what it was made from", async () => {
  const { origin, seen, server } = await answering();
  try {
    settings({ baseUrl: origin, size: "1024x1024", editEnabled: true });
    const folder = chat("chat-1", "Lighthouses");
    const tools = media.tools("chat-1");
    const made = await tools.generate_image.execute("id", { prompt: "a lighthouse", title: "Lighthouse" });
    const picture = (await listed("?origin=chat")).pictures[0];
    assert.equal(picture.origin, "chat");
    assert.deepEqual(picture.chat, { id: "chat-1", title: "Lighthouses" });
    assert.equal(picture.kind, "generated");
    assert.equal(picture.prompt, "a lighthouse");
    assert.deepEqual(picture.params, { model: "image-model", size: "1024x1024" });
    assert.equal(picture.fileName, path.basename(made.details.files[0].path));
    assert.equal(picture.from, null);
    const file = await call("GET", `/images/${picture.id}/file`);
    assert.equal(file.status, 200);
    assert.deepEqual(file.bytes, PNG);
    assert.equal(file.headers.get("cache-control"), "private, no-cache", "a file in a chat's folder is that folder's: the browser asks");

    const changed = await tools.edit_image.execute("id", { path: made.details.files[0].path, prompt: "at night" });
    const edited = (await listed("?origin=chat&kind=edited")).pictures[0];
    assert.equal(edited.from, picture.id);
    assert.equal(edited.prompt, "at night");
    assert.deepEqual(edited.params, { sources: [picture.id] });
    assert.equal(edited.fileName, path.basename(changed.details.files[0].path));
    // What an edit was made from is reached by its id, wherever it is in the list.
    const by = await listed(`?ids=${picture.id},${edited.id},ffffffffffff`);
    assert.deepEqual(by.pictures.map((p: any) => p.id), [picture.id, edited.id], "in the order given; a picture that is not there is left out");

    // A picture of the folder that the gallery does not know is no link.
    writeFileSync(path.join(folder, "mine.png"), PNG);
    await tools.edit_image.execute("id", { path: "mine.png", prompt: "brighter" });
    const unknown = (await listed("?origin=chat&kind=edited")).pictures[0];
    assert.equal(unknown.prompt, "brighter");
    assert.equal(unknown.from, null);
    assert.equal(seen.length, 3);
  } finally {
    server.close();
    gone();
  }
});

test("a picture the agent made from references is a generated one in the gallery, with its references in order and tied to none of them", async () => {
  const { origin, seen, server } = await answering(png("made"));
  try {
    settings({ baseUrl: origin, size: "1024x1024", editEnabled: true, editMultiple: true, editModel: "edit-model", sdExtras: true });
    const folder = chat("chat-refs", "Characters");
    const tools = media.tools("chat-refs");
    // A character sheet the agent made, which the gallery knows, and a style picture of the folder, which it does not.
    const sheet = await tools.generate_image.execute("id", { prompt: "a character sheet of a fox" });
    const sheetPicture = (await listed("?origin=chat")).pictures[0];
    writeFileSync(path.join(folder, "style.png"), png("style"));
    const made = await tools.generate_image.execute("id", { prompt: "the fox from the first picture, skiing", references: [sheet.details.files[0].path, "style.png"] });
    assert.match(seen.at(-1)!.url!, /\/images\/edits$/);
    const picture = (await listed("?origin=chat")).pictures[0];
    assert.equal(picture.fileName, path.basename(made.details.files[0].path));
    assert.equal(picture.kind, "generated", "a new picture, not a change");
    assert.equal(picture.from, null, "no picture it was changed from: the viewer links it to none");
    assert.equal(picture.prompt, "the fox from the first picture, skiing");
    assert.deepEqual(picture.params, { model: "edit-model", size: "1024x1024", fromNoise: true, references: [sheetPicture.id] }, "the references the gallery knows; the other is no link");
    assert.deepEqual((await listed("?origin=chat&kind=edited")).pictures.filter((p: any) => p.chat?.id === "chat-refs"), [], "none of this chat's is a change");

    // With the Stable Diffusion switch off it did not start from noise, and does not say it did.
    settings({ baseUrl: origin, editEnabled: true, editMultiple: true, sdExtras: false });
    await tools.generate_image.execute("id", { prompt: "the fox, sleeping", references: [sheet.details.files[0].path] });
    const plain = (await listed("?origin=chat")).pictures[0];
    assert.deepEqual(plain.params, { references: [sheetPicture.id] });
  } finally {
    server.close();
    gone();
  }
});

test("a picture made on the page from references: the editing endpoint, the references in order, from noise, and the gallery keeps which they were", async () => {
  const { origin, seen, server } = await answering(png("made"));
  await clearJobs();
  try {
    const sheet = (await call("POST", "/images/upload?name=sheet.png", undefined, { raw: png("sheet") })).body.picture;
    const style = (await call("POST", "/images/upload?name=style.png", undefined, { raw: png("style") })).body.picture;
    settings({ baseUrl: origin, size: "1024x1024", editEnabled: true, editMultiple: true, editModel: "edit-model", sdExtras: true });
    const started = await call("POST", "/images/generate", { prompt: "  the character from the first picture, in a new pose  ", references: [sheet.id, style.id], seed: 7, count: 2 });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    assert.deepEqual(started.body.jobs.map((j: any) => [j.kind, j.size, j.from]), [["generate", "1024x1024", undefined], ["generate", "1024x1024", undefined]], "a new picture, in the frame of its size, with no picture under the wait");
    const jobs = await settled();
    assert.ok(jobs.every((j: any) => j.state === "done"), JSON.stringify(jobs));
    assert.equal(seen.length, 2, "one request for each picture");
    for (const [i, one] of seen.entries()) {
      assert.match(one.url!, /\/images\/edits$/);
      assert.equal(one.auth, `Bearer ${KEY}`);
      const parts = partList(one);
      assert.deepEqual(parts.map((p) => p.name), ["image[]", "image[]", "prompt", "model", "n", "size"]);
      assert.deepEqual(parts.slice(0, 2).map((p) => p.bytes), [png("sheet"), png("style")], "in the order given");
      assert.ok(parts.every((p) => OPENAI_EDIT.includes(p.name)));
      assert.deepEqual(cutOut(parts[2].bytes.toString()), { prompt: "the character from the first picture, in a new pose", args: { init_image: null, seed: 7 + i } });
      assert.equal(parts[3].bytes.toString(), "edit-model", "the editing model where the request names none");
      assert.equal(parts[5].bytes.toString(), "1024x1024", "the add-on's size where the request names none");
    }
    const made = (await listed()).pictures.filter((p: any) => jobs.some((j: any) => j.pictureId === p.id));
    assert.equal(made.length, 2);
    for (const picture of made) {
      assert.equal(picture.kind, "generated");
      assert.equal(picture.from, null);
      assert.deepEqual(picture.params.references, [sheet.id, style.id]);
      assert.equal(picture.params.fromNoise, true);
      assert.equal(picture.params.model, "edit-model");
      assert.equal(picture.params.size, "1024x1024");
    }

    // A size of the request's own goes as asked, a model of its own does not: it is always the editing endpoint's. With the switch off, no block, and nothing said of noise.
    settings({ baseUrl: origin, size: "", editEnabled: true, editMultiple: true, editModel: "edit-model", sdExtras: false });
    await call("POST", "/images/generate", { prompt: "plain", references: [style.id], size: "768x1344", model: "generation-only-model" });
    const [one] = await settled();
    assert.equal(one.state, "done", one.error);
    assert.deepEqual(partList(seen[2]).map((p) => [p.name, p.name === "image" ? p.bytes : p.bytes.toString()]), [["image", png("style")], ["prompt", "plain"], ["model", "edit-model"], ["n", "1"], ["size", "768x1344"]]);
    const plain = (await listed()).pictures.find((p: any) => p.id === one.pictureId);
    assert.deepEqual(plain.params, { model: "edit-model", size: "768x1344", references: [style.id] });

    // Without references the request is the one it always was.
    await clearJobs();
    await call("POST", "/images/generate", { prompt: "no references" });
    await settled();
    assert.match(seen[3].url!, /\/images\/generations$/);
    assert.deepEqual(seen[3].body, { model: "image-model", prompt: "no references", n: 1 });
  } finally {
    server.close();
    gone();
  }
});

test("a reference that was scaled down to fit is said to be a reference, not a picture that was changed", async () => {
  const { origin, server } = await answering(png("made"));
  await clearJobs();
  try {
    const wide = await sharp({ create: { width: 128, height: 64, channels: 3, background: "#c33" } }).png().toBuffer();
    const sheet = (await call("POST", "/images/upload?name=sheet.png", undefined, { raw: wide })).body.picture;
    const style = (await call("POST", "/images/upload?name=style.png", undefined, { raw: wide })).body.picture;
    settings({ baseUrl: origin, editEnabled: true, editMultiple: true, editMaxSize: "64x64" });
    await call("POST", "/images/generate", { prompt: "the fox", references: [sheet.id] });
    const [one] = await settled();
    assert.equal(one.state, "done", one.error);
    assert.equal(one.kind, "generate");
    assert.equal(one.notes.length, 1);
    assert.match(one.notes[0], /^The reference was scaled down from 128x64 pixels \([^)]+\) to 64x32 pixels \([^)]+\) to fit what the editing endpoint takes\.$/);
    await clearJobs();
    await call("POST", "/images/generate", { prompt: "the fox", references: [sheet.id, style.id] });
    const [two] = await settled();
    assert.deepEqual(two.notes.map((note: string) => note.split(" was ")[0]), ["Reference 1", "Reference 2"]);
    // An edit's notes are as they were.
    await clearJobs();
    await call("POST", "/images/edit", { prompt: "brighter", sources: [sheet.id] });
    const [edit] = await settled();
    assert.match(edit.notes[0], /^The image was scaled down .* to fit what an edit takes\. The result is not scaled back up\.$/);
  } finally {
    server.close();
    gen.saveImageGeneration({ editMaxSize: "" });
    gone();
  }
});

test("references on the page are refused before anything is sent: editing off, several where the endpoint takes one, too many, one that is not in the gallery", async () => {
  const { origin, seen, server } = await answering(png("made"));
  await clearJobs();
  try {
    const sheet = (await call("POST", "/images/upload?name=sheet.png", undefined, { raw: png("sheet") })).body.picture;
    const style = (await call("POST", "/images/upload?name=style.png", undefined, { raw: png("style") })).body.picture;
    settings({ baseUrl: origin, editEnabled: false });
    const off = await call("POST", "/images/generate", { prompt: "x", references: [sheet.id] });
    assert.equal(off.status, 409);
    assert.match(off.body.error, /^Reference pictures are sent to the image editing endpoint, and image editing is switched off or has no address: set it up under Media in Settings, or leave the references out$/);
    settings({ baseUrl: origin, editEnabled: true, editMultiple: false });
    const two = await call("POST", "/images/generate", { prompt: "x", references: [sheet.id, style.id] });
    assert.equal(two.status, 400);
    assert.match(two.body.error, /not set up to take several pictures, so none was sent \(2 were given\).*"Several pictures per edit"/);
    settings({ baseUrl: origin, editEnabled: true, editMultiple: true });
    settings({ baseUrl: origin, editEnabled: true, editMultiple: true, sdExtras: true });
    const block = await call("POST", "/images/generate", { prompt: 'x <sd_cpp_extra_args>{"seed":1}</sd_cpp_extra_args>', references: [sheet.id] });
    assert.equal(block.status, 400);
    assert.match(block.body.error, /^The description has an sd_cpp_extra_args block of its own, which would hide the one that makes a picture with references start from noise/);
    settings({ baseUrl: origin, editEnabled: true, editMultiple: true });
    const missing = await call("POST", "/images/generate", { prompt: "x", references: [sheet.id, "ffffffffffff"] });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /^Reference 2: There is no such picture/);
    for (const [references, message] of [
      [[], /leave them out to make a picture from the description alone/],
      ["abc", /leave them out/],
      [Array(9).fill(sheet.id), /at most 8 references, and 9 were given/],
      [["../x"], /named by their ids in the gallery/],
    ] as const) {
      const bad = await call("POST", "/images/generate", { prompt: "x", references });
      assert.equal(bad.status, 400, JSON.stringify(references));
      assert.match(bad.body.error, message);
    }
    assert.equal(seen.length, 0, "nothing was sent");
    assert.deepEqual((await call("GET", "/images/jobs")).body.jobs, [], "and no job was started");
  } finally {
    server.close();
    gone();
  }
});

test("a picture in a chat's folder is deleted from the folder on purpose; what was made of it loses its link, and the rest stays", async () => {
  const { origin, server } = await answering();
  try {
    settings({ baseUrl: origin, editEnabled: true });
    const folder = chat("chat-3");
    const tools = media.tools("chat-3");
    const one = await tools.generate_image.execute("id", { prompt: "one" });
    const two = await tools.generate_image.execute("id", { prompt: "two" });
    await tools.edit_image.execute("id", { path: one.details.files[0].path, prompt: "edited one" });
    const all = (await listed("?origin=chat")).pictures.filter((p: any) => p.chat.id === "chat-3");
    const [editedOne, pictureTwo, pictureOne] = [all.find((p: any) => p.kind === "edited"), all.find((p: any) => p.prompt === "two"), all.find((p: any) => p.prompt === "one")];
    assert.equal(editedOne.from, pictureOne.id);

    const deleted = await call("DELETE", `/images/${pictureOne.id}`);
    assert.equal(deleted.status, 200);
    assert.equal(existsSync(path.join(folder, one.details.files[0].path)), false, "the file is gone from the chat's folder");
    assert.equal(existsSync(path.join(folder, two.details.files[0].path)), true, "the others are not touched");
    const after = await listed(`?ids=${editedOne.id}`);
    assert.equal(after.pictures[0].from, null);
    assert.equal((await call("GET", `/images/${pictureOne.id}/file`)).status, 404);
    assert.equal((await call("DELETE", `/images/${pictureOne.id}`)).status, 404, "gone is gone");

    // Several at once: each as asked, and what could not be said for each.
    const page = (await call("POST", "/images/upload?name=p.png", undefined, { raw: png("p") })).body.picture;
    const several = await call("POST", "/images/delete", { ids: [pictureTwo.id, page.id, "ffffffffffff"] });
    assert.equal(several.status, 200);
    assert.deepEqual(several.body.deleted.sort(), [pictureTwo.id, page.id].sort());
    assert.deepEqual(several.body.failed.map((f: any) => f.id), ["ffffffffffff"]);
    assert.equal(existsSync(path.join(folder, two.details.files[0].path)), false);
    assert.equal(existsSync(path.join(dir, `${page.id}.png`)), false, "the page's own file goes too");
    assert.equal((await call("POST", "/images/delete", { ids: [] })).status, 400);
    assert.equal((await call("POST", "/images/delete", { ids: ["../../x"] })).status, 400);
    assert.equal((await call("POST", "/images/delete", {})).status, 400);
  } finally {
    server.close();
    gone();
  }
});

test("only what the portal knows is served: a row that points anywhere else is not, whatever put it there", async () => {
  const folder = chat("chat-4");
  const outside = path.join(temp, "outside.png");
  writeFileSync(outside, png("secret"));
  mkdirSync(path.join(folder, GENERATED_DIR));
  mkdirSync(path.join(folder, "notes"));
  writeFileSync(path.join(folder, "notes", "secret.png"), png("notes"));
  symlinkSync(outside, path.join(folder, GENERATED_DIR, "link.png"));
  writeFileSync(path.join(dir, "..", "outside2.png"), png("secret2"));
  const row = (id: string, origin: string, session: string | null, file: string) =>
    getDb().prepare("INSERT INTO images (id, origin, session_id, path, kind, prompt, params, bytes, created_at) VALUES (?, ?, ?, ?, 'generated', 'x', '{}', 1, ?)").run(id, origin, session, file, Date.now());
  row("aaaaaaaaaaa1", "chat", "chat-4", "../outside.png");
  row("aaaaaaaaaaa2", "chat", "chat-4", "notes/secret.png");
  row("aaaaaaaaaaa3", "chat", "chat-4", `${GENERATED_DIR}/link.png`);
  row("aaaaaaaaaaa4", "chat", "chat-4", GENERATED_DIR);
  row("aaaaaaaaaaa5", "chat", "no-such-chat", `${GENERATED_DIR}/x.png`);
  row("aaaaaaaaaaa6", "chat", null, `${GENERATED_DIR}/x.png`);
  row("aaaaaaaaaaa7", "page", null, "../outside2.png");
  // Beginning in the folder of generated pictures is not being in it.
  row("aaaaaaaaaaa8", "chat", "chat-4", `${GENERATED_DIR}/../notes/secret.png`);
  const bad = ["aaaaaaaaaaa1", "aaaaaaaaaaa2", "aaaaaaaaaaa3", "aaaaaaaaaaa4", "aaaaaaaaaaa5", "aaaaaaaaaaa6", "aaaaaaaaaaa7", "aaaaaaaaaaa8"];
  for (const id of bad) {
    const r = await call("GET", `/images/${id}/file`);
    assert.notEqual(r.status, 200, id);
    assert.ok(![png("secret"), png("notes"), png("secret2")].some((b) => r.bytes.equals(b)), `${id} gave a file from outside`);
  }
  // A picture that was served nowhere is no picture the page is shown either.
  const ids = (await listed()).pictures.map((p: any) => p.id);
  for (const id of ["aaaaaaaaaaa3", "aaaaaaaaaaa4", "aaaaaaaaaaa5", "aaaaaaaaaaa6", "aaaaaaaaaaa8"]) assert.ok(!ids.includes(id), `${id} is not listed`);
  // Nor can deleting one take a file from anywhere else.
  for (const id of bad) await call("DELETE", `/images/${id}`);
  assert.equal(existsSync(outside), true);
  assert.equal(existsSync(path.join(media.data, "outside2.png")), true);
  assert.equal(existsSync(path.join(folder, "notes", "secret.png")), true);
});

test("the gallery is paged newest first, filtered by where a picture is from and how it was made, and counted", async () => {
  // As many as it takes to want more than a page, spread over time as pictures are.
  const folder = chat("chat-5", "Many");
  const make = (n: number) => {
    for (let i = 0; i < n; i++) gallery.addPagePicture({ bytes: png(`p${i}`), ext: "png", kind: i % 5 === 0 ? "edited" : "generated", prompt: `picture ${i}`, params: {} });
  };
  getDb().prepare("DELETE FROM images").run();
  make(120);
  const missing = gallery.addPagePicture({ bytes: PNG, ext: "png", kind: "generated", prompt: "x", params: {} });
  rmSync(path.join(dir, `${missing.id}.png`));
  mkdirSync(path.join(folder, GENERATED_DIR), { recursive: true });
  for (let i = 0; i < 3; i++) {
    writeFileSync(path.join(folder, GENERATED_DIR, `c${i}.png`), png(`c${i}`));
    gallery.recordChatPicture({ sessionId: "chat-5", path: `${GENERATED_DIR}/c${i}.png`, kind: i === 0 ? "edited" : "generated", prompt: `chat ${i}`, params: {}, bytes: 70 });
  }
  const ids = (getDb().prepare("SELECT id FROM images ORDER BY rowid").all() as { id: string }[]).map((r) => r.id);
  ids.forEach((id, i) => getDb().prepare("UPDATE images SET created_at = ? WHERE id = ?").run(1_000_000 + Math.floor(i / 2), id));

  const first = await listed();
  assert.equal(first.pictures.length, 48, "a page of the default size, not all of them");
  assert.equal(first.total, 123, "the one whose file is gone is not counted: the first look drops it");
  assert.ok(first.pageBytes > 0);
  const seen = new Set<string>(first.pictures.map((p: any) => p.id));
  let page = first;
  let pages = 1;
  while (page.next) {
    page = await listed(`?before=${page.next}`);
    pages++;
    for (const p of page.pictures) assert.ok(!seen.has(p.id), "no picture twice");
    for (const p of page.pictures) seen.add(p.id);
  }
  assert.equal(pages, 3);
  assert.equal(seen.size, 123, "every picture once");
  const order = (await listed("?limit=100")).pictures.map((p: any) => p.createdAt);
  assert.deepEqual(order, [...order].sort((a, b) => b - a), "newest first");
  assert.equal((await listed("?limit=100")).next !== null, true);

  const mine = await listed("?origin=chat");
  assert.equal(mine.total, 3);
  assert.deepEqual(mine.pictures.map((p: any) => p.chat.title), ["Many", "Many", "Many"]);
  assert.equal((await listed("?origin=page")).total, 120);
  const edited = await listed("?kind=edited&limit=100");
  assert.equal(edited.total, 25);
  assert.ok(edited.pictures.every((p: any) => p.kind === "edited"));
  const both = await listed("?origin=chat&kind=edited");
  assert.equal(both.total, 1);
  assert.equal(both.pictures[0].prompt, "chat 0");
  assert.equal((await listed("?kind=uploaded")).total, 0);
  for (const bad of ["?origin=other", "?kind=nice", "?limit=0", "?limit=101", "?limit=x", "?before=not-a-cursor", "?ids=zzz"]) {
    assert.equal((await call("GET", `/images${bad}`)).status, 400, bad);
  }
  // Only the page that is asked for is made of rows; the pictures of the others are not touched.
  assert.equal((await listed("?limit=1")).pictures.length, 1);
});

test("a picture whose file is gone is dropped when the page looks, and the pictures of a chat go with it, the files staying", async () => {
  getDb().prepare("DELETE FROM images").run();
  const { origin, server } = await answering();
  try {
    settings({ baseUrl: origin, editEnabled: true });
    const first = gallery.addPagePicture({ bytes: png("a"), ext: "png", kind: "generated", prompt: "a", params: {} });
    const second = gallery.addPagePicture({ bytes: png("b"), ext: "png", kind: "edited", prompt: "b", params: { sources: [first.id] }, sourceId: first.id });
    assert.equal((await listed()).total, 2);
    rmSync(path.join(dir, `${first.id}.png`));
    const after = await listed();
    assert.deepEqual(after.pictures.map((p: any) => p.id), [second.id]);
    assert.equal(after.total, 1);
    assert.equal(after.pictures[0].from, null, "the edit no longer points at what is not there");

    const folder = chat("chat-6", "Going");
    const made = await media.tools("chat-6").generate_image.execute("id", { prompt: "stays" });
    assert.equal((await listed("?origin=chat")).total, 1);
    media.deleteChat("chat-6");
    assert.equal((await listed("?origin=chat")).total, 0, "the chat is gone, and so are its places in the gallery");
    assert.equal(existsSync(path.join(folder, made.details.files[0].path)), true, "its folder is not the chat's to take away");

    // A folder that cannot be reached for the moment is not a file that is gone.
    const away = chat("chat-7", "Away");
    await media.tools("chat-7").generate_image.execute("id", { prompt: "kept" });
    const moved = `${away}-moved`;
    renameSync(away, moved);
    assert.equal((await listed("?origin=chat")).total, 1, "kept, to be shown when the folder is back");
    renameSync(moved, away);
    assert.equal((await listed("?origin=chat")).total, 1);
    rmSync(path.join(away, GENERATED_DIR), { recursive: true });
    assert.equal((await listed("?origin=chat")).total, 0, "its file was taken from the folder: it is gone from the gallery");
  } finally {
    server.close();
    gone();
  }
});

test("the page's own requests do not drop a chat's pictures while its folder cannot be reached, and a delete does not say it is done", async () => {
  getDb().prepare("DELETE FROM images").run();
  const { origin, server } = await answering();
  try {
    settings({ baseUrl: origin });
    const away = chat("chat-8", "Offline drive");
    const made = await media.tools("chat-8").generate_image.execute("id", { prompt: "stays" });
    const id = (await listed("?origin=chat")).pictures[0].id;
    const moved = `${away}-moved`;
    renameSync(away, moved);
    // What every tile of the grid asks for: not found for the moment, and not a reason to forget it.
    assert.equal((await call("GET", `/images/${id}/file`)).status, 404);
    // A delete cannot reach the file, so it does not say the file is gone.
    assert.equal((await call("DELETE", `/images/${id}`)).status, 404);
    const several = await call("POST", "/images/delete", { ids: [id] });
    assert.deepEqual(several.body.deleted, []);
    assert.deepEqual(several.body.failed.map((f: any) => f.id), [id]);
    assert.equal((await listed("?origin=chat")).total, 1, "still listed");
    renameSync(moved, away);
    assert.equal((await listed("?origin=chat")).total, 1, "and still, with the folder back");
    assert.equal((await call("GET", `/images/${id}/file`)).status, 200, "shown again");
    assert.equal(existsSync(path.join(away, made.details.files[0].path)), true);
    // A file that is gone from a folder that is there is dropped by a request for it.
    rmSync(path.join(away, made.details.files[0].path));
    assert.equal((await call("GET", `/images/${id}/file`)).status, 404);
    assert.equal((await listed("?origin=chat")).total, 0);
    // A chat that is gone: a delete has nothing left to remove.
    getDb().prepare("INSERT INTO images (id, origin, session_id, path, kind, prompt, params, source_id, bytes, created_at) VALUES (?, 'chat', ?, ?, 'generated', 'orphan', '{}', NULL, 1, ?)").run("0000000000aa", "no-such-chat", `${GENERATED_DIR}/x.png`, Date.now());
    assert.equal((await call("DELETE", "/images/0000000000aa")).status, 200);
    assert.equal((await listed("?origin=chat")).total, 0);
  } finally {
    server.close();
    gone();
  }
});

test("a file name that comes back in a chat is a new picture, with its own words, time and links", async () => {
  getDb().prepare("DELETE FROM images").run();
  const folder = chat("chat-9", "Retries");
  mkdirSync(path.join(folder, GENERATED_DIR), { recursive: true });
  const write = (name: string, tag: string) => writeFileSync(path.join(folder, GENERATED_DIR, name), png(tag));
  const record = (over: Partial<Parameters<typeof gallery.recordChatPicture>[0]>) =>
    gallery.recordChatPicture({ sessionId: "chat-9", path: `${GENERATED_DIR}/x-edited.png`, kind: "edited", prompt: "", params: {}, bytes: 70, ...over });
  write("x.png", "x");
  record({ path: `${GENERATED_DIR}/x.png`, kind: "generated", prompt: "the original" });
  write("x-edited.png", "1");
  record({ prompt: "old edit", from: [`${GENERATED_DIR}/x.png`] });
  write("x-edited-edited.png", "2");
  record({ path: `${GENERATED_DIR}/x-edited-edited.png`, prompt: "edit of the old edit", from: [`${GENERATED_DIR}/x-edited.png`] });
  const old = (await listed("?origin=chat")).pictures.find((p: any) => p.prompt === "old edit");
  assert.ok(old);

  // The file was taken away by something that did not tell the list, and an edit of the original makes the name again.
  rmSync(path.join(folder, GENERATED_DIR, "x-edited.png"));
  write("x-edited.png", "3");
  record({ prompt: "new edit", from: [`${GENERATED_DIR}/x.png`], params: { model: "m2" } });
  const all = (await listed("?origin=chat")).pictures;
  const mine = all.filter((p: any) => p.fileName === "x-edited.png");
  assert.equal(mine.length, 1, "one picture for the name");
  assert.equal(mine[0].prompt, "new edit");
  assert.equal(mine[0].params.model, "m2");
  assert.notEqual(mine[0].id, old.id);
  assert.equal(all.some((p: any) => p.id === old.id), false);
  assert.equal(mine[0].from, all.find((p: any) => p.prompt === "the original").id);
  // What was made of the old one is not made of this.
  assert.equal(all.find((p: any) => p.prompt === "edit of the old edit").from, null);
  assert.ok(mine[0].createdAt >= old.createdAt, "it is as new as it is, not as old as the first");
});

test("chats in one folder share its files: a name that comes back replaces the other chat's old row too, and a picture of one is the other's original", async () => {
  getDb().prepare("DELETE FROM images").run();
  const folder = chat("chat-10", "Chat A");
  media.chat("chat-11", folder, "Chat B");
  const elsewhere = chat("chat-12", "Chat C in another folder");
  mkdirSync(path.join(folder, GENERATED_DIR), { recursive: true });
  const file = `${GENERATED_DIR}/photo-edited.png`;
  const write = (tag: string) => writeFileSync(path.join(folder, file), png(tag));
  const record = (sessionId: string, prompt: string, over: Partial<Parameters<typeof gallery.recordChatPicture>[0]> = {}) =>
    gallery.recordChatPicture({ sessionId, path: file, kind: "edited", prompt, params: {}, bytes: 70, ...over });
  const mine = async () => (await listed("?origin=chat")).pictures.filter((p: any) => p.fileName === "photo-edited.png");

  // Chat A's picture, whose file the person then takes away; chat B makes the name again.
  write("a");
  record("chat-10", "A: make it red");
  rmSync(path.join(folder, file));
  write("b");
  record("chat-11", "B: make it blue");
  const both = await mine();
  assert.equal(both.length, 1, "one file, one picture");
  assert.equal(both[0].prompt, "B: make it blue");
  assert.equal(both[0].chat.title, "Chat B");
  // Deleting it is deleting chat B's file, and that is what the entry says it is.
  assert.equal((await call("DELETE", `/images/${both[0].id}`)).status, 200);
  assert.equal(existsSync(path.join(folder, file)), false);
  assert.equal((await mine()).length, 0);

  // A chat in another folder with the same name is another file, and keeps its row.
  mkdirSync(path.join(elsewhere, GENERATED_DIR), { recursive: true });
  writeFileSync(path.join(elsewhere, file), png("c"));
  record("chat-12", "C: elsewhere");
  write("d");
  record("chat-10", "A again");
  const rows = await mine();
  assert.deepEqual(rows.map((p: any) => p.prompt).sort(), ["A again", "C: elsewhere"]);

  // What chat B edits that chat A made in the shared folder is linked to it.
  writeFileSync(path.join(folder, GENERATED_DIR, "base.png"), png("e"));
  record("chat-10", "the base", { path: `${GENERATED_DIR}/base.png`, kind: "generated" });
  writeFileSync(path.join(folder, GENERATED_DIR, "base-edited.png"), png("f"));
  record("chat-11", "B edits A's", { path: `${GENERATED_DIR}/base-edited.png`, from: [`${GENERATED_DIR}/base.png`] });
  const all = (await listed("?origin=chat")).pictures;
  const base = all.find((p: any) => p.prompt === "the base");
  const edit = all.find((p: any) => p.prompt === "B edits A's");
  assert.equal(edit.from, base.id);
  assert.deepEqual(edit.params.sources, [base.id]);
});

test("deleting a project takes the pictures of every chat that worked in it from the gallery, routine runs too, and no more", async () => {
  getDb().prepare("DELETE FROM images").run();
  const root = mkdtempSync(path.join(temp, "root-"));
  const project = path.join(root, "site");
  const sibling = path.join(root, "site-old");
  for (const dir of [project, sibling]) mkdirSync(path.join(dir, GENERATED_DIR), { recursive: true });
  media.chat("run-1", project, "A run", "routine");
  media.chat("chat-p", project, "In the project");
  media.chat("chat-s", sibling, "In its neighbour");
  for (const [id, dir] of [["run-1", project], ["chat-p", project], ["chat-s", sibling]]) {
    writeFileSync(path.join(dir, GENERATED_DIR, `${id}.png`), png(id));
    gallery.recordChatPicture({ sessionId: id, path: `${GENERATED_DIR}/${id}.png`, kind: "generated", prompt: id, params: {}, bytes: 70 });
  }
  assert.equal((await listed("?origin=chat")).total, 3);
  // The folder goes, as the portal removes a project's: the run's session stays, as the record of what it did.
  rmSync(project, { recursive: true });
  assert.equal((await listed("?origin=chat")).total, 3, "a folder that cannot be reached is kept, since it may be a drive that is not mounted");
  media.folderRemoved(project);
  const left = (await listed("?origin=chat")).pictures;
  assert.deepEqual(left.map((p: any) => p.prompt), ["chat-s"], "the neighbour whose name starts the same is another folder");
});

test("the pictures of a deleted chat whose folder cannot be reached leave the gallery, and what was made of them no longer names them", async () => {
  getDb().prepare("DELETE FROM images").run();
  const folder = chat("chat-13", "Going");
  mkdirSync(path.join(folder, GENERATED_DIR), { recursive: true });
  writeFileSync(path.join(folder, GENERATED_DIR, "a.png"), png("a"));
  gallery.recordChatPicture({ sessionId: "chat-13", path: `${GENERATED_DIR}/a.png`, kind: "generated", prompt: "original", params: {}, bytes: 70 });
  const original = (await listed("?origin=chat")).pictures[0];
  const edited = gallery.addPagePicture({ bytes: png("b"), ext: "png", kind: "edited", prompt: "edit", params: { sources: [original.id] }, sourceId: original.id });
  assert.equal((await listed(`?ids=${edited.id}`)).pictures[0].from, original.id);
  // There is no folder to find them in, so there is nothing to keep them for.
  renameSync(folder, `${folder}-away`);
  media.deleteChat("chat-13");
  assert.equal((await listed(`?ids=${edited.id}`)).pictures[0].from, null, "no link to what is not in the list");
});

test("the sidebar is told whether the page is there: on while an address is set and the add-on is on", async () => {
  gone();
  gen.saveImageGeneration({ baseUrl: "https://images.example.com/v1" });
  assert.deepEqual((await call("GET", "/state")).body.images, { enabled: false });
  gen.saveImageGeneration({ enabled: true });
  assert.deepEqual((await call("GET", "/state")).body.images, { enabled: true });
  gone();
  // Changing pictures is set up apart from making them, and the page is there for either: the agent's changes are kept in it, and the server edits.
  gen.saveImageGeneration({ baseUrl: "", editEnabled: true, editBaseUrl: "https://edits.example.com/v1" });
  assert.deepEqual((await call("GET", "/state")).body.images, { enabled: true }, "only changing is set up");
  const state = (await call("GET", "/settings/images")).body.images;
  assert.equal(state.enabled, false);
  assert.equal(state.ready, false, "nothing to make pictures with: only changing is set up");
  assert.equal(state.editReady, true);
  gen.saveImageGeneration({ editEnabled: false });
  assert.deepEqual((await call("GET", "/state")).body.images, { enabled: false }, "an address for changes that is switched off is not a page");
  gone();
});


// Pictures with real pixels: Media decodes them to make the small copy. Random pixels do not compress, so these are well over the 48 KB below which no copy is made.
const { default: sharp } = await import("sharp");
const { randomBytes } = await import("node:crypto");
const { thumbJobsPeak } = await import("../src/server/image-thumbs.ts");
const noise = (width: number, height: number, channels: 3 | 4 = 3) => sharp(randomBytes(width * height * channels), { raw: { width, height, channels } });
const bigPng = (width: number, height: number) => noise(width, height).png().toBuffer();
const meta = (bytes: Buffer) => sharp(bytes).metadata();
const thumbs = path.join(media.data, "image-thumbs");
const kept = () => (existsSync(thumbs) ? readdirSync(thumbs) : []);
const upload = async (raw: Buffer, name = "p.png") => (await call("POST", `/images/upload?name=${name}`, undefined, { raw })).body.picture;
/** A picture in a chat's folder, which the agent may write over. */
async function inChat(id: string, name: string, bytes: Buffer) {
  const folder = chat(id);
  const file = path.join(folder, GENERATED_DIR, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  gallery.recordChatPicture({ sessionId: id, path: `${GENERATED_DIR}/${name}`, kind: "generated", prompt: id, params: {}, bytes: bytes.length });
  const picture = (await listed("?origin=chat")).pictures.find((p: any) => p.chat?.id === id);
  return { folder, file, picture };
}
const writeOver = (file: string, bytes: Buffer, minutesLater = 1) => {
  writeFileSync(file, bytes);
  const later = new Date(Date.now() + minutesLater * 60_000);
  utimesSync(file, later, later);
};

test("Media makes the small copy of a big picture itself: WebP, at most 480 pixels on the long side, the picture's proportions", async () => {
  const wide = await bigPng(1200, 800);
  const picture = await upload(wide);
  assert.equal(picture.thumb, true, "the gallery says the tile shows a small copy");
  assert.deepEqual(kept(), [], "none is made before it is asked for");
  const got = await call("GET", `/images/${picture.id}/thumb`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("content-type"), "image/webp");
  assert.equal(got.headers.get("cache-control"), "private, max-age=86400");
  assert.equal(got.headers.get("x-content-type-options"), "nosniff");
  const info = await meta(got.bytes);
  assert.equal(info.format, "webp");
  assert.deepEqual([info.width, info.height], [480, 320]);
  assert.ok(got.bytes.length < wide.length / 5, `${got.bytes.length} bytes is far below the file's ${wide.length}`);
  assert.deepEqual((await call("GET", `/images/${picture.id}/file`)).bytes, wide, "the file itself is as it was");
  assert.equal(kept().length, 1);

  const tall = await upload(await bigPng(600, 1500));
  const info2 = await meta((await call("GET", `/images/${tall.id}/thumb`)).bytes);
  assert.deepEqual([info2.width, info2.height], [192, 480], "the long side is the height");
  const small = await upload(await bigPng(300, 200));
  assert.ok(small.bytes > 48 * 1024, "heavy for its size, so it gets a copy");
  const info3 = await meta((await call("GET", `/images/${small.id}/thumb`)).bytes);
  assert.deepEqual([info3.width, info3.height], [300, 200], "a picture below 480 is not made larger");
  await call("POST", "/images/delete", { ids: [picture.id, tall.id, small.id] });
  assert.deepEqual(kept(), []);
});

test("the small copy keeps transparency, and turns a picture the way its camera said", async () => {
  const pixels = randomBytes(800 * 600 * 4);
  // The left half is see-through, the right one is not.
  for (let y = 0; y < 600; y++) for (let x = 0; x < 800; x++) pixels[(y * 800 + x) * 4 + 3] = x < 400 ? 0 : 255;
  const see = await upload(await sharp(pixels, { raw: { width: 800, height: 600, channels: 4 } }).png().toBuffer());
  const got = await call("GET", `/images/${see.id}/thumb`);
  assert.equal(got.headers.get("content-type"), "image/webp");
  const raw = await sharp(got.bytes).raw().toBuffer({ resolveWithObject: true });
  assert.equal(raw.info.channels, 4, "it has an alpha channel");
  const alpha = (x: number, y: number) => raw.data[(y * raw.info.width + x) * 4 + 3];
  assert.equal(alpha(20, 100), 0, "the left side is still see-through");
  assert.equal(alpha(raw.info.width - 20, 100), 255, "and the right side is not");

  // A photo taken with the phone on its side says so in its metadata, which the copy does not keep.
  const turned = await upload(await noise(1000, 600).jpeg({ quality: 95 }).withMetadata({ orientation: 6 }).toBuffer(), "turned.jpg");
  const info = await meta((await call("GET", `/images/${turned.id}/thumb`)).bytes);
  assert.deepEqual([info.width, info.height], [288, 480], "it stands up, as the viewer shows it");
  await call("POST", "/images/delete", { ids: [see.id, turned.id] });
});

test("a small file, a GIF, an animated picture and one that cannot be read are sent whole, and get no copy", async () => {
  const tiny = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#c33" } }).png().toBuffer();
  assert.ok(tiny.length < 48 * 1024);
  const little = await upload(tiny);
  assert.equal(little.thumb, false, "the gallery says the tile shows the file");
  const gotLittle = await call("GET", `/images/${little.id}/thumb`);
  assert.equal(gotLittle.status, 200);
  assert.deepEqual(gotLittle.bytes, tiny);

  const gifBytes = await noise(400, 300).gif().toBuffer();
  assert.ok(gifBytes.length > 48 * 1024);
  const gif = await upload(gifBytes, "move.gif");
  assert.equal(gif.thumb, false);
  const gotGif = await call("GET", `/images/${gif.id}/thumb`);
  assert.equal(gotGif.headers.get("content-type"), "image/gif");
  assert.deepEqual(gotGif.bytes, gifBytes, "a copy would stand still");

  // An animated WebP, which the gallery cannot tell by its name.
  const frames = Buffer.concat([randomBytes(400 * 300 * 3), randomBytes(400 * 300 * 3)]);
  const moving = await sharp(frames, { raw: { width: 400, height: 600, channels: 3, pageHeight: 300 } }).webp({ quality: 90 }).toBuffer();
  assert.equal((await meta(moving)).pages, 2);
  const animated = await upload(moving, "move.webp");
  assert.deepEqual((await call("GET", `/images/${animated.id}/thumb`)).bytes, moving);

  // A header that is a PNG's and nothing after it.
  const broken = Buffer.concat([PNG.subarray(0, 8), randomBytes(100 * 1024)]);
  const bad = await upload(broken);
  const gotBad = await call("GET", `/images/${bad.id}/thumb`);
  assert.equal(gotBad.status, 200);
  assert.deepEqual(gotBad.bytes, broken, "what cannot be drawn small is shown as it is");
  assert.deepEqual(kept(), [], "none of them has a copy");
  await call("POST", "/images/delete", { ids: [little.id, gif.id, animated.id, bad.id] });
});

test("a copy is made once, kept, and sent from then on", async () => {
  const picture = await upload(await bigPng(900, 900));
  const [first, second, third] = await Promise.all([1, 2, 3].map(() => call("GET", `/images/${picture.id}/thumb`)));
  assert.deepEqual(second.bytes, first.bytes);
  assert.deepEqual(third.bytes, first.bytes);
  assert.equal(kept().length, 1, "asked for three times at once, made once");

  // Put back in time: a copy that is made again would have the time of now.
  const [name] = kept();
  // A whole second: utimes turns a time with milliseconds into a fraction of seconds that Node 22 (on CI) hands
  // to the file system a millisecond short about half the time, and the time written is not the one asserted below.
  const long = new Date(Math.floor(Date.now() / 1000) * 1000 - 3_600_000);
  utimesSync(path.join(thumbs, name), long, long);
  const again = await call("GET", `/images/${picture.id}/thumb`);
  assert.deepEqual(again.bytes, first.bytes);
  assert.equal(statSync(path.join(thumbs, name)).mtimeMs, long.getTime(), "the copy that was kept is the one that was sent");
  // The browser that has it is told so.
  const tag = again.headers.get("etag")!;
  assert.ok(tag);
  // (not through fetch, which adds a no-cache of its own to a request that asks with a tag)
  const status = await new Promise<number>((resolve) => get(`${at}/images/${picture.id}/thumb`, { headers: { "if-none-match": tag } }, (res) => { res.resume(); resolve(res.statusCode!); }));
  assert.equal(status, 304);
  await call("DELETE", `/images/${picture.id}`);
});

test("a file that is written over gets a new copy, and the old one goes", async () => {
  const one = await bigPng(1000, 500);
  const { file, picture } = await inChat("chat-thumb-over", "owl.png", one);
  const before = await call("GET", `/images/${picture.id}/thumb`);
  assert.equal(before.headers.get("cache-control"), "private, no-cache", "the folder's, not the page's: the browser asks");
  assert.deepEqual([(await meta(before.bytes)).width, (await meta(before.bytes)).height], [480, 240]);
  const [oldName] = kept();

  // The agent made another picture under the same name.
  writeOver(file, await bigPng(500, 1000));
  const after = await call("GET", `/images/${picture.id}/thumb`);
  assert.equal(after.status, 200);
  assert.deepEqual([(await meta(after.bytes)).width, (await meta(after.bytes)).height], [240, 480], "it is of the new picture");
  assert.notEqual(after.headers.get("etag"), before.headers.get("etag"));
  assert.equal(kept().length, 1, "and the copy of the old one is not kept");
  assert.notEqual(kept()[0], oldName);

  // The same bytes with another time are another file: its copy is made again.
  const [middleName] = kept();
  const later = new Date(Date.now() + 120_000);
  utimesSync(file, later, later);
  assert.equal((await call("GET", `/images/${picture.id}/thumb`)).status, 200);
  assert.equal(kept().length, 1);
  assert.notEqual(kept()[0], middleName, "the time alone makes it a new copy");

  // The same time with another size, as a file system that keeps only seconds would give.
  const stamp = statSync(file).mtime;
  writeFileSync(file, await bigPng(700, 700));
  utimesSync(file, stamp, stamp);
  const sized = await call("GET", `/images/${picture.id}/thumb`);
  assert.deepEqual([(await meta(sized.bytes)).width, (await meta(sized.bytes)).height], [480, 480]);
  await call("DELETE", `/images/${picture.id}`);
});

test("a copy is only sent for a picture whose file can be read in full", async () => {
  const { folder, file, picture } = await inChat("chat-thumb-away", "bat.png", await bigPng(800, 800));
  assert.equal((await call("GET", `/images/${picture.id}/thumb`)).status, 200);
  assert.equal(kept().length, 1);
  const moved = `${folder}-moved`;
  renameSync(folder, moved);
  assert.equal((await call("GET", `/images/${picture.id}/thumb`)).status, 404, "the copy is not a way round: a folder that cannot be reached shows nothing of its pictures");
  renameSync(moved, folder);
  assert.equal((await call("GET", `/images/${picture.id}/thumb`)).status, 200);

  // The file has become a link out of the folder: not a picture of this gallery any more, and not made small either.
  const outside = path.join(temp, "outside.png");
  writeFileSync(outside, await bigPng(900, 900));
  rmSync(file);
  symlinkSync(outside, file);
  const linked = await call("GET", `/images/${picture.id}/thumb`);
  assert.notEqual(linked.status, 200);
  assert.equal((await call("GET", `/images/${picture.id}/file`)).status, linked.status, "the same answer as for the file");
  assert.equal((await call("GET", "/images/ffffffffffff/thumb")).status, 404);
  assert.equal((await call("GET", "/images/..%2F..%2Fx/thumb")).status, 404);

  // The file is something that is no picture.
  const second = await inChat("chat-thumb-svg", "x.png", await bigPng(800, 800));
  writeOver(second.file, Buffer.concat([SVG, Buffer.alloc(60 * 1024)]));
  const before = kept().length;
  assert.notEqual((await call("GET", `/images/${second.picture.id}/thumb`)).status, 200);
  assert.equal(kept().length, before, "nothing was made of it");
  await call("POST", "/images/delete", { ids: [picture.id, second.picture.id] });
});

test("the small copies go with their pictures, however the pictures go", async () => {
  getDb().prepare("DELETE FROM images").run();
  const page = await upload(await bigPng(700, 700));
  assert.equal((await call("GET", `/images/${page.id}/thumb`)).status, 200);
  assert.equal((await call("DELETE", `/images/${page.id}`)).status, 200);
  assert.deepEqual(kept(), [], "deleted in the gallery");

  const { folder, picture } = await inChat("chat-thumb-gone", "a.png", await bigPng(700, 700));
  assert.equal((await call("GET", `/images/${picture.id}/thumb`)).status, 200);
  assert.equal(kept().length, 1);
  renameSync(folder, `${folder}-away`);
  media.deleteChat("chat-thumb-gone");
  assert.equal((await listed("?origin=chat")).total, 0);
  assert.deepEqual(kept(), [], "the chat is deleted and its folder cannot be reached: nothing lists the copy any more, so it has to go with the row");

  const gonePicture = await inChat("chat-thumb-file-gone", "b.png", await bigPng(700, 700));
  assert.equal((await call("GET", `/images/${gonePicture.picture.id}/thumb`)).status, 200);
  rmSync(gonePicture.file);
  assert.equal((await call("GET", `/images/${gonePicture.picture.id}/thumb`)).status, 404, "its file is gone");
  assert.deepEqual(kept(), [], "and so the copy is, as the row is forgotten");
});

test("only a few small copies are made at the same time", async () => {
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) ids.push((await upload(await bigPng(1600, 1200))).id);
  const all = await Promise.all(ids.map((id) => call("GET", `/images/${id}/thumb`)));
  assert.ok(all.every((r) => r.status === 200 && r.headers.get("content-type") === "image/webp"));
  assert.equal(kept().length, 8);
  assert.ok(thumbJobsPeak() >= 1 && thumbJobsPeak() <= 2, `at most 2 at once, saw ${thumbJobsPeak()}`);
  await call("POST", "/images/delete", { ids });
});

/** Open file descriptors of this process that lead into the folder of the small copies (Linux only: nothing is seen elsewhere). */
const openCopies = () => {
  try {
    return readdirSync("/proc/self/fd").filter((fd) => { try { return readlinkSync(`/proc/self/fd/${fd}`).startsWith(thumbs); } catch { return false; } }).length;
  } catch {
    return 0;
  }
};
const settle = async (done: () => boolean) => {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
};

test("a request that is dropped while it waits for its small copy does not keep the copy open", { skip: !existsSync("/proc/self/fd") }, async () => {
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) ids.push((await upload(await bigPng(2000, 1500))).id);
  await Promise.all(ids.map((id) => new Promise<void>((resolve) => {
    const request = get(`${at}/images/${id}/thumb`, (res) => res.resume());
    request.on("error", () => resolve());
    request.on("close", () => resolve());
    setTimeout(() => request.destroy(), 30);
  })));
  // The copies are made all the same, for the next view.
  await settle(() => kept().length === 8 && thumbJobsPeak() >= 1);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(kept().length, 8);
  assert.equal(openCopies(), 0, "no copy is left open by a request that was gone before it was answered");
  await call("POST", "/images/delete", { ids });
});

test("a copy that is still being made when its picture is deleted is not kept", async () => {
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) ids.push((await upload(await bigPng(1600, 1200))).id);
  const asked = Promise.all(ids.map((id) => call("GET", `/images/${id}/thumb`)));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const deleted = await call("POST", "/images/delete", { ids });
  assert.equal(deleted.body.deleted.length, 8);
  await asked;
  assert.deepEqual(kept(), [], "the pictures are gone, and so are the copies that were not done yet");
});
