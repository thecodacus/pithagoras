import express, { type Router } from "express";
import { memoryHolder } from "../memory-holder.js";

/**
 * Where the subagent extension (extensions/subagent) keeps what the portal kept for it at these addresses before: its
 * settings, and what each chat's subagents run on. It is switched in Settings → Extensions.
 */
const SUBAGENT_EXTENSION = "/api/x/pithagoras-subagent";

/** What holds the agent's memory, where an extension does (`portal.memory.hold`); and the subagent's old addresses. */
export function featuresRouter(): Router {
  const router = express.Router();

  /** Only whether something holds the memory, by its label: for the chat's menus and the Projects page, which need no more. */
  router.get("/features/flags", (_req, res) => {
    try {
      const holder = memoryHolder();
      res.json({ memory: { held: holder !== undefined, by: holder?.label ?? null } });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // The subagent's settings and each chat's choice of its model are its extension's, at addresses of its own. The old
  // ones send there, the method and the body kept, and answer what the extension does. A 307, not a 308: a browser
  // keeps a 308 for good, and an older version after a going back has no route there to answer it.
  router.get("/features/subagent", (_req, res) => res.redirect(307, `${SUBAGENT_EXTENSION}/settings`));
  router.put("/features/subagent", (_req, res) => res.redirect(307, `${SUBAGENT_EXTENSION}/settings`));
  router.get("/sessions/:id/subagent-model", (req, res) => res.redirect(307, `${SUBAGENT_EXTENSION}/chats/${encodeURIComponent(req.params.id)}/model`));
  router.put("/sessions/:id/subagent-model", (req, res) => res.redirect(307, `${SUBAGENT_EXTENSION}/chats/${encodeURIComponent(req.params.id)}/model`));

  return router;
}
