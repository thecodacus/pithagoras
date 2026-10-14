/** The terminal's texts in German, each by what the code says in English. */
export const de: Record<string, string> = {
  // The panel and its tabs
  Agent: "Agent",
  Background: "Hintergrund",
  "Your shell": "Deine Shell",
  Terminals: "Terminals",
  Running: "Läuft",
  "The agent's terminal, and a shell of your own in this workspace": "Das Terminal des Agenten und eine eigene Shell in diesem Arbeitsbereich",
  "Show the whole output in the agent terminal": "Die ganze Ausgabe im Agent-Terminal zeigen",
  "Open in the agent terminal": "Im Agent-Terminal öffnen",
  "Show or hide the terminal": "Das Terminal zeigen oder ausblenden",

  // What the agent ran
  "Agent terminal output": "Terminal-Ausgabe des Agenten",
  "No commands yet. What the agent runs shows up here as it runs.": "Noch keine Befehle. Was der Agent ausführt, erscheint hier, während es läuft.",
  "Command running": "Befehl läuft",
  interrupted: "unterbrochen",

  // Background jobs
  "Background jobs can only be followed when pi runs on the host (EXECUTOR=host).": "Hintergrundjobs lassen sich nur verfolgen, wenn pi auf dem Host läuft (EXECUTOR=host).",
  "Nothing running in the background. What the agent leaves running — a dev server, a watcher, an extension's job — shows up here.":
    "Im Hintergrund läuft nichts. Was der Agent laufen lässt — ein Dev-Server, ein Watcher, der Job einer Erweiterung — erscheint hier.",
  "Background jobs": "Hintergrundjobs",
  "finished · ran {time}": "fertig · lief {time}",
  paused: "pausiert",
  "Forget the finished jobs": "Die fertigen Jobs vergessen",
  "Clear finished": "Fertige entfernen",
  finished: "fertig",
  running: "aktiv",
  Stop: "Stoppen",
  "This job's output does not go to a file, so it cannot be followed from here.": "Die Ausgabe dieses Jobs geht in keine Datei und lässt sich hier nicht verfolgen.",
  "Waiting for output…": "Warte auf Ausgabe…",
  "(no output)": "(keine Ausgabe)",
  "The output could not be read — trying again: {error}": "Die Ausgabe ließ sich nicht lesen — neuer Versuch: {error}",

  // Your shell
  "Terminal input": "Terminal-Eingabe",
  "Too much output to read out; move through the lines to read it.": "Zu viel Ausgabe zum Vorlesen; geh die Zeilen einzeln durch, um sie zu lesen.",
  "Connection to the shell lost — close this panel and open it again": "Verbindung zur Shell verloren — schließ diesen Bereich und öffne ihn erneut",
  "Could not open a shell: {error}": "Konnte keine Shell öffnen: {error}",
};
