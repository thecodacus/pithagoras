import { closeSync } from "node:fs";
import path from "node:path";
import type { Chat, FileOpenOptions } from "@pithagoras/extension-api/server";
import { FileError } from "../file-error";
import { portal } from "../host";
import { openPicture } from "../picture-files";
import { pathBelow } from "../within";
import { object, text } from "./schema";
import type { MediaTool } from "./tools";

/**
 * Putting a picture in front of the person: a chart the agent drew, a
 * screenshot it saved, a photo it found.
 *
 * The agent has always been able to make pictures — it has a shell — but not
 * to show one: in voice mode there is nothing on the screen but the orb, and in
 * the chat a file name is all that appears. This names a picture in the chat's
 * folder; the page sees the call, and shows it (the picture window in voice
 * mode, a thumbnail under the tool line in the chat).
 *
 * Only the chat's folder, for the same reason the Files panel keeps to it: the
 * page fetches the picture back through /sessions/:id/picture, which serves
 * nothing outside it. A picture anywhere else is copied in first.
 */

/** Where `p` is below `root`, relative to it; null when it is not below it, or is `root` itself. */
const under = (root: string, p: string): string | null => pathBelow(root, p) || null;

/**
 * Where `given` is inside the chat's folder, relative to it, or an explanation why it is not. `as` is who it is opened for: for a path the agent
 * gave, its chat's agent (`likeParent`), so that a picture the sandbox closed to the agent is not read for it. `action` is what is to be done
 * with the picture, for the explanation.
 */
export function pictureIn(chat: Chat, given: string, as: FileOpenOptions, action = "shown"): string {
  const base = portal().chats.folder(chat.id);
  // The folder as the agent names it may reach the real one through a link:
  // an absolute path is taken inside either. openPicture then checks what the
  // path really leads to.
  const rel = under(base, path.resolve(base, given)) ?? under(path.resolve(chat.workspace), path.resolve(chat.workspace, given));
  if (!rel) {
    throw new FileError("invalid", `Only a picture in the chat's folder can be ${action}. Copy it there first.`);
  }
  // Checked as the page will fetch it, so a call that succeeds is one that shows.
  closeSync(openPicture(base, rel, as).fd);
  return rel;
}

export const showImageTool: MediaTool = {
  name: "show_image",
  label: "show image",
  description:
    "Show the person a picture: PNG, JPEG, GIF or WebP in the chat's folder (save or copy it there first). " +
    "In voice mode the only way they see one. Give a short title; say briefly what it shows.",
  parameters: object(
    {
      path: text("The picture, relative to the chat's folder or absolute inside it"),
      title: text("A few words shown above it"),
    },
    ["title"],
  ),
  // In a spoken conversation it is the only way the person sees a picture.
  voiceGuidelines: ["To show the user a picture, chart, diagram or screenshot, save it as a PNG, JPEG, GIF or WebP in the chat folder and call show_image."],
  run: async (chat, p: { path: string; title?: string }) => {
    const rel = pictureIn(chat, p.path, { likeParent: true, chats: [chat.id] });
    const title = typeof p.title === "string" ? p.title.trim().slice(0, 120) : "";
    const details = { files: [{ path: rel, ...(title ? { title } : {}) }] };
    return { content: [{ type: "text", text: `Shown to the user: ${rel}` }], details };
  },
};
