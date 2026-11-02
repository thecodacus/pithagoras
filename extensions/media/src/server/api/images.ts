import type { Response, Router } from "express";
import { portal } from "../host";
import { MAX_EDIT_PICTURES } from "../image-editing";
import {
  DEFAULT_PAGE,
  MAX_PAGE,
  addPagePicture,
  deletePicture,
  listPictures,
  openListed,
  openListedThumb,
  picturesById,
  type PictureKind,
  type PictureOrigin,
} from "../image-gallery";
import { JobRefusal, MAX_RUNNING, listJobs, startEdit, startGenerations, stopJob, type EditJob, type GenerateJob } from "../image-jobs";
import { MAX_PROMPT } from "../image-generation";
import { nativeConflict, parsePictureSettings } from "../image-settings";
import { MAX_PICTURE_BYTES, decodeBase64, pictureExt } from "../picture-files";
import { fail } from "./fail";

/**
 * The Media page: making pictures with the image endpoint the person set up
 * under Media in Settings, without the agent, and the gallery of
 * what was made — here and in chats. Its routes are the package's, at
 * /api/x/pithagoras-media/images….
 *
 * The page asks the portal and the portal asks the endpoint, with the same
 * settings, key and checks the agent's tools have (see image-generation.ts):
 * the key never reaches the page, a picture sent as an address is fetched under
 * the same rules, and what comes back is a picture by its bytes and not too
 * large. Pictures are listed and sent only from the two places the portal
 * knows (see image-gallery.ts), never from a path the page names: it names a
 * picture by its id. Making one is a job that runs on the server (see
 * image-jobs.ts), which the page watches.
 */

const IDS = /^[0-9a-f]{12}$/;
const ORIGINS = new Set<string>(["page", "chat", "folder"]);
const KINDS = new Set<string>(["generated", "edited", "uploaded", "unknown"]);
/** The most that go in one request to delete, or that are looked up by id. */
const MAX_IDS = 200;

const object = (body: unknown): Record<string, unknown> => (body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {});

/** A prompt as the tools take one: text, not empty, not longer than an endpoint takes. */
function parsePrompt(value: unknown): string | { error: string } {
  const prompt = typeof value === "string" ? value.trim() : "";
  if (!prompt) return { error: "A prompt is required: say what the picture should show" };
  if (prompt.length > MAX_PROMPT) return { error: `The prompt is over ${MAX_PROMPT} characters` };
  return prompt;
}

/** How many pictures a request asks for: one each, up to as many as run at once. */
function parseCount(value: unknown): number | string {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_RUNNING) return `The number of pictures is a whole number from 1 to ${MAX_RUNNING}`;
  return value as number;
}

/** What a request that still has the free extra fields of an older page is told: none is sent, so that it is not thought to be. */
const NO_EXTRA = "Free extra fields are not sent any more: the settings of a picture are named fields (outputFormat, seed, sampleSteps, negativePrompt, …)";

/**
 * A request to make pictures, checked; the reason when it may not be made. `references` are pictures of the gallery,
 * by their ids, that the new picture is made from as well as the description, in the order it refers to them: as
 * many as an edit takes, since they go to the editing endpoint (see image-jobs.ts). Left out, the request is the one
 * it always was.
 */
export function parseGenerate(body: unknown): GenerateJob | string {
  const b = object(body);
  if (b.extra !== undefined) return NO_EXTRA;
  const prompt = parsePrompt(b.prompt);
  if (typeof prompt !== "string") return prompt.error;
  if (b.references !== undefined) {
    if (!Array.isArray(b.references) || !b.references.length) return "The references are a list of pictures of the gallery: leave them out to make a picture from the description alone";
    if (b.references.length > MAX_EDIT_PICTURES) return `A picture takes at most ${MAX_EDIT_PICTURES} references, and ${b.references.length} were given`;
    if (!b.references.every((id) => typeof id === "string" && IDS.test(id))) return "The references are named by their ids in the gallery";
  }
  const count = parseCount(b.count);
  if (typeof count === "string") return count;
  const settings = parsePictureSettings(b, false, count);
  if (typeof settings === "string") return settings;
  return nativeConflict(prompt, settings) ?? { ...settings, prompt, count, ...(b.references !== undefined ? { references: b.references as string[] } : {}) };
}

/** A mask as the page sends it, base64 or a data: URL, decoded. */
function parseMask(value: unknown): Buffer | string {
  if (typeof value !== "string") return "The mask must be a picture, as base64";
  const decoded = decodeBase64(value, MAX_PICTURE_BYTES);
  if ("error" in decoded) return decoded.error === "invalid" ? "The mask is not base64" : `The mask is over ${MAX_PICTURE_BYTES / 1024 / 1024} MB`;
  return decoded.bytes;
}

/** A request to change pictures, checked; the reason when it may not be made. */
export function parseEdit(body: unknown): EditJob | string {
  const b = object(body);
  if (b.extra !== undefined) return NO_EXTRA;
  const prompt = parsePrompt(b.prompt);
  if (typeof prompt !== "string") return prompt.error;
  if (!Array.isArray(b.sources) || !b.sources.length) return "There is no picture to change";
  if (b.sources.length > MAX_EDIT_PICTURES) return `An edit takes at most ${MAX_EDIT_PICTURES} pictures, and ${b.sources.length} were given`;
  if (!b.sources.every((id) => typeof id === "string" && IDS.test(id))) return "The pictures are named by their ids in the gallery";
  const count = parseCount(b.count);
  if (typeof count === "string") return count;
  const settings = parsePictureSettings(b, true, count);
  if (typeof settings === "string") return settings;
  const conflict = nativeConflict(prompt, settings);
  if (conflict) return conflict;
  const job: EditJob = { ...settings, prompt, sources: b.sources as string[], count };
  if (b.mask !== undefined && b.mask !== null) {
    if (settings.fromNoise) return "A mask marks what to change in the picture that is built on, and there is none to start from";
    const mask = parseMask(b.mask);
    if (typeof mask === "string") return mask;
    job.mask = mask;
  }
  return job;
}

/** The ids of a request, checked: the same twelve letters and digits they are made of. */
function parseIds(value: unknown): string[] | string {
  if (!Array.isArray(value) || !value.length) return "ids must be a list of picture ids";
  if (value.length > MAX_IDS) return `At most ${MAX_IDS} pictures at a time`;
  if (!value.every((id) => typeof id === "string" && IDS.test(id))) return "ids must be a list of picture ids";
  return [...new Set(value as string[])];
}

/** What an uploaded file is called in the list: the name it had, without any place in it, and without what cannot be shown. */
const uploadedName = (given: unknown): string =>
  (typeof given === "string" ? given : "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .split(/[\\/]/)
    .pop()!
    .trim()
    .slice(0, 120);

/** The routes, on `router`: the package's. */
export function imagesRoutes(router: Router): void {
  const { http } = portal();
  // A body is read where a route asks for it, up to what the portal's own routes take: a parser's own limit is 100 kB.
  const json = http.json({ limit: "2mb" });

  /**
   * A page of the gallery, newest first, with the filters on where a picture
   * is from and how it was made, and where the next page starts. `ids` asks
   * for those pictures alone, in the order given: what an edit was made from,
   * which may be further down than the page has reached.
   */
  router.get("/images", (req, res) => {
    try {
      if (req.query.ids !== undefined) {
        const ids = parseIds(String(req.query.ids).split(",").filter(Boolean));
        if (typeof ids === "string") return res.status(400).json({ error: ids });
        return res.json({ pictures: picturesById(ids) });
      }
      const { origin, kind, before, limit, again } = req.query;
      if (origin !== undefined && !(typeof origin === "string" && ORIGINS.has(origin))) return res.status(400).json({ error: "origin is page, chat or folder" });
      if (kind !== undefined && !(typeof kind === "string" && KINDS.has(kind))) return res.status(400).json({ error: "kind is generated, edited, uploaded or unknown" });
      if (before !== undefined && !(typeof before === "string" && /^\d+:[0-9a-f]+$/.test(before))) return res.status(400).json({ error: "before is the next of the page before" });
      const asked = limit === undefined ? DEFAULT_PAGE : Number(limit);
      if (!Number.isInteger(asked) || asked < 1 || asked > MAX_PAGE) return res.status(400).json({ error: `limit is a whole number from 1 to ${MAX_PAGE}` });
      res.json(
        listPictures({
          ...(origin ? { origin: origin as PictureOrigin } : {}),
          ...(kind ? { kind: kind as PictureKind } : {}),
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
  router.get("/images/jobs", (_req, res) => {
    res.json({ jobs: listJobs(), limit: MAX_RUNNING });
  });

  /** Stops a picture that is being made, or clears a finished one from the list. */
  router.delete("/images/jobs/:id", (req, res) => {
    if (!stopJob(req.params.id)) return res.status(404).json({ error: "There is no such job" });
    res.json({ ok: true });
  });

  const refused = (res: Response, e: unknown) => (e instanceof JobRefusal ? res.status(e.status).json({ error: e.message }) : fail(res, e));

  /** Makes pictures from a description, and references where it has some: one request, and one job, for each; answers at once, without waiting for any. */
  router.post("/images/generate", json, (req, res) => {
    const job = parseGenerate(req.body);
    if (typeof job === "string") return res.status(400).json({ error: job });
    try {
      res.status(202).json({ jobs: startGenerations(job) });
    } catch (e) {
      refused(res, e);
    }
  });

  /** Changes pictures of the gallery as told. The mask is the only large thing in the request: base64 of a picture up to the size an edit takes. */
  router.post("/images/edit", http.json({ limit: Math.ceil((MAX_PICTURE_BYTES * 4) / 3) + 64 * 1024 }), (req, res) => {
    const job = parseEdit(req.body);
    if (typeof job === "string") return res.status(400).json({ error: job });
    try {
      res.status(202).json({ jobs: startEdit(job) });
    } catch (e) {
      refused(res, e);
    }
  });

  /**
   * A picture from the person's own files, put in the gallery to be changed. It is the file itself
   * as the body, up to the size an edit takes, and is kept as a picture only if its bytes say it is one.
   */
  router.post("/images/upload", http.raw({ type: () => true, limit: MAX_PICTURE_BYTES }), (req, res) => {
    const bytes: unknown = req.body;
    if (!Buffer.isBuffer(bytes) || !bytes.length) return res.status(400).json({ error: "There is no picture in the request" });
    const ext = pictureExt(bytes.subarray(0, 12));
    if (!ext) return res.status(400).json({ error: "That is not a PNG, JPEG, GIF or WebP picture" });
    try {
      res.status(201).json({ picture: addPagePicture({ bytes, ext, kind: "uploaded", prompt: uploadedName(req.query.name), params: {} }) });
    } catch (e) {
      fail(res, e);
    }
  });

  /** A picture, as the file it is: whole, for the viewer and a download. */
  router.get("/images/:id/file", (req, res) => {
    let opened: ReturnType<typeof openListed>;
    try {
      opened = openListed(req.params.id);
    } catch (e) {
      return fail(res, e);
    }
    // One of the page's own never changes under its id; one in a chat's folder is that folder's, and the browser asks.
    http.send(req, res, opened, { cache: opened.origin === "page" ? "private, max-age=86400" : "private, no-cache" });
  });

  /**
   * The small copy of a picture, which the tiles of the gallery show instead of the file. It is
   * made here, the first time it is asked for and again when the file has changed, and kept for
   * every view after that, of any person and any device. A picture that gets none is sent whole.
   */
  router.get("/images/:id/thumb", async (req, res) => {
    let opened: Awaited<ReturnType<typeof openListedThumb>>;
    try {
      opened = await openListedThumb(req.params.id);
    } catch (e) {
      return fail(res, e);
    }
    http.send(req, res, opened, { cache: opened.origin === "page" ? "private, max-age=86400" : "private, no-cache" });
  });

  /**
   * Takes pictures away, files and all, each as asked: a picture in a chat's folder goes from
   * the folder, for good. What could not be, is said for each; the rest is done.
   */
  router.post("/images/delete", json, async (req, res) => {
    const ids = parseIds(object(req.body).ids);
    if (typeof ids === "string") return res.status(400).json({ error: ids });
    const deleted: string[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const id of ids) {
      try {
        await deletePicture(id);
        deleted.push(id);
      } catch (e) {
        failed.push({ id, error: (e as Error).message });
      }
    }
    res.json({ deleted, failed });
  });

  router.delete("/images/:id", async (req, res) => {
    try {
      await deletePicture(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      fail(res, e);
    }
  });
}
