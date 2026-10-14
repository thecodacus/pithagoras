/** The width of the menus above the composer's toolbar: their w-72. */
export const MENU_WIDTH = 288;

/**
 * Where a menu above the composer's toolbar starts, so that it opens over the
 * button that opened it: at that button's left edge, pulled back only as far
 * as it must be to stay within the toolbar. The menus used to hang from the
 * toolbar's right edge, so a click on the model on the left opened its list
 * on the far right.
 *
 * `button`'s offset parent is the toolbar (the positioned box the menus are
 * placed in); `width` is the menu's.
 */
export function anchorLeft(button: HTMLElement | null, width: number): number | undefined {
  const bar = button?.offsetParent as HTMLElement | null;
  if (!button || !bar) return undefined;
  return Math.max(0, Math.min(button.offsetLeft, bar.clientWidth - width));
}
