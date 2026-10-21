import type { ServerPortal } from "@pithagoras/extension-api/server";
import type { Docker } from "../../docker/src/api";

/**
 * Voice's server half. It builds on Docker (`pithagoras.requires` in its package.json), which runs its container:
 * Docker's server half starts before this one, and this one is started again whenever Docker is.
 */
export default function voice(portal: ServerPortal) {
  portal.extensions.use<Docker>("pithagoras-docker");
}
