import type { ServerPortal } from "@pithagoras/extension-api/server";
import { MODE } from "./mode";
import type { Run } from "./server/made";
import { sweepLeftovers } from "./server/snapshot";
import { registerTools } from "./server/tools";

/**
 * Creator mode's server half: a chat mode, asked first, in which the agent writes an extension in the chat's folder,
 * installs it into the portal from a copy in Creator's own folder (server/snapshot.ts), and calls its tools in the
 * same chat from its next step. Its tools are only in the chats in the mode; the other chats have nothing of it. What
 * it installs runs in a process of its own, as everything installed from an extension's data folder does.
 */
export default function creator(portal: ServerPortal) {
  // This start's own: see Run.
  const run: Run = { portal, stopped: false };
  sweepLeftovers(run);
  const CREATOR = portal.modes.provide(MODE);
  portal.chats.extend((pi, chat) => {
    if (chat.mode !== CREATOR) return;
    registerTools(run, pi, chat);
  });
  return () => {
    run.stopped = true;
  };
}
