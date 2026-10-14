import express, { type Router } from "express";
import { runningSessionCount } from "../db.js";
import { LOG_BOOT } from "../logs.js";
import { restartPending, restartPortal, restartProblem } from "../restart.js";
import { Updater, UpdateError, installRoot, realExec, type Notice } from "../update.js";
import { fileArtifacts } from "../update-files.js";

const root = installRoot();

/** What this portal updates: its own checkout. */
export const portalUpdater = new Updater({
  root,
  exec: realExec(root),
  running: runningSessionCount,
  artifacts: fileArtifacts(root),
  restart: () => restartPortal(),
  restartProblem: () => restartProblem(),
  restartPending,
  onRaise: (notice: Notice) => console.log(`[update] ${notice.count} new ${notice.count === 1 ? "commit" : "commits"} on main, update available (${notice.target.sha.slice(0, 7)})`),
});

/**
 * Checks for new commits at the start and then on a schedule: see `Updater.begin`. `PORTAL_UPDATE_CHECK=off` leaves
 * the schedule out, for a portal that is not to ask its remote by itself; the Update button still asks when it is pressed.
 */
export const startUpdateChecks = (): void => {
  if (/^(off|0|false|no)$/i.test(process.env.PORTAL_UPDATE_CHECK ?? "")) return;
  void portalUpdater.begin();
};

const failure = (res: express.Response, e: unknown) => {
  if (e instanceof UpdateError) return res.status(e.status).json({ error: e.message, code: e.code });
  res.status(500).json({ error: (e as Error).message });
};

/**
 * Settings → About: the Update button, and the notice that new commits are on main.
 *
 * Open to whoever is signed in, as everything is: the login already hands out a shell on the host.
 */
export function updateRouter(updater: Updater = portalUpdater): Router {
  const router = express.Router();

  /** Where things stand, from memory: the remote is not asked. `boot` is how the page tells that the portal came back new. */
  router.get("/update", async (_req, res) => {
    try {
      res.json({ ...(await updater.status()), boot: LOG_BOOT });
    } catch (e) {
      failure(res, e);
    }
  });

  /** Asks the remote, and says what an update would do and what stands in its way. Changes nothing. */
  router.post("/update/check", async (_req, res) => {
    try {
      res.json(await updater.check());
    } catch (e) {
      failure(res, e);
    }
  });

  /** `{ expect }` is the commit the person was shown, and is required: without it nothing is started. */
  router.post("/update", async (req, res) => {
    try {
      res.status(202).json({ run: await updater.start(req.body?.expect) });
    } catch (e) {
      failure(res, e);
    }
  });

  return router;
}
