import type { ServerPortal } from "@pithagoras/extension-api/server";

/**
 * The portal this server half was started with, for every module of it to reach: voice mode, the log, its folder. Set
 * as the half starts (see server.ts), before anything else of it runs, and set again by a start after a stop: the
 * modules are loaded once, and outlive a stop.
 */
let current: ServerPortal | undefined;

export function setPortal(portal: ServerPortal): void {
  current = portal;
}

export function portal(): ServerPortal {
  if (!current) throw new Error("Voice servers' server half has not started");
  return current;
}
