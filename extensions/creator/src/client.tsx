import type { Portal } from "@pithagoras/extension-api";
import { portal, setPortal } from "./portal";
import { de } from "./de";

/**
 * Creator mode's browser half: its texts in German, the mode's among them, which the picker above the message box and
 * Settings → Audit show it in.
 */
export default function creator(given: Portal) {
  setPortal(given);
  portal.locale.add("de", de);
}
