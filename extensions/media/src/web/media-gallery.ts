import type { GalleryPicture, GalleryVideo, PictureKind, PictureOrigin, VideoKind } from "./api";
import type { Filter as PictureFilter, Tile as PictureTile } from "./images-gallery";
import type { Filter as VideoFilter, Tile as VideoTile } from "./videos-gallery";
import { msg, t } from "../portal";

/**
 * What the Media page (MediaPage.tsx) works out without a page: which of the pictures and the videos it shows,
 * what each of the two lists is asked for, and how their tiles join into the one gallery, newest first.
 *
 * The server half keeps two lists and pages each by itself, in the same order:
 * newest first, and by id among those made in the same moment. The page asks for a page of each and puts them together.
 */

/** What the gallery shows: both, or one of the kinds. */
export type Show = "all" | "images" | "videos";

/** How a picture or a video was made, as one filter says it: the kinds of the two lists together. */
export type MediaKind = PictureKind | VideoKind;

export interface MediaFilter {
  show: Show;
  origin?: PictureOrigin;
  kind?: MediaKind;
}

const SHOWS: readonly string[] = ["images", "videos"];
const ORIGINS: readonly string[] = ["page", "chat", "folder"];
const PICTURE_KINDS: readonly string[] = ["generated", "edited", "uploaded", "unknown"];
const VIDEO_KINDS: readonly string[] = ["generated", "animated", "unknown"];
const KINDS: readonly string[] = [...new Set([...PICTURE_KINDS, ...VIDEO_KINDS])];

/** The filters in the address; what is not one of them is no filter, so that a link that is out of date shows everything. */
export function readFilter(params: URLSearchParams): MediaFilter {
  const show = params.get("show");
  const origin = params.get("origin");
  const kind = params.get("kind");
  return {
    show: show && SHOWS.includes(show) ? (show as Show) : "all",
    ...(origin && ORIGINS.includes(origin) ? { origin: origin as PictureOrigin } : {}),
    ...(kind && KINDS.includes(kind) ? { kind: kind as MediaKind } : {}),
  };
}

/** The filters as the address has them: only what is set. */
export const filterParams = (filter: MediaFilter): Record<string, string> => ({
  ...(filter.show !== "all" ? { show: filter.show } : {}),
  ...(filter.origin ? { origin: filter.origin } : {}),
  ...(filter.kind ? { kind: filter.kind } : {}),
});

/**
 * What is shown, where the portal makes only one of the kinds: that one, whatever the address says. `pictures` and
 * `videos` are whether each is made at all.
 */
export function shownKinds(wanted: Show, pictures: boolean, videos: boolean): Show {
  if (pictures && !videos) return "images";
  if (videos && !pictures) return "videos";
  return wanted;
}

/**
 * What each list is asked for, or null where it is left out. The origin is every list's; a kind is only of some:
 * with both shown, a kind that only pictures have (changed, from this computer) leaves the videos out, and one that
 * only videos have (from a picture) leaves the pictures out. Where one kind alone is shown, a kind it does not have
 * is no filter, as in a link that is out of date.
 */
export function feedFilters(filter: MediaFilter, show: Show): { pictures: PictureFilter | null; videos: VideoFilter | null } {
  const { origin, kind } = filter;
  const pictureKind = kind && PICTURE_KINDS.includes(kind) ? (kind as PictureKind) : undefined;
  const videoKind = kind && VIDEO_KINDS.includes(kind) ? (kind as VideoKind) : undefined;
  const both = show === "all";
  return {
    pictures: show === "videos" || (both && kind && !pictureKind) ? null : { ...(origin ? { origin } : {}), ...(pictureKind ? { kind: pictureKind } : {}) },
    videos: show === "images" || (both && kind && !videoKind) ? null : { ...(origin ? { origin } : {}), ...(videoKind ? { kind: videoKind } : {}) },
  };
}

/** The choices of "How it was made" for what is shown: the kinds there are of it, in the words the page of each uses where it is alone. */
export function kindOptions(show: Show): { id: MediaKind | ""; label: string }[] {
  const all = { id: "" as const, label: msg("All") };
  if (show === "images")
    return [all, { id: "generated", label: msg("Made") }, { id: "edited", label: msg("Changed") }, { id: "uploaded", label: msg("From this computer") }, { id: "unknown", label: msg("Not known") }];
  if (show === "videos") return [all, { id: "generated", label: msg("From a description") }, { id: "animated", label: msg("From a picture") }, { id: "unknown", label: msg("Not known") }];
  return [
    all,
    { id: "generated", label: msg("Made") },
    { id: "edited", label: msg("Changed") },
    { id: "animated", label: msg("From a picture") },
    { id: "uploaded", label: msg("From this computer") },
    { id: "unknown", label: msg("Not known") },
  ];
}

/** What a folder is called: its agent for an agent's home, as the sidebar names it (Home where the server gave no name), or its place under the workspace root. */
export const folderName = (folder: { name: string; home: boolean }): string => (folder.home ? folder.name || t("Home") : folder.name);

interface Positioned {
  id: string;
  createdAt: number;
}

/** Whether `a` comes before `b` in the gallery's order, which is the portal's. */
const newer = (a: Positioned, b: Positioned): boolean => a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id);

/** What of one list the gallery goes by: what is loaded of it, and whether the portal has more. */
export interface FeedView {
  items: Positioned[];
  more: boolean;
}

/**
 * How far down the gallery is known: a list that has more only tells what is newer than its last item loaded, so
 * the gallery is complete down to the newest of those lasts, and nothing older is shown yet, though it may be loaded.
 * Undefined where no list has more: all of it is known.
 */
export function horizon(feeds: (FeedView | null)[]): Positioned | undefined {
  let found: Positioned | undefined;
  for (const feed of feeds) {
    const last = feed?.items[feed.items.length - 1];
    if (feed?.more && last && (!found || newer(last, found))) found = last;
  }
  return found;
}

/** The lists whose next page moves the horizon down: those that have more and whose last item it is. */
export function behind(pictures: FeedView | null, videos: FeedView | null): ("pictures" | "videos")[] {
  const edge = horizon([pictures, videos]);
  if (!edge) return [];
  const at = (feed: FeedView | null) => feed?.more && feed.items[feed.items.length - 1] === edge;
  return [...(at(pictures) ? (["pictures"] as const) : []), ...(at(videos) ? (["videos"] as const) : [])];
}

/** What the grid draws in one place: the tile of a picture or the tile of a video. */
export type MediaTile = { kind: "picture"; key: string; tile: PictureTile } | { kind: "video"; key: string; tile: VideoTile };

/** The picture or video a tile shows, where it has one: a job that has made nothing to show yet has none. */
const itemOf = (m: MediaTile): GalleryPicture | GalleryVideo | undefined => (m.kind === "picture" ? m.tile.picture : m.tile.video);
const startedAt = (m: MediaTile): number => m.tile.job?.startedAt ?? 0;

/**
 * The tiles of both lists as one grid, newest first, in the order the viewers step through: the jobs that have no
 * picture or video to show yet in front, newest started first, and then the gallery, each tile by the picture or video
 * it shows (a job that made one holds its place), down to the horizon of the lists. A list that is left out (null)
 * has no tiles.
 */
export function joinTiles(pictures: { tiles: PictureTile[]; view: FeedView } | null, videos: { tiles: VideoTile[]; view: FeedView } | null): MediaTile[] {
  const own: MediaTile[] = (pictures?.tiles ?? []).map((tile) => ({ kind: "picture", key: `picture:${tile.key}`, tile }));
  const clips: MediaTile[] = (videos?.tiles ?? []).map((tile) => ({ kind: "video", key: `video:${tile.key}`, tile }));
  const waiting = [...own, ...clips].filter((m) => !itemOf(m)).sort((a, b) => startedAt(b) - startedAt(a));
  const edge = horizon([pictures?.view ?? null, videos?.view ?? null]);
  const placed = [...own, ...clips]
    .filter((m) => itemOf(m))
    .sort((a, b) => (newer(itemOf(a)!, itemOf(b)!) ? -1 : newer(itemOf(b)!, itemOf(a)!) ? 1 : 0))
    // Nothing older than the horizon: a list that has more may have items between that it has not got yet.
    .filter((m) => !edge || !newer(edge, itemOf(m)!));
  return [...waiting, ...placed];
}

/** The id a tile is selected by, whichever list it is from: the two have ids of their own, and nothing says they differ. */
export const selectionKey = (kind: "picture" | "video", id: string): string => `${kind}:${id}`;

/** The key a tile is selected by, where it has a picture or a video to select: a job that has made none yet has not. */
export function tileSelection(m: MediaTile): string | undefined {
  if (m.kind === "picture") {
    const id = m.tile.picture?.id ?? m.tile.job?.pictureId;
    return id ? selectionKey("picture", id) : undefined;
  }
  const id = m.tile.video?.id ?? m.tile.job?.videoId;
  return id ? selectionKey("video", id) : undefined;
}

/** What a selection is of, split by list. */
export function splitSelection(keys: Iterable<string>): { pictures: string[]; videos: string[] } {
  const pictures: string[] = [];
  const videos: string[] = [];
  for (const key of keys) {
    if (key.startsWith("picture:")) pictures.push(key.slice("picture:".length));
    else if (key.startsWith("video:")) videos.push(key.slice("video:".length));
  }
  return { pictures, videos };
}
