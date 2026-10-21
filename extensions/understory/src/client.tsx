import { Suspense } from "react";
import { LuBrain } from "react-icons/lu";
import type { Portal } from "@pithagoras/extension-api";
import { msg, portal, setPortal, t } from "./portal";
import { forget, useUnderstoryState } from "./web/state";
import { de } from "./de";

/**
 * Understory: the agent's memory, kept by Understory in a container of its own. Its Memory page, in the sidebar while
 * Understory is the agent's memory, where the notes are read and tended; and its page in Settings, where it is
 * installed, set up, started, stopped and removed, and switched on as the agent's memory. Its texts in German are in
 * de.ts.
 */

/** Whether the Memory page is listed in the sidebar: while Understory is the agent's memory, as the server half says. Until it has said, it is not. */
function useShown(): boolean {
  return useUnderstoryState()?.enabled === true;
}

export default function understory(given: Portal) {
  setPortal(given);
  forget();
  portal.locale.add("de", de);
  // Only fetched once they are opened.
  const Page = portal.ui.lazy(() => import("./web/MemoryPage"), "MemoryPage");
  const Settings = portal.ui.lazy(() => import("./web/MemorySettings"), "MemorySettings");

  portal.slots.register("nav.page", {
    id: "memory",
    title: msg("Memory"),
    icon: LuBrain,
    useShown,
    component: () => (
      <Suspense fallback={<div className="flex flex-1 items-center justify-center text-sm text-fg-subtle">{t("Loading…")}</div>}>
        <Page />
      </Suspense>
    ),
  });

  portal.slots.register("settings.page", {
    id: "memory",
    title: msg("Memory"),
    icon: LuBrain,
    search: [
      {
        title: msg("Memory"),
        words: "memory understory notes dream tidy model container docker install mcp gedächtnis notizen aufräumen modell installieren",
      },
    ],
    component: () => (
      <Suspense fallback={<p className="text-sm text-fg-subtle">{t("Loading…")}</p>}>
        <Settings />
      </Suspense>
    ),
  });
}
