import path from "node:path";
import type { ServerPortal } from "@pithagoras/extension-api/server";
import { imagesRoutes } from "./server/api/images";
import { settingsRoutes } from "./server/api/settings";
import { videosRoutes } from "./server/api/videos";
import { takeHandoff } from "./server/handoff";
import { setPortal, stopWork } from "./server/host";
import { forgetPicturesIn, keepChatPictures } from "./server/image-gallery";
import { stopJobs as stopPictureJobs } from "./server/image-jobs";
import { offeredTools, registerTools } from "./server/pi/tools";
import { closeStore, openStore } from "./server/store";
import { forgetVideosIn, keepChatVideos } from "./server/video-gallery";
import { stopJobs as stopVideoJobs } from "./server/video-jobs";

/**
 * Media's server half: the agent's picture and video tools in each chat, the Media page's galleries and the jobs
 * that make pictures and clips for it, and the settings of the endpoints they are made with, at
 * /api/x/pithagoras-media/….
 *
 * What it keeps is in its own folder in the portal's data folder (`portal.dataDir()`): its store (store.ts), the
 * page's own pictures and clips, and the small copies, posters and playable copies the galleries show. What the
 * portal kept of Media from before Media was an extension is taken up first (handoff.ts).
 */
export default function media(portal: ServerPortal) {
  setPortal(portal);
  openStore(path.join(portal.dataDir(), "media.db"));
  takeHandoff();

  portal.tools.offer(offeredTools);
  portal.chats.extend(registerTools);
  // A chat that goes leaves its pictures and clips in its folder, and in the galleries as the folder's.
  portal.chats.on("deleted", (chat) => {
    keepChatPictures(chat);
    keepChatVideos(chat);
  });
  // A project or an agent's home the portal deleted takes what was made in it, which went with it.
  portal.folders.on("removed", (folder) => {
    forgetPicturesIn(folder);
    forgetVideosIn(folder);
  });

  imagesRoutes(portal.router);
  videosRoutes(portal.router);
  settingsRoutes(portal.router);

  return () => {
    stopPictureJobs();
    stopVideoJobs();
    stopWork();
    closeStore();
  };
}
