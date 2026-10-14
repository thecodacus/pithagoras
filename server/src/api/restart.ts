import express, { type Router } from "express";
import { loginsSurviveRestart } from "../auth.js";
import { runningSessionCount } from "../db.js";
import { LOG_BOOT } from "../logs.js";
import { holdRestart, restartPortal, restartSupport, type RestartSupport } from "../restart.js";
import { loadedExtensions } from "./extensions.js";
import { portalUpdater } from "./update.js";

export interface RestartDeps {
  support: () => Promise<RestartSupport>;
  restart: (support: Extract<RestartSupport, { ok: true }>) => Promise<void>;
  running: () => number;
  now: () => Date;
  /** An update is going on: it has moved the files the portal starts from aside, and a stop now would leave it without them. */
  updating: () => boolean;
  /** Tells the update that a restart is on its way, or that it is not any more. */
  hold: (on: boolean) => void;
  /** The extensions this start of the portal runs, and whether a login outlives the restart. */
  loaded: () => string[] | null;
  keepsLogins: () => boolean;
}

const UPDATING = "An update is running. Restarting now would cut it off and could leave the portal without its files. Wait until it has finished.";

const real: RestartDeps = {
  support: () => restartSupport(),
  restart: (s) => restartPortal(undefined, undefined, s.mode),
  running: runningSessionCount,
  now: () => new Date(),
  updating: () => portalUpdater.working,
  hold: holdRestart,
  loaded: loadedExtensions,
  keepsLogins: loginsSurviveRestart,
};

/**
 * Settings → About → Restart: the portal ends and whatever runs it starts it again.
 *
 * Behind the login like every route under /api, and like the update: whoever can sign in already has a shell on the host.
 * The stop is the one a SIGTERM makes (running chats wound down, requests given their time), and the portal ends with
 * `RESTART_EXIT`, which is what the unit's `Restart=on-failure` and Docker's restart policy start it again from.
 */
export function restartRouter(deps: RestartDeps = real): Router {
  const router = express.Router();
  let restarting = false;

  /** Whether a restart would bring the portal back, and what it would stop. Changes nothing. */
  router.get("/restart", async (_req, res) => {
    const support = await deps.support();
    const state = deps.updating()
      ? { possible: false, code: "update", reason: UPDATING }
      : support.ok ? { possible: true, by: support.by } : { possible: false, code: support.code, reason: support.message };
    res.json({ ...state, running: deps.running(), loaded: deps.loaded(), keepsLogins: deps.keepsLogins() });
  });

  /** `{ confirm: true }` is required, as the update wants the commit it showed: nothing starts from a request that did not ask. */
  router.post("/restart", async (req, res) => {
    if (req.body?.confirm !== true) return res.status(400).json({ error: "Send { confirm: true } to restart the portal.", code: "confirm" });
    if (restarting) return res.status(409).json({ error: "The portal is already restarting.", code: "busy" });
    if (deps.updating()) return res.status(409).json({ error: UPDATING, code: "update" });
    restarting = true;
    deps.hold(true);
    try {
      const support = await deps.support();
      if (!support.ok) {
        restarting = false;
        deps.hold(false);
        return res.status(409).json({ error: support.message, code: support.code });
      }
      const running = deps.running();
      // Who: the one login the portal has. Where from, for the log.
      console.log(`[restart] the owner asked for a restart at ${deps.now().toISOString()} from ${req.ip ?? "an unknown address"}, started again by ${support.by}; ${running} running ${running === 1 ? "chat or routine ends" : "chats or routines end"}`);
      await deps.restart(support);
      res.status(202).json({ restarting: true, boot: LOG_BOOT });
    } catch (e) {
      restarting = false;
      deps.hold(false);
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return router;
}
