import { Suspense, useEffect, useState, type ReactNode } from "react";
import { LuImages } from "react-icons/lu";
import type { Portal, ToolCallView } from "@pithagoras/extension-api";
import { msg, portal, setPortal, t } from "./portal";
import { api } from "./web/api";
import { onMediaChanged } from "./web/changes";
import { PictureCall, PictureCallTile } from "./web/PictureCall";
import { VideoCall } from "./web/VideoCall";
import { de } from "./de";
import "./client.css";

/**
 * Media: pictures and videos made with the endpoints the person sets up, by
 * the agent's tools (the server half) and on a page of their own. The cards of
 * the tools that make them in the chat, and what voice mode's cards say of
 * each of its tools; the Media page, in the sidebar while either endpoint can
 * make something; and its page in Settings, where the endpoints are set up.
 */

const text = (v: unknown) => (typeof v === "string" ? v : "");
const flat = (s: string, n = 90) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
};

/** What each tool's card says it is doing in voice mode, and which of its parameters says what of, after a title the agent gave. */
const SAYS: Record<string, { label: string; of: string }> = {
  generate_image: { label: msg("Making a picture"), of: "prompt" },
  edit_image: { label: msg("Editing a picture"), of: "prompt" },
  show_image: { label: msg("Showing a picture"), of: "path" },
  generate_video: { label: msg("Making a video"), of: "prompt" },
  show_video: { label: msg("Showing a video"), of: "path" },
};

/** What a card of a call of one of its tools says in voice mode. */
function describe(call: ToolCallView) {
  const says = SAYS[call.name];
  return { label: t(says.label), detail: flat(text(call.input.title) || text(call.input[says.of])) };
}

/** A call drawn as the portal draws it, with the files it shows: of the tools that only show one, voice mode's words are all that is the extension's. */
const PortalCard = ({ card }: { card: ReactNode }) => <>{card}</>;

/**
 * Whether the Media page is listed in the sidebar: while pictures can be made
 * or changed, or videos made, as the server half says, asked again when the
 * settings change. Until it has said, and while it is not running to say, it
 * is not; an answer that does not come keeps the last one.
 */
function useShown(): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const ask = () => api.state().then((s) => setShown(s.images.enabled || s.videos.enabled), () => {});
    void ask();
    return onMediaChanged(ask);
  }, []);
  return shown;
}

export default function media(given: Portal) {
  setPortal(given);
  portal.locale.add("de", de);
  // The page and the settings are large, and only fetched once they are opened.
  const Page = portal.ui.lazy(() => import("./web/MediaPage"), "MediaPage");
  const Settings = portal.ui.lazy(() => import("./web/MediaPanel"), "MediaPanel");

  for (const tool of ["generate_image", "edit_image"]) portal.slots.register("chat.tool", { id: tool, tool, component: PictureCall, tile: PictureCallTile, describe });
  portal.slots.register("chat.tool", { id: "generate_video", tool: "generate_video", component: VideoCall, describe });
  for (const tool of ["show_image", "show_video"]) portal.slots.register("chat.tool", { id: tool, tool, component: PortalCard, describe });

  portal.slots.register("nav.page", {
    id: "media",
    title: msg("Media"),
    icon: LuImages,
    useShown,
    component: () => (
      <Suspense fallback={<div className="flex flex-1 items-center justify-center text-sm text-fg-subtle">{t("Loading…")}</div>}>
        <Page />
      </Suspense>
    ),
  });

  portal.slots.register("settings.page", {
    id: "media",
    title: msg("Media"),
    icon: LuImages,
    search: [
      { section: msg("Image model"), title: msg("Image generation"), words: "generate make draw picture image model endpoint address api key size openai add-on media bild bilder erzeugen generieren bildgenerierung" },
      { section: msg("Image model"), title: msg("Image editing"), words: "edit change picture image mask several pictures endpoint model add-on media bild bilder bearbeiten bildbearbeitung" },
      { section: msg("Editing endpoint"), title: msg("Editing endpoint"), words: "edit editing endpoint address key model maximum picture size bearbeiten adresse schlüssel" },
      { section: msg("More options"), title: msg("Several pictures per edit"), words: "several multiple pictures references combine subjects style edit mehrere bilder" },
      { section: msg("More options"), title: msg("Stable Diffusion extra settings"), words: "stable diffusion stable-diffusion.cpp sdcpp seed steps negative prompt strength extra advanced" },
      {
        section: msg("Video model"),
        title: msg("Video generation"),
        words: "generate make video videos clip movie film animate picture first frame model endpoint address api key size frames frame rate fps stable-diffusion.cpp sdcpp add-on media time limit disk limit erzeugen generieren videogenerierung zeitlimit",
      },
    ],
    component: () => (
      <Suspense fallback={<p className="text-sm text-fg-subtle">{t("Loading…")}</p>}>
        <Settings />
      </Suspense>
    ),
  });
}
