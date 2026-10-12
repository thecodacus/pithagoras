/**
 * Finding a setting by what it does rather than by where it lives.
 *
 * Each entry names the page it is on and, where there is one, the section
 * heading to scroll to. The words are what someone might type instead of its
 * title — including a few in German, which is what some of the people using
 * this portal think in.
 */

import { msg } from "./i18n";

export interface SettingEntry {
  /** The Settings page it is on. */
  tab: string;
  /** An extension's own page instead of a fixed one. */
  ext?: string;
  /** The heading to scroll to, as it is written on the page. */
  section?: string;
  title: string;
  words?: string;
}

export const SETTINGS_INDEX: SettingEntry[] = [
  { tab: "models", section: msg("Providers"), title: msg("Providers"), words: "add provider server endpoint base url address llama.cpp llama-server llama-swap ollama openrouter openai anthropic google vllm lm studio models.json anbieter" },
  { tab: "models", section: msg("Providers"), title: msg("API keys"), words: "key token secret password auth.json openrouter anthropic openai google schlüssel" },
  { tab: "models", section: msg("Providers"), title: msg("Whether a server answers"), words: "status online offline reachable latency loaded running erreichbar" },
  { tab: "models", section: msg("Providers"), title: msg("Setup assistant"), words: "wizard first run getting started onboarding einrichtung assistent" },
  { tab: "models", section: msg("Provider packages"), title: msg("Provider packages"), words: "npm install extension catalog litellm gateway proxy paket" },
  { tab: "general", section: msg("For new chats"), title: msg("Default model"), words: "model provider default new chat standard modell" },
  { tab: "general", section: msg("For new chats"), title: msg("Effort"), words: "thinking reasoning level effort denken nachdenken" },
  { tab: "general", section: msg("Context"), title: msg("Context window"), words: "tokens ctx context window size length kontext fenster" },
  { tab: "general", section: msg("Context"), title: msg("Kept when compacting"), words: "compaction compact keep recent summary kompaktieren zusammenfassung" },
  { tab: "general", section: msg("Routine reports"), title: msg("Routine reports"), words: "routine schedule cron report destination channel bericht" },
  { tab: "tools", title: msg("Default tools"), words: "tools enable disable default on off werkzeuge show_image generate_image edit_image picture images bild bilder" },
  { tab: "tools", title: msg("Questions from the agent"), words: "ask_question question questions wait timeout answer fragen frage warten antwort" },
  { tab: "images", section: msg("Making and changing pictures"), title: msg("Image generation"), words: "generate make draw picture image model endpoint address api key size openai add-on bild bilder erzeugen generieren bildgenerierung" },
  { tab: "images", section: msg("Making and changing pictures"), title: msg("Image editing"), words: "edit change picture image mask several pictures endpoint model add-on bild bilder bearbeiten bildbearbeitung" },
  { tab: "skills", title: msg("Skills"), words: "skill procedure import repository fähigkeiten" },
  { tab: "mcp", title: msg("MCP servers"), words: "mcp model context protocol server adapter tools" },
  { tab: "extensions", section: msg("Find packages"), title: msg("Find packages"), words: "browse catalog gallery npm pi-package search discover katalog paket" },
  { tab: "extensions", section: msg("Install by name"), title: msg("Install a package"), words: "install npm git url path spec installieren" },
  { tab: "extensions", section: msg("Installed"), title: msg("Installed packages"), words: "extensions packages installed remove uninstall switch off update erweiterungen" },
  { tab: "channels", title: msg("Channels"), words: "telegram discord slack matrix signal email webhook bot kanäle" },
  { tab: "people", title: msg("People"), words: "allow deny stranger contact who users personen" },
  { tab: "sandbox", title: msg("Sandbox"), words: "sandbox permissions read only secrets keys files isolate restrict trusted commands sudo user berechtigungen schlüssel" },
  { tab: "browser", section: msg("Appearance"), title: msg("Theme"), words: "dark light mode appearance colour color design dunkel hell" },
  { tab: "browser", section: msg("Animations"), title: msg("Fancy animations"), words: "motion animation animate effects intro transitions flourish reduce reduced motion off animationen bewegung effekte übergänge ausschalten" },
  { tab: "browser", section: msg("Language"), title: msg("Language"), words: "language locale translation german english deutsch englisch sprache übersetzung" },
  { tab: "browser", section: msg("Notifications"), title: msg("Notifications"), words: "notify alert done finished benachrichtigung" },
  { tab: "browser", section: msg("Command character"), title: msg("Command character"), words: "command trigger prefix slash palette skill start type befehl zeichen auslöser schrägstrich" },
  { tab: "browser", section: msg("Confirmations"), title: msg("Ask before deleting"), words: "confirm delete question prompt bestätigen löschen" },
  { tab: "browser", section: msg("Signed in"), title: msg("Sign out"), words: "logout log out password session abmelden" },
  { tab: "add-ons", title: msg("Add-ons"), words: "portal addon optional voice browser terminal" },
  { tab: "shortcuts", section: msg("Chat"), title: msg("Keyboard shortcuts"), words: "keys hotkey keybinding shortcut tastenkürzel tastatur" },
  { tab: "shortcuts", section: msg("Voice mode"), title: msg("Voice mode shortcuts"), words: "voice speak microphone push to talk sprache" },
  { tab: "logs", title: msg("Logs"), words: "log logs error errors warning console output stream download audit debug server protokoll fehler" },
  { tab: "about", section: msg("This portal"), title: msg("Where the agent runs"), words: "executor container host docker" },
  { tab: "about", section: msg("This portal"), title: msg("Workspaces"), words: "folder path directory workspace ordner" },
  { tab: "about", section: msg("This portal"), title: msg("pi's files"), words: "settings.json models.json auth.json agent directory dateien" },
  { tab: "advanced", section: msg("settings.json"), title: msg("settings.json"), words: "raw json edit file advanced datei" },
];

/** Lower case, without accents: "Schlüssel" is found by "schlussel" too. */
export const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * The entries matching every word of `query`, best first: a title that
 * starts with a word, then one that contains it, then a match in its words.
 * `where` says where each one is, and is searched too.
 */
export function searchSettings<T extends SettingEntry & { where?: string }>(query: string, entries: T[], limit = 12): T[] {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const scored: { entry: T; score: number; i: number }[] = [];
  entries.forEach((entry, i) => {
    const title = fold(entry.title);
    const rest = fold(`${entry.section ?? ""} ${entry.where ?? ""} ${entry.words ?? ""}`);
    let score = 0;
    for (const t of terms) {
      if (title.startsWith(t) || title.includes(` ${t}`)) score += 3;
      else if (title.includes(t)) score += 2;
      else if (rest.includes(t)) score += 1;
      else return;
    }
    scored.push({ entry, score, i });
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).slice(0, limit).map((s) => s.entry);
}
