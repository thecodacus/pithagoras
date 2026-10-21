import express, { type Router } from "express";
import { getSession, packageRemoved, sessionSubagentModel, setSessionSubagentModel } from "../db.js";
import { SUBAGENT_MAX_PARALLEL, bundledSubagentDir, isModelChoice, piPackageArg, subagentModelOf, subagentState } from "../features.js";
import { readPiSettings, updatePiSettings } from "../pi-settings.js";
import { sessions } from "../session-manager.js";
import { followPackages, switchPackage } from "./extensions.js";
import { memoryHolder } from "../memory-holder.js";
import { pi } from "./packages.js";

/**
 * The opt-in subagent tool: whether it is on, and switching it. A switch reloads
 * the idle conversations, as switching a package does, so it is there without a
 * restart; a running one keeps what it had until it is reloaded. And what holds
 * the agent's memory, where an extension does (`portal.memory.hold`).
 */
export function featuresRouter(): Router {
  const router = express.Router();

  /**
   * Only whether each is on: for the sidebar and every chat's menus, which
   * need no more. Reads pi's settings, and asks what holds the memory.
   */
  router.get("/features/flags", (_req, res) => {
    try {
      const holder = memoryHolder();
      res.json({
        subagent: { enabled: subagentState().enabled },
        // What holds the agent's memory, where something does: its label.
        memory: { held: holder !== undefined, by: holder?.label ?? null },
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.get("/features/subagent", (_req, res) => {
    try {
      res.json({ subagent: subagentState() });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.put("/features/subagent", async (req, res) => {
    const { enabled, mode, maxParallel, model } = req.body ?? {};
    if (model !== undefined && !isModelChoice(model)) return res.status(400).json({ error: 'model must be "auto" or provider/model' });
    if (enabled !== undefined && typeof enabled !== "boolean") return res.status(400).json({ error: "enabled must be true or false" });
    if (mode !== undefined && mode !== "interrupt" && mode !== "background") {
      return res.status(400).json({ error: "mode must be interrupt or background" });
    }
    if (maxParallel !== undefined && !(Number.isInteger(maxParallel) && maxParallel >= 1 && maxParallel <= SUBAGENT_MAX_PARALLEL)) {
      return res.status(400).json({ error: `maxParallel must be a whole number from 1 to ${SUBAGENT_MAX_PARALLEL}` });
    }
    try {
      if (mode || maxParallel !== undefined || model !== undefined) {
        // What the tool does without being told is left unsaid: interrupt, one at a time, the chat's model.
        await updatePiSettings((all) => {
          if (model === "auto") delete all.subagentModel;
          else if (model !== undefined) all.subagentModel = model;
          if (mode === "background") all.subagentMode = "background";
          else if (mode) delete all.subagentMode;
          if (maxParallel === 1) delete all.subagentMaxParallel;
          else if (maxParallel !== undefined) all.subagentMaxParallel = maxParallel;
        });
      }
      const state = subagentState();
      if (enabled === true && !state.enabled) {
        if (state.source) await switchPackage(state.source, true);
        else {
          const bundled = bundledSubagentDir();
          if (!bundled) return res.status(409).json({ error: "The subagent tool is not part of this install" });
          await pi(["install", bundled]);
        }
      }
      if (enabled === false && state.source) {
        await pi(["remove", piPackageArg(state.source)]);
        await packageRemoved(state.source);
      }
      // A package installed, removed or switched: its server half follows, where it has one.
      if (enabled !== undefined) await followPackages();
      // The mode changes what the tool tells the model, which it reads when it is loaded.
      const { reloaded, waiting } = await sessions.reloadIdle();
      res.json({ subagent: subagentState(), reloaded, waiting });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** What one chat's subagents run on: its own choice, or null for the portal's default. */
  router.get("/sessions/:id/subagent-model", (req, res) => {
    if (!getSession(req.params.id)) return res.status(404).json({ error: "Not found" });
    res.json({ model: sessionSubagentModel(req.params.id), default: subagentModelOf(readPiSettings()) });
  });

  router.put("/sessions/:id/subagent-model", (req, res) => {
    if (!getSession(req.params.id)) return res.status(404).json({ error: "Not found" });
    const model = req.body?.model ?? null;
    if (model !== null && !isModelChoice(model)) return res.status(400).json({ error: 'model must be null, "auto" or provider/model' });
    // Asked when a subagent starts: nothing to reload.
    setSessionSubagentModel(req.params.id, model);
    res.json({ model, default: subagentModelOf(readPiSettings()) });
  });

  return router;
}
