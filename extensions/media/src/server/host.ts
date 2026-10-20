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

let life = new AbortController();

/**
 * Aborted as the half stops. What the half sets going that runs on by itself, the small copies, posters and playable
 * copies being made and those waiting their turn, takes it as it is set going, and gives up then: a running ffmpeg is
 * killed, and what waits is not made. A start after the stop has a new one.
 */
export const stopSignal = (): AbortSignal => life.signal;

/** Gives up what the half set going, as it stops (see stopSignal). */
export function stopWork(): void {
  life.abort();
  life = new AbortController();
}
