import { language, t, type Plural } from "../i18n";

/**
 * An extension's own texts in other languages. English is what its code
 * says, as it is for the portal: a package adds what each of its texts is in
 * a language, and asks for a text with `portal.t`. Kept apart from the
 * portal's own, so that neither replaces the other's.
 */
type Strings = Record<string, string | Plural>;

const added = new Map<string, Map<string, Strings>>();

/** The texts of `extension` in the language `code` ("de"). Returns what takes them out again. */
export function addStrings(extension: string, code: string, strings: Strings): () => void {
  let byExtension = added.get(code);
  if (!byExtension) added.set(code, (byExtension = new Map()));
  const merged = { ...byExtension.get(extension), ...strings };
  byExtension.set(extension, merged);
  return () => {
    if (byExtension.get(extension) === merged) byExtension.delete(extension);
  };
}

/** A text of an extension's in the language in effect: its own if it has it, else the portal's, else as written. */
export function translate(extension: string, text: string, vars?: Record<string, string | number>): string {
  const said = added.get(language())?.get(extension)?.[text];
  return t(typeof said === "string" ? said : text, vars);
}

/** Everything an extension added, gone with it. */
export function forgetStrings(extension: string): void {
  for (const byExtension of added.values()) byExtension.delete(extension);
}
