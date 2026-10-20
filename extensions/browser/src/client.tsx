import type { Portal } from "@pithagoras/extension-api";
import { portal, setPortal } from "./portal";
import { de } from "./de";
import "./client.css";

/** Browser: the browser the agent drives, for the person to watch and take over. Its texts in German are in de.ts. */
export default function browser(given: Portal) {
  setPortal(given);
  portal.locale.add("de", de);
}
