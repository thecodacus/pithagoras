import type { ServerPortal } from "@pithagoras/extension-api/server";
import { takeHandoff } from "./server/handoff";
import { setPortal } from "./server/host";
import { maintain, provider } from "./server/provider";
import { voiceRoutes } from "./server/routes";
import { adoptKept } from "./server/service";
import { openStore } from "./server/store";
import { openLibrary } from "./server/voices";

/**
 * Voice's server half: the voice service's container through Docker, offered to voice mode as a place to listen and
 * speak (`portal.voice.provide`, server/provider.ts), and the routes of its page in Settings, at
 * /api/x/pithagoras-voice/… (server/routes.ts).
 *
 * It builds on Docker (`pithagoras.requires` in its package.json), which runs its container: Docker's server half starts
 * before this one, and this one is started again whenever Docker is. So it starts without waiting on Docker, and stops
 * without touching the container: a start or a stop of it is not one of the service's.
 *
 * Its settings and its voice library are in its own folder (`portal.dataDir()`, server/store.ts and server/voices.ts).
 * What the portal kept of the service from before Voice was an extension is taken up first (server/handoff.ts).
 */
export default function voice(portal: ServerPortal) {
  setPortal(portal);
  openStore(portal.dataDir());
  openLibrary(portal.dataDir());
  takeHandoff();
  portal.voice.provide(provider());
  voiceRoutes(portal.router);

  let stopped = false;
  const look = () => {
    if (!stopped) void maintain().catch((e) => portal.log(`could not look after the voice service: ${(e as Error).message}`));
  };
  const timer = setInterval(look, 30_000);
  timer.unref();
  // The container and the volume the portal made before are Voice's to run: taken over by their names, in the
  // background, as Docker can take a while to answer, and then looked after.
  void adoptKept()
    .catch((e) => portal.log(`could not take over the voice container and its downloads: ${(e as Error).message}`))
    .then(look);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
