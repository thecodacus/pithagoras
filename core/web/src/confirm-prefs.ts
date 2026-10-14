import { useState } from "react";
import { local } from "./safe-storage";

const KEY = "confirmDeletes";

/**
 * Whether deleting something asks first.
 *
 * On by default, and kept per browser like the other preferences of the page
 * rather than on the server: a phone that trips over a delete button is not
 * made safer by the laptop having turned the question off.
 */
export function asksBeforeDeleting(): boolean {
  // Storage blocked reads as unset: the question keeps being asked, the safe side.
  return local.get(KEY) !== "off";
}

function setAsksBeforeDeleting(ask: boolean): void {
  local.set(KEY, ask ? "on" : "off");
}

export function useAsksBeforeDeleting() {
  const [ask, setAsk] = useState(asksBeforeDeleting);
  return [
    ask,
    (next: boolean) => {
      setAsksBeforeDeleting(next);
      setAsk(next);
    },
  ] as const;
}
