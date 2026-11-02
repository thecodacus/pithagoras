import { isApiError, portal, t } from "../portal";
import type { OutputFormat } from "../server/image-settings";

/**
 * What the browser half asks of Media's server half: its own routes, under the
 * address the portal gives the package (`portal.api.url`), for the gallery of
 * pictures and of videos, the jobs that make them, and the settings of the two
 * endpoints. A request made while the server half is not running is refused as
 * one the server refused is, so that what asked says so where it says the rest.
 */

/** A JSON route of the server half. */
const call = async <T>(path: string, init?: RequestInit): Promise<T> => portal.api.json<T>(portal.api.url(path), init);

/** The query of a page of either list: `again` is a switch the server reads as 1, the page asking again for a list it has, so that the files are not looked through again at once. */
function pageQuery(query: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) if (value !== undefined && value !== false) params.set(name, value === true ? "1" : String(value));
  return params.size ? `?${params}` : "";
}

export const api = {
  /** Whether pictures can be made or changed, and whether videos can be made, now: for the sidebar's entry and what the page shows. */
  state: () => call<MediaState>("/state"),
  /** Image generation, as the page is told it: never the key, only whether one is set. */
  imagesFeature: () => call<{ images: ImagesFeature }>("/settings/images"),
  /** Video generation alone, as images are. */
  videosFeature: () => call<{ videos: VideosFeature }>("/settings/videos"),
  /** `changed`: the agent got or lost a tool, which chats have from their next load. */
  setImagesFeature: (patch: ImagesFeaturePatch) =>
    call<{ images: ImagesFeature; changed: boolean; reloaded: number; waiting: number }>("/settings/images", { method: "PUT", body: JSON.stringify(patch) }),
  /** `changed`: the agent got or lost its video tools, which chats have from their next load. */
  setVideosFeature: (patch: VideosFeaturePatch) =>
    call<{ videos: VideosFeature; changed: boolean; reloaded: number; waiting: number }>("/settings/videos", { method: "PUT", body: JSON.stringify(patch) }),
  /** A page of the clips, newest first; `before` is the `next` of the page before. */
  videoPage: (query: { origin?: VideoOrigin; kind?: VideoKind; before?: string; limit?: number; again?: boolean } = {}) => call<VideoPage>(`/videos${pageQuery(query)}`),
  /** Some clips by their ids, as far as they are there. */
  galleryVideos: (ids: string[]) => call<{ videos: GalleryVideo[] }>(`/videos?ids=${ids.join(",")}`),
  /** What is being made, and what was, with the most that run at once. */
  videoJobs: () => call<{ jobs: VideoJob[]; limit: number }>("/videos/jobs"),
  /** Stops a clip that is being made, or clears one that is done. */
  stopVideoJob: (id: string) => call<{ ok: true }>(`/videos/jobs/${id}`, { method: "DELETE" }),
  /** One job for each clip; answers at once. */
  makeVideos: (request: VideoRequest) => call<{ jobs: VideoJob[] }>("/videos/generate", { method: "POST", body: JSON.stringify(request) }),
  /** The clip as the file it is, which a player asks for in parts. Its address never changes what it shows, unless it is in a chat's folder, which the browser then asks about. */
  videoFileUrl: (id: string) => portal.api.url(`/videos/${id}/file`),
  /** The poster picture of a clip, for the clips the gallery says can have one (`GalleryVideo.poster`). */
  videoPosterUrl: (id: string) => portal.api.url(`/videos/${id}/poster`),
  /** The playable copy of a clip a browser does not play, once it is made. */
  videoCopyUrl: (id: string) => portal.api.url(`/videos/${id}/copy`),
  /** Makes it, when ffmpeg is there: answers when it is done, which takes a while for a long clip. */
  makeVideoCopy: (id: string) => call<{ ok: true }>(`/videos/${id}/copy`, { method: "POST" }),
  /** Each as asked, files and all: what could not be deleted is said for each. */
  deleteVideos: (ids: string[]) => call<{ deleted: string[]; failed: { id: string; error: string }[] }>("/videos/delete", { method: "POST", body: JSON.stringify({ ids }) }),
  /** A page of the gallery, newest first; `before` is the `next` of the page before. */
  galleryPage: (query: { origin?: PictureOrigin; kind?: PictureKind; before?: string; limit?: number; again?: boolean } = {}) => call<GalleryPage>(`/images${pageQuery(query)}`),
  /** Some pictures of the gallery by their ids, as far as they are there. */
  galleryPictures: (ids: string[]) => call<{ pictures: GalleryPicture[] }>(`/images?ids=${ids.join(",")}`),
  /** What is being made, and what was, with the most that run at once. */
  pictureJobs: () => call<{ jobs: PictureJob[]; limit: number }>("/images/jobs"),
  /** Stops a picture that is being made, or clears one that is done. */
  stopPictureJob: (id: string) => call<{ ok: true }>(`/images/jobs/${id}`, { method: "DELETE" }),
  /** One job for each picture; answers at once. */
  makePictures: (request: PictureRequest) => call<{ jobs: PictureJob[] }>("/images/generate", { method: "POST", body: JSON.stringify(request) }),
  /** One job for each change; answers at once. */
  changePicture: (request: ChangeRequest) => call<{ jobs: PictureJob[] }>("/images/edit", { method: "POST", body: JSON.stringify(request) }),
  /** A picture from this computer, into the gallery to be changed: its bytes as they are, always a plain stream, since what the file calls itself is not how it is sent. */
  uploadPicture: async (file: File): Promise<GalleryPicture> => {
    try {
      return (await call<{ picture: GalleryPicture }>(`/images/upload?name=${encodeURIComponent(file.name)}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file })).picture;
    } catch (e) {
      // The server's words when it has any; otherwise which file, and why. A portal that cannot be reached answered nothing, and says so itself.
      if (isApiError(e) && e.status !== 0 && typeof e.body.error !== "string") throw new portal.api.ApiError(t("Could not upload {name} ({status})", { name: file.name, status: e.status }), e.status, e.body);
      throw e;
    }
  },
  /** The picture as the file it is. Its address never changes what it shows, unless it is in a chat's folder, which the browser then asks about. */
  galleryFileUrl: (id: string) => portal.api.url(`/images/${id}/file`),
  /** The small copy of a picture, which the portal makes when it is asked for; for the pictures the gallery says have one (`GalleryPicture.thumb`). */
  galleryThumbUrl: (id: string) => portal.api.url(`/images/${id}/thumb`),
  /** Each as asked, files and all: what could not be deleted is said for each. */
  deletePictures: (ids: string[]) => call<{ deleted: string[]; failed: { id: string; error: string }[] }>("/images/delete", { method: "POST", body: JSON.stringify({ ids }) }),
};

/** Whether each can be done now: pictures when they can be made or changed (switched on, with an address to ask), videos when they can be made. */
export interface MediaState {
  images: { enabled: boolean };
  videos: { enabled: boolean };
}

/** Image generation as the page is told it: never the key, only whether one is set. */
export interface ImagesFeature {
  enabled: boolean;
  /** The API's base, such as https://host/v1. */
  baseUrl: string;
  model: string;
  /** "1024x1024" or empty for the endpoint's own. */
  size: string;
  keySet: boolean;
  /** Editing a picture has a switch of its own: not every endpoint that makes pictures changes them. */
  editEnabled: boolean;
  /** Where edits go; empty is the address above. */
  editBaseUrl: string;
  /** Empty sends no model: the model above is not taken for editing. */
  editModel: string;
  /** The edit endpoint takes several pictures, so edit_image has a list; off until said, and off again when edits move to another server. */
  editMultiple: boolean;
  /** "2048x2048", the most pixels a picture sent to be edited may have, or empty for no limit. */
  editMaxSize: string;
  editKeySet: boolean;
  /** How long a request for a picture, made or edited, may take, in whole seconds. */
  timeoutSeconds: number;
  /** Whether pictures can be made: switched on, and with an address to ask. The portal says it, so that the page does not work it out again. */
  ready: boolean;
  /** Whether the agent has an edit tool: switched on, and with an address to ask. */
  editReady: boolean;
  /** The endpoint is stable-diffusion.cpp's server: the page shows, and sends, the settings that only it reads. Off by default. */
  sdExtras: boolean;
}

/** Made on the page, made by the agent in a chat, or found in a folder the agent's tools write into, with no chat to name. */
export type PictureOrigin = "page" | "chat" | "folder";
/** Made from a description, changed from another picture, put in by the person to be changed, or found with nothing to tell how it was made. */
export type PictureKind = "generated" | "edited" | "uploaded" | "unknown";

/** A picture of the gallery, as the portal tells of it. */
export interface GalleryPicture {
  id: string;
  origin: PictureOrigin;
  /** The chat whose agent made it, for the agent's pictures. */
  chat: { id: string; title: string } | null;
  /** The folder it was found in, for one that was found: Home, or the project's name or the way to the folder under the workspace root. */
  folder: { name: string; home: boolean } | null;
  kind: PictureKind;
  prompt: string;
  /** What it was asked for with, as far as that is known. */
  params: {
    model?: string;
    size?: string;
    outputFormat?: OutputFormat;
    outputCompression?: number;
    /** The ones that only stable-diffusion.cpp's server reads. */
    negativePrompt?: string;
    seed?: number;
    sampleSteps?: number;
    strength?: number;
    fromNoise?: boolean;
    /** Fields an older version of the page sent as typed; shown, not sent again. */
    extra?: Record<string, string | number | boolean>;
    sources?: string[];
    masked?: boolean;
    /** A new picture's references, by their ids in the gallery, in order: those still there. */
    references?: string[];
  };
  /** The picture an edit was made from, when that one is in the gallery. */
  from: string | null;
  createdAt: number;
  bytes: number;
  fileName: string;
  /** The tiles load a small copy of it (see `galleryThumbUrl`), and not the file. */
  thumb: boolean;
}

export interface GalleryPage {
  pictures: GalleryPicture[];
  /** Where the next page starts, or null at the end. */
  next: string | null;
  /** How many there are with the filters, and how much of the disk the page's own take. */
  total: number;
  pageBytes: number;
}

/** A picture that is being made, was, or was not. */
export interface PictureJob {
  id: string;
  kind: "generate" | "edit";
  state: "running" | "done" | "failed";
  prompt: string;
  size?: string;
  /** An edit's first picture. */
  from?: string;
  startedAt: number;
  finishedAt?: number;
  pictureId?: string;
  /** What was done to a picture to make it fit an edit (scaled down, compressed), when something was. */
  notes?: string[];
  error?: string;
}

/**
 * What the page asks of the portal for one picture beyond its description, and
 * only what is set. Model, size, format and compression are fields of the
 * OpenAI image format; the rest are not, and reach only an endpoint that is
 * stable-diffusion.cpp's server, in the prompt (see the server half's image settings).
 */
export interface PictureSettingsBody {
  model?: string;
  /** `1024x1024`. */
  size?: string;
  outputFormat?: OutputFormat;
  /** With jpeg or webp. */
  outputCompression?: number;
  negativePrompt?: string;
  seed?: number;
  sampleSteps?: number;
  /** For a change only. */
  strength?: number;
  /** For a change only: from noise, with the pictures as references; no strength and no mask then. */
  fromNoise?: boolean;
}

/** What the page asks the portal to make: `references` are pictures of the gallery, by their ids, that the new picture is made with, through the editing endpoint. */
export interface PictureRequest extends PictureSettingsBody {
  prompt: string;
  count?: number;
  references?: string[];
}

/** What the page asks the portal to change: `mask` is a PNG as base64, and the transparent part is what changes. */
export interface ChangeRequest extends PictureSettingsBody {
  prompt: string;
  sources: string[];
  mask?: string;
  count?: number;
}

/** What the page may change of it. A key left out keeps the saved one; "" takes it away. */
export interface ImagesFeaturePatch {
  enabled?: boolean;
  baseUrl?: string;
  model?: string;
  size?: string;
  apiKey?: string;
  editEnabled?: boolean;
  editBaseUrl?: string;
  editModel?: string;
  editApiKey?: string;
  editMultiple?: boolean;
  editMaxSize?: string;
  /** null takes a saved limit away: the default again. */
  timeoutSeconds?: number | null;
  sdExtras?: boolean;
}

/** Video generation as the page is told it: never the key, only whether one is set. */
export interface VideosFeature {
  enabled: boolean;
  /** How the endpoint is spoken to: one of `backends`. */
  backend: string;
  backends: { id: string; label: string }[];
  /** The API's base, such as http://host:1234. */
  baseUrl: string;
  model: string;
  /** "832x480" or empty for the endpoint's own. */
  size: string;
  /** How many frames a clip has, and how fast they play, when the form says nothing; none for the endpoint's own. */
  frames: number | null;
  fps: number | null;
  keySet: boolean;
  /** How long a clip may take in all, in whole seconds. */
  timeoutSeconds: number;
  /** The most the page's own clips may take of the disk, in megabytes: 0 is no limit. */
  storageLimitMb: number;
  /** Whether clips can be made: switched on, and with an address to ask. The portal says it, so that the page does not work it out again. */
  ready: boolean;
}

/** What the page may change of it. A key left out keeps the saved one; "" takes it away. */
export interface VideosFeaturePatch {
  enabled?: boolean;
  backend?: string;
  baseUrl?: string;
  model?: string;
  size?: string;
  frames?: number | null;
  fps?: number | null;
  apiKey?: string;
  /** null takes a saved limit away: the default again. */
  timeoutSeconds?: number | null;
  /** null takes the limit away. */
  storageLimitMb?: number | null;
}

/** Made on the page, made by the agent in a chat, or found in a folder the agent's tool writes into, with no chat to name. */
export type VideoOrigin = "page" | "chat" | "folder";
/** Made from a description, made from a picture as its first frame, or found with nothing to tell how it was made. */
export type VideoKind = "generated" | "animated" | "unknown";

/** A clip of the gallery, as the portal tells of it. */
export interface GalleryVideo {
  id: string;
  origin: VideoOrigin;
  /** The chat whose agent made it, for the agent's clips. */
  chat: { id: string; title: string } | null;
  /** The folder it was found in, for one that was found: Home, or the project's name or the way to the folder under the workspace root. */
  folder: { name: string; home: boolean } | null;
  kind: VideoKind;
  prompt: string;
  /** What it was asked for with, as far as that is known; `madeFrames` and `madeFps` are what the server says it made. */
  params: {
    model?: string;
    size?: string;
    frames?: number;
    fps?: number;
    seed?: number;
    sampleSteps?: number;
    negativePrompt?: string;
    strength?: number;
    madeFrames?: number;
    madeFps?: number;
    /** A clip made from a picture: the picture of the gallery, or its path in the chat's folder. */
    firstFrame?: { picture?: string; path?: string };
    /** A clip made to end on a picture: named as the first frame is. */
    lastFrame?: { picture?: string; path?: string };
  };
  createdAt: number;
  bytes: number;
  fileName: string;
  /** The portal can make a poster picture of it (see `videoPosterUrl`). Only for a clip a browser plays. */
  poster: boolean;
  /** What the file is by its first bytes, and whether a browser plays it here: only a WebM and an MP4 are; any other is a file to download. */
  format: VideoFormat;
  /** For a clip that is not played as it is: a playable WebM copy of it is `ready`, or ffmpeg is there to make one on request (`available`). */
  copy?: "ready" | "available";
  /** Why the file could not be opened when the list was made, when it could not: out of reach (its folder or the file), or over the size a clip may have. Its format is then what is known of it without opening it. */
  unavailable?: "unreachable" | "too_large";
}

export interface VideoFormat {
  /** The kind, as a file extension: webm, mp4, mov, avi, webp, gif, mkv, ogg, or bin for one that is not known. */
  id: string;
  /** What a person is told it is: "AVI", "WebP", "EBML (foo)", "Unknown". */
  label: string;
  mimeType: string;
  playable: boolean;
}

export interface VideoPage {
  videos: GalleryVideo[];
  /** Where the next page starts, or null at the end. */
  next: string | null;
  /** How many there are with the filters, and how much of the disk the page's own take. */
  total: number;
  pageBytes: number;
}

/** A clip that is being made, was, or was not. */
export interface VideoJob {
  id: string;
  kind: "generate" | "animate";
  state: "running" | "done" | "failed";
  /** While it runs, and the server says: waiting its turn there, or being made. */
  stage?: "waiting" | "making";
  /** Which place in the server's queue, while it waits. */
  queuePosition?: number;
  prompt: string;
  size?: string;
  /** A clip made from a picture: the picture's id in the gallery. */
  from?: string;
  startedAt: number;
  finishedAt?: number;
  videoId?: string;
  error?: string;
}

/** What the page asks the portal to make, and only what is set. */
export interface VideoRequest {
  prompt: string;
  model?: string;
  /** `832x480`. */
  size?: string;
  frames?: number;
  fps?: number;
  seed?: number;
  sampleSteps?: number;
  negativePrompt?: string;
  strength?: number;
  /** The picture of the gallery to start from. */
  firstFrame?: string;
  /** The picture of the gallery to end on, for a server that says it takes one. */
  lastFrame?: string;
  count?: number;
}
