import { t } from "../i18n";
import { ImagesAddon, VideosAddon } from "./FeatureAddons";
import { Section } from "./SettingsUi";

/**
 * The settings of the agent's picture and video tools: the image model behind making and changing
 * pictures, the video model behind making videos, and whether the agent has those tools at all. The
 * tools themselves are switched in the tool lists like any other, in their one Media group; the
 * endpoints and the on/off state of each feature are the add-ons'.
 */
export function MediaPanel({ onError }: { onError: (e: string) => void }) {
  return (
    <>
      <Section title={t("Image model")} hint={t("Making and changing pictures, on the Media page and for the agent.")}>
        <ImagesAddon onError={onError} />
      </Section>
      <Section title={t("Video model")} hint={t("Making videos, on the Media page and for the agent.")}>
        <VideosAddon onError={onError} />
      </Section>
      <p className="text-[11px] text-fg-faint">{t("Which chats' agents get the tools is set in the tool lists (Settings → Agent → Tools), in the Media group.")}</p>
    </>
  );
}
