import { Suspense } from "react";
import { LuHammer } from "react-icons/lu";
import type { Portal } from "@pithagoras/extension-api";
import { msg, portal, setPortal, t } from "./portal";
import { de } from "./de";

/**
 * Creator mode's browser half: its texts in German, the mode's among them, which the picker above the message box and
 * Settings → Audit show it in; and its page in Settings, which lists what agents made in Creator mode chats.
 */
export default function creator(given: Portal) {
  setPortal(given);
  portal.locale.add("de", de);
  // Only fetched once it is opened.
  const Made = portal.ui.lazy(() => import("./web/MadePage"), "MadePage");

  portal.slots.register("settings.page", {
    id: "creator",
    title: msg("Creator mode"),
    icon: LuHammer,
    search: [
      {
        title: msg("Creator mode"),
        words: "creator mode made extensions agent install forget copy erstellt erweiterungen agent installieren vergessen kopie",
      },
    ],
    component: () => (
      <Suspense fallback={<p className="text-sm text-fg-subtle">{t("Loading…")}</p>}>
        <Made />
      </Suspense>
    ),
  });
}
