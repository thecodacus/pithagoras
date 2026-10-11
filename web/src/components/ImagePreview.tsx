import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { LuImage, LuImageOff } from "react-icons/lu";
import { fancy } from "../motion";
import { shapeOf } from "../picture-call";
import { formatElapsed } from "../transcript";
import { t } from "../i18n";

export type PreviewState = "making" | "done" | "failed";

interface ImagePreviewProps {
  state: PreviewState;
  /** An edit of a picture rather than a new one: what the label says, and what is shown under the wait. */
  edit?: boolean;
  /** The picture, once there. */
  src?: string;
  /** An edit's original: shown under the wait, and the picture arrives over it. */
  before?: string;
  /** Width over height of the picture to come, as far as it is known; a square until the picture itself says. */
  ratio?: number;
  /** What the picture is of: under it, and what a screen reader says of it. */
  title?: string;
  /** Why it was not made, for `failed`. */
  reason?: string;
  /** Seconds the making has taken so far, for `making`. */
  elapsed?: number;
  /** The viewer's id for the picture, and what opens it: a click on the picture goes there, and focus comes back to it when the viewer closes. Neither, and the picture is not a button. */
  pictureId?: string;
  onOpen?: (id: string) => void;
  /** Only the frame, small, for where a label and a caption have no room (the cards of voice mode). */
  compact?: boolean;
  /** Beside the title under the picture. */
  actions?: ReactNode;
}

/**
 * A picture that is being made, is there, or was not made, in one place.
 *
 * While it is made the frame is the shape of the picture to come — the size
 * asked for, the original's shape for an edit — and says what is going on,
 * with an animation that only runs while Settings → This browser has the
 * animations on (see motion.css); with them off it is the same frame and the
 * same words, still. The picture then takes the frame's place: it fades in
 * over the wait, and the frame takes the picture's own shape once that is
 * known, so nothing under it moves when the guess was right. Not made, the
 * frame says so and why, quietly.
 *
 * Being made ends with the call, not with the picture's download: from then on
 * the frame says it is loading, still, however long the file takes to come —
 * a large one over a slow link, a request queued behind others. The wait over
 * the frame is a thing to look at, not a thing that can be stuck.
 *
 * Only a picture that was watched being made arrives with a transition: one
 * drawn from the history just is there, and costs nothing while it is not.
 * It knows nothing of chats or tools, so that the Images page can use it as
 * well; what goes in `actions` and around it is the caller's.
 */
export function ImagePreview({ state, edit = false, src, before, ratio, title, reason, elapsed, pictureId, onOpen, compact = false, actions }: ImagePreviewProps) {
  // Taken once: whether it was being made when it first appeared here.
  const arriving = useRef(state === "making").current;
  // What has loaded, and what has not, by the address: another picture in the same place starts over.
  const [loaded, setLoaded] = useState<{ src: string; shape?: number }>();
  const [gone, setGone] = useState<string>();
  const [original, setOriginal] = useState<{ shape?: number; gone?: boolean }>({});
  const [settled, setSettled] = useState(false);
  const img = useRef<HTMLImageElement>(null);

  const ready = !!src && loaded?.src === src;
  const missing = !!src && gone === src;
  const shown: PreviewState = missing ? "failed" : state;
  const making = state === "making";
  // The call is over, and the picture is on its way, or fading in over what was there: only worth a place for one that was being made.
  const loading = arriving && state === "done" && !settled && !missing;
  const waiting = making || loading;
  const withOriginal = !!before && !compact && waiting && !original.gone;
  const shape = (ready ? loaded?.shape : undefined) ?? (withOriginal ? original.shape : undefined) ?? ratio ?? 1;

  const loadedNow = (el: HTMLImageElement) => src && setLoaded({ src, shape: shapeOf(el.naturalWidth, el.naturalHeight) });
  // A picture that was there already may have loaded before this saw it.
  useEffect(() => {
    const el = img.current;
    if (el?.complete && el.naturalWidth) loadedNow(el);
  }, [src]);
  useEffect(() => {
    if (!arriving || !ready) return;
    // Long enough for the fade, and at once where there is none.
    const timer = setTimeout(() => setSettled(true), fancy() ? 900 : 0);
    return () => clearTimeout(timer);
  }, [arriving, ready]);

  const picture = state === "done" && src && !missing && (
    <img
      key={src}
      ref={img}
      className="image-preview-img"
      src={src}
      alt={compact ? "" : title ?? ""}
      // One that was waited for is fetched now, wherever the page is scrolled to and whether or not it is on show: the browser decides when a lazy one is, and a picture the chat is waiting on cannot wait for that.
      loading={arriving ? "eager" : "lazy"}
      decoding="async"
      onLoad={(e) => loadedNow(e.currentTarget)}
      onError={() => setGone(src)}
    />
  );
  // One that was just made is not gone from the folder: what failed was getting it here.
  const headline = missing ? (arriving ? t("The picture could not be loaded.") : t("This picture is no longer in the folder.")) : edit ? t("The picture was not changed") : t("No picture was made");
  const label = edit ? t("Editing a picture") : t("Making a picture");
  // What a screen reader is told, in one place that stays: a live region that appears with its words is not read, one whose words change is.
  const said = making ? label : shown === "failed" ? [headline, !missing && reason].filter(Boolean).join(". ") : arriving && ready ? t("The picture is ready") : "";
  const busy = making || (shown === "done" && !!src && !ready);
  const frame = (
    <div className={`image-preview-frame is-${shown}${arriving ? " is-arriving" : ""}${ready ? " is-loaded" : ""}${withOriginal ? " has-before" : ""}`}>
      {withOriginal && (
        <img
          className="image-preview-before"
          src={before}
          alt=""
          decoding="async"
          onLoad={(e) => setOriginal({ shape: shapeOf(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight) })}
          onError={() => setOriginal({ gone: true })}
        />
      )}
      {waiting && (
        // Looked at, not read: what is said is the status below the picture. The seconds are not part of it.
        <div className={making ? "image-preview-making" : "image-preview-loading"} aria-hidden>
          <LuImage aria-hidden />
          {!compact && <span>{making ? label : t("Loading the picture")}</span>}
          {!compact && making && elapsed !== undefined && elapsed >= 3 && <small className="tabular-nums">{formatElapsed(elapsed)}</small>}
        </div>
      )}
      {picture && (onOpen && pictureId && !compact ? <button type="button" className="image-preview-link" data-picture-id={pictureId} aria-haspopup="dialog" title={title} onClick={() => onOpen(pictureId)}>{picture}</button> : picture)}
      {shown === "failed" && (
        <div className="image-preview-failed" aria-hidden>
          <LuImageOff aria-hidden />
          {!compact && (
            <div>
              <b>{headline}</b>
              {!missing && reason && <p>{reason}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );

  const style = { "--ratio": shape } as CSSProperties;
  if (compact) return <div className={`image-preview is-compact is-${shown}`} style={style}>{frame}</div>;
  return (
    <figure className={`image-preview is-${shown}`} style={style} aria-busy={busy}>
      {frame}
      <span className="sr-only" role="status">{said}</span>
      {(title || actions) && (
        <figcaption className="image-preview-caption">
          <span className="image-preview-title" title={title}>{title}</span>
          {actions}
        </figcaption>
      )}
    </figure>
  );
}
