import { useEffect, useRef, useState, type ReactNode } from "react";
import { asksBeforeDeleting } from "../confirm-prefs";
import { useLeaveRef } from "../motion";
import { t } from "../i18n";

/**
 * Asking "are you sure" in the portal's own dialog instead of the browser's.
 *
 * window.confirm() is a grey system box that ignores the theme, cannot say what
 * the button will do, and looks like something from a different site — for the
 * one moment the portal is about to delete something. This keeps the call shape
 * (ask, get a yes or no) so a call site changes by one word:
 *
 *   if (await confirmDialog({ title: "Delete it?", danger: true })) …
 */
interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  /** What the button says. "OK" tells nobody what it is about to do. */
  confirmLabel?: string;
  /** Destructive: the button is red, and focus starts on Cancel. */
  danger?: boolean;
  /**
   * Removes something, so the question can be switched off in Settings. Not
   * the same as `danger`: throwing away unsaved edits is dangerous too, but
   * there is no copy of them to fall back on and nobody asked to skip it.
   */
  deletes?: boolean;
}

/** `from` is what had focus when it was asked, which is where focus goes back to: by the time the dialog is drawn it has taken focus itself. */
type Pending = ConfirmOptions & { id: number; resolve: (ok: boolean) => void; from: HTMLElement | null };

let present: ((p: Pending) => void) | null = null;
/** The question that is drawn now. */
let shown: Pending | undefined;
let counter = 0;

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  if (options.deletes && !asksBeforeDeleting()) return Promise.resolve(true);
  // Nothing mounted to draw it — which is a bug, but not one that should make
  // a delete button do nothing.
  if (!present) {
    const text = typeof options.message === "string" ? `\n\n${options.message}` : "";
    return Promise.resolve(window.confirm(options.title + text));
  }
  const active = document.activeElement as HTMLElement | null;
  // Asked while another question is open (a check that took a while came back): focus is in that dialog, which goes
  // before this one is drawn. Focus goes back to where that one would have put it.
  const from = shown && active?.closest('[role="alertdialog"]') ? shown.from : active;
  return new Promise((resolve) => present!({ ...options, id: ++counter, resolve, from }));
}

/** Mounted once, at the root. Draws whatever confirmDialog() asked for, in order. */
export function ConfirmHost() {
  const [queue, setQueue] = useState<Pending[]>([]);
  const cancel = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const current = queue[0];
  // What is waiting, as the last drawing had it: for the cleanup of the question answered, which runs after the next one is drawn.
  const waiting = useRef(queue);
  waiting.current = queue;
  useEffect(() => {
    shown = current;
    return () => {
      shown = undefined;
    };
  }, [current]);
  // Answered, the dialog sinks away as a picture of itself (see motion.ts).
  const leaving = useLeaveRef<HTMLDivElement>("dialog");

  useEffect(() => {
    present = (p) => setQueue((q) => [...q, p]);
    return () => {
      present = null;
    };
  }, []);

  const answer = (ok: boolean) => {
    current?.resolve(ok);
    setQueue((q) => q.slice(1));
  };

  useEffect(() => {
    if (!current) return;
    // Back to whatever had focus, so a keyboard user is not dropped at the top
    // of the page after answering.
    const before = current.from;
    const onKey = (e: KeyboardEvent) => {
      // Capture phase, and stopped: a settings dialog underneath listens for
      // Escape too, and one keypress should close only the topmost thing.
      if (e.key === "Escape") {
        e.stopPropagation();
        answer(false);
      } else if (e.key === "Tab") {
        // Tab goes round the dialog, the buttons and whatever the message offers
        // (a checkbox, say), rather than out into the page behind the backdrop.
        e.preventDefault();
        const items = [...(cancel.current?.closest('[role="alertdialog"]')?.querySelectorAll<HTMLElement>("input, select, textarea, button, a[href]") ?? [])].filter(
          (el) => !(el as HTMLInputElement).disabled,
        );
        if (!items.length) return;
        const at = items.indexOf(document.activeElement as HTMLElement);
        items[at < 0 ? (e.shiftKey ? items.length - 1 : 0) : (at + (e.shiftKey ? -1 : 1) + items.length) % items.length].focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      // The next question is drawn already, and has taken focus: it is the one to give it back, from the same place.
      if (waiting.current[0] && waiting.current[0].id !== current.id) return;
      // A control that is only drawn while its row has focus (the sidebar's Delete) is not there to take it back: its row is.
      const back = before && before.getClientRects().length === 0 ? before.parentElement?.closest<HTMLElement>('[tabindex]:not([tabindex="-1"]), a[href], button') : before;
      // Unless focus went somewhere on purpose meanwhile: what the answer led to.
      const at = document.activeElement;
      if (at && at !== document.body && !at.closest('[role="alertdialog"]')) return;
      back?.focus?.();
    };
    // answer closes over `current`, which is what this effect is keyed on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  if (!current) return null;

  return (
    <div
      ref={leaving}
      className="ui-backdrop fixed inset-0 z-[60] flex items-center justify-center bg-canvas/80 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        // The press would otherwise clear the focus that the answer has just given back to the button.
        e.preventDefault();
        answer(false);
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby={current.message ? "confirm-message" : undefined}
        key={current.id}
        data-danger={current.danger || undefined}
        className="ui-dialog is-alert w-full max-w-sm rounded-2xl border border-line bg-surface p-5 shadow-pop"
      >
        <h2 id="confirm-title" className="text-sm font-semibold text-fg">
          {current.title}
        </h2>
        {current.message && (
          <div id="confirm-message" className="mt-2 whitespace-pre-line text-sm text-fg-muted">
            {current.message}
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            key={`cancel-${current.id}`}
            ref={cancel}
            type="button"
            autoFocus={current.danger}
            onClick={() => answer(false)}
            className="rounded-lg px-3 py-1.5 text-sm text-fg-muted transition hover:bg-fg/5 hover:text-fg"
          >
            {t("Cancel")}
          </button>
          <button
            key={`confirm-${current.id}`}
            ref={confirm}
            type="button"
            autoFocus={!current.danger}
            onClick={() => answer(true)}
            className={`rounded-lg px-3 py-1.5 text-sm ring-1 ring-inset transition ${
              current.danger
                ? "bg-danger/15 text-danger ring-danger/30 hover:bg-danger/25"
                : "bg-accent/15 text-accent ring-accent/30 hover:bg-accent/25"
            }`}
          >
            {current.confirmLabel ?? t("OK")}
          </button>
        </div>
      </div>
    </div>
  );
}
