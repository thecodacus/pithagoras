import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../atomic-write.js";
import { DATA_DIR } from "../data-dir.js";

/**
 * A little of a channel's own memory that outlives its start: ctx.state.
 *
 * Everything else a package knows is gone when it is stopped, which is every
 * time the portal restarts or the channel's form is saved. Most need nothing
 * more. One that reads a stream it can resume — Signal's, from the last event
 * it saw — has to know where it was, or what arrived while it was stopped is
 * never read. A file per channel rather than a row: it is written as messages
 * come in, and nothing else in the database has to hear of it.
 */

/** Plenty for a cursor or two; a package keeping more than this wants its own store. */
export const MAX_STATE_BYTES = 64 * 1024;

const ID = /^[A-Za-z0-9_-]{1,64}$/;

const folder = (): string => path.resolve(DATA_DIR, "channel-state");

function fileOf(channelId: string): string {
  if (!ID.test(channelId)) throw new Error(`"${channelId}" is not a channel id`);
  return path.join(folder(), `${channelId}.json`);
}

/** What the channel kept, or undefined when it kept nothing or it cannot be read. */
export function readChannelState(channelId: string): unknown {
  try {
    return JSON.parse(readFileSync(fileOf(channelId), "utf8"));
  } catch {
    return undefined;
  }
}

/** Keeps `value` in place of what was kept; undefined or null forgets it. */
export function writeChannelState(channelId: string, value: unknown): void {
  const file = fileOf(channelId);
  if (value === undefined || value === null) return void rmSync(file, { force: true });
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("ctx.state.set takes a value JSON can hold");
  if (Buffer.byteLength(text) > MAX_STATE_BYTES) throw new Error(`ctx.state holds at most ${MAX_STATE_BYTES / 1024} KB`);
  mkdirSync(folder(), { recursive: true });
  writeFileAtomic(file, text, 0o600);
}

/** When the channel goes: what it kept was for it alone. */
export const removeChannelState = (channelId: string): void => {
  try {
    rmSync(fileOf(channelId), { force: true });
  } catch {
    // Not an id one could have kept anything under.
  }
};
