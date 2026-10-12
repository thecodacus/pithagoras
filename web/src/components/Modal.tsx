import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { LuChevronLeft, LuX } from "react-icons/lu";
import { isEscape } from "../shortcuts";
import { useLeaveRef } from "../motion";
import { useDialogFocus } from "../dialog-focus";
import { confirmDialog } from "./ConfirmDialog";
import { t } from "../i18n";

/** What is typed into the dialog and not saved, as its contents say so (see `useUnsavedDraft`). */
const Drafts = createContext<Set<object> | null>(null);

/**
 * Says that this part of a dialog holds something typed in that nothing has
 * saved: closing the dialog (Escape, a click beside it, its close button) then
 * asks first. For what is not in the dialog's own component; that one passes
 * `unsaved`.
 */
export function useUnsavedDraft(unsaved: boolean) {
  const drafts = useContext(Drafts);
  useEffect(() => {
    if (!unsaved || !drafts) return;
    const mine = {};
    drafts.add(mine);
    return () => {
      drafts.delete(mine);
    };
  }, [unsaved, drafts]);
}

/**
 * Centered dialog with a dimmed backdrop. Escape and backdrop clicks close it,
 * after asking when there is something unsaved in it: a draft is in no other place.
 *
 * With a `rail` it becomes a two-pane settings dialog: navigation down the left
 * edge, content on the right. On a narrow screen the two take turns, like a
 * phone's settings: the rail first, then the chosen section with a way back.
 * Stacked, the rail took most of the height and left the section a sliver.
 * `startInRail` false opens straight on the section the caller chose.
 */
export function Modal({
  title,
  subtitle,
  rail,
  onClose,
  children,
  footer,
  wide,
  startInRail = true,
  section,
  unsaved = false,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  rail?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  startInRail?: boolean;
  /** The rail's chosen section: the title on a phone, where the rail is out of sight. */
  section?: ReactNode;
  /** Something typed in the dialog's own component that is not saved. */
  unsaved?: boolean;
}) {
  // Only read below `sm`; wider, both panes are always there.
  const [inRail, setInRail] = useState(startInRail);
  // Closed, it sinks away as a picture of itself (see motion.ts).
  const leaving = useLeaveRef<HTMLDivElement>("dialog");
  const dialog = useDialogFocus<HTMLDivElement>();
  // Only for its first moment, so that what comes in with it (the rail's lines) does not come in again when it is drawn again.
  // Over when what came in has come in, not after a time about as long: a search started and ended in between
  // drew the rail anew while the dialog was still fresh, and its lines came in again.
  const [fresh, setFresh] = useState(true);
  useEffect(() => {
    let done = false;
    const over = () => {
      if (done) return;
      done = true;
      setFresh(false);
    };
    // Until a few frames pass with nothing coming in: lines drawn a moment after the dialog (a list that
    // loads) come in with it as well, and are not cut off half way.
    let frame = 0;
    let quiet = 0;
    const look = () => {
      if (done) return;
      const entrance = (dialog.current?.getAnimations?.({ subtree: true }) ?? []).filter(
        (a) => a.playState !== "finished" && a.effect?.getComputedTiming().iterations !== Infinity
      );
      if (entrance.length) {
        quiet = 0;
        void Promise.allSettled(entrance.map((a) => a.finished)).then(() => {
          if (!done) frame = requestAnimationFrame(look);
        });
      } else if (++quiet >= 3) over();
      else frame = requestAnimationFrame(look);
    };
    frame = requestAnimationFrame(look);
    // Whatever happens to the animations, it does not stay fresh for long.
    const timer = window.setTimeout(over, 3000);
    return () => {
      done = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, []);
  const drafts = useRef(new Set<object>());
  const unsavedNow = useRef(unsaved);
  unsavedNow.current = unsaved;
  const asking = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const close = async () => {
    if (asking.current) return;
    // A field that saves when it is left is left first, whichever way the dialog is closed: the
    // close button and a click beside it move focus out of it, and Escape does not.
    const at = document.activeElement;
    const field = at instanceof HTMLElement && at !== dialog.current && dialog.current?.contains(at) ? at : null;
    field?.blur();
    if (unsavedNow.current || drafts.current.size) {
      asking.current = true;
      const discard = await confirmDialog({ title: t("Discard your changes?"), message: t("What you changed here has not been saved."), confirmLabel: t("Discard"), danger: true });
      asking.current = false;
      // Closed meanwhile by whoever drew it (a save that finished): there is nothing left to close.
      if (!alive.current) return;
      if (!discard) return field?.isConnected ? field.focus({ preventScroll: true }) : undefined;
    }
    onClose();
  };
  useEffect(() => {
    // Not the Escape that takes back an input method's word in one of its fields.
    const onKey = (e: KeyboardEvent) => isEscape(e) && void close();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const body = <Drafts.Provider value={drafts.current}>{children}</Drafts.Provider>;

  return (
    <div
      ref={leaving}
      className="ui-backdrop fixed inset-0 z-50 flex items-center justify-center bg-canvas/80 p-2 backdrop-blur-sm sm:p-4"
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        // The press would otherwise clear focus once the question has taken it, or once it was given back.
        e.preventDefault();
        void close();
      }}
    >
      {/* The rail layout gets a floor as well as a ceiling: its panels fetch
          before they render anything, so without one the dialog opened as a
          bare title bar and snapped to full height a moment later. Wider than
          a phone its height is fixed: sized to each section, it grew and shrank
          and re-centred from one to the next, and the rail moved under the
          pointer that had just picked from it. */}
      <div
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        className={`ui-dialog${fresh ? " is-fresh" : ""} outline-none flex max-h-[94dvh] w-full sm:max-h-[88vh] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-pop ${
          // Grows with the viewport rather than to it: the rail plus a settings
          // form has a comfortable width, and a 34-inch screen should not
          // stretch a two-column form across all of it.
          wide ? "max-w-3xl xl:max-w-5xl" : "max-w-2xl"
        } ${rail ? "min-h-[min(34rem,94dvh)] sm:h-[min(44rem,88vh)]" : ""}`}
      >
        <header className="flex items-center gap-3 border-b border-line px-5 py-3.5">
          {rail && !inRail && (
            <button
              type="button"
              onClick={() => setInRail(true)}
              className="-ml-2 rounded-lg p-1.5 text-fg-subtle transition hover:bg-fg/10 hover:text-fg sm:hidden"
              aria-label={t("Back")}
            >
              <LuChevronLeft className="h-4 w-4" />
            </button>
          )}
          <div className="min-w-0 flex-1">
            {rail && section && !inRail ? (
              <>
                <h2 className="truncate text-sm font-semibold text-fg sm:hidden">{section}</h2>
                <h2 className="hidden truncate text-sm font-semibold text-fg sm:block">{title}</h2>
                {subtitle && <p className="hidden truncate text-xs text-fg-subtle sm:block">{subtitle}</p>}
              </>
            ) : (
              <>
                <h2 className="truncate text-sm font-semibold text-fg">{title}</h2>
                {subtitle && <p className="truncate text-xs text-fg-subtle">{subtitle}</p>}
              </>
            )}
          </div>
          <button
            onClick={() => void close()}
            className="rounded-lg p-1.5 text-fg-subtle transition hover:bg-fg/10 hover:text-fg"
            aria-label={t("Close")}
          >
            <LuX className="h-4 w-4" />
          </button>
        </header>

        {rail ? (
          <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
            {/* Any button in the rail picks a section, so any click on one
                turns to it; the rail's own state says which. */}
            <nav
              onClick={(e) => (e.target as HTMLElement).closest("button") && setInRail(false)}
              className={`min-h-0 flex-1 overflow-y-auto bg-canvas/40 p-2 sm:block sm:w-52 sm:flex-none sm:shrink-0 sm:border-r sm:border-line ${inRail ? "" : "hidden"}`}
            >
              {rail}
            </nav>
            <div className={`min-w-0 flex-1 overflow-y-auto px-5 py-4 sm:block ${inRail ? "hidden" : ""}`}>{body}</div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-5 py-4">{body}</div>
        )}

        {footer && <footer className="border-t border-line px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}
