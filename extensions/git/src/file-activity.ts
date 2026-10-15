import type { PortalEvent } from "@pithagoras/extension-api";
import { below } from "./helpers";

/**
 * When the agent last read or changed a file in the chat's folder: the event it
 * was noticed at, for the panel to look again. As the portal's own Files panel
 * notices it: a read when it starts, a write or an edit when it ends (the path
 * of an ending comes from the call that began it), and a file somewhere else is
 * somebody else's.
 */

const TOOLS = new Set(["read", "write", "edit"]);
const nameOf = (p: any): string => String(p?.toolName ?? p?.name ?? "");
const pathOf = (p: any): string | undefined => {
  const input = p?.input ?? p?.args ?? p?.parameters ?? {};
  const given = input.path ?? input.file_path;
  return typeof given === "string" && given ? given : undefined;
};

/** `given`, as the agent wrote it (relative to where it works, or absolute), as a path inside `folder`; undefined elsewhere. */
function insideFolder(folder: string, given: string): string | undefined {
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

export function latestFileActivity(events: readonly PortalEvent[], folder: string): number | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    const p = event.payload;
    const tool = nameOf(p);
    if (!TOOLS.has(tool)) continue;
    let given: string | undefined;
    if (event.type === "tool_execution_start" && tool === "read") given = pathOf(p);
    else if (event.type === "tool_execution_end" && tool !== "read" && !p?.isError) {
      given = pathOf(p);
      // Only with a call id to look for; without one the scan could never match, and would still walk every event.
      for (let j = i - 1; j >= 0 && !given && p?.toolCallId; j--) {
        const before = events[j];
        if (before.type === "tool_execution_start" && before.payload?.toolCallId === p.toolCallId) given = pathOf(before.payload);
      }
    } else continue;
    if (given && insideFolder(folder, given)) return event.seq;
  }
  return undefined;
}
