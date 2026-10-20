import { Suspense } from "react";
import { LuGlobe } from "react-icons/lu";
import type { Portal } from "@pithagoras/extension-api";
import { msg, portal, setPortal, t } from "./portal";
import { useBrowserState } from "./web/state";
import { de } from "./de";
import "./client.css";

/**
 * Browser: the browser the agent drives, for the person to watch and take
 * over. Its page, in the sidebar while there is a browser or the agent has its
 * tools; and its page in Settings, where it is installed, started, stopped and
 * removed. Its texts in German are in de.ts.
 */

/**
 * Whether the Browser page is listed in the sidebar: while a browser runs,
 * while the agent has the browser tools, or while a routine's runs are given
 * them otherwise than the default, as the server half says. Until it has said,
 * it is not.
 */
function useShown(): boolean {
  const { state } = useBrowserState();
  return !!state && (state.running || state.connected || state.routines.length > 0);
}

export default function browser(given: Portal) {
  setPortal(given);
  portal.locale.add("de", de);
  // Only fetched once they are opened.
  const Page = portal.ui.lazy(() => import("./web/BrowserPage"), "BrowserPage");
  const Settings = portal.ui.lazy(() => import("./web/BrowserSettings"), "BrowserSettings");

  portal.slots.register("nav.page", {
    id: "browser",
    title: msg("Browser"),
    icon: LuGlobe,
    useShown,
    component: () => (
      <Suspense fallback={<div className="flex flex-1 items-center justify-center text-sm text-fg-subtle">{t("Loading…")}</div>}>
        <Page />
      </Suspense>
    ),
  });

  portal.slots.register("settings.page", {
    id: "browser",
    title: msg("Browser"),
    icon: LuGlobe,
    search: [
      {
        title: msg("Browser"),
        words: "browser add-on addon chromium chrome container docker install remove start stop password profile logins image download installieren entfernen starten anhalten passwort profil anmeldungen",
      },
    ],
    component: () => (
      <Suspense fallback={<p className="text-sm text-fg-subtle">{t("Loading…")}</p>}>
        <Settings />
      </Suspense>
    ),
  });
}
