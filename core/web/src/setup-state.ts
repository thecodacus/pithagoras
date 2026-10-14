import { local } from "./safe-storage";

const DONE_KEY = "pithagoras.setup";

/** Whether this browser has been through the setup assistant, or waved it away. */
export function setupDismissed(): boolean {
  return local.get(DONE_KEY) !== null;
}

/** Where storage fails it is asked again next time, which is no harm. */
export function dismissSetup(how: "done" | "skipped") {
  local.set(DONE_KEY, how);
}
