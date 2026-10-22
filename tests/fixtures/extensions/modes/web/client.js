/**
 * A stand-in for the portal's own specs: an extension that offers a chat mode which asks first, "test-modes/focus".
 * Its server half would offer it with `portal.modes.provide`, in English; the specs answer for the server, so this is
 * only what its browser half adds: the mode's three texts in German, which the portal shows them through.
 */
export default function (portal) {
  portal.locale.add("de", {
    "Focus mode": "Fokusmodus",
    "Works with the focus tool alone.": "Arbeitet allein mit dem Fokus-Werkzeug.",
    "The agent can install and remove extensions in this chat. Use it only with what you would install yourself.":
      "Der Agent kann in diesem Chat Erweiterungen installieren und entfernen. Verwende ihn nur mit dem, was du selbst installieren würdest.",
  });
}
