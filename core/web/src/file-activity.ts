import type { PortalEvent } from "./api";
import { below } from "./paths";
import { toolArgsOf, toolNameOf } from "./tool-payload";

/** A file the agent has just read or changed, as a path inside the chat's folder. */
export interface FileActivity {
  /** The event it was noticed at; a newer one means "look again", even at the same file. */
  seq: number;
  path: string;
  tool: "read" | "write" | "edit";
}

const TOOLS = new Set(["read", "write", "edit"]);
const pathOf = (p: any): string | undefined => {
  const input = toolArgsOf(p) ?? {};
  const given = input.path ?? input.file_path;
  return typeof given === "string" && given ? given : undefined;
};

/**
 * `given` — as the agent wrote it, relative to where it works or absolute — as a
 * path inside `folder`, or undefined when it is somewhere else.
 */
export function insideFolder(folder: string, given: string): string | undefined {
  let text = given;
  if (text.startsWith("/")) {
    const under = below(folder, text);
    if (under === undefined) return undefined;
    text = under;
  }
  const parts: string[] = [];
  for (const part of text.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!parts.pop()) return undefined;
    } else parts.push(part);
  }
  return parts.length ? parts.join("/") : undefined;
}

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
export function latestFileActivity(events: PortalEvent[], folder: string): FileActivity | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    const p = event.payload;
    const tool = toolNameOf(p);
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
