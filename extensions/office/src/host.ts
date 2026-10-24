import type { ServerPortal } from "@pithagoras/extension-api/server";
import type { Docker } from "../../docker/src/api";

/**
 * The portal this server half was started with, for every module of it to reach: Docker, the data folder, the log.
 * Set as the half starts (see server.ts), before anything else of it runs, and set again by a start after a stop: the
 * modules are loaded once, and outlive a stop.
 */
let current: ServerPortal | undefined;

export function setPortal(portal: ServerPortal): void {
  current = portal;
}

export function portal(): ServerPortal {
  if (!current) throw new Error("pithagoras-office's server half has not started");
  return current;
}

/** This extension's own data folder (settings, jwt-secret, the document library). */
export const dataDir = (): string => portal().dataDir();

/** Docker, which pithagoras-office requires (`pithagoras.requires` in its package.json): there whenever this half runs. */
export function docker(): Docker | undefined {
  return portal().extensions.use("pithagoras-docker");
}
