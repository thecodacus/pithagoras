/** What a count (`portal.tp`) is in another language: a form for each number the language tells apart, and an `other`. */
export interface PluralForms {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
}

/** The texts of one language, as `portal.locale.add(code, strings)` takes them: by the English text. */
export type LanguageStrings = Record<string, string | PluralForms>;

export interface CheckStringsOptions {
  /** The folder (or folders) with the code, searched below for `.ts`, `.tsx`, `.js`, `.jsx` and `.mjs` files. */
  dir: string | string[];
  /** Each language the code ships, by its code (`de`). */
  locales: Record<string, LanguageStrings>;
}

/**
 * What is wrong with the languages of the code below `dir`, as sentences, and an empty list when nothing is: every text the
 * code passes to `t`, `tx`, `tc`, `tp` or `msg` has an entry in every language, no entry is for a text the code does not
 * show, a count has the forms of a count, and a translation fills in the words (`{name}`) the English has.
 *
 * A text built at run time is not found: write it out, or keep it out of the language files.
 */
export function checkStrings(options: CheckStringsOptions): string[];

/**
 * The texts the code in `source` passes to the translating functions, by the key a language file has for each (the
 * English text; "text\u0004context" for `tc`; the English plural for `tp`), and the calls whose texts are not written out
 * but must be (`tc`, `tp`).
 */
export function textsOf(source: string, where?: string): { texts: Map<string, { plural: boolean; where: string }>; dynamic: string[] };
