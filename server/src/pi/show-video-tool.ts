import { closeSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { pathBelow } from "../within.js";
import { SHOW_VIDEO_TOOL, videoGenerationReady } from "../video-generation.js";
import { openVideo } from "../video-files.js";
import { FileError, baseDir } from "../workspace-files.js";

/**
 * Putting a clip in front of the person: one the agent made with a tool of its
 * own or downloaded, or one that is in the chat's folder for any other reason.
 * The page sees the call and plays it under the tool line in the chat.
 *
 * Only the chat's folder, for the same reason show_image keeps to it: the page
 * fetches the clip back through /sessions/:id/video, which serves nothing outside
 * it. A clip anywhere else is copied in first. The tool is there while video
 * generation is on, as the tools of that feature are; there is no clip to show
 * for a person who has no use for the feature.
 */

/** Where `p` is below `root`, relative to it; null when it is not below it, or is `root` itself. */
const under = (root: string, p: string): string | null => pathBelow(root, p) || null;

/** Where `given` is inside `folder`, relative to it, or an explanation why it is not. `action` is what is to be done with the clip, for that. */
export function videoIn(folder: string, given: string, action = "shown"): string {
  const base = baseDir(folder);
  // The folder as the agent names it may reach the real one through a link: an absolute path is taken inside either.
  // openVideo then checks what the path really leads to.
  const rel = under(base, path.resolve(base, given)) ?? under(path.resolve(folder), path.resolve(folder, given));
  if (!rel) {
    throw new FileError("invalid", `Only a video in the chat's folder can be ${action}. Copy it there first.`);
  }
  // Checked as the page will fetch it, so a call that succeeds is one that plays.
  closeSync(openVideo(base, rel).fd);
  return rel;
}

/** An ExtensionFactory — see pi's InlineExtension. Registers nothing while video generation is off or has no address. */
export function showVideoTool(folder: string) {
  return (pi: any) => {
    if (!videoGenerationReady()) return;
    pi.registerTool({
      name: SHOW_VIDEO_TOOL,
      label: "show video",
      description:
        "Show the person a clip with a player: WebM or MP4 in the chat's folder (save or copy it there first). " +
        "Clips from generate_video are shown already. Give a short title; say briefly what it shows.",
      parameters: Type.Object({
        path: Type.String({ description: "The clip, relative to the chat's folder or absolute inside it" }),
        title: Type.Optional(Type.String({ description: "A few words shown above it" })),
      }),
      execute: async (_id: string, p: { path: string; title?: string }) => {
        const rel = videoIn(folder, p.path);
        const title = typeof p.title === "string" ? p.title.trim().slice(0, 120) : "";
        const details = { path: rel, ...(title ? { title } : {}) };
        return { content: [{ type: "text", text: `Shown to the user: ${rel}` }], details };
      },
    });
  };
}
