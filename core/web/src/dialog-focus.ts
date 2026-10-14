import { useEffect, useRef } from "react";

const TABBABLE = 'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';

/** What Tab can reach inside `box`: not what is disabled, hidden, or left out of the order. */
function tabbables(box: HTMLElement): HTMLElement[] {
  return [...box.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (el) => !(el as HTMLButtonElement).disabled && el.getAttribute("tabindex") !== "-1" && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden",
  );
}

/** Is `el` on the page and drawn? A control inside something that is hidden is on the page, and cannot take focus. */
const drawn = (el: HTMLElement) => el.isConnected && el.getClientRects().length > 0;

/** Where focus goes back to when each open dialog closes, the newest last: for a dialog that opens from inside one, or in its place, to find. */
const returnsTo = new Map<Element, () => HTMLElement | null>();

/**
 * The keyboard of a dialog that covers the page: focus goes in when it opens
 * (to a field that took it, or else to the dialog itself), Tab goes round it
 * instead of out into the page behind the backdrop, and focus goes back to
 * what had it when the dialog closes, so that nobody is dropped at the top of
 * the page. Put the returned ref and `tabIndex={-1}` on the element with
 * `role="dialog"`. `active` is for one that is always drawn and only
 * sometimes covers the page (the phone's navigation).
 */
export function useDialogFocus<T extends HTMLElement>(active = true) {
  const box = useRef<T>(null);
  const opener = useRef<HTMLElement | null>(null);
  // Where the dialog this one opened from goes back to: that dialog may be the one this replaces.
  const behind = useRef<HTMLElement | null>(null);
  const was = useRef(false);
  const now = useRef(active);
  now.current = active;
  // Read while drawing, before anything in the dialog (an autofocused field) has taken focus.
  if (active && !was.current) {
    const from = document.activeElement as HTMLElement | null;
    opener.current = from;
    // The next of two questions is drawn in the commit that removes the one answered, from the button that
    // answered it, or from nowhere once that button was disabled: it goes back to where the first would have.
    const parent = from?.closest('[aria-modal="true"]') ?? (!from || from === document.body ? [...returnsTo.keys()].at(-1) : undefined);
    behind.current = (parent && returnsTo.get(parent)?.()) || null;
  }
  was.current = active;
  useEffect(() => {
    const dialog = box.current;
    if (!active || !dialog) return;
    // What it was opened from, or where that went back to when it is gone from the page or no longer drawn
    // (the phone's drawer closes with Settings opened from it), or was no element to begin with.
    const target = () => {
      const from = opener.current;
      return from && from !== document.body && drawn(from) ? from : behind.current && drawn(behind.current) ? behind.current : null;
    };
    returnsTo.set(dialog, target);
    if (!dialog.contains(document.activeElement)) dialog.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.defaultPrevented) return;
      const at = document.activeElement as HTMLElement | null;
      // A dialog on top of this one (a confirmation) has its own Tab.
      if (at && !dialog.contains(at) && at.closest('[aria-modal="true"]')) return;
      const items = tabbables(dialog);
      if (!items.length) {
        e.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const first = items[0], last = items[items.length - 1];
      if (!at || at === dialog || !dialog.contains(at)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && at === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && at === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      returnsTo.delete(dialog);
      // React also runs this to see that it can, with the dialog still open.
      if (now.current && dialog.isConnected) return;
      // Focus that went somewhere on purpose (a dialog that opened as this one closed) stays there.
      const at = document.activeElement;
      if (at && at !== document.body && !dialog.contains(at)) return;
      target()?.focus({ preventScroll: true });
    };
  }, [active]);
  return box;
}
