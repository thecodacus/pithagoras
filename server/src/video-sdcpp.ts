import { readBody, sendRequest, without } from "./image-generation.js";
import { decodeBase64 } from "./prompt-images.js";
import { MAX_VIDEO_BYTES, VIDEO_HEAD, ebmlDocType, videoType } from "./video-files.js";
import { VIDEO_TIMEOUT_SECONDS, framesFor } from "./video-settings.js";
import { VideoGenerationError, type MadeVideo, type VideoBackend, type VideoGenerationConfig, type VideoRequest, type VideoRun } from "./video-types.js";

/**
 * Clips from stable-diffusion.cpp's server, through its native API (`/sdcpp/v1`,
 * documented in the server's api.md): a video request is a job. The portal
 * submits it (`POST vid_gen`), asks how it is doing until it has finished
 * (`GET jobs/{id}`), and takes the clip out of the answer, which holds the whole
 * file as base64. The server makes one clip at a time and queues the others, so
 * a request may wait for its turn, and says which place it has.
 *
 * The address is the server's own, such as http://host:1234: one with the
 * OpenAI-style `/v1` the same server answers pictures under is taken as it is,
 * so that the address of the image endpoint can be given again here.
 *
 * What the portal asks for is a WebM, which every browser plays: the server
 * makes it only when it was built with WebM support, which it says in its
 * capabilities, and an AVI or an animated WebP, which it can make too, is not
 * something a page can play.
 */

/** Said of a clip's frame rate when the caller thinks in seconds and neither the request, the settings nor the server say one: what most video models are made for. */
const FALLBACK_FPS = 16;
/** How long the portal waits between two questions of how a job is doing: short at first, so that a short clip is not waited for. */
const POLL_MS = [1000, 1500, 2000, 3000];
/** Questions in a row that may fail before the clip is given up: a blip of the network is not the job's end. */
const MAX_MISSES = 3;
/** What is read of an answer that is not a finished clip. */
const SMALL_ANSWER = 1024 * 1024;

const fail = (message: string): Error => new VideoGenerationError(message);

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** The server's own address: the one given, without the `/v1` or `/sdcpp/v1` that routes are put after. */
export function sdcppRoot(baseUrl: string): URL {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/sdcpp\/v1$/, "").replace(/\/v1$/, "");
  return url;
}

const route = (root: URL, name: string): URL => {
  const url = new URL(root);
  url.pathname = `${root.pathname.replace(/\/+$/, "")}/sdcpp/v1/${name}`;
  return url;
};

/** What the server says went wrong, in its own words: it answers `{"error": "…"}`, and sometimes a `message` beside it. */
function said(json: any): string {
  const error = text(json?.error?.message) || text(json?.error);
  const message = text(json?.message);
  return [error, message && message !== error ? message : ""].filter(Boolean).join(": ");
}

/** The body of a request for a clip, in the native API's own names. */
function bodyOf(config: VideoGenerationConfig, request: VideoRequest, serverFps: number | undefined): Record<string, unknown> {
  const size = request.size || config.size;
  const sides = /^(\d+)x(\d+)$/.exec(size);
  const model = request.model || config.model;
  // A length in seconds needs a frame rate to be frames: the request's, the settings', the server's own, and one that is made for most models.
  const fps = request.fps ?? config.fps ?? (request.seconds !== undefined ? (serverFps ?? FALLBACK_FPS) : undefined);
  const frames = request.frames ?? (request.seconds !== undefined && fps !== undefined ? framesFor(request.seconds, fps) : (config.frames ?? undefined));
  return {
    prompt: request.prompt,
    // The server runs the one model it was started with and ignores this; a gateway in front of it may route by it.
    ...(model ? { model } : {}),
    ...(request.negativePrompt ? { negative_prompt: request.negativePrompt } : {}),
    ...(sides ? { width: Number(sides[1]), height: Number(sides[2]) } : {}),
    ...(frames !== undefined ? { video_frames: frames } : {}),
    ...(fps !== undefined ? { fps } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(request.sampleSteps !== undefined ? { sample_params: { sample_steps: request.sampleSteps } } : {}),
    ...(request.firstFrame ? { init_image: `data:${request.firstFrame.mimeType};base64,${request.firstFrame.bytes.toString("base64")}` } : {}),
    output_format: "webm",
  };
}

/** Waits, and is cut short by the signal, which then says why. */
const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

async function generate(config: VideoGenerationConfig, request: VideoRequest, run: VideoRun): Promise<MadeVideo> {
  const timeoutMs = run.timeoutMs ?? VIDEO_TIMEOUT_SECONDS.default * 1000;
  const max = run.maxBytes ?? MAX_VIDEO_BYTES;
  const key = config.apiKey;
  const root = sdcppRoot(config.baseUrl);
  const signal = AbortSignal.any([...(run.signal ? [run.signal] : []), AbortSignal.timeout(timeoutMs)]);
  // What a finished clip comes in is the whole file as base64, in JSON; every answer is read up to that.
  const limit = Math.ceil((max * 4) / 3) + 64 * 1024;

  const call = async (url: URL, method: "GET" | "POST", body?: object): Promise<{ status: number; json: any }> => {
    const bytes = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const res = await sendRequest(url, key, { method, signal, body: bytes, type: bytes ? "application/json" : undefined, what: "video endpoint", fail });
    const answer = await readBody(res, limit, "The video endpoint's answer", fail);
    let json: any;
    try {
      json = JSON.parse(answer.toString("utf8"));
    } catch {
      // Not JSON: the status says what there is to say.
    }
    return { status: res.statusCode ?? 0, json };
  };

  const pause = (turn: number) => run.pollMs ?? POLL_MS[Math.min(turn, POLL_MS.length - 1)];

  let jobId = "";
  const failed = (e: unknown): Error => {
    // The chat or the page stopped it: nobody is told it failed.
    if (run.signal?.aborted) return e as Error;
    if (signal.aborted) {
      return fail(`The video endpoint did not finish the clip within ${Math.round(timeoutMs / 1000)} seconds. Raise the time limit in Settings → Agent → Media if it needs longer.`);
    }
    if (e instanceof VideoGenerationError) return e;
    const why = (e as { code?: string })?.code ?? (e as { cause?: { code?: string } })?.cause?.code ?? (e as Error)?.message ?? "unknown error";
    return fail(without(`Could not reach the video endpoint at ${root.origin} (${why})`, key));
  };

  /** Whether the server is one that makes clips, and the frame rate it makes them at without being told: nothing is assumed of one that does not answer. */
  const capabilities = async (base: URL): Promise<{ fps?: number } | undefined> => {
    try {
      const { status, json } = await call(route(base, "capabilities"), "GET");
      if (status !== 200 || !json || typeof json !== "object") return undefined;
      if (Array.isArray(json.supported_modes) && !json.supported_modes.includes("vid_gen")) {
        throw fail("This stable-diffusion.cpp server has no video model loaded, so it cannot make a clip: start it with a video model");
      }
      const formats = json.output_formats_by_mode?.vid_gen;
      if (Array.isArray(formats) && !formats.includes("webm")) {
        throw fail(`This stable-diffusion.cpp server cannot make a WebM, which is what a browser plays (it makes ${without(formats.join(", "), key).slice(0, 100) || "nothing"}): build it with WebM support`);
      }
      const fps = json.defaults_by_mode?.vid_gen?.fps;
      return { fps: Number.isInteger(fps) && fps > 0 ? fps : undefined };
    } catch (e) {
      if (e instanceof VideoGenerationError || signal.aborted) throw e;
      // Not answering is for the request itself to say, with the reason.
      return undefined;
    }
  };

  try {
    // Asked of the server before anything is sent, so that a server that has no video model, or cannot make a WebM, is said so in plain words.
    const caps = await capabilities(root);
    const submitted = await call(route(root, "vid_gen"), "POST", bodyOf(config, request, caps?.fps));
    if (submitted.status !== 202 && submitted.status !== 200) {
      // In the server's words, with the key out first (it may repeat it) and then the cut: every answer of its that is shown is shown so.
      const why = without(said(submitted.json), key).replace(/\s+/g, " ").slice(0, 300);
      if (submitted.status === 404) throw fail(`The server at ${root.origin} has no video route (${route(root, "vid_gen").pathname}): is it a stable-diffusion.cpp server started with a video model?`);
      if (submitted.status === 429) throw fail(`The video endpoint's queue is full${why ? ` (${why})` : ""}: try again when a clip has finished`);
      throw fail(`The video endpoint answered ${submitted.status}${why ? `: ${why}` : ""}`);
    }
    const id = text(submitted.json?.id);
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw fail("The video endpoint accepted the request, but did not name the job");
    jobId = id;

    let misses = 0;
    for (let turn = 0; ; turn++) {
      let job: { status: number; json: any };
      try {
        job = await call(route(root, `jobs/${id}`), "GET");
      } catch (e) {
        if (signal.aborted || e instanceof VideoGenerationError || ++misses > MAX_MISSES) throw e;
        await sleep(pause(turn), signal);
        continue;
      }
      if (job.status === 404 || job.status === 410) {
        throw fail("The video endpoint no longer has the job: it was restarted, or the clip was not fetched before the server forgot it (a stable-diffusion.cpp server keeps a finished clip for ten minutes)");
      }
      if (job.status < 200 || job.status >= 300) {
        if (++misses > MAX_MISSES) throw fail(`The video endpoint answered ${job.status} when asked how the clip was doing${said(job.json) ? `: ${without(said(job.json), key).slice(0, 300)}` : ""}`);
      } else {
        misses = 0;
        const state = text(job.json?.status);
        if (state === "completed") return finished(job.json?.result, max, job.json, key);
        if (state === "failed") {
          const why = without(said({ error: job.json?.error }), key).replace(/\s+/g, " ").slice(0, 300);
          throw fail(`The video endpoint could not make the clip${why ? `: ${why}` : ""}`);
        }
        if (state === "cancelled") throw fail("The clip was cancelled on the video endpoint");
        if (state === "queued") {
          const place = job.json?.queue_position;
          run.onProgress?.({ stage: "waiting", ...(Number.isInteger(place) && place > 0 ? { queuePosition: place } : {}) });
        } else if (state === "generating") run.onProgress?.({ stage: "making" });
        else throw fail(`The video endpoint reported a state the portal does not know${state ? `: ${state.slice(0, 40)}` : ""}`);
      }
      await sleep(pause(turn), signal);
    }
  } catch (e) {
    // A clip that is waiting in the queue can be taken out of it; one that is being made cannot be stopped on the server, and finishes there.
    if (jobId && (signal.aborted || run.signal?.aborted)) void cancel(root, key, jobId);
    throw failed(e);
  }
}

/** A value the server named, for a message: the key out first (it may repeat it, and a cut would leave a piece of it), printable characters only, and short; nothing is said of one that is not text or a number. */
const named = (v: unknown, key: string, most = 40): string => {
  const flat = without(typeof v === "string" || (typeof v === "number" && Number.isFinite(v)) ? String(v) : "", key).replace(/[^\x20-\x7e]/g, "?").trim();
  return flat.length > most ? `${flat.slice(0, most - 1)}…` : flat;
};

/** The size a job says its clip has: "832x480" as it names it, or its width and height. */
function resolutionOf(result: any, job: any, key: string): string {
  for (const from of [result, job]) {
    const given = from?.resolution;
    if (given && typeof given === "object" && Number.isInteger(given.width) && Number.isInteger(given.height)) return `${given.width}x${given.height}`;
    if (named(given, key)) return named(given, key);
    if (Number.isInteger(from?.width) && Number.isInteger(from?.height)) return `${from.width}x${from.height}`;
  }
  return "";
}

/**
 * What the portal says of a finished job whose file is no WebM or MP4, so that it can be read without the server's log:
 * what the job calls the file (`output_format`, `mime_type`), what the file's first bytes are (and, for an EBML file,
 * the document type it says it is), and how many frames and what size the job says it made. What a field does not say
 * is said not to be given.
 */
function notPlayable(result: any, job: any, head: Buffer, key: string): string {
  const frames = result?.frame_count ?? job?.frame_count;
  const bytes = [...head.subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
  // A file of the Matroska family that a browser does not play as a WebM: what it says it is, as the format has it.
  const ebml = head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3;
  const doc = ebml ? ebmlDocType(head.subarray(0, VIDEO_HEAD)) : undefined;
  const kind = !ebml ? "" : doc !== undefined ? ` (an EBML file of document type ${named(doc, key) || "none"})` : " (an EBML file with no readable document type)";
  return [
    "What the video endpoint sent is not a WebM or MP4 video, which is what a browser plays.",
    `It says output_format ${named(result?.output_format, key, 20) || "not given"}, mime_type ${named(result?.mime_type, key) || "not given"}; the file starts with ${bytes || "nothing"}${kind};`,
    `frame_count ${named(frames, key) || "not given"}, resolution ${resolutionOf(result, job, key) || "not given"}.`,
  ].join(" ");
}

/** The clip in a finished job's result: decoded, and by its first bytes a WebM or an MP4. `job` is the whole answer about the job, which may say more of it than its result. */
function finished(result: any, max: number, job: any, key: string): MadeVideo {
  const encoded = text(result?.b64_json);
  if (!encoded) throw fail("The video endpoint finished the clip, but with no video in its answer");
  const decoded = decodeBase64(encoded, max);
  if ("error" in decoded) throw fail(decoded.error === "invalid" ? "The clip the video endpoint sent is not base64" : `The clip is over ${max / 1024 / 1024} MB`);
  const type = videoType(decoded.bytes.subarray(0, VIDEO_HEAD));
  if (!type) throw fail(notPlayable(result, job, decoded.bytes, key));
  const frames = result?.frame_count;
  const fps = result?.fps;
  return { bytes: decoded.bytes, ext: type.ext, ...(Number.isInteger(frames) && frames > 0 ? { frames } : {}), ...(Number.isInteger(fps) && fps > 0 ? { fps } : {}) };
}

/** Takes a job out of the server's queue when it is still in it. Best effort, with a short time of its own: the portal is done with the job either way. */
async function cancel(root: URL, key: string, id: string): Promise<void> {
  try {
    const signal = AbortSignal.timeout(5000);
    const res = await sendRequest(route(root, `jobs/${id}/cancel`), key, { method: "POST", signal, body: Buffer.alloc(0), what: "video endpoint", fail });
    await readBody(res, SMALL_ANSWER, "The video endpoint's answer", fail);
  } catch {
    // Nothing to do about it: the job runs to its end, or is forgotten by the server.
  }
}

export const sdcppBackend: VideoBackend = { id: "sdcpp", label: "stable-diffusion.cpp", generate };
