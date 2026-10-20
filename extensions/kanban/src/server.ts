import type { ServerPortal } from "@pithagoras/extension-api/server";
import { routes } from "./server/routes";
import { KanbanStore } from "./server/store";
import { offeredTools, registerTools } from "./server/tools";

/**
 * Kanban's server half: the boards (server/store.ts), the page's routes at /api/x/pithagoras-kanban/… (server/routes.ts),
 * and the agent's tools in each chat (server/tools.ts), which work on the same boards. What it keeps is in its own
 * folder of the portal's data folder, as JSON: nothing native, and nothing an agent can reach but through its tools.
 */
export default function kanban(portal: ServerPortal) {
  const store = KanbanStore.open(portal.dataDir(), portal.log);

  portal.tools.offer(offeredTools);
  portal.chats.extend((pi, chat) =>
    registerTools(pi, () => ({
      store,
      chat: chat.id,
      // The chat as it is called when the tool runs: it may have been renamed since its pi loaded.
      by: { kind: "agent", chat: { id: chat.id, title: portal.chats.get(chat.id)?.title ?? chat.title } },
    })),
  );
  // A chat that goes takes with it which board its agent worked on last.
  portal.chats.on("deleted", (chat) => void store.forgetChat(chat).catch((e) => portal.log(`kanban: ${(e as Error).message}`)));

  routes(portal.router, portal.http.json(), store, portal.log);

  // Stopped once the writes asked for are done.
  return () => store.idle();
}
