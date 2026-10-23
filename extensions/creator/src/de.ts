import type { Plural } from "@pithagoras/extension-api";

/**
 * Creator mode's texts in German, each by what the code says in English: the mode's, which the picker above the
 * message box shows; the reasons of its rows in Settings → Audit; and its page in Settings. Those the portal says the
 * same way are here as well, as the portal has them.
 */
export const de: Record<string, string | Plural> = {
  "Creator mode": "Creator-Modus",
  "The agent writes extensions for the portal, installs them, and calls their tools in this chat.":
    "Der Agent schreibt Erweiterungen für das Portal, installiert sie und ruft ihre Tools in diesem Chat auf.",
  "The agent in this chat will write extensions and install them into the portal. It installs without asking you, except after this chat has read something that may be a prompt injection. An installed extension runs with the portal's own rights, outside the sandbox: it can read and change everything the portal can, including Docker where the portal is given it. Its tools are offered in every chat and run there without asking you, and its pages run in every browser signed in to the portal, with that sign-in. Its server half runs in a process of its own, which is ended if it hangs or uses too much memory: that keeps the portal running, and does not limit what the code can do. Every install is recorded in Settings → Audit, and each extension can be switched off or removed in Settings → Extensions.":
    "Der Agent in diesem Chat schreibt Erweiterungen und installiert sie im Portal. Er installiert, ohne dich zu fragen, außer nachdem dieser Chat etwas gelesen hat, das eine Prompt-Injection sein könnte. Eine installierte Erweiterung läuft mit den Rechten des Portals, außerhalb der Sandbox: Sie kann alles lesen und ändern, was das Portal kann, auch Docker, wo das Portal darauf zugreifen kann. Ihre Tools werden in jedem Chat angeboten und laufen dort, ohne dich zu fragen, und ihre Seiten laufen in jedem Browser, der im Portal angemeldet ist, mit dieser Anmeldung. Ihr Serverteil läuft in einem eigenen Prozess, der beendet wird, wenn er hängt oder zu viel Speicher braucht: Das hält das Portal am Laufen und begrenzt nicht, was der Code tun kann. Jede Installation steht in Einstellungen → Audit, und jede Erweiterung lässt sich in Einstellungen → Erweiterungen ausschalten oder entfernen.",
  "Installed": "Installiert",
  "Installed again": "Erneut installiert",
  "Removed": "Entfernt",
  "What agents made in Creator mode chats, newest first. Each is installed for the whole portal: switch it off or remove it in Settings → Extensions.":
    "Was Agenten in Chats im Creator-Modus erstellt haben, das Neueste zuerst. Jede Erweiterung ist für das ganze Portal installiert: Schalte sie unter Einstellungen → Erweiterungen aus oder entferne sie dort.",
  "Nothing made yet. Start a chat in Creator mode: what its agent installs is listed here.":
    "Noch nichts erstellt. Starte einen Chat im Creator-Modus: Was sein Agent installiert, steht dann hier.",
  "On": "An",
  "Off": "Aus",
  "Not installed": "Nicht installiert",
  "Made in {chat}": "Erstellt in {chat}",
  "Made in a chat that was deleted": "Erstellt in einem Chat, der gelöscht wurde",
  "Forget": "Vergessen",
  "Forget {name}?": "{name} vergessen?",
  "Its copy is deleted from Creator mode's folder. It is not installed, so nothing else changes.":
    "Ihre Kopie wird aus dem Ordner des Creator-Modus gelöscht. Sie ist nicht installiert, also ändert sich sonst nichts.",
  "Loading…": "Wird geladen…",
};
