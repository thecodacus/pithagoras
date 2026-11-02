import type { Chat } from "@pithagoras/extension-api/server";
import { refusalOf } from "../file-error";
import { portal } from "../host";
import { MAX_PICTURE_BYTES, readPicture } from "../picture-files";
import { pictureIn } from "./show-image-tool";

/**
 * The pictures of the chat's folder that a tool sends to the image editing endpoint: the ones edit_image changes, and
 * the references generate_image makes a new picture from. Both read them the same way, as the chat's agent, which named
 * them, so that a picture the sandbox closed to it is not read for it.
 */

/** One picture: where it is in the folder, as show_image needs it, and its bytes. `action` is what is done with it, for the explanation. */
function readOne(chat: Chat, given: unknown, action: string): { path: string; bytes: Buffer } {
  if (typeof given !== "string") throw new Error("Name the picture by its path in the chat's folder.");
  const as = { likeParent: true, chats: [chat.id] };
  try {
    const at = pictureIn(chat, given, as, action);
    return { path: at, bytes: readPicture(portal().chats.folder(chat.id), at, as).bytes };
  } catch (e) {
    // The words the folder's routes have for it ("download it instead") are no way forward for an edit.
    if (refusalOf(e) === "too_large") {
      throw new Error(`The picture is over ${MAX_PICTURE_BYTES / 1024 / 1024} MB, which is more than can be read to be scaled down for an edit; say so to the person, or make a smaller copy of it first.`);
    }
    throw e;
  }
}

/**
 * Each picture named where it is in the chat's folder, and read from there: no other place is read. All of them before
 * anything is sent, in the order given; one that is refused refuses them all, and with several the message says which
 * (`label` and its place, "Picture 2 (style.jpg): …"), as the others may be fine.
 */
export function readChatPictures(chat: Chat, named: unknown[], label: string, action: string): { paths: string[]; images: Buffer[] } {
  const paths: string[] = [];
  const images: Buffer[] = [];
  for (const [i, given] of named.entries()) {
    try {
      const one = readOne(chat, given, action);
      paths.push(one.path);
      images.push(one.bytes);
    } catch (e) {
      if (named.length > 1 && e instanceof Error) throw new Error(`${label} ${i + 1} (${String(given)}): ${e.message}`);
      throw e;
    }
  }
  return { paths, images };
}
