import type { PortalEvent, ToolCallView } from "@pithagoras/extension-api";
import { insideFolder } from "./helpers";

/** A file the agent has just read or changed, as a path inside the chat's folder. */
export interface FileActivity {
  /** The event it was noticed at; a newer one means "look again", even at the same file. */
  seq: number;
  path: string;
  tool: "read" | "write" | "edit";
}

const TOOLS = new Set(["read", "write", "edit"]);
// pi has spelled the name `toolName` and `name`, and the arguments `input`, `args` and `parameters`.
const nameOf = (p: any): string => String(p?.toolName ?? p?.name ?? "");
const givenPath = (input: any): string | undefined => {
  const given = input?.path ?? input?.file_path;
  return typeof given === "string" && given ? given : undefined;
};
const pathOf = (p: any): string | undefined => givenPath(p?.input ?? p?.args ?? p?.parameters);

/** The entry it was before when nothing in it differs, so that what is handed it on is not seen as changed by a later event that was about something else. */
export function keepFileActivity(was: FileActivity | null, next: FileActivity | null): FileActivity | null {
  return was && next && was.seq === next.seq && was.path === next.path && was.tool === next.tool ? was : next;
}

/**
 * The file the agent most recently read or changed in the chat's folder, if any.
 *
 * A read is noticed when it starts, since the file is there to be shown. A write
 * or an edit is noticed when it ends: before that there may be nothing to see,
 * or the old text. The path of an ending comes from the call that began it.
 */
export function latestFileActivity(events: readonly PortalEvent[], folder: string): FileActivity | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    const p = event.payload;
    const tool = nameOf(p);
    if (!TOOLS.has(tool)) continue;
    let given: string | undefined;
    if (event.type === "tool_execution_start" && tool === "read") given = pathOf(p);
    else if (event.type === "tool_execution_end" && tool !== "read" && !p?.isError) {
      given = pathOf(p);
      if (!given) {
        // Only with a call id to look for; without one the scan could never match, and would still walk every event.
        for (let j = i - 1; j >= 0 && !given && p?.toolCallId; j--) {
          const before = events[j];
          if (before.type === "tool_execution_start" && before.payload?.toolCallId === p.toolCallId) given = pathOf(before.payload);
        }
      }
    } else continue;
    const inside = given && insideFolder(folder, given);
    // Somewhere else is somebody else's file, and the last one that counts is still the latest.
    if (inside) return { seq: event.seq, path: inside, tool: tool as FileActivity["tool"] };
  }
  return null;
}

/** The file in the chat's folder a call of the agent's reads or changes, by its path there; undefined for any other call. */
export function fileOfCall(call: ToolCallView, folder: string): string | undefined {
  if (!TOOLS.has(call.name)) return undefined;
  const given = givenPath(call.input);
  return given ? insideFolder(folder, given) : undefined;
}
