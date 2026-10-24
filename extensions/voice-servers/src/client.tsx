import { Suspense } from "react";
import { LuServer } from "react-icons/lu";
import type { Portal } from "@pithagoras/extension-api";
import { msg, portal, setPortal, t } from "./portal";
import { de } from "./de";

/**
 * Voice servers: speech recognition and speech synthesis on servers the person runs, which voice mode listens and
 * speaks through once it is chosen on this extension's page in Settings, where the addresses, the models and the voices
 * are set. Its texts in German are in de.ts.
 */
export default function voiceServers(given: Portal) {
  setPortal(given);
  portal.locale.add("de", de);
  // Only fetched once it is opened.
  const Settings = portal.ui.lazy(() => import("./web/VoiceServers"), "VoiceServers");

  portal.slots.register("settings.page", {
    id: "voice-servers",
    title: msg("Voice servers"),
    icon: LuServer,
    search: [
      {
        title: msg("Voice servers"),
        words: "voice speech recognition synthesis transcription whisper openai server url dictation custom voices clone breeze chatterbox sprache spracherkennung sprachausgabe server diktat eigene stimmen klon",
      },
    ],
    component: () => (
      <Suspense fallback={<p className="text-sm text-fg-subtle">{t("Loading…")}</p>}>
        <Settings />
      </Suspense>
    ),
  });
}
