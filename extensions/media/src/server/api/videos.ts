import { closeSync } from "node:fs";
import type { Router } from "express";
import { portal } from "../host";
import {
  DEFAULT_PAGE,
  MAX_PAGE,
  deleteVideo,
  listVideos,
  openListedCopy,
  openListedPoster,
  openListedVideo,
  videosById,
  type VideoKind,
  type VideoOrigin,
} from "../video-gallery";
import { VideoJobRefusal, listJobs, startVideos, stopJob, type GenerateVideoJob } from "../video-jobs";
import { MAX_RUNNING_VIDEOS, MAX_VIDEO_PROMPT, parseVideoSettings } from "../video-settings";
import { fail } from "./fail";

/**
 * The Media page: making clips with the video endpoint the person set up
 * under Media in Settings, without the agent, and the gallery of what was
 * made — here and in chats. Its routes are the package's, at
 * /api/x/pithagoras-media/videos….
 *
 * The same shape as the Media page's API (see images.ts), and the same rules: the
 * page asks the portal and the portal asks the endpoint, with the same settings,
 * key and checks the agent's tool has (see video-generation.ts), so the key never
 * reaches the page; clips are listed and sent only from the two places the portal
 * knows (see video-gallery.ts), never from a path the page names: it names a clip by
 * its id. Making one is a job that runs on the server (see video-jobs.ts), which the
 * page watches.
 */

const IDS = /^[0-9a-f]{12}$/;
const ORIGINS = new Set<string>(["page", "chat", "folder"]);
const KINDS = new Set<string>(["generated", "animated", "unknown"]);
/** The most that go in one request to delete, or that are looked up by id. */
const MAX_IDS = 200;

const object = (body: unknown): Record<string, unknown> => (body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {});

/** A prompt as the tool takes one: text, not empty, not longer than an endpoint takes. */
function parsePrompt(value: unknown): string | { error: string } {
  const prompt = typeof value === "string" ? value.trim() : "";
  if (!prompt) return { error: "A prompt is required: say what the clip should show" };
  if (prompt.length > MAX_VIDEO_PROMPT) return { error: `The prompt is over ${MAX_VIDEO_PROMPT} characters` };
  return prompt;
}

/** How many clips a request asks for: one each, up to as many as run at once. */
function parseCount(value: unknown): number | string {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_RUNNING_VIDEOS) return `The number of clips is a whole number from 1 to ${MAX_RUNNING_VIDEOS}`;
  return value as number;
}

/** A request to make clips, checked; the reason when it may not be made. */
export function parseGenerate(body: unknown): GenerateVideoJob | string {
  const b = object(body);
  const prompt = parsePrompt(b.prompt);
  if (typeof prompt !== "string") return prompt.error;
  const count = parseCount(b.count);
  if (typeof count === "string") return count;
  const settings = parseVideoSettings(b, count);
  if (typeof settings === "string") return settings;
  const job: GenerateVideoJob = { ...settings, prompt, count };
  if (b.firstFrame !== undefined && b.firstFrame !== null) {
    if (typeof b.firstFrame !== "string" || !IDS.test(b.firstFrame)) return "The first frame is a picture, named by its id in the gallery of the Media page";
    job.firstFrame = b.firstFrame;
  }
  if (b.lastFrame !== undefined && b.lastFrame !== null) {
    if (typeof b.lastFrame !== "string" || !IDS.test(b.lastFrame)) return "The last frame is a picture, named by its id in the gallery of the Media page";
    job.lastFrame = b.lastFrame;
  }
  return job;
}

/** The ids of a request, checked: the same twelve letters and digits they are made of. */
function parseIds(value: unknown): string[] | string {
  if (!Array.isArray(value) || !value.length) return "ids must be a list of video ids";
  if (value.length > MAX_IDS) return `At most ${MAX_IDS} videos at a time`;
  if (!value.every((id) => typeof id === "string" && IDS.test(id))) return "ids must be a list of video ids";
  return [...new Set(value as string[])];
}

/** The routes, on `router`: the package's. */
export function videosRoutes(router: Router): void {
  const { http } = portal();
  // A body is read where a route asks for it, up to what the portal's own routes take: a parser's own limit is 100 kB.
  const json = http.json({ limit: "2mb" });

  /** A page of the gallery, newest first, with the filters on where a clip is from and how it was made, and where the next page starts. `ids` asks for those clips alone, in the order given. */
  router.get("/videos", (req, res) => {
    try {
      if (req.query.ids !== undefined) {
        const ids = parseIds(String(req.query.ids).split(",").filter(Boolean));
        if (typeof ids === "string") return res.status(400).json({ error: ids });
        return res.json({ videos: videosById(ids) });
      }
      const { origin, kind, before, limit, again } = req.query;
      if (origin !== undefined && !(typeof origin === "string" && ORIGINS.has(origin))) return res.status(400).json({ error: "origin is page, chat or folder" });
      if (kind !== undefined && !(typeof kind === "string" && KINDS.has(kind))) return res.status(400).json({ error: "kind is generated, animated or unknown" });
      if (before !== undefined && !(typeof before === "string" && /^\d+:[0-9a-f]+$/.test(before))) return res.status(400).json({ error: "before is the next of the page before" });
      const asked = limit === undefined ? DEFAULT_PAGE : Number(limit);
      if (!Number.isInteger(asked) || asked < 1 || asked > MAX_PAGE) return res.status(400).json({ error: `limit is a whole number from 1 to ${MAX_PAGE}` });
      res.json(
        listVideos({
          ...(origin ? { origin: origin as VideoOrigin } : {}),
          ...(kind ? { kind: kind as VideoKind } : {}),
          ...(typeof before === "string" ? { before } : {}),
          // A page asking again for a list it has: see ListQuery.again.
          ...(again === "1" ? { again: true } : {}),
          limit: asked,
        }),
      );
    } catch (e) {
      fail(res, e);
    }
  });

  /** What is being made, and what was, for the page to follow. */
  router.get("/videos/jobs", (_req, res) => {
    res.json({ jobs: listJobs(), limit: MAX_RUNNING_VIDEOS });
  });

  /** Stops a clip that is being made, or clears a finished one from the list. */
  router.delete("/videos/jobs/:id", (req, res) => {
    if (!stopJob(req.params.id)) return res.status(404).json({ error: "There is no such job" });
    res.json({ ok: true });
  });

  /** Makes clips from a description, and from a picture of the Media page where one is named: one request, and one job, for each; answers at once, without waiting for any. */
  router.post("/videos/generate", json, (req, res) => {
    const job = parseGenerate(req.body);
    if (typeof job === "string") return res.status(400).json({ error: job });
    try {
      res.status(202).json({ jobs: startVideos(job) });
    } catch (e) {
      if (e instanceof VideoJobRefusal) return res.status(e.status).json({ error: e.message });
      fail(res, e);
    }
  });

  /**
   * A clip, as the file it is: whole or, where a player asks, a part of it. A WebM and an MP4 are sent to be played;
   * any other file is sent to be saved (`Content-Disposition: attachment`), as the type its bytes say, and never shown.
   */
  router.get("/videos/:id/file", (req, res) => {
    let opened: ReturnType<typeof openListedVideo>;
    try {
      opened = openListedVideo(req.params.id);
    } catch (e) {
      return fail(res, e);
    }
    // One of the page's own never changes under its id; one in a chat's folder is that folder's, and the browser asks.
    http.send(req, res, opened, { cache: opened.origin === "page" ? "private, max-age=86400" : "private, no-cache", download: opened.format.playable ? undefined : opened.fileName });
  });

  /** The playable copy of a clip a browser does not play, where one was made. */
  router.get("/videos/:id/copy", async (req, res) => {
    let opened: Awaited<ReturnType<typeof openListedCopy>>;
    try {
      opened = await openListedCopy(req.params.id, false);
    } catch (e) {
      return fail(res, e);
    }
    if (!opened) return res.status(404).json({ error: "This video has no playable copy", code: "missing" });
    http.send(req, res, opened, { cache: opened.origin === "page" ? "private, max-age=86400" : "private, no-cache" });
  });

  /**
   * Makes the playable copy of a clip a browser does not play, when ffmpeg is there, and says when it is made: the
   * original is kept as it is. It can take a while for a long clip, and answers when it is done.
   */
  router.post("/videos/:id/copy", async (req, res) => {
    try {
      const clip = videosById([req.params.id])[0];
      if (!clip) return res.status(404).json({ error: "There is no such video", code: "missing" });
      if (clip.format.playable) return res.status(400).json({ error: "This video plays as it is: it has no use for a copy" });
      if (!clip.copy) return res.status(409).json({ error: "ffmpeg is not installed, so no playable copy can be made. The original can be downloaded" });
      const made = await openListedCopy(req.params.id, true);
      if (!made) return res.status(502).json({ error: "A playable copy could not be made of this video. The original can be downloaded" });
      closeSync(made.fd);
      res.json({ ok: true });
    } catch (e) {
      fail(res, e);
    }
  });

  /**
   * The poster picture of a clip, which the tiles of the gallery show until it is played: made here, the first
   * time it is asked for and again when the file has changed, and kept for every view after that. A clip that has
   * none (the portal has no ffmpeg to make one) answers 404, and the page shows the clip's first frame itself.
   */
  router.get("/videos/:id/poster", async (req, res) => {
    let opened: Awaited<ReturnType<typeof openListedPoster>>;
    try {
      opened = await openListedPoster(req.params.id);
    } catch (e) {
      return fail(res, e);
    }
    if (!opened) return res.status(404).json({ error: "This video has no poster picture", code: "missing" });
    http.send(req, res, opened, { cache: opened.origin === "page" ? "private, max-age=86400" : "private, no-cache" });
  });

  /** Takes clips away, files and all, each as asked: a clip in a chat's folder goes from the folder, for good. What could not be, is said for each; the rest is done. */
  router.post("/videos/delete", json, async (req, res) => {
    const ids = parseIds(object(req.body).ids);
    if (typeof ids === "string") return res.status(400).json({ error: ids });
    const deleted: string[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const id of ids) {
      try {
        await deleteVideo(id);
        deleted.push(id);
      } catch (e) {
        failed.push({ id, error: (e as Error).message });
      }
    }
    res.json({ deleted, failed });
  });

  router.delete("/videos/:id", async (req, res) => {
    try {
      await deleteVideo(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      fail(res, e);
    }
  });
}
