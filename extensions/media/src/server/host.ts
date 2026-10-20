import type { ServerPortal } from "@pithagoras/extension-api/server";

/**
 * The portal this server half was started with, for every module of it to reach: the chats and their folders,
 * `portal.files`, the folders the agents work in, the log. Set as the half starts (see server.ts), before anything
 * else of it runs, and set again by a start after a stop: the modules are loaded once, and outlive a stop.
 */
let current: ServerPortal | undefined;

export function setPortal(portal: ServerPortal): void {
  current = portal;
}

export function portal(): ServerPortal {
  if (!current) throw new Error("Media's server half has not started");
  return current;
}
