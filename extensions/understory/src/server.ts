import type { ServerPortal } from "@pithagoras/extension-api/server";
import { UNDERSTORY, UNDERSTORY_RULE } from "./server/entry";
import { takeHandoff } from "./server/handoff";
import { setPortal } from "./server/host";
import { forgetAsking, forgetChat, noteEvent, serveModels } from "./server/llm";
import { memoryRoutes } from "./server/memory";
import { understoryRoutes } from "./server/routes";
import { lookAfter, scheduleDreams, settleKept, stopDreams } from "./server/service";
import { openStore } from "./server/store";

/**
 * Understory's server half: Understory as the agent's memory, its MCP server in pi's mcp.json (`portal.mcp`), the
 * Understory the portal runs, in a container through Docker, the model server it thinks with in "the chat's" mode
 * (server/llm.ts), and the routes of its Settings page and of its Memory page, at /api/x/pithagoras-understory/…
 * (server/routes.ts, server/memory.ts).
 *
 * It builds on Docker (`pithagoras.requires` in its package.json), which runs its container: Docker's server half starts
 * before this one, and this one is started again whenever Docker is. So it starts without waiting on Docker, and stops
 * without touching the container: a start or a stop of it is not one of Understory's.
 *
 * Its settings are in its own folder (`portal.dataDir()`, server/store.ts). What the portal kept of Understory from
 * before Understory was an extension is taken up first (server/handoff.ts).
 */
export default async function understory(portal: ServerPortal) {
  setPortal(portal);
  openStore(portal.dataDir());
  takeHandoff();
  // While its server is the chats' (switched on, and pi-mcp-adapter on): MEMORY.md is left aside for it.
  portal.memory.hold({ label: "Understory", rule: UNDERSTORY_RULE, on: () => portal.mcp.get(UNDERSTORY)?.on === true });
  understoryRoutes(portal.router);
  memoryRoutes(portal.router);
  // Which chat is asking, for the model it thinks with: what the chats' pi say, and the chats whose pi is gone.
  portal.chats.onEvent(noteEvent);
  for (const life of ["stopped", "deleted", "finished"] as const) portal.chats.on(life, forgetChat);
  const closeModels = await serveModels();
  scheduleDreams();

  let stopped = false;
  // The container and the volume the portal made before are Understory's to run: taken over by their names, in the
  // background, as Docker can take a while to answer, and then looked after.
  void settleKept().catch((e) => portal.log(`could not take over Understory's container and its memory: ${(e as Error).message}`));
  const timer = setInterval(() => {
    if (!stopped) lookAfter();
  }, 30_000);
  timer.unref();

  return async () => {
    stopped = true;
    clearInterval(timer);
    stopDreams();
    await closeModels();
    forgetAsking();
  };
}
