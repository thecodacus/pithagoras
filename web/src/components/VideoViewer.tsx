import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { LuChevronLeft, LuChevronRight, LuDownload, LuExternalLink, LuX } from "react-icons/lu";
import { isEscape } from "../shortcuts";
import { useLeaveRef } from "../motion";
import { useBackToClose } from "../use-back-to-close";
import { useScrollLock } from "../use-scroll-lock";
import { stepped } from "../image-viewer";
import { t } from "../i18n";
import { iconButton } from "./ImageViewer";

/** What the viewer works with for one clip: the Videos page makes these from its gallery, the chat from a clip the agent made. */
export interface ViewerVideo {
  /** Tells it from the others in the list. */
  id: string;
  /** Where the clip is, as a <video> takes it. Also what Open in a new tab and Download go to. */
  src: string;
  /** The picture shown until it plays, where there is one. */
  poster?: string;
  /** What it shows, for those who cannot see it. */
  label: string;
  /** Shown under it, when there is something to say: its title. */
  caption?: string;
  /** What Download names the file, when the address does not say. */
  fileName?: string;
}

/** What can take the keyboard: the viewer's own buttons, and what a page puts in `actions`. */
const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), video[controls], [tabindex]:not([tabindex="-1"])';

/**
 * A clip over the whole page, on a calm backdrop, with the browser's own player: play and pause, the slider,
 * the volume, full screen. The picture viewer's twin (ImageViewer.tsx), with the same manners:
 *
 * - A dialog: labelled, with the keyboard kept inside it (Tab goes round), the page behind it not scrollable,
 *   and focus given back to the clip it was opened from when it closes.
 * - Closed by the button, Escape, a click beside the clip, or the browser's back button, which on a phone is the
 *   way out (see use-back-to-close.ts).
 * - Stepped through with the arrows on the sides or the arrow keys — except while the player itself has the
 *   keyboard, where they move through the clip.
 * - Open in a new tab and Download are there on purpose, as the quiet way to the file. `actions` adds a page's own buttons.
 *
 * It starts playing when it opens, since opening it was asking for that; stepping to another clip plays that one.
 */
export function VideoViewer({
  videos,
  startId,
  onClose,
  anchor,
  actions,
}: {
  videos: ViewerVideo[];
  /** The `id` of the clip to open on. */
  startId: string;
  onClose: () => void;
  /** Where focus goes when it closes, for the clip shown last. Without it, to what had focus when it opened. */
  anchor?: (id: string) => HTMLElement | null | undefined;
  /** More buttons beside Close, for the clip shown: a page that can delete one puts that here. */
  actions?: (video: ViewerVideo) => ReactNode;
}) {
  const [shownId, setShownId] = useState(startId);
  const found = videos.findIndex((v) => v.id === shownId);
  // A clip taken out of the list while it is open leaves its place to the one that took it.
  const kept = useRef(Math.max(0, found));
  const index = found >= 0 ? found : Math.min(kept.current, videos.length - 1);
  kept.current = index;
  const video: ViewerVideo | undefined = videos[index];
  const id = video?.id ?? shownId;

  const dialog = useRef<HTMLDivElement>(null);
  const leaving = useLeaveRef<HTMLDivElement>("dialog");
  const [failed, setFailed] = useState<string | null>(null);

  const step = (by: 1 | -1) => {
    const to = stepped(index, videos.length, by);
    if (to !== undefined) setShownId(videos[to].id);
  };
  useScrollLock();
  useBackToClose(onClose);

  // What the handlers that outlive a draw (keys, closing) have to go by.
  const latest = useRef({ step, onClose, anchor, shown: id });
  latest.current = { step, onClose, anchor, shown: id };
  const [opener] = useState(() => document.activeElement);

  useEffect(() => {
    if (!videos.length) onClose();
  }, [videos.length, onClose]);

  // What has focus can go away under it (an arrow that is used up), and focus drops to the page: it goes to the dialog.
  useLayoutEffect(() => {
    const focused = document.activeElement;
    if (!focused || focused === document.body || focused.matches(":disabled")) dialog.current?.focus({ preventScroll: true });
  });

  useEffect(() => {
    dialog.current?.focus({ preventScroll: true });
    const root = () => dialog.current;
    // Over another dialog that opened from here, that one has the keys.
    const covered = () => {
      const over = (document.activeElement as HTMLElement | null)?.closest('[aria-modal="true"]');
      return !!over && over !== root();
    };
    // Capture phase, and stopped: the page behind listens for Escape too, and one press closes the topmost thing.
    const onKey = (e: KeyboardEvent) => {
      const box = root();
      if (!box || covered()) return;
      if (isEscape(e)) {
        e.preventDefault();
        e.stopPropagation();
        latest.current.onClose();
        return;
      }
      if (e.key === "Tab") {
        // Round the dialog, rather than out into the page behind it.
        const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)];
        const at = items.indexOf(document.activeElement as HTMLElement);
        const [first, last] = [items[0], items[items.length - 1]];
        if (!first) {
          e.preventDefault();
          box.focus();
        } else if (e.shiftKey && at <= 0) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (at < 0 || document.activeElement === last)) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      // A field a page put in `actions` keeps its own keys, and so does the player: its arrows seek.
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable], video")) return;
      if (e.key === "ArrowLeft") latest.current.step(-1);
      else if (e.key === "ArrowRight") latest.current.step(1);
      else return;
      e.preventDefault();
    };
    // Something outside took focus (a field that fills itself in as a run ends): it comes back.
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && root() && !root()!.contains(target) && !target.closest?.('[aria-modal="true"]')) root()!.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocusIn);
      // To the clip that was last shown, if the page can find it; else to where it came from.
      const back = latest.current.anchor?.(latest.current.shown) ?? (opener instanceof HTMLElement ? opener : null);
      if (back?.isConnected) back.focus();
    };
  }, [opener]);

  if (!video) return null;
  const many = videos.length > 1;
  const closeOnBlank = (e: ReactMouseEvent) => e.target === e.currentTarget && onClose();
  const broken = failed === id;

  return createPortal(
    <div ref={leaving} className="ui-backdrop video-viewer fixed inset-0 z-[55] bg-canvas/95 backdrop-blur-md">
      <div ref={dialog} role="dialog" aria-modal="true" aria-label={t("Video viewer")} tabIndex={-1} onClick={closeOnBlank} className="flex h-full w-full flex-col outline-none">
        <header onClick={closeOnBlank} className="flex shrink-0 flex-wrap items-center justify-end gap-1 px-2 pb-1 pt-[max(0.5rem,env(safe-area-inset-top))] sm:px-3">
          {many && <span aria-hidden className="px-2 text-xs tabular-nums text-fg-muted">{index + 1} / {videos.length}</span>}
          <div className="flex-1" onClick={closeOnBlank} />
          {actions?.(video)}
          <a href={video.src} target="_blank" rel="noreferrer" className={iconButton} aria-label={t("Open in a new tab")} title={t("Open in a new tab")}>
            <LuExternalLink aria-hidden className="h-[18px] w-[18px]" />
          </a>
          <a href={video.src} download={video.fileName ?? ""} className={iconButton} aria-label={t("Download the video")} title={t("Download the video")}>
            <LuDownload aria-hidden className="h-[18px] w-[18px]" />
          </a>
          <button type="button" onClick={onClose} className={iconButton} aria-label={t("Close")} title={t("Close")}>
            <LuX aria-hidden className="h-[18px] w-[18px]" />
          </button>
        </header>

        <div className="relative min-h-0 flex-1" onClick={closeOnBlank}>
          <div className="absolute inset-0 grid place-items-center px-2 sm:px-14" onClick={closeOnBlank}>
            {broken ? (
              <p className="px-6 text-center text-sm text-fg-muted">{t("The video could not be loaded.")}</p>
            ) : (
              <video
                key={id}
                data-video=""
                src={video.src}
                poster={video.poster}
                aria-label={video.label}
                controls
                autoPlay
                playsInline
                preload="metadata"
                onError={() => setFailed(id)}
                className="max-h-full max-w-full rounded-lg bg-black"
              />
            )}
          </div>
          {many && (
            <>
              <button type="button" onClick={() => step(-1)} disabled={index === 0} aria-label={t("Previous video")} title={t("Previous video")} className={`${iconButton} absolute left-2 top-1/2 -translate-y-1/2 border border-line bg-surface/80 shadow-pop backdrop-blur`}>
                <LuChevronLeft aria-hidden className="h-5 w-5" />
              </button>
              <button type="button" onClick={() => step(1)} disabled={index === videos.length - 1} aria-label={t("Next video")} title={t("Next video")} className={`${iconButton} absolute right-2 top-1/2 -translate-y-1/2 border border-line bg-surface/80 shadow-pop backdrop-blur`}>
                <LuChevronRight aria-hidden className="h-5 w-5" />
              </button>
            </>
          )}
        </div>

        <footer onClick={closeOnBlank} className="flex shrink-0 items-center gap-3 px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1">
          <p className="min-w-0 flex-1 text-sm text-fg-muted" onClick={closeOnBlank}>
            {video.caption && <span className="line-clamp-2">{video.caption}</span>}
          </p>
          {/* Said aloud when the clip changes: the arrows move nothing a screen reader is on. */}
          <span className="sr-only" aria-live="polite">
            {video.caption ?? video.label}
            {many ? `, ${index + 1} / ${videos.length}` : ""}
          </span>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
