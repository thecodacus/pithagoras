import type { Portal } from "@pithagoras/extension-api";
import { portal, setPortal } from "./portal";
import { de } from "./de";

/** Understory: the agent's memory, kept by Understory in a container of its own. Its texts in German are in de.ts. */
export default function understory(given: Portal) {
  setPortal(given);
  portal.locale.add("de", de);
}
