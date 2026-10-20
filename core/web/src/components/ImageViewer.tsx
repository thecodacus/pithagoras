import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { LuChevronLeft, LuChevronRight, LuDownload, LuExternalLink, LuRedo2, LuUndo2, LuX, LuZoomIn, LuZoomOut } from "react-icons/lu";
import { isEscape } from "../shortcuts";
import { useLeaveRef } from "../motion";
import { usePanZoom } from "../use-pan-zoom";
import { useBackToClose } from "../use-back-to-close";
import { useScrollLock } from "../use-scroll-lock";
import { linked, stepped, type Size, type ViewerPicture } from "../image-viewer";
import { t } from "../i18n";

/** Wide enough for a finger on a phone, and for the pointer beside it. */
export const iconButton = "grid h-10 w-10 shrink-0 place-items-center rounded-lg text-fg-muted transition hover:bg-fg/10 hover:text-fg disabled:pointer-events-none disabled:opacity-35 sm:h-9 sm:w-9";
/** The viewer's own buttons, with a look for the ones that are on: the ones a page adds in `actions` match them. */
export const viewerButton = `${iconButton} aria-pressed:bg-accent/15 aria-pressed:text-accent`;
const textButton = "inline-flex h-10 min-w-10 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2.5 text-xs text-fg-muted transition hover:bg-fg/10 hover:text-fg sm:h-9";

/** What can take the keyboard: the viewer's own buttons, and what a page puts in `actions`. */
const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * A picture over the whole page, fitted to the screen, on a calm backdrop.
 *
 * It takes a list of pictures and the one to start at, and knows nothing of
 * where they come from: the chat opens it, and an extension's page the same way (`ui.ImageViewer`).
 *
 * - A dialog: labelled, with the keyboard kept inside it (Tab goes round), the
 *   page behind it not scrollable, and focus given back to the picture it
 *   was opened from — or to the one last shown, when `anchor` can find that —
 *   when it closes. Over a docked panel or the chat in fullscreen it is the same:
 *   it covers the whole window, since a picture wants all the room there is.
 * - Closed by the button, Escape, a click beside the picture, or the browser's
 *   back button, which on a phone is the way out (see use-back-to-close.ts).
 * - Zoomed by the wheel, a pinch, the buttons, `+` and `-`, and a double tap or
 *   click, which goes between the whole picture and its own size; moved when
 *   zoomed, by dragging (use-pan-zoom.ts).
 * - Stepped through with the arrows on the sides, the arrow keys, or a swipe.
 * - The picture's `caption` underneath, and a link both ways between a picture
 *   and the one it was edited from, when both are in the list.
 * - Open in a new tab and Download are there on purpose, as the quiet way to the
 *   file itself. `actions` adds a page's own buttons beside them.
 *
 * Opening and closing move only as much as the page does everywhere (styles/viewer.css).
 */
export function ImageViewer({
  pictures,
  startId,
  onClose,
  anchor,
  actions,
}: {
  pictures: ViewerPicture[];
  /** The `id` of the picture to open on. */
  startId: string;
  onClose: () => void;
  /** Where focus goes when it closes, for the picture shown last. Without it, to what had focus when it opened. */
  anchor?: (id: string) => HTMLElement | null | undefined;
  /** More buttons beside Close, for the picture shown: a page that can delete one puts that here. */
  actions?: (picture: ViewerPicture) => ReactNode;
}) {
  const [shownId, setShownId] = useState(startId);
  const found = pictures.findIndex((p) => p.id === shownId);
  // A picture taken out of the list while it is open leaves its place to the one that took it.
  const kept = useRef(Math.max(0, found));
  const index = found >= 0 ? found : Math.min(kept.current, pictures.length - 1);
  kept.current = index;
  const picture: ViewerPicture | undefined = pictures[index];
  const id = picture?.id ?? shownId;

  const dialog = useRef<HTMLDivElement>(null);
  const stageEl = useRef<HTMLDivElement>(null);
  // Closed, it sinks away as a picture of itself (see motion.ts).
  const leaving = useLeaveRef<HTMLDivElement>("dialog");
  const [stage, setStage] = useState<Size | null>(null);
  const [loaded, setLoaded] = useState<{ id: string; image: Size } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const image = loaded?.id === id ? loaded.image : null;

  const step = (by: 1 | -1) => {
    const to = stepped(index, pictures.length, by);
    if (to !== undefined) setShownId(pictures[to].id);
  };
  const pan = usePanZoom({ id, image, stage, element: stageEl, onSwipe: step, onTap: onClose });
  useScrollLock();
  useBackToClose(onClose);

  // What the handlers that outlive a draw (keys, closing) have to go by.
  const latest = useRef({ step, pan, onClose, anchor, shown: id });
  latest.current = { step, pan, onClose, anchor, shown: id };
  const [opener] = useState(() => document.activeElement);

  useEffect(() => {
    if (!pictures.length) onClose();
  }, [pictures.length, onClose]);

  // What has focus can go away under it (an arrow that is used up, Zoom out of a picture that is whole again, Original of one that has none), and focus drops to the page: it goes to the dialog.
  useLayoutEffect(() => {
    const focused = document.activeElement;
    if (!focused || focused === document.body || focused.matches(":disabled")) dialog.current?.focus({ preventScroll: true });
  });

  useEffect(() => {
    const el = stageEl.current;
    if (!el) return;
    const measure = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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
      // A field a page put in `actions` keeps its own keys.
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]")) return;
      const { step, pan } = latest.current;
      if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
      else if (e.key === "+" || e.key === "=") pan.zoomIn();
      else if (e.key === "-") pan.zoomOut();
      else if (e.key === "0") pan.fit();
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
      // To the picture that was last shown, if the page can find it; else to where it came from.
      const back = latest.current.anchor?.(latest.current.shown) ?? (opener instanceof HTMLElement ? opener : null);
      if (back?.isConnected) back.focus();
    };
  }, [opener]);

  if (!picture) return null;
  const { original, edits } = linked(pictures, picture);
  const edit = edits.find((p) => pictures.indexOf(p) > index) ?? edits[0];
  const many = pictures.length > 1;
  const closeOnBlank = (e: ReactMouseEvent) => e.target === e.currentTarget && onClose();
  const broken = failed === id;

  return createPortal(
    <div ref={leaving} className="ui-backdrop image-viewer fixed inset-0 z-[55] bg-canvas/95 backdrop-blur-md">
      <div ref={dialog} role="dialog" aria-modal="true" aria-label={t("Picture viewer")} tabIndex={-1} onClick={closeOnBlank} className="image-viewer-card flex h-full w-full flex-col outline-none">
        <header onClick={closeOnBlank} className="flex shrink-0 flex-wrap items-center justify-end gap-1 px-2 pb-1 pt-[max(0.5rem,env(safe-area-inset-top))] sm:px-3">
          {many && <span aria-hidden className="px-2 text-xs tabular-nums text-fg-muted">{index + 1} / {pictures.length}</span>}
          {original && (
            <button type="button" onClick={() => setShownId(original.id)} className={textButton} aria-label={t("Show the original")} title={t("Show the original")}>
              <LuUndo2 aria-hidden className="h-4 w-4" />
              <span className="max-sm:hidden">{t("Original")}</span>
            </button>
          )}
          {edit && (
            <button type="button" onClick={() => setShownId(edit.id)} className={textButton} aria-label={t("Show the edited version")} title={t("Show the edited version")}>
              <LuRedo2 aria-hidden className="h-4 w-4" />
              <span className="max-sm:hidden">{t("Edited version")}</span>
            </button>
          )}
          <div className="flex-1" onClick={closeOnBlank} />
          {actions?.(picture)}
          <a href={picture.src} target="_blank" rel="noreferrer" className={iconButton} aria-label={t("Open in a new tab")} title={t("Open in a new tab")}>
            <LuExternalLink aria-hidden className="h-[18px] w-[18px]" />
          </a>
          <a href={picture.src} download={picture.fileName ?? ""} className={iconButton} aria-label={t("Download the picture")} title={t("Download the picture")}>
            <LuDownload aria-hidden className="h-[18px] w-[18px]" />
          </a>
          <button type="button" onClick={onClose} className={iconButton} aria-label={t("Close")} title={t("Close")}>
            <LuX aria-hidden className="h-[18px] w-[18px]" />
          </button>
        </header>

        <div className="relative min-h-0 flex-1">
          <div ref={stageEl} {...pan.bind} className={`image-viewer-stage absolute inset-0 overflow-hidden${pan.zoomed ? " is-zoomed" : ""}`}>
            {broken ? (
              <p className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-fg-muted">{t("The picture could not be loaded.")}</p>
            ) : (
              <div className="image-viewer-frame absolute inset-0">
                <img
                  key={id}
                  data-picture=""
                  src={picture.src}
                  alt={picture.alt}
                  draggable={false}
                  onLoad={(e) => setLoaded({ id, image: { w: e.currentTarget.naturalWidth || 300, h: e.currentTarget.naturalHeight || 300 } })}
                  onError={() => setFailed(id)}
                  className="image-viewer-img"
                  style={pan.view && image ? { width: image.w, height: image.h, transform: `translate(${pan.view.x}px, ${pan.view.y}px) scale(${pan.view.k})` } : { visibility: "hidden" }}
                />
              </div>
            )}
          </div>
          {many && (
            <>
              <button type="button" onClick={() => step(-1)} disabled={index === 0} aria-label={t("Previous picture")} title={t("Previous picture")} className={`${iconButton} absolute left-2 top-1/2 -translate-y-1/2 border border-line bg-surface/80 shadow-pop backdrop-blur`}>
                <LuChevronLeft aria-hidden className="h-5 w-5" />
              </button>
              <button type="button" onClick={() => step(1)} disabled={index === pictures.length - 1} aria-label={t("Next picture")} title={t("Next picture")} className={`${iconButton} absolute right-2 top-1/2 -translate-y-1/2 border border-line bg-surface/80 shadow-pop backdrop-blur`}>
                <LuChevronRight aria-hidden className="h-5 w-5" />
              </button>
            </>
          )}
        </div>

        <footer onClick={closeOnBlank} className="flex shrink-0 items-center gap-3 px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1">
          <p className="min-w-0 flex-1 text-sm text-fg-muted" onClick={closeOnBlank}>
            {picture.caption && <span className="line-clamp-2">{picture.caption}</span>}
          </p>
          {/* Said aloud when the picture changes: the arrows move nothing a screen reader is on. */}
          <span className="sr-only" aria-live="polite">
            {picture.caption ?? picture.alt}
            {many ? `, ${index + 1} / ${pictures.length}` : ""}
          </span>
          <div className="flex shrink-0 items-center gap-0.5">
            <button type="button" onClick={pan.zoomOut} disabled={!image || !pan.zoomed} aria-label={t("Zoom out")} title={t("Zoom out")} className={iconButton}>
              <LuZoomOut aria-hidden className="h-[18px] w-[18px]" />
            </button>
            <button
              type="button"
              onClick={pan.toggle}
              disabled={!image}
              aria-label={pan.zoomed ? t("Fit the picture") : t("Show the picture at full size")}
              title={pan.zoomed ? t("Fit the picture") : t("Show the picture at full size")}
              className="h-10 min-w-[3.25rem] shrink-0 rounded-lg px-1.5 text-xs tabular-nums text-fg-muted transition hover:bg-fg/10 hover:text-fg disabled:pointer-events-none disabled:opacity-35 sm:h-9"
            >
              {pan.view ? `${Math.round(pan.view.k * 100)}%` : ""}
            </button>
            <button type="button" onClick={pan.zoomIn} disabled={!image} aria-label={t("Zoom in")} title={t("Zoom in")} className={iconButton}>
              <LuZoomIn aria-hidden className="h-[18px] w-[18px]" />
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
