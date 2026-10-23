import type { ServerPortal } from "@pithagoras/extension-api/server";
import { setPortal } from "./host";

/**
 * pithagoras-office's server half: OnlyOffice Document Server in a container the portal runs through Docker, its
 * documents in the extension's own data folder, the routes of its Office tab and its Settings page at
 * /api/x/pithagoras-office/…, plus the cookie-free endpoints on a loopback listener (src/callback.ts). Wave W4 wires it;
 * this skeleton only takes the portal so the later modules have their host to set (src/host.ts).
 */
export default async function office(portal: ServerPortal) {
  setPortal(portal);
  // TODO (W4): jwt-secret file (0600, crypto.randomBytes(32)), registerTools(), wirePing(), routes on portal.router,
  // the loopback listener (GET /doc/<ticket>, POST /callback), settleKept() at boot, lookAfter() every 30 s (unref'd).
  return () => {};
}
