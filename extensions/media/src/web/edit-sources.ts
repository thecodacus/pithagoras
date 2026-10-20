import { portal } from "../portal";
import type { GalleryPicture } from "./api";
import { MAX_EDIT_PICTURES } from "../server/image-settings";

/**
 * The pictures an edit on the Media page works from, and how that list
 * changes: what the editor (ImageMaker.tsx) works out without a page.
 *
 * The list is in the order the request sends it: the endpoint knows the
 * pictures by their place, the description says "the second picture", and the
 * mask belongs to the first. Whether it may hold more than one is said of the
 * editing endpoint (Media in Settings, "Several pictures per edit"), and
 * a request that names more than it takes is refused by the portal; here the
 * list is kept within what is allowed, and what could not be kept is counted, so
 * that the page can say so rather than drop it without a word.
 */

/** The most pictures one edit takes, as the portal sets it. */
export const MAX_SOURCES = MAX_EDIT_PICTURES;

export interface Added {
  list: GalleryPicture[];
  /** How many of the added pictures were not taken: there was no room, or the endpoint takes one. */
  left: number;
}

/**
 * `current` with `added` after it, and what did not fit counted. A picture that is in the list already is not
 * added twice, and is no loss. Where the endpoint takes one picture (`multiple` is false) a picture put in takes
 * the place of the one there is: the first of what was added, as the person means to change that.
 */
export function addSources(current: readonly GalleryPicture[], added: readonly GalleryPicture[], multiple: boolean): Added {
  if (!multiple) return { list: added.slice(0, 1), left: Math.max(0, added.length - 1) };
  const have = new Set(current.map((p) => p.id));
  const fresh = added.filter((p, i) => !have.has(p.id) && added.findIndex((q) => q.id === p.id) === i);
  const room = Math.max(0, MAX_SOURCES - current.length);
  return { list: [...current, ...fresh.slice(0, room)], left: Math.max(0, fresh.length - room) };
}

/** What follows the address of the gallery's pictures (api.galleryFileUrl) in what an `<img>` of the gallery has for its `src`. */
const FILE_PATH = /^([0-9a-f]{12})\/file$/;

/**
 * The pictures of the gallery that a drag or a paste names by their address. A browser that is made to drag or
 * copy a picture of the page hands over a file made from it, with its address beside it (`uris` is the
 * `text/uri-list` of the data, `html` its `text/html`). That file is the gallery's own picture, not one from
 * the person's computer: taken as a file it would be uploaded, and be in the gallery twice. Only addresses of
 * this portal (`origin`) count, so that a picture of another site with the same path is a file like any other.
 * Each picture once, in the order named.
 */
export function galleryIdsIn({ uris = "", html = "" }: { uris?: string; html?: string }, origin: string): string[] {
  const sources = [
    ...uris.split(/\r?\n/).filter((line) => line && !line.startsWith("#")),
    ...[...html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((m) => m[1] ?? m[2]),
  ];
  // The server half's routes are under the package's own address, which the portal gives it.
  const pictures = portal.api.url("/images/");
  const ids: string[] = [];
  for (const source of sources) {
    let url: URL;
    try {
      url = new URL(source.trim(), origin);
    } catch {
      continue;
    }
    const id = url.origin === new URL(origin).origin && url.pathname.startsWith(pictures) ? FILE_PATH.exec(url.pathname.slice(pictures.length))?.[1] : undefined;
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** How many more pictures a list can be given at once: all that are left of the limit, and one where it takes one. */
export const roomFor = (have: number, multiple: boolean): number => (multiple ? Math.max(0, MAX_SOURCES - have) : 1);

/** `list` with the picture at `index` one place earlier (`by` -1) or later (1); the list itself where there is no such place. */
export function moved<T>(list: readonly T[], index: number, by: -1 | 1): T[] {
  const to = index + by;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return [...list];
  const next = [...list];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

/** `list` with the picture `id` taken out and put at place `to`, the others keeping their order: what dragging one to another's place does. The list itself, copied, where there is no such picture or place. */
export function moveTo<T extends { id: string }>(list: readonly T[], id: string, to: number): T[] {
  const from = list.findIndex((p) => p.id === id);
  if (from < 0 || to < 0 || to >= list.length || from === to) return [...list];
  const next = [...list];
  const [one] = next.splice(from, 1);
  next.splice(to, 0, one);
  return next;
}

/** What a picture is called where it stands among others: what it was made from, else its file, on one line. */
export function sourceName(picture: GalleryPicture, longest = 60): string {
  const flat = (picture.prompt || picture.fileName).replace(/\s+/g, " ").trim();
  return flat.length > longest ? `${flat.slice(0, longest - 1)}…` : flat;
}

/**
 * Why the pictures cannot be sent as they are, in the form's own terms, or nothing when they can:
 * "one" is several where the endpoint takes one. How much they weigh is no reason: pictures that are too heavy together are
 * scaled down by the server half.
 */
export function refusal(list: readonly GalleryPicture[], multiple: boolean): "one" | undefined {
  return !multiple && list.length > 1 ? "one" : undefined;
}
