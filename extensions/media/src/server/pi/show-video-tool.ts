import { closeSync } from "node:fs";
import path from "node:path";
import type { Chat, FileOpenOptions } from "@pithagoras/extension-api/server";
import { FileError } from "../file-error";
import { portal } from "../host";
import { SHOW_VIDEO_TOOL } from "../video-generation";
import { openVideo } from "../video-files";
import { pathBelow } from "../within";
import { object, text } from "./schema";
import type { MediaTool } from "./tools";

/**
 * Putting a clip in front of the person: one the agent made with a tool of its
 * own or downloaded, or one that is in the chat's folder for any other reason.
 * The page sees the call and plays it under the tool line in the chat.
 *
 * Only the chat's folder, for the same reason show_image keeps to it: the page
 * fetches the clip back through /sessions/:id/video, which serves nothing outside
 * it. A clip anywhere else is copied in first. The tool is there while video
 * generation is on, as the tools of that feature are (see mediaTools); there is
 * no clip to show for a person who has no use for the feature.
 */

/** Where `p` is below `root`, relative to it; null when it is not below it, or is `root` itself. */
const under = (root: string, p: string): string | null => pathBelow(root, p) || null;

/** Where `given` is inside the chat's folder, relative to it, or an explanation why it is not. `as` and `action` as for pictureIn. */
export function videoIn(chat: Chat, given: string, as: FileOpenOptions, action = "shown"): string {
  const base = portal().chats.folder(chat.id);
  // The folder as the agent names it may reach the real one through a link: an absolute path is taken inside either.
  // openVideo then checks what the path really leads to.
  const rel = under(base, path.resolve(base, given)) ?? under(path.resolve(chat.workspace), path.resolve(chat.workspace, given));
  if (!rel) {
    throw new FileError("invalid", `Only a video in the chat's folder can be ${action}. Copy it there first.`);
  }
  // Checked as the page will fetch it, so a call that succeeds is one that plays.
  closeSync(openVideo(base, rel, as).fd);
  return rel;
}

export const showVideoTool: MediaTool = {
  name: SHOW_VIDEO_TOOL,
  label: "show video",
  description:
    "Show the person a clip with a player: WebM or MP4 in the chat's folder (save or copy it there first). " +
    "Clips from generate_video are shown already. Give a short title; say briefly what it shows.",
  parameters: object(
    {
      path: text("The clip, relative to the chat's folder or absolute inside it"),
      title: text("A few words shown above it"),
    },
    ["title"],
  ),
  run: async (chat, p: { path: string; title?: string }) => {
    const rel = videoIn(chat, p.path, { likeParent: true, chats: [chat.id] });
    const title = typeof p.title === "string" ? p.title.trim().slice(0, 120) : "";
    const details = { files: [{ path: rel, ...(title ? { title } : {}) }] };
    return { content: [{ type: "text", text: `Shown to the user: ${rel}` }], details };
  },
};
