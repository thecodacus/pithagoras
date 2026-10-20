import { useLayoutEffect, useRef } from 'react';
/** The portal's own panels, and one an extension brought: `x:<extension>/<id>`. */
export type Panel = 'pictures' | 'conversation' | 'agents' | `x:${string}`;
/** Two panels beside the conversation is what fits; a third would cover one of them. */
const MAX_OPEN = 2;

/**
 * Which panels to close so that no more than two stay open: the ones open the
 * longest. `order` is the panels in the order they were opened, and is returned
 * brought up to date. A panel in `keep` has something in it that closing would
 * lose, so it stays if any other can go instead.
 */
export function settlePanels(order: Panel[], open: Panel[], keep: Panel[] = []): { order: Panel[]; close: Panel[] } {
  const next = order.filter(p => open.includes(p));
  for (const panel of open) if (!next.includes(panel)) next.push(panel);
  const close: Panel[] = [];
  while (next.length > MAX_OPEN) {
    const at = next.findIndex(p => !keep.includes(p));
    close.push(next.splice(at === -1 ? 0 : at, 1)[0]);
  }
  return { order: next, close };
}

/** Enforce before paint so a third panel never covers the current workspace. */
export function useWorkPanels(open: Partial<Record<Panel, boolean>>, hide: (panel: Panel) => void, keep: Panel[] = []) {
  const order = useRef<Panel[]>([]), callback = useRef(hide); callback.current = hide;
  useLayoutEffect(() => {
    const settled = settlePanels(order.current, (Object.keys(open) as Panel[]).filter(p => open[p]), keep);
    order.current = settled.order;
    for (const panel of settled.close) callback.current(panel);
  }, [(Object.keys(open) as Panel[]).filter(p => open[p]).join(), keep.join()]);
}
