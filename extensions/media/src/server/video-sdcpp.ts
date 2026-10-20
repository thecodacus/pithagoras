import { readBody, sendRequest, without } from "./image-generation";
import { decodeBase64 } from "./picture-files";
import { MAX_VIDEO_BYTES, VIDEO_HEAD, sniffVideo } from "./video-files";
import { VIDEO_TIMEOUT_SECONDS, framesFor } from "./video-settings";
import { VideoGenerationError, type MadeVideo, type VideoBackend, type VideoGenerationConfig, type VideoRequest, type VideoRun } from "./video-types";

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
 * capabilities. What it answers with is kept whatever it is (an AVI or an
 * animated WebP, which it can make too, is a file the person can download); the
 * page plays a WebM and an MP4 and offers the rest as a download.
 */

/** Said of a clip's frame rate when the caller thinks in seconds and neither the request, the settings nor the server say one: what most video models are made for. */
const FALLBACK_FPS = 16;
/** How long the portal waits between two questions of how a job is doing: short at first, so that a short clip is not waited for. */
const POLL_MS = [1000, 1500, 2000, 3000];
/** Questions in a row that may fail before the clip is given up: a blip of the network is not the job's end. */
const MAX_MISSES = 3;
/** What is read of an answer that is not a finished clip. */
const SMALL_ANSWER = 1024 * 1024;

/** What the server says of itself that a request depends on: the frame rate it makes clips at, the format to ask for, and whether it takes a last frame. */
interface Capabilities {
  fps?: number;
  format?: string;
  endImage: boolean;
}

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

/** A picture as the native API takes one: a data URL. */
const dataUrl = (picture: { bytes: Buffer; mimeType: string }): string => `data:${picture.mimeType};base64,${picture.bytes.toString("base64")}`;

/**
 * The body of a request for a clip, in the native API's own names. A last frame goes as `end_image` and only when the
 * server's capabilities report it for `vid_gen` (`endImage`): for any other it is refused here, in words, and never dropped,
 * since a clip that ends on something else than the picture asked for is no clip the person wanted.
 */
function bodyOf(config: VideoGenerationConfig, request: VideoRequest, caps: Capabilities | undefined, format: string): Record<string, unknown> {
  if (request.lastFrame && !caps?.endImage) {
    throw fail(
      caps
        ? "This stable-diffusion.cpp server does not take a last frame (its capabilities do not list end_image for video): make the clip without one, or use a stable-diffusion.cpp build that reports it"
        : "The video endpoint did not say whether it takes a last frame (it gave no capabilities listing end_image for video), so none is sent: make the clip without one, or use a stable-diffusion.cpp server that reports it",
    );
  }
  const serverFps = caps?.fps;
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
    ...(request.strength !== undefined ? { strength: request.strength } : {}),
    ...(request.firstFrame ? { init_image: dataUrl(request.firstFrame) } : {}),
    ...(request.lastFrame ? { end_image: dataUrl(request.lastFrame) } : {}),
    output_format: format,
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
      return fail(`The video endpoint did not finish the clip within ${Math.round(timeoutMs / 1000)} seconds. Raise the time limit under Media in Settings if it needs longer.`);
    }
    if (e instanceof VideoGenerationError) return e;
    const why = (e as { code?: string })?.code ?? (e as { cause?: { code?: string } })?.cause?.code ?? (e as Error)?.message ?? "unknown error";
    return fail(without(`Could not reach the video endpoint at ${root.origin} (${why})`, key));
  };

  /**
   * Whether the server is one that makes clips, the frame rate it makes them at without being told, and the format to ask for:
   * a WebM, which every browser plays, where it makes one, else the first it says it makes, which is kept as the file it is.
   * Whether the server takes a last frame is what its features say (`end_image`), and only `true` says it.
   * Nothing is assumed of one that does not answer. With a last frame, a server that cannot be reached, or answers an error, is said so
   * (it is not "did not say"): the person or the agent would drop the picture on that advice, and get a clip that does not end on it.
   */
  const capabilities = async (base: URL): Promise<Capabilities | undefined> => {
    try {
      const { status, json } = await call(route(base, "capabilities"), "GET");
      if (status !== 200 && status !== 404 && request.lastFrame) {
        throw fail(`The video endpoint answered ${status} when asked what it can do, so it is not known whether it takes a last frame: try again when it answers`);
      }
      if (status !== 200 || !json || typeof json !== "object") return undefined;
      if (Array.isArray(json.supported_modes) && !json.supported_modes.includes("vid_gen")) {
        throw fail("This stable-diffusion.cpp server has no video model loaded, so it cannot make a clip: start it with a video model");
      }
      const formats: unknown[] = Array.isArray(json.output_formats_by_mode?.vid_gen) ? json.output_formats_by_mode.vid_gen : [];
      const asked = formats.includes("webm") ? "webm" : formats.find((f): f is string => typeof f === "string" && /^[a-z0-9]{1,10}$/.test(f));
      const fps = json.defaults_by_mode?.vid_gen?.fps;
      return { fps: Number.isInteger(fps) && fps > 0 ? fps : undefined, ...(asked ? { format: asked } : {}), endImage: json.features_by_mode?.vid_gen?.end_image === true };
    } catch (e) {
      if (e instanceof VideoGenerationError || signal.aborted) throw e;
      // Not answering is for the request itself to say, with the reason; with a last frame it is said here, as the request would not be sent.
      if (request.lastFrame) throw failed(e);
      return undefined;
    }
  };

  try {
    // Asked of the server before anything is sent, so that a server that has no video model, or cannot make a WebM, is said so in plain words.
    const caps = await capabilities(root);
    const submitted = await call(route(root, "vid_gen"), "POST", bodyOf(config, request, caps, caps?.format ?? "webm"));
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
        if (state === "completed") return finished(job.json?.result, max);
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

/**
 * The clip in a finished job's result, decoded. Whatever it is, it is kept: a finished clip is never failed by its
 * format. Its first bytes say what kind of file it is (see sniffVideo), which names the file and tells the page
 * whether a browser plays it; the size limit still holds, and so does the answer having a clip in it at all.
 */
function finished(result: any, max: number): MadeVideo {
  const encoded = text(result?.b64_json);
  if (!encoded) throw fail("The video endpoint finished the clip, but with no video in its answer");
  const decoded = decodeBase64(encoded, max);
  if ("error" in decoded) throw fail(decoded.error === "invalid" ? "The clip the video endpoint sent is not base64" : `The clip is over ${max / 1024 / 1024} MB`);
  const frames = result?.frame_count;
  const fps = result?.fps;
  return { bytes: decoded.bytes, ext: sniffVideo(decoded.bytes.subarray(0, VIDEO_HEAD)).id, ...(Number.isInteger(frames) && frames > 0 ? { frames } : {}), ...(Number.isInteger(fps) && fps > 0 ? { fps } : {}) };
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
