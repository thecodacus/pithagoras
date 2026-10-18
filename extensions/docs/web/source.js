/**
 * The document's Markdown as plain text, for people who would rather write it than see it drawn (the bar's **Markdown**): a
 * plain `<textarea>`, which the page (document-editor.js) puts in the text's place. It has no state of its own. These are the
 * few things the page needs of one: a text put into it without throwing the person's place away, and its height following its text (the
 * page scrolls, not the box). Native undo and redo, selection and spell checking are the browser's.
 */

/** The preference for the way the text is edited: kept in the browser, as the one thing about the page that is the person's own. */
const MODE = "pithagoras-docs/mode";

/** "visual" or "markdown": what the person chose last, "visual" where nothing was chosen or the browser keeps nothing. */
export function readMode() {
  try {
    return localStorage.getItem(MODE) === "markdown" ? "markdown" : "visual";
  } catch {
    return "visual";
  }
}

export function keepMode(mode) {
  try {
    localStorage.setItem(MODE, mode);
  } catch {
    // The browser keeps nothing: the choice holds for this page.
  }
}

/** The box as high as its text, so that the page scrolls and not the box. */
export function fit(box) {
  // One that is not shown has no height to measure.
  if (box.hidden || !box.isConnected) return;
  box.style.height = "auto";
  box.style.height = `${box.scrollHeight}px`;
}

/**
 * Puts `next` in the box in place of what it holds, changing what differs and no more: the caret and the selection stay at the
 * words they were at (or at the nearest place that is left of them), and the page does not move. Where nothing differs, nothing happens.
 * In a box that has the focus the change is made as typing is (`insertText` over the span that differs), so that the browser's own undo
 * keeps what the person typed before it and takes the change back as one step of its own; else (and where the browser refuses) the
 * value is set, which starts the box's undo history over.
 */
export function replaceText(box, next) {
  const was = box.value;
  if (was === next) return;
  let head = 0;
  const most = Math.min(was.length, next.length);
  while (head < most && was[head] === next[head]) head++;
  let tail = 0;
  while (tail < most - head && was[was.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
  // Where a position of the old text is in the new: before the change stays, after it moves by what the change added.
  const moved = (at) => (at <= head ? at : at >= was.length - tail ? at + (next.length - was.length) : head);
  const [start, end, direction] = [box.selectionStart, box.selectionEnd, box.selectionDirection];
  const focused = document.activeElement === box;
  const scroller = box.closest(".pd-scroll");
  const scrolled = scroller ? scroller.scrollTop : 0;
  let typed = false;
  if (focused) {
    try {
      box.setSelectionRange(head, was.length - tail);
      const middle = next.slice(head, next.length - tail);
      typed = (middle ? document.execCommand("insertText", false, middle) : document.execCommand("delete")) && box.value === next;
    } catch {
      typed = false;
    }
  }
  if (!typed) box.value = next;
  // A box that is not shown has no selection to keep, and setting one would give it the focus in some browsers.
  if (focused) box.setSelectionRange(moved(start), moved(end), direction);
  fit(box);
  if (scroller) scroller.scrollTop = scrolled;
}
