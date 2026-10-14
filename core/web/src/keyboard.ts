/**
 * The on-screen keyboard, on a phone: only the composer moves up for it.
 *
 * Opened, the keyboard covers the bottom of the page, and the browser pushed
 * the whole page up to keep the box being typed in on screen: the chat's
 * header and its buttons went off the top, and came back when it closed. The
 * page is made as tall as what the keyboard leaves instead: the header stays
 * where it is, the conversation is shorter, and the composer sits on the
 * keyboard.
 *
 * Chrome on Android does that itself when asked to (`interactive-widget` in
 * index.html's viewport), and the page's `100dvh` is then what is left. Safari
 * does not: there `--keyboard` on the root is how tall the keyboard is, read
 * from the visual viewport, which the app's height takes off; and the page
 * Safari pushed up to show the box is put back, now that the box is above the
 * keyboard.
 *
 * Only for the app itself (`data-fits-keyboard`), which is what gets shorter.
 * A box on the login screen or in a dialog stays where Safari pushed it: put
 * back, it would be under the keyboard again.
 */
export type Visual = { height: number; offsetTop: number; scale: number };

/**
 * How tall the keyboard is, in px: what it leaves of the page's height. Not
 * less where Safari has pushed the page up to show the box — then less of the
 * page is under the keyboard, but that push is what is undone.
 *
 * Zoomed in, the visual viewport is smaller by the zoom as well: it is
 * measured at the zoom, so that only the keyboard is left. Safari zooms in
 * on its own when a small field is typed in — the terminal's — and taking
 * that for no keyboard at all put the page back to being pushed up.
 */
export function keyboardInset(innerHeight: number, visual: Visual): number {
  return Math.max(0, Math.round(innerHeight - visual.height * visual.scale));
}

/** Typing in the app itself, which gets shorter — not on the login screen or in a dialog over it. */
const inApp = (el: Element | null) => !!el?.closest("[data-fits-keyboard]") && !el.closest('[role="dialog"], dialog');

export function watchKeyboard(win: Window = window): () => void {
  const visual = win.visualViewport;
  if (!visual) return () => {};
  const root = win.document.documentElement;
  const apply = () => {
    const inset = keyboardInset(win.innerHeight, visual);
    root.style.setProperty("--keyboard", `${inset}px`);
    // Pushed up to show the box: put back, now that the box is above the
    // keyboard. Not while zoomed in: there the page is moved by the person.
    const zoomed = Math.abs(visual.scale - 1) > 0.01;
    if (inset > 0 && !zoomed && (win.scrollY > 0 || visual.offsetTop > 0) && inApp(win.document.activeElement)) win.scrollTo(0, 0);
  };
  apply();
  visual.addEventListener("resize", apply);
  visual.addEventListener("scroll", apply);
  return () => {
    visual.removeEventListener("resize", apply);
    visual.removeEventListener("scroll", apply);
  };
}
