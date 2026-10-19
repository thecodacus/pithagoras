/**
 * What the portal draws over the page in a layer of its own, which a popover that closes on a press outside it must not count as
 * outside: a list a select or a menu opened (drawn at the body, though it belongs to the popover it is in), and the question
 * `confirm` asks.
 */

/** What marks a list drawn at the body that belongs to the popover it was opened from. */
export const POPOVER_LAYER = "[data-popover-layer]";
const OVERLAYS = `${POPOVER_LAYER}, [role="alertdialog"]`;

/** Whether `target`, a press's, is inside a list that belongs to a popover (see useDismiss). */
export const inPopoverLayer = (target: EventTarget | null): boolean => !!(target as Element | null)?.closest?.(POPOVER_LAYER);

/** Whether `target`, a press's, is inside something the portal draws over the page: the list of a select or a menu, or a question. */
export const inOverlay = (target: EventTarget | null): boolean => !!(target as Element | null)?.closest?.(OVERLAYS);
