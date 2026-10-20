import { lstatSync, readFileSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";
import { portal } from "./host";
import { imagesDir } from "./image-gallery";
import { thumbsDir } from "./image-thumbs";
import { getDb, getSetting, putSetting } from "./store";
import { copiesDir } from "./video-copies";
import { videosDir } from "./video-gallery";
import { postersDir } from "./video-posters";

/**
 * What the portal kept of Media when Media was part of it, taken up when Media first starts: the upgrade that made
 * Media an extension left it in the portal's data folder under the name "media", and `portal.handoffs.take` gives
 * it to the first extension that asks, moved into its own folder. In it:
 *
 *   handoff.json    what it is: {"format": 1, …}, the format this reads
 *   settings.json   the settings of the image and video endpoints, as the portal stored them (or null)
 *   images.json     {"rows": [...]}: the rows of the portal's images table, each with `chat`, the workspace and
 *                   the real folder of its chat ({workspace, real}) where it had one
 *   videos.json     the same for the videos table
 *   files/images/   the Media page's own pictures, and files/videos/ its clips, under the names the rows give
 *   cache/          the small copies of pictures, the posters and the playable copies of clips
 *
 * The files are moved in first, each folder by one rename where Media has none of its own yet; then the rows are
 * put in the store as they were, ids and paths kept, in one transaction, and the settings where the store has
 * none. Only then is the hand-off done with. All of it is done again, harmlessly, by a start that finds it again
 * because the one before stopped half way: a row that is there is not put in twice, and a file that was moved is
 * not in the hand-off any more. What cannot be taken up stays where it is, for the next start: Media starts
 * without it, and says why in the portal's log.
 */

/** The settings the portal kept, by their keys: the store keeps them under the same. */
const SETTINGS = ["image_generation", "video_generation"];

const exists = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * Moves the folder `from` to `to`: by one rename where there is nothing at `to` yet, else what is in it, one by
 * one, leaving where it is what has a name that is taken at `to`.
 */
function moveInto(from: string, to: string): void {
  if (!exists(from)) return;
  if (!exists(to)) return renameSync(from, to);
  for (const name of readdirSync(from)) {
    if (!exists(path.join(to, name))) renameSync(path.join(from, name), path.join(to, name));
  }
}

interface Row {
  id: string;
  origin: string;
  session_id: string | null;
  folder: string | null;
  path: string;
  kind: string;
  prompt: string;
  params: string;
  source_id?: string | null;
  bytes: number;
  created_at: number;
  chat: { workspace: string; real: string | null } | null;
}

/** Takes up what the portal kept of Media, if it kept anything: what the server half does first, as it starts. */
export function takeHandoff(): void {
  try {
    const dir = portal().handoffs.take("media");
    if (!dir) return;
    const read = (name: string) => JSON.parse(readFileSync(path.join(dir, name), "utf8"));
    const { format } = read("handoff.json");
    if (format !== 1) throw new Error(`it is in a format this version of Media does not read (${format})`);
    moveInto(path.join(dir, "files", "images"), imagesDir());
    moveInto(path.join(dir, "files", "videos"), videosDir());
    moveInto(path.join(dir, "cache", "image-thumbs"), thumbsDir());
    moveInto(path.join(dir, "cache", "video-posters"), postersDir());
    moveInto(path.join(dir, "cache", "video-copies"), copiesDir());
    const settings: Record<string, string | null> = read("settings.json");
    const images: Row[] = read("images.json").rows;
    const videos: Row[] = read("videos.json").rows;
    const d = getDb();
    const image = d.prepare(
      "INSERT OR IGNORE INTO images (id, origin, session_id, folder, path, kind, prompt, params, source_id, bytes, created_at, chat_folder) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const video = d.prepare("INSERT OR IGNORE INTO videos (id, origin, session_id, folder, path, kind, prompt, params, bytes, created_at, chat_folder) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const taken: string[] = [];
    d.transaction(() => {
      // Settings saved here since, while the hand-off waited, are the person's latest word.
      for (const key of SETTINGS) {
        const kept = settings[key];
        if (typeof kept !== "string" || getSetting(key) !== undefined) continue;
        putSetting(key, kept);
        taken.push(key);
      }
      // A chat's row keeps its chat's real folder, as a row Media records itself does: what it stays in when the chat goes.
      for (const r of images) image.run(r.id, r.origin, r.session_id, r.folder, r.path, r.kind, r.prompt, r.params, r.source_id, r.bytes, r.created_at, r.chat?.real ?? null);
      for (const r of videos) video.run(r.id, r.origin, r.session_id, r.folder, r.path, r.kind, r.prompt, r.params, r.bytes, r.created_at, r.chat?.real ?? null);
    })();
    portal().handoffs.done("media");
    portal().log(`took up what the portal kept of Media: ${images.length} pictures and ${videos.length} videos${taken.length ? `, and the settings ${taken.join(" and ")}` : ""}`);
  } catch (e) {
    // Nothing of it is lost: it stays where it is, for the next start to take up.
    portal().log(`could not take up what the portal kept of Media, which is kept for the next start: ${(e as Error).message}`);
  }
}
