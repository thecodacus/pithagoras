import type { Router } from "express";
import { portal } from "../host";
import { ImageGenerationError, imageEditingMultiple, imageEditingReady, imageGenerationReady, imageGenerationState, parseImageGenerationPatch, saveImageGeneration } from "../image-generation";
import { VideoGenerationError, parseVideoGenerationPatch, saveVideoGeneration, videoGenerationReady, videoGenerationState } from "../video-generation";

/**
 * The settings of the endpoints, for Media's page in Settings, and where Media stands, for the Media page and the
 * sidebar: the routes are the package's, at /api/x/pithagoras-media/…. A key is never in what they answer, only
 * whether one is set.
 */
export function settingsRoutes(router: Router): void {
  const { http, chats } = portal();
  // A body is read where a route asks for it, up to what the portal's own routes take: a parser's own limit is 100 kB.
  const json = http.json({ limit: "2mb" });

  /**
   * Only whether each is on: for the sidebar and the Media page, which need no more. Images is on when it can make
   * a picture or change one: switched on, and with an address to ask; Videos when it can make a clip.
   */
  router.get("/state", (_req, res) => {
    try {
      res.json({ images: { enabled: imageGenerationReady() || imageEditingReady() }, videos: { enabled: videoGenerationReady() } });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.get("/settings/images", (_req, res) => {
    try {
      res.json({ images: imageGenerationState() });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.get("/settings/videos", (_req, res) => {
    try {
      res.json({ videos: videoGenerationState() });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /**
   * The image endpoint and whether the agent has a tool for it, and for editing
   * a picture. A tool is there only while it is on and has an address, and a
   * chat decides that when it loads, so a change in either reloads the idle
   * ones. So does one in whether the edit tool takes a list of pictures, which
   * is the shape of its parameters, as editing being ready and taking several is
   * the shape of generate_image's references. The rest — address, model, size,
   * key, the Stable Diffusion switch — is read at each call and needs no reload.
   */
  router.put("/settings/images", json, async (req, res) => {
    const patch = parseImageGenerationPatch(req.body);
    if (typeof patch === "string") return res.status(400).json({ error: patch });
    try {
      const before = [imageGenerationReady(), imageEditingReady(), imageEditingMultiple()];
      saveImageGeneration(patch);
      const changed = imageGenerationReady() !== before[0] || imageEditingReady() !== before[1] || imageEditingMultiple() !== before[2];
      const { reloaded, waiting } = changed ? await chats.reload() : { reloaded: 0, waiting: 0 };
      res.json({ images: imageGenerationState(), changed, reloaded, waiting });
    } catch (e) {
      res.status(e instanceof ImageGenerationError ? 400 : 500).json({ error: (e as Error).message });
    }
  });

  /**
   * The video endpoint and whether the agent has the tools for it. A tool is there only while it is on and
   * has an address, and a chat decides that when it loads, so a change in that reloads the idle ones. The
   * rest — address, model, size, key, time limit — is read at each call and needs no reload.
   */
  router.put("/settings/videos", json, async (req, res) => {
    const patch = parseVideoGenerationPatch(req.body);
    if (typeof patch === "string") return res.status(400).json({ error: patch });
    try {
      const before = videoGenerationReady();
      saveVideoGeneration(patch);
      const changed = videoGenerationReady() !== before;
      const { reloaded, waiting } = changed ? await chats.reload() : { reloaded: 0, waiting: 0 };
      res.json({ videos: videoGenerationState(), changed, reloaded, waiting });
    } catch (e) {
      res.status(e instanceof VideoGenerationError ? 400 : 500).json({ error: (e as Error).message });
    }
  });
}
