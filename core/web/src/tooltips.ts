/**
 * Tooltips in the portal's own style, for every `title` in the app.
 *
 * The browser's tooltip is a system-grey box that arrives a second late and
 * ignores the theme. Rather than rewrite hundreds of `title`s, the attribute
 * is emptied on an element while the pointer is on it — so the native one
 * never shows — and filled again when it leaves, so screen readers and React's
 * own bookkeeping see it as it was.
 *
 * Emptied rather than removed: React taking a title away is then a removal
 * that can be seen, where on a missing attribute it would do nothing, and the
 * old text would come back.
 *
 * A title is the only name an icon-only button has, and an emptied one names
 * nothing: for a screen reader that follows the pointer, or a voice command
 * that says "click Delete session", the button would be a bare "button" for as
 * long as it is lifted. Its text is given as an `aria-label` meanwhile, to an
 * element that has no name of its own.
 */
const DELAY = 450;

export function installTooltips(): void {
  if (typeof document === "undefined" || !window.matchMedia("(hover: hover)").matches) return;
  const tip = document.createElement("div");
  tip.className = "ui-tooltip";
  tip.setAttribute("role", "presentation");
  document.body.appendChild(tip);

  let owner: HTMLElement | null = null;
  let text = "";
  /** Whether the lifted title is also the element's name, in `aria-label`, until it is put back. */
  let named = false;
  let timer = 0;
  let watch = 0;

  const release = () => {
    window.clearTimeout(timer);
    window.clearInterval(watch);
    // Put back only if nothing set a new one, or took it away, meanwhile.
    if (owner && text && owner.getAttribute("title") === "") owner.setAttribute("title", text);
    if (owner && named && owner.getAttribute("aria-label") === text) owner.removeAttribute("aria-label");
    owner = null;
    text = "";
    named = false;
    tip.classList.remove("is-shown");
  };

  const place = () => {
    if (!owner) return;
    // Gone from the page while the pointer was on it — a button that goes when
    // a run starts, a row that was deleted. No pointerout comes for it, and its
    // box is all zeros: the tip would appear in the corner and stay there.
    if (!owner.isConnected) return release();
    // Its title was taken away before the tip was due: nothing to say.
    if (!owner.hasAttribute("title")) return release();
    const r = owner.getBoundingClientRect();
    tip.textContent = text;
    tip.style.left = "0px";
    tip.style.top = "0px";
    const t = tip.getBoundingClientRect();
    const below = r.top < t.height + 12;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - t.width / 2), window.innerWidth - t.width - 8);
    const top = below ? r.bottom + 8 : r.top - t.height - 8;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.dataset.side = below ? "below" : "above";
    tip.classList.add("is-shown");
    window.clearInterval(watch);
    watch = window.setInterval(() => {
      if (!owner) return;
      if (!owner.isConnected) return release();
      // React took its title away: there is nothing to say any more.
      if (!owner.hasAttribute("title")) return release();
      // React gave it a new title while it was lifted ("Copy" to "Copied"):
      // lifted again, and said instead, or the browser's own would show too.
      const next = owner.getAttribute("title")?.trim();
      if (next) {
        owner.setAttribute("title", "");
        if (next !== text) {
          if (named) owner.setAttribute("aria-label", next);
          text = next;
          place();
        }
      }
    }, 250);
  };

  document.addEventListener(
    "pointerover",
    (e) => {
      // The lifted one keeps its emptied title, so from anywhere inside it this
      // finds it — or something in it with a title of its own, whose is said.
      const el = (e.target as Element | null)?.closest?.<HTMLElement>("[title]");
      if (el && el === owner) return;
      release();
      if (!el) return;
      const t = el.getAttribute("title")?.trim();
      // An iframe or the terminal is not ours to decorate. The iframe also
      // keeps every pointer and key event inside it, so nothing would take the
      // tip away again until the pointer left it.
      if (!t || el instanceof HTMLIFrameElement || el.closest(".xterm")) return;
      owner = el;
      text = t;
      el.setAttribute("title", "");
      // Named by its text, or by a label of its own, it needs no help.
      named = !el.hasAttribute("aria-label") && !el.hasAttribute("aria-labelledby") && !el.textContent?.trim();
      if (named) el.setAttribute("aria-label", t);
      timer = window.setTimeout(place, DELAY);
    },
    true,
  );
  document.addEventListener(
    "pointerout",
    (e) => {
      if (owner && !owner.contains(e.relatedTarget as Node | null)) release();
    },
    true,
  );
  // Where the pointer is, for a scroll that moves things under it.
  let pointer = { x: -1, y: -1 };
  window.addEventListener("pointermove", (e) => { pointer = { x: e.clientX, y: e.clientY }; }, { capture: true, passive: true });
  // Only a scroll that moves the element matters — not the chat following a
  // reply while the pointer rests on a header button. Moved from under the
  // pointer, it lets go; still under it, the tip goes with it.
  window.addEventListener(
    "scroll",
    (e) => {
      if (!owner) return;
      const scrolled = e.target instanceof Document ? e.target.documentElement : e.target;
      if (!(scrolled instanceof Node) || !scrolled.contains(owner)) return;
      const under = document.elementFromPoint(pointer.x, pointer.y);
      if (!under || !owner.contains(under)) return release();
      if (tip.classList.contains("is-shown")) place();
    },
    { capture: true, passive: true },
  );
  for (const type of ["pointerdown", "keydown", "blur"]) window.addEventListener(type, release, true);
}
