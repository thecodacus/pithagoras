import type { ServerPortal } from "@pithagoras/extension-api/server";
import { stopWatchingFrames, watchBrowserFrames } from "./server/frames";
import { takeHandoff } from "./server/handoff";
import { setPortal } from "./server/host";
import { uiUpgrade } from "./server/proxy";
import { browserRoutes } from "./server/routes";
import { adoptKept } from "./server/service";
import { connected, openStore } from "./server/store";
import { browserTools, disconnect, forgetChat, offeredTools } from "./server/tools";

/**
 * Browser's server half: the agent's browser tools in each chat while they are connected, the browser's container
 * through Docker (or the machine's own Chrome, or a browser run elsewhere), the routes of its page and its Settings
 * page, and the browser's own UI, at /api/x/pithagoras-browser/… (server/routes.ts).
 *
 * It builds on Docker (`pithagoras.requires` in its package.json), which runs its container: Docker's server half starts
 * before this one, and this one is started again whenever Docker is. So it starts without waiting on Docker, and stops
 * without touching the browser: a start or a stop of it is not one of the browser's.
 *
 * Its settings are in its own folder (`portal.dataDir()`, server/store.ts). What the portal kept of the browser from
 * before Browser was an extension is taken up first (server/handoff.ts).
 */
export default function browser(portal: ServerPortal) {
  setPortal(portal);
  openStore(portal.dataDir());
  takeHandoff();
  // The container and the profile the portal made before are Browser's to run: taken over by their names, in the
  // background, as Docker can take a while to answer.
  void adoptKept().catch((e) => portal.log(`could not take over the browser's container and profile: ${(e as Error).message}`));
  watchBrowserFrames();

  portal.tools.offer(() => (connected() ? offeredTools() : []));
  portal.chats.extend((pi, chat) => {
    if (connected()) browserTools(chat.id)(pi);
  });
  // The tab a chat worked in, and what it was shown there, go with a chat that is gone or a run that is over. A chat
  // stopped for being idle keeps them: it goes on in its own tab.
  portal.chats.on("deleted", forgetChat);
  portal.chats.on("finished", forgetChat);

  browserRoutes(portal.router);
  portal.http.upgrade(uiUpgrade);

  return async () => {
    stopWatchingFrames();
    await disconnect();
  };
}
