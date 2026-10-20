import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { LuImage, LuImageOff, LuPlay, LuVideo, LuVideoOff } from "react-icons/lu";
import { fancy } from "../motion";
import { formatElapsed } from "../transcript";
import { t } from "../i18n";

export type PreviewState = "making" | "done" | "failed";

/**
 * Narrowest and widest a preview is drawn: past that a picture is shown whole in a
 * frame of this shape, not cropped, so that no frame is a sliver.
 */
const NARROWEST = 0.4;
const WIDEST = 3;

/** Width over height for a frame, from the sizes in pixels of a picture or a request. */
export function shapeOf(width: number, height: number): number | undefined {
  if (!(width > 0) || !(height > 0)) return undefined;
  return Math.min(WIDEST, Math.max(NARROWEST, width / height));
}

interface ImagePreviewProps {
  state: PreviewState;
  /**
   * What is being made: a picture (the default), or a clip. A clip's frame is its poster picture (`src`) or, where the
   * portal has none, its first frame as the browser decodes it from the clip itself (`video`); a click opens it in the
   * viewer as it does a picture, and a mark on it says it plays.
   */
  kind?: "picture" | "video";
  /** A clip without a poster: the clip, for its first frame to be the picture. */
  video?: string;
  /** While it is made, one more line under what it is: where the clip is, waiting its turn or being made. */
  detail?: string;
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
 * It knows nothing of chats or tools, so that an extension's page can use it
 * as well (`ui.ImagePreview`); what goes in `actions` and around it is the caller's.
 */
export function ImagePreview({ state, kind = "picture", video, detail, edit = false, src, before, ratio, title, reason, elapsed, pictureId, onOpen, compact = false, actions }: ImagePreviewProps) {
  const clip = kind === "video";
  // A poster that could not be had (the portal has none for this clip: ffmpeg cannot make a frame of every file) is no reason to say the clip is gone: its own first frame is shown instead.
  const [posterGone, setPosterGone] = useState<string>();
  const poster = !!src && !(clip && !!video && posterGone === src);
  // What the frame shows once there: the picture, or the poster of a clip, or the clip's own first frame.
  const still = poster ? src : clip ? video : undefined;
  // Taken once: whether it was being made when it first appeared here.
  const arriving = useRef(state === "making").current;
  // What has loaded, and what has not, by the address: another picture in the same place starts over.
  const [loaded, setLoaded] = useState<{ src: string; shape?: number }>();
  const [gone, setGone] = useState<string>();
  const [original, setOriginal] = useState<{ shape?: number; gone?: boolean }>({});
  const [settled, setSettled] = useState(false);
  const img = useRef<HTMLImageElement>(null);
  const frameEl = useRef<HTMLDivElement>(null);
  // A clip with no poster is fetched, for its first frame, only once it is near the screen: a gallery of hundreds does not ask for every start at once.
  const [near, setNear] = useState(typeof IntersectionObserver === "undefined");
  const needsClip = clip && !poster && state === "done" && !!still;
  useEffect(() => {
    const el = frameEl.current;
    if (!needsClip || near || !el) return;
    const observer = new IntersectionObserver((seen) => seen.some((s) => s.isIntersecting) && setNear(true), { rootMargin: "400px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [needsClip, near]);

  const ready = !!still && loaded?.src === still;
  const missing = !!still && gone === still;
  const shown: PreviewState = missing ? "failed" : state;
  const making = state === "making";
  // The call is over, and the picture is on its way, or fading in over what was there: only worth a place for one that was being made.
  const loading = arriving && state === "done" && !settled && !missing;
  const waiting = making || loading;
  const withOriginal = !!before && !compact && waiting && !original.gone;
  const shape = (ready ? loaded?.shape : undefined) ?? (withOriginal ? original.shape : undefined) ?? ratio ?? 1;

  const loadedNow = (width: number, height: number) => still && setLoaded({ src: still, shape: shapeOf(width, height) });
  // A picture that was there already may have loaded before this saw it.
  useEffect(() => {
    const el = img.current;
    if (el?.complete && el.naturalWidth) loadedNow(el.naturalWidth, el.naturalHeight);
  }, [still]);
  useEffect(() => {
    if (!arriving || !ready) return;
    // Long enough for the fade, and at once where there is none.
    const timer = setTimeout(() => setSettled(true), fancy() ? 900 : 0);
    return () => clearTimeout(timer);
  }, [arriving, ready]);

  const picture = state === "done" && still && !missing && (needsClip ? near : true) && (
    clip && !poster ? (
      // Muted and never played here: the first frame is all it is for. Its size says the clip's shape.
      <video
        key={still}
        className="image-preview-img"
        src={still}
        preload="metadata"
        muted
        playsInline
        tabIndex={-1}
        aria-hidden
        onLoadedData={(e) => loadedNow(e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
        onError={() => setGone(still)}
      />
    ) : (
      <img
        key={still}
        ref={img}
        className="image-preview-img"
        src={still}
        alt={compact ? "" : title ?? ""}
        // One that was waited for is fetched now, wherever the page is scrolled to and whether or not it is on show: the browser decides when a lazy one is, and a picture the chat is waiting on cannot wait for that.
        loading={arriving ? "eager" : "lazy"}
        decoding="async"
        onLoad={(e) => loadedNow(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
        onError={() => (clip && video ? setPosterGone(still) : setGone(still))}
      />
    )
  );
  // One that was just made is not gone from the folder: what failed was getting it here.
  const headline = clip
    ? missing
      ? arriving
        ? t("The video could not be loaded.")
        : t("This video is no longer in the folder.")
      : t("No video was made")
    : missing
      ? arriving
        ? t("The picture could not be loaded.")
        : t("This picture is no longer in the folder.")
      : edit
        ? t("The picture was not changed")
        : t("No picture was made");
  const label = clip ? t("Making a video") : edit ? t("Editing a picture") : t("Making a picture");
  // What a screen reader is told, in one place that stays: a live region that appears with its words is not read, one whose words change is.
  const said = making ? [label, detail].filter(Boolean).join(". ") : shown === "failed" ? [headline, !missing && reason].filter(Boolean).join(". ") : arriving && ready ? (clip ? t("The video is ready") : t("The picture is ready")) : "";
  const busy = making || (shown === "done" && !!still && !ready);
  const frame = (
    <div ref={frameEl} className={`image-preview-frame is-${shown}${arriving ? " is-arriving" : ""}${ready ? " is-loaded" : ""}${withOriginal ? " has-before" : ""}`}>
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
          {clip ? <LuVideo aria-hidden /> : <LuImage aria-hidden />}
          {!compact && <span>{making ? label : clip ? t("Loading the video") : t("Loading the picture")}</span>}
          {!compact && making && detail && <small>{detail}</small>}
          {!compact && making && elapsed !== undefined && elapsed >= 3 && <small className="tabular-nums">{formatElapsed(elapsed)}</small>}
        </div>
      )}
      {picture && (onOpen && pictureId && !compact ? <button type="button" className={`image-preview-link${clip ? " is-clip" : ""}`} data-picture-id={pictureId} aria-haspopup="dialog" title={title} onClick={() => onOpen(pictureId)}>{picture}{clip && <LuPlay aria-hidden className="image-preview-play" />}</button> : picture)}
      {shown === "failed" && (
        <div className="image-preview-failed" aria-hidden>
          {clip ? <LuVideoOff aria-hidden /> : <LuImageOff aria-hidden />}
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
    <figure className={`image-preview is-${shown}${clip ? " is-clip" : ""}`} style={style} aria-busy={busy}>
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
