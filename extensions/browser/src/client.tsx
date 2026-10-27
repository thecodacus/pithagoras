import { Suspense } from "react";
import { LuGlobe } from "react-icons/lu";
import type { Portal } from "@pithagoras/extension-api";
import { msg, portal, setPortal, t } from "./portal";
import { describeBrowserCall, isBrowserCall, latestBrowserCall } from "./calls";
import { BrowserPanel, BrowserWindow, PanelActions } from "./web/BrowserScreen";
import { forget, useBrowserState, watchable } from "./web/state";
import { de } from "./de";
import "./client.css";

/**
 * Browser: the browser the agent drives, for the person to watch and take
 * over. Its page, in the sidebar while there is a browser or the agent has its
 * tools; its page in Settings, where it is installed, started, stopped and
 * removed; the browser beside a chat, and in voice mode, where it opens as the
 * agent drives it and its key (B) shows and hides it; and what voice mode's
 * card of a browser call says. Its texts in German are in de.ts.
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

/** How the buttons of the panel and of the voice window are: there only while the browser can be watched here. */
function useButton() {
  portal.locale.use();
  const { state } = useBrowserState();
  return { hidden: !watchable(state), title: t("Watch the browser the agent is driving") };
}

export default function browser(given: Portal) {
  setPortal(given);
  forget();
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
        words: "browser chromium chrome container docker install remove start stop password profile logins image download installieren entfernen starten anhalten passwort profil anmeldungen",
      },
    ],
    component: () => (
      <Suspense fallback={<p className="text-sm text-fg-subtle">{t("Loading…")}</p>}>
        <Settings />
      </Suspense>
    ),
  });

  portal.slots.register("chat.panel", {
    id: "browser",
    title: msg("Browser"),
    name: "browser",
    icon: LuGlobe,
    bleed: true,
    component: BrowserPanel,
    actions: PanelActions,
    useButton,
  });

  portal.slots.register("voice.window", {
    id: "browser",
    title: msg("Browser"),
    icon: LuGlobe,
    // No place of its own: alone it stands at the side, as Files' window does, and beside the conversation or the
    // pictures it has the middle.
    maximizable: true,
    keepLoaded: true,
    useButton,
    // Each time the agent drives a browser, its own or a Playwright MCP's.
    useAutoOpen: ({ chat }) => portal.chats.use(chat.id, (feed) => latestBrowserCall(feed.events)),
    opensFor: (call) => isBrowserCall(call.name, call.input),
    describe: describeBrowserCall,
    component: BrowserWindow,
  });

  portal.shortcuts.register({
    id: "browser",
    label: msg("Show or hide the browser"),
    scope: "voice",
    default: { code: "KeyB" },
    run: ({ windows }) => (windows.isOpen("browser") ? windows.close("browser") : windows.open("browser")),
  });
}
