/**
 * Where a popover goes beside the button that opens it: under it, its right
 * edge on the button's, shifted along to stay `margin` inside the window, and
 * above the button when there is more room there than below. The same rule as
 * the portal's Select list, for a popover of a size known before it is drawn.
 */
export function placePopover(
  anchor: { left: number; right: number; top: number; bottom: number },
  size: { width: number; height: number },
  view: { width: number; height: number },
  margin = 8,
): { left: number; top: number; width: number; above: boolean } {
  const width = Math.min(size.width, view.width - margin * 2);
  const left = Math.max(margin, Math.min(anchor.right - width, view.width - width - margin));
  const below = view.height - anchor.bottom - margin;
  const above = anchor.top - margin;
  const flip = below < size.height + 6 && above > below;
  const top = flip ? Math.max(margin, anchor.top - 6 - size.height) : Math.min(anchor.bottom + 6, Math.max(margin, view.height - size.height - margin));
  return { left, top, width, above: flip };
}
