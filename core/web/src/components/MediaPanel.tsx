import { t } from "../i18n";
import { ImagesAddon, VideosAddon } from "./FeatureAddons";

/**
 * The settings of the agent's picture and video tools: the image model behind making and changing
 * pictures, the video model behind making videos, and whether the agent has those tools at all. Each
 * model is a section of its own that opens and closes, with its switches in view either way. The
 * tools themselves are switched in the tool lists like any other, in their one Media group; the
 * endpoints and the on/off state of each feature are the add-ons'.
 */
export function MediaPanel({ onError }: { onError: (e: string) => void }) {
  return (
    <>
      <ImagesAddon onError={onError} />
      <VideosAddon onError={onError} />
      <p className="text-[11px] text-fg-faint">{t("Which chats' agents get the tools is set in the tool lists (Settings → Agent → Tools), in the Media group.")}</p>
    </>
  );
}
