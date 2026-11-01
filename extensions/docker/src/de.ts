/** Docker's texts in German, each by what the code says in English. */
export const de: Record<string, string> = {
  "Delete": "Löschen",
  "Delete the volume {name}?": "Das Volume {name} löschen?",
  "Docker": "Docker",
  "Docker {version}, reached through its socket. The containers and volumes the extensions run, by the extension that runs each.":
    "Docker {version}, über seinen Socket erreicht. Die Container und Volumes, die die Erweiterungen betreiben, nach der Erweiterung, die sie betreibt.",
  "Docker's socket is there, but Docker does not answer on it. Is Docker running?": "Der Socket von Docker ist da, aber Docker antwortet nicht. Läuft Docker?",
  "Everything {owner} kept in it is deleted for good.": "Alles, was {owner} darin aufbewahrt hat, wird endgültig gelöscht.",
  "Give it the socket in docker-compose.yml, under the portal's volumes, and start it again:":
    "Gib ihm den Socket in docker-compose.yml, unter den Volumes des Portals, und starte es neu:",
  "It has written nothing.": "Er hat nichts ausgegeben.",
  "It is in use: {reason}.": "Er ist in Gebrauch: {reason}.",
  "Loading…": "Wird geladen…",
  "Logs": "Protokoll",
  "No extension runs a container.": "Keine Erweiterung betreibt einen Container.",
  "Outdated image: it runs {running}, and {owner} now wants {wanted}.": "Veraltetes Image: Er läuft mit {running}, und {owner} will jetzt {wanted}.",
  "Outdated image: {image} has been downloaded again since it was made, and it still runs the older one.":
    "Veraltetes Image: {image} wurde seit dem Anlegen neu heruntergeladen, und er läuft noch mit dem älteren.",
  "Remove": "Entfernen",
  "Remove {name}?": "{name} entfernen?",
  "Start": "Starten",
  "Stop": "Anhalten",
  "The container is stopped and removed. What {owner} keeps in a volume stays; it may make the container again.":
    "Der Container wird angehalten und entfernt. Was {owner} in einem Volume aufbewahrt, bleibt; die Erweiterung kann den Container neu anlegen.",
  "The portal cannot reach Docker: its container has no Docker socket.": "Das Portal erreicht Docker nicht: Sein Container hat keinen Docker-Socket.",
  "The update failed, and {name} is as it was: {error}": "Die Aktualisierung ist fehlgeschlagen, und {name} ist unverändert: {error}",
  "Update": "Aktualisieren",
  "Update {name}?": "{name} aktualisieren?",
  "Updated: {name} runs {to} now, and ran {from}.": "Aktualisiert: {name} läuft jetzt mit {to} und lief mit {from}.",
  "Updating: {line}": "Wird aktualisiert: {line}",
  "Volumes": "Volumes",
  "What the extensions keep, which stays when a container is removed.": "Was die Erweiterungen aufbewahren und was bleibt, wenn ein Container entfernt wird.",
  "What {name} wrote": "Was {name} ausgegeben hat",
  "{image} is downloaded if it is not there yet, then {name} is stopped and made again on it, with the same settings, mounts, networks and volumes. What {owner} keeps in a volume stays. {name} is out of use meanwhile.":
    "{image} wird heruntergeladen, falls es noch nicht da ist; dann wird {name} angehalten und damit neu angelegt, mit denselben Einstellungen, Einbindungen, Netzwerken und Volumes. Was {owner} in einem Volume aufbewahrt, bleibt. {name} ist solange nicht nutzbar.",
};
