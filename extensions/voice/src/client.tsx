import { Suspense } from "react";
import { LuAudioLines } from "react-icons/lu";
import type { Portal } from "@pithagoras/extension-api";
import { msg, portal, setPortal, t } from "./portal";
import { de } from "./de";

/**
 * Voice: the voice service, which voice mode listens and speaks through once it is installed. Its page in Settings,
 * where it is installed, started, stopped and removed, and where its engines and its GPU are chosen. Voice mode itself
 * is the portal's, in Settings → Add-ons → Voice. Its texts in German are in de.ts.
 */
export default function voice(given: Portal) {
  setPortal(given);
  portal.locale.add("de", de);
  // Only fetched once it is opened.
  const Settings = portal.ui.lazy(() => import("./web/VoiceService"), "VoiceService");

  portal.slots.register("settings.page", {
    id: "voice",
    title: msg("Voice service"),
    icon: LuAudioLines,
    search: [
      {
        title: msg("Voice service"),
        words: "voice speech whisper breeze kokoro chatterbox qwen gpu install docker container models stimme sprache spracherkennung sprachausgabe grafikkarte installieren modelle",
      },
    ],
    component: () => (
      <Suspense fallback={<p className="text-sm text-fg-subtle">{t("Loading…")}</p>}>
        <Settings />
      </Suspense>
    ),
  });
}
