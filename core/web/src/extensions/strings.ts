import type { ReactNode } from "react";
// The portal's own lookups, under other names: what is passed to them here is the extension's text, not one written out.
import { fill, formatNumber, language, pluralForm, t, textsAdded, tc as portalInContext, tp as portalCount, tx as portalWithParts, withParts, type Plural } from "../i18n";

/**
 * An extension's own texts in other languages. English is what its code
 * says, as it is for the portal: a package adds what each of its texts is in
 * a language, and asks for a text with `portal.t`. Kept apart from the
 * portal's own, so that neither replaces the other's.
 */
type Strings = Record<string, string | Plural>;

const added = new Map<string, Map<string, Strings>>();

/**
 * The texts of `extension` in the language `code` ("de"). Returns what takes them out again. Where that is the language
 * in effect, what is drawn already is drawn anew in them: a browser half can arrive after the page drew the text it
 * translates (a row in Audit).
 */
export function addStrings(extension: string, code: string, strings: Strings): () => void {
  let byExtension = added.get(code);
  if (!byExtension) added.set(code, (byExtension = new Map()));
  const merged = { ...byExtension.get(extension), ...strings };
  byExtension.set(extension, merged);
  if (code === language()) textsAdded();
  return () => {
    if (byExtension.get(extension) === merged) byExtension.delete(extension);
  };
}

const own = (extension: string, key: string) => added.get(language())?.get(extension)?.[key];

/** A text of an extension's in the language in effect: its own if it has it, else the portal's, else as written. */
export function translate(extension: string, text: string, vars?: Record<string, string | number>): string {
  const said = own(extension, text);
  return t(typeof said === "string" ? said : text, vars);
}

/** A text with a count (`portal.tp`): the extension's own forms, keyed by the English plural, else the portal's. */
export function translateCount(extension: string, n: number, one: string, other: string, vars?: Record<string, string | number>): string {
  const said = own(extension, other);
  if (said === undefined) return portalCount(n, one, other, vars);
  const text = typeof said === "string" ? said : (said[pluralForm(n)] ?? said.other);
  return fill(text, { n: formatNumber(n), ...vars });
}

/** A text told apart by what it is (`portal.tc`), keyed as "text\u0004context": the extension's own, else the portal's. */
export function translateInContext(extension: string, text: string, context: string, vars?: Record<string, string | number>): string {
  const said = own(extension, `${text}\u0004${context}`);
  return typeof said === "string" ? fill(said, vars) : portalInContext(text, context, vars);
}

/** A text with something drawn in it (`portal.tx`): the extension's own, else the portal's. */
export function translateWithParts(extension: string, text: string, vars: Record<string, ReactNode>): ReactNode {
  const said = own(extension, text);
  return typeof said === "string" ? withParts(said, vars) : portalWithParts(text, vars);
}

/** Everything an extension added, gone with it. */
export function forgetStrings(extension: string): void {
  for (const byExtension of added.values()) byExtension.delete(extension);
}
