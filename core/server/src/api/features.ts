import express, { type Router } from "express";
import { getSession, sessionSubagentModel, setSessionSubagentModel } from "../db.js";
import { isModelChoice } from "../features.js";
import { isServing } from "../extension-host.js";
import { memoryHolder } from "../memory-holder.js";

/**
 * The subagent extension, by its package name: what the chat's model menu asks about until the extension draws that
 * row itself. It is switched in Settings → Extensions, and keeps its settings at its own address.
 */
const SUBAGENT_EXTENSION = "pithagoras-subagent";
/** Where the subagent extension keeps its settings: what /api/features/subagent was. */
const SUBAGENT_SETTINGS = `/api/x/${SUBAGENT_EXTENSION}/settings`;

/**
 * Whether the subagent tool is on, and what holds the agent's memory, where an extension does (`portal.memory.hold`).
 * And what one chat's subagents run on, which the chat's model menu sets.
 */
export function featuresRouter(): Router {
  const router = express.Router();

  /**
   * Only whether each is on: for the sidebar and every chat's menus, which need no more. The subagent tool is on where
   * its extension's server half runs, which registers it in every chat; and asks what holds the memory.
   */
  router.get("/features/flags", (_req, res) => {
    try {
      const holder = memoryHolder();
      res.json({
        subagent: { enabled: isServing(SUBAGENT_EXTENSION) },
        // What holds the agent's memory, where something does: its label.
        memory: { held: holder !== undefined, by: holder?.label ?? null },
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // The subagent's settings are its extension's now, at an address of its own; its switch is Settings → Extensions'.
  // The old address sends there, the method and the body kept, and answers what the extension does. A 307, not a 308:
  // a browser keeps a 308 for good, and an older version after a going back has no route there to answer it.
  router.get("/features/subagent", (_req, res) => res.redirect(307, SUBAGENT_SETTINGS));
  router.put("/features/subagent", (_req, res) => res.redirect(307, SUBAGENT_SETTINGS));

  /** What one chat's subagents run on: its own choice, or null for the extension's (GET /api/x/pithagoras-subagent/settings). */
  router.get("/sessions/:id/subagent-model", (req, res) => {
    if (!getSession(req.params.id)) return res.status(404).json({ error: "Not found" });
    res.json({ model: sessionSubagentModel(req.params.id) });
  });

  router.put("/sessions/:id/subagent-model", (req, res) => {
    if (!getSession(req.params.id)) return res.status(404).json({ error: "Not found" });
    const model = req.body?.model ?? null;
    if (model !== null && !isModelChoice(model)) return res.status(400).json({ error: 'model must be null, "auto" or provider/model' });
    // Asked when a subagent starts: nothing to reload.
    setSessionSubagentModel(req.params.id, model);
    res.json({ model });
  });

  return router;
}
