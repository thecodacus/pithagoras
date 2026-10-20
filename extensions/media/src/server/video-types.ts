import type { VideoExt } from "./video-files";
import type { VideoSettings } from "./video-settings";

/**
 * What video generation and its backends share (see video-generation.ts): in a
 * module of its own so that a backend can be written without importing the
 * add-on that holds it.
 */

/** What went wrong with a clip, in words the agent can pass on: nothing in it is secret. */
export class VideoGenerationError extends Error {}

/** How a video endpoint is spoken to: the id the settings name a backend by. */
export type VideoBackendId = "sdcpp";

export interface VideoGenerationConfig {
  enabled: boolean;
  /** How the endpoint is spoken to: see VideoBackend. */
  backend: VideoBackendId;
  /** The API's base, such as https://host:1234: no credentials, query or fragment, so that nothing secret is in what the page is shown. */
  baseUrl: string;
  /** Sent as `model` when it is not empty. */
  model: string;
  /** Sent as the size when it is not empty, unless the request asks for another. */
  size: string;
  /** How many frames a clip has when the request does not say; none leaves it to the server. */
  frames: number | null;
  /** Frames per second when the request does not say; none leaves it to the server. */
  fps: number | null;
  apiKey: string;
  /** How long a clip may take in all, queue included; see VIDEO_TIMEOUT_SECONDS. */
  timeoutSeconds: number;
  /** The most the page's own clips may take of the disk, in megabytes: while they take that much, no new clip is made on the page. 0 is no limit. */
  storageLimitMb: number;
}

/** What a request for a clip says, on top of the settings it is made with. */
export interface VideoRequest extends VideoSettings {
  prompt: string;
  /** The first frame of the clip, as the bytes of a picture and its type: an image-to-video request. Without it the clip is made from the description alone. */
  firstFrame?: { bytes: Buffer; mimeType: string };
  /** The last frame of the clip, in the same form. Only a server that says it takes one is sent it (what its model does with it is the model's own); for any other the request fails, and the picture is never dropped. */
  lastFrame?: { bytes: Buffer; mimeType: string };
  /** The length in seconds, for a caller that thinks in them (the agent's tool): worked out to frames at the frame rate, unless `frames` says. */
  seconds?: number;
}

/** Where a clip is while it is being made, for a page that shows it. */
export interface VideoProgress {
  /** Waiting its turn on the server, or being made. */
  stage: "waiting" | "making";
  /** Which place in the server's queue, while it waits and the server says. */
  queuePosition?: number;
}

/** What a clip that was made comes with: the file, and what the server says of it. */
export interface MadeVideo {
  bytes: Buffer;
  ext: VideoExt;
  /** As the server made it: it may have rounded the frames to what its model takes. */
  frames?: number;
  fps?: number;
}

/** How a request is run: what the caller can say of it, and be told. */
export interface VideoRun {
  /** The chat or the job being stopped. */
  signal?: AbortSignal;
  /** The limit of the whole request in milliseconds; the callers pass the one of the settings. */
  timeoutMs?: number;
  maxBytes?: number;
  onProgress?: (progress: VideoProgress) => void;
  /** How often the server is asked how far a clip is, in milliseconds, instead of the backend's own pace: for a test. */
  pollMs?: number;
}

/** One way of asking a server for a clip. */
export interface VideoBackend {
  id: VideoBackendId;
  /** What the person knows it as. */
  label: string;
  /**
   * Asks for a clip and returns it, with every check the portal makes of what comes back (see generateVideo).
   * The key goes with the requests to this address and is not followed anywhere else.
   */
  generate(config: VideoGenerationConfig, request: VideoRequest, run: VideoRun): Promise<MadeVideo>;
}
