import { useEffect, useRef, useState } from "react";
import { portal, t } from "../portal";
import { ImagesAddon, VideosAddon } from "./MediaAddons";

/**
 * Media's page in Settings: the image model behind making and changing pictures, the video model behind making
 * videos, and whether the agent has those tools at all. Each model is a section of its own that opens and closes,
 * with its switches in view either way. The tools themselves are switched in the tool lists like any other, in the
 * group of this extension's package; the endpoints and the on/off state of each feature are the add-ons'.
 */
export function MediaPanel() {
  portal.locale.use();
  const { ui } = portal;
  const [error, setError] = useState<string | null>(null);
  const banner = useRef<HTMLDivElement>(null);
  // A refused save is said at the top of the page, which a long form has scrolled away from: it is brought into view when it comes.
  useEffect(() => {
    if (error) banner.current?.scrollIntoView({ block: "nearest" });
  }, [error]);
  return (
    <>
      {error && (
        <div ref={banner}>
          <ui.ErrorBanner className="mb-4" onClose={() => setError(null)}>
            {error}
          </ui.ErrorBanner>
        </div>
      )}
      <ImagesAddon onError={setError} />
      <VideosAddon onError={setError} />
      <p className="text-[11px] text-fg-faint">{t("Which chats' agents get the tools is set in the tool lists (Settings → Agent → Tools), in the {group} group.", { group: portal.extension })}</p>
    </>
  );
}
