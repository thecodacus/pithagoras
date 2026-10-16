import type { Item } from "./transcript";
import { insideFolder } from "./file-activity";
import type { ViewerPicture } from "./image-viewer";
import { t } from "./i18n";

/** Where a chat's pictures are fetched from: the portal's address for a sent one and for one in the folder. */
export interface PictureUrls {
  sent: (name: string) => string;
  shown: (path: string, version: string) => string;
}

/** The id of a picture the person sent, and of one a call gave, as the viewer is told. */
export const sentPictureId = (itemId: string, name: string) => `sent:${itemId}:${name}`;
export const shownPictureId = (itemId: string, path: string) => `shown:${itemId}:${path}`;

/**
 * Every picture in a conversation, oldest first: what the person sent and the
 * pictures calls gave (see file-outputs.ts). This is what the viewer steps
 * through.
 *
 * A changed picture is tied to the one it was changed from when that was shown
 * in the conversation too: the call says what it was made from (`from`; the
 * first of them, when there are several), and the latest picture by that path
 * before it is the one it started from. An original that never appeared here —
 * a file the agent was told about, a picture it had not shown — has nothing to
 * reach it, and the link is left out.
 */
export function chatPictures(items: Item[], folder: string, urls: PictureUrls): ViewerPicture[] {
  const list: ViewerPicture[] = [];
  const latestByPath = new Map<string, string>();
  for (const item of items) {
    if (item.kind === "user" && item.images) {
      for (const image of item.images) {
        list.push({ id: sentPictureId(item.id, image.name), src: urls.sent(image.name), alt: t("A picture sent with this message"), fileName: image.name });
      }
    } else if (item.kind === "tool") {
      for (const { path, title, kind, from: made } of item.files ?? []) {
        if (kind !== "picture") continue;
        const id = shownPictureId(item.id, path);
        const changed = made?.[0] && insideFolder(folder, made[0]);
        const from = changed && latestByPath.get(changed);
        list.push({
          id,
          // By the end that showed it, which is the version every other place draws it by (voice mode's window, a card's tile), so that the browser has one download for it, not one for each.
          src: urls.shown(path, String(item.filesSeq ?? item.id)),
          alt: title ?? path,
          ...(title ? { caption: title } : {}),
          fileName: path.split("/").pop() || undefined,
          ...(from ? { from } : {}),
        });
        const own = insideFolder(folder, path);
        if (own) latestByPath.set(own, id);
      }
    }
  }
  return list;
}
