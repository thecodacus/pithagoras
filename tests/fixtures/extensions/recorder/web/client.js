/**
 * A stand-in for the portal's own specs: an extension that writes rows in Audit, "test-recorder". Its server half would
 * write them with `portal.audit.record`, its reason in English; the specs answer for the server, so this is only what
 * its browser half adds: that reason in German, which Audit shows it through. The portal's own German has no such text.
 */
export default function (portal) {
  portal.locale.add("de", { "Made again": "Erneut gemacht" });
}
