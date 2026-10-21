import type { ServerPortal } from "@pithagoras/extension-api/server";
import type { Docker } from "../../../docker/src/api";

/**
 * The portal this server half was started with, for every module of it to reach: Docker, voice mode, the log. Set as
 * the half starts (see server.ts), before anything else of it runs, and set again by a start after a stop: the modules
 * are loaded once, and outlive a stop.
 */
let current: ServerPortal | undefined;

export function setPortal(portal: ServerPortal): void {
  current = portal;
}

export function portal(): ServerPortal {
  if (!current) throw new Error("Voice's server half has not started");
  return current;
}

/** Docker, which Voice requires (`pithagoras.requires` in its package.json): there whenever this half runs. */
export const docker = (): Docker => portal().extensions.use<Docker>("pithagoras-docker")!;
