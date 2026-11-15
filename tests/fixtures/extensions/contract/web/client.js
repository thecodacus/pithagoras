/**
 * A stand-in for the portal's own specs: an extension that names the interface API it needs (`pithagoras.api`) and says
 * what the portal handed it, for the spec to read: `window.contractSeen`, and the portal itself in `window.contractPortal`
 * for a page to call the contract's hooks with.
 */
export default function (portal) {
  const members = ["sessions", "composer", "models", "settings", "me", "status", "prefs", "env", "media"];
  window.contractPortal = portal;
  // What every extension is handed is shared with the others and the page: changing it is refused, not taken.
  const tries = (change) => {
    try {
      change();
      return "changed";
    } catch {
      return "refused";
    }
  };
  const changes = {
    features: tries(() => portal.api.features.push("parts.wrap")),
    api: tries(() => (portal.api.version = "9.9.9")),
    controller: tries(() => (portal.chats.controller("c1").deleteMessage = async () => true)),
  };
  window.contractSeen = {
    changes,
    version: portal.version,
    api: portal.api.version,
    features: [...portal.api.features],
    has: { sessions: portal.has("data.sessions"), media: portal.has("data.media"), unknown: portal.has("parts.wrap") },
    members: Object.fromEntries(members.map((name) => [name, typeof portal[name]])),
    controller: typeof portal.chats.controller("c1").send,
    image: portal.media.image("c1", "a b.png"),
    picture: portal.media.picture("c1", "x/y.png", 3),
  };
}
