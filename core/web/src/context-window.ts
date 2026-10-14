import { language, t } from "./i18n";
/** What a context window may be; the server refuses anything else, so the field can say so first. */
const WINDOW_MIN = 1_024;
const WINDOW_MAX = 10_000_000;

export type ParsedWindow =
  | { kind: "empty" }
  | { kind: "ok"; tokens: number }
  | { kind: "bad"; message: string };

/**
 * Plain digits, or digits grouped in threes by one separator — 131072,
 * 131,072, 131.072, 131 072 or 131_072.
 *
 * A separator is only read as grouping when exactly three digits follow it.
 * Stripping them all turned 262144.0 into 2621440 and 1,024.00 into 102400: a
 * window ten times what was typed, which is the failure this field is there to
 * prevent, and it is not the kind of number that looks wrong when it is shown.
 */
const WINDOW_TEXT = /^(?:\d+|\d{1,3}(?:([ ,._])\d{3}(?:\1\d{3})*))$/;

/**
 * A number as the field takes it back: "1,024" in English, grouped by spaces
 * in any other language — which the field reads everywhere, where the "." a
 * German reader would write, or the "'" of Switzerland, it does not.
 */
const typeable = (n: number) =>
  language() === "en" ? n.toLocaleString("en-US") : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

export function parseWindow(text: string): ParsedWindow {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "empty" };
  const n = WINDOW_TEXT.test(trimmed) ? Number(trimmed.replace(/[ ,._]/g, "")) : NaN;
  if (!Number.isInteger(n) || n < WINDOW_MIN || n > WINDOW_MAX) {
    return {
      kind: "bad",
      message: t("Enter the window as a whole number of tokens, from {min} to {max}", { min: typeable(WINDOW_MIN), max: typeable(WINDOW_MAX) }),
    };
  }
  return { kind: "ok", tokens: n };
}
