import { useEffect, useState } from "react";
import { LuChevronLeft, LuChevronRight, LuExternalLink } from "react-icons/lu";
import { api, type PortalEvent } from "../api";
import { shownPicture, type ShownPicture } from "../transcript";
import { t } from "../i18n";

/** A picture the agent showed, and the event it was shown at: the same file shown again is a new picture. */
export type Shown = ShownPicture & { seq: number };

/** Every picture shown in this conversation, oldest first. */
export function shownPictures(events: PortalEvent[]): Shown[] {
  const list: Shown[] = [];
  for (const event of events) {
    if (event.type !== "tool_execution_end") continue;
    const picture = shownPicture(event.payload);
    if (picture) list.push({ ...picture, seq: event.seq });
  }
  return list;
}

/**
 * The pictures the agent showed, one at a time, for the picture window in voice mode.
 *
 * Fitted to the window; a tap shows it at its own size, to look at a detail,
 * and another fits it again. The arrows go back through earlier ones.
 */
export function VoicePictures({ sessionId, pictures, index, onIndex }: { sessionId: string; pictures: Shown[]; index: number; onIndex: (index: number) => void }) {
  const [zoomed, setZoomed] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setZoomed(false); setFailed(false); }, [index, pictures[index]?.seq]);
  const picture = pictures[index];
  if (!picture) return <p className="voice-pictures-empty">{t("No pictures yet. Ask the agent to show you one.")}</p>;
  const url = api.pictureUrl(sessionId, picture.path, picture.seq);
  return <div className="voice-pictures">
    <div className={`voice-pictures-view ${zoomed ? "is-zoomed" : ""}`}>
      {failed
        ? <p className="voice-pictures-empty">{t("This picture is no longer in the folder.")}</p>
        : <button type="button" onClick={() => setZoomed(z => !z)} aria-label={zoomed ? t("Fit the picture") : t("Show the picture at full size")}>
            <img src={url} alt={picture.title ?? picture.path} onError={() => setFailed(true)} />
          </button>}
    </div>
    <footer>
      <span className="voice-pictures-caption" title={picture.path}>{picture.title ?? picture.path}</span>
      <div>
        {pictures.length > 1 && <>
          <button type="button" aria-label={t("Previous picture")} disabled={index === 0} onClick={() => onIndex(index - 1)}><LuChevronLeft /></button>
          <span className="voice-pictures-count">{index + 1} / {pictures.length}</span>
          <button type="button" aria-label={t("Next picture")} disabled={index === pictures.length - 1} onClick={() => onIndex(index + 1)}><LuChevronRight /></button>
        </>}
        <a href={url} target="_blank" rel="noreferrer" aria-label={t("Open the picture in a new tab")} title={t("Open in a new tab")}><LuExternalLink /></a>
      </div>
    </footer>
  </div>;
}
