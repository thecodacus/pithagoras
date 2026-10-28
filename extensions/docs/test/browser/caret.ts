import { type Locator } from '@playwright/test';

/**
 * Clicks into the editor's text, and waits for what the editor does once it has the focus.
 *
 * When the text takes the focus, ProseMirror looks at the caret again 20 ms later and, if the
 * page's caret is not where it last read it, puts its own back (prosemirror-view's focus handler).
 * A key that moves the caret right after the click (End, say) can come first on a busy machine,
 * since the browser runs input before timers: the caret then jumps back to where the click put it,
 * and what is typed next lands there. A timer of the same length started after the click runs after
 * the editor's, so once it has run the caret stays where the keys put it.
 */
export async function clickIntoText(target: Locator) {
  await target.click();
  await target.page().evaluate(() => new Promise((done) => setTimeout(done, 20)));
}
