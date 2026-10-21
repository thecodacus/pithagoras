import type { Portal } from "@pithagoras/extension-api";
import { portal, setPortal } from "./portal";
import { de } from "./de";

/** Voice: the voice service, which voice mode listens and speaks through. Its texts in German are in de.ts. */
export default function voice(given: Portal) {
  setPortal(given);
  portal.locale.add("de", de);
}
