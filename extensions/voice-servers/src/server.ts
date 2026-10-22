import type { ServerPortal } from "@pithagoras/extension-api/server";
import { takeHandoff } from "./server/handoff";
import { setPortal } from "./server/host";
import { provider } from "./server/provider";
import { routes } from "./server/routes";
import { openStore } from "./server/store";

/**
 * Voice servers' server half: speech recognition and speech synthesis on servers the person runs, offered to voice mode
 * (`portal.voice.provide`, server/provider.ts), and the routes of its page in Settings, at
 * /api/x/pithagoras-voice-servers/… (server/routes.ts).
 *
 * Its settings are in its own folder (`portal.dataDir()`, server/store.ts). The addresses the portal kept for voice mode
 * from before its sources were extensions are taken up first (server/handoff.ts).
 */
export default function voiceServers(portal: ServerPortal) {
  setPortal(portal);
  openStore(portal.dataDir());
  takeHandoff();
  portal.voice.provide(provider);
  routes(portal.router);
}
