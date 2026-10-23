import type { ServerPortal } from "@pithagoras/extension-api/server";
import { MODE } from "./mode";
import type { Run } from "./server/made";
import { registerTools } from "./server/tools";

/**
 * Creator mode's server half: a chat mode, asked first, in which the agent works on the extensions made for the
 * portal. Its tools are only in the chats in the mode; the other chats have nothing of it.
 */
export default function creator(portal: ServerPortal) {
  // This start's own: see Run.
  const run: Run = { portal, stopped: false };
  const CREATOR = portal.modes.provide(MODE);
  portal.chats.extend((pi, chat) => {
    if (chat.mode !== CREATOR) return;
    registerTools(run, pi, chat);
  });
  return () => {
    run.stopped = true;
  };
}
