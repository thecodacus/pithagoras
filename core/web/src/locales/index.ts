import { apply, loadLanguage, offerLocale, type Locale } from "../i18n";

/**
 * Every language in this folder, offered as it is found: a new one is a new
 * file here, named by its code, and nothing else changes. Not loaded here: the
 * text of a language is fetched when it is the one in use, so that a page in
 * English does not carry a German one.
 */
const found = import.meta.glob<{ default: Locale }>("./*.ts");
for (const [file, load] of Object.entries(found)) if (!file.endsWith("/index.ts")) offerLocale(file.slice("./".length, -".ts".length), async () => (await load()).default);

/** The language chosen, fetched: the page is not drawn before it, so that what it shows first is in it. */
export const ready = loadLanguage().then(apply);
// Following the browser, it follows the browser's language changing too.
window.addEventListener("languagechange", () => {
  apply();
  void loadLanguage();
});
