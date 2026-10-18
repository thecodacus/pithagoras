import type { FileActivity } from "@pithagoras/extension-api";

/** The entry it was before when nothing in it differs, so that what is handed it on is not seen as changed by a later event that was about something else. */
export function keepFileActivity(was: FileActivity | null, next: FileActivity | null): FileActivity | null {
  return was && next && was.seq === next.seq && was.path === next.path && was.tool === next.tool ? was : next;
}
