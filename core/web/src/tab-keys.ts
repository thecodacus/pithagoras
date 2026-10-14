import type { KeyboardEvent } from "react";

/**
 * The keys of a tab list: Left and Right go to the tab beside the one that has
 * the focus (round the ends), Home and End to the first and the last, and the
 * tab reached is selected as it is focused. Put it on the element with
 * `role="tablist"`, with `tabIndex` 0 on the selected tab and -1 on the others,
 * so that Tab passes the list in one stop and the arrows move within it.
 */
export function tabKeys(e: KeyboardEvent<HTMLElement>) {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const tabs = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')].filter((tab) => !(tab as HTMLButtonElement).disabled);
  const at = tabs.indexOf((e.target as Element).closest<HTMLElement>('[role="tab"]') as HTMLElement);
  if (at < 0) return;
  const next = e.key === "ArrowRight" ? at + 1 : e.key === "ArrowLeft" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
  if (next === null) return;
  e.preventDefault();
  const tab = tabs[(next + tabs.length) % tabs.length];
  tab.focus();
  tab.click();
}
