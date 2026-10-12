import { t } from "../i18n";
import { VideosAddon } from "./FeatureAddons";
import { Section } from "./SettingsUi";

/**
 * The settings of the agent's video tools: the video endpoint behind making clips,
 * and whether the agent has those tools at all. The tools themselves are switched in
 * the tool lists like any other, in their one Videos group; the endpoint and the
 * add-on's on/off state are the add-on's.
 */
export function VideosPanel({ onError }: { onError: (e: string) => void }) {
  return (
    <Section title={t("Making videos")} hint={t("The video model behind generate_video and show_video, and whether the agent has them at all.")}>
      <VideosAddon onError={onError} />
    </Section>
  );
}
