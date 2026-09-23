/**
 * Spell digits out for speech models that read them unreliably.
 *
 * Chatterbox reads digit groups as its own guess: German "RTX 4070" came back
 * from recognition as "RTX 70", "3060" as "3030". Written-out numbers are read
 * correctly, so synthesis receives words while the transcript keeps the digits.
 *
 * One pack per language, and a language without a pack keeps its text
 * unchanged — spelling a number wrong is worse than leaving the digits.
 */
interface NumberPack {
  /** 0–999999 as words. */
  number: (value: number) => string;
  /** Between the whole part and its digits, e.g. "3,5" in German. */
  decimal: string;
  /** The character this locale writes a fraction with: "," in German. */
  decimalChar: string;
  /** The character this locale groups thousands with: "." in German. */
  groupChar: string;
  percent: string;
}

function build(ones: string[], tens: string[], join: {
  /** Between tens and ones, e.g. "vierzig" + "und" + "eins", or "forty-one". */
  tensOnes: (tens: string, ones: string) => string;
  hundred: (count: string, rest: string) => string;
  thousand: (count: string, rest: string) => string;
  /** Some languages say "one hundred", others prefix a shortened form. */
  one: string;
}): (value: number) => string {
  const spell = (value: number): string => {
    if (value < 20) return ones[value];
    if (value < 100) {
      const rest = value % 10;
      return rest ? join.tensOnes(tens[Math.floor(value / 10)], rest === 1 ? join.one : ones[rest]) : tens[Math.floor(value / 10)];
    }
    if (value < 1000) {
      const count = Math.floor(value / 100);
      return join.hundred(count === 1 ? join.one : ones[count], value % 100 ? spell(value % 100) : "");
    }
    const count = Math.floor(value / 1000);
    return join.thousand(count === 1 ? join.one : spell(count), value % 1000 ? spell(value % 1000) : "");
  };
  return spell;
}

const PACKS: Record<string, NumberPack> = {
  de: {
    number: build(
      ["null", "eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn",
        "elf", "zwölf", "dreizehn", "vierzehn", "fünfzehn", "sechzehn", "siebzehn", "achtzehn", "neunzehn"],
      ["", "", "zwanzig", "dreißig", "vierzig", "fünfzig", "sechzig", "siebzig", "achtzig", "neunzig"],
      { tensOnes: (tens, ones) => `${ones}und${tens}`, hundred: (count, rest) => `${count}hundert${rest}`,
        thousand: (count, rest) => `${count}tausend${rest}`, one: "ein" }),
    decimal: "Komma", decimalChar: ",", groupChar: ".", percent: "Prozent",
  },
  en: {
    number: build(
      ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
        "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"],
      ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"],
      { tensOnes: (tens, ones) => `${tens}-${ones}`, hundred: (count, rest) => `${count} hundred${rest && " " + rest}`,
        thousand: (count, rest) => `${count} thousand${rest && " " + rest}`, one: "one" }),
    decimal: "point", decimalChar: ".", groupChar: ",", percent: "percent",
  },
};

/** The languages numbers are written out for; the rest keep their digits. */
export const NUMBER_PACK_LANGUAGES = Object.keys(PACKS);

/**
 * A digit run with the separators it carries, so "1.999,99" and "16.09.2026"
 * each arrive whole rather than as the pieces between their dots. Anything
 * glued to letters or an underscore (Q8_0, v2) is skipped: it reads as an
 * identifier rather than a quantity.
 */
const NUMERIC = /(?<![\p{L}\d_])\d(?:[\d.,:/-]*\d)?(?![\p{L}\d_])/gu;

/** The digits of a whole part, or undefined when its grouping is not a number. */
function wholeDigits(whole: string, groupChar: string): string | undefined {
  // A leading zero marks a label — a room, a build, a phone number — not a count.
  if (/^\d+$/.test(whole)) return whole.length > 1 && whole.startsWith("0") ? undefined : whole;
  const groups = whole.split(groupChar);
  if (groups.length < 2 || !/^[1-9]\d{0,2}$/.test(groups[0]) || groups.slice(1).some(group => !/^\d{3}$/.test(group)))
    return undefined;
  return groups.join("");
}

/**
 * One numeric token as words, or undefined when it is not a plain quantity.
 * Dates, clock times, ranges and version strings all reach this as digit runs
 * with separators, and reading those as decimals is worse than leaving the
 * digits, so they are declined — as are numbers of seven digits or more, which
 * read as identifiers.
 */
function spokenNumber(token: string, pack: NumberPack): string | undefined {
  if (/[:/-]/.test(token)) return undefined;
  const [whole, fraction, ...rest] = token.split(pack.decimalChar);
  if (rest.length) return undefined;
  const digits = wholeDigits(whole, pack.groupChar);
  if (digits === undefined || digits.length > 6) return undefined;
  const spoken = pack.number(Number(digits));
  if (fraction === undefined) return spoken;
  if (!/^\d{1,6}$/.test(fraction)) return undefined;
  return `${spoken} ${pack.decimal} ${[...fraction].map(digit => pack.number(Number(digit))).join(" ")}`;
}

/**
 * Text with its numbers written out in `language`. A language without a pack
 * gets its text back unchanged.
 */
export function spokenNumbers(text: string, language: string): string {
  const pack = PACKS[language];
  if (!pack) return text;
  return text
    .replace(/(\d+)\s*%/g, (_, digits: string) => `${digits} ${pack.percent}`)
    .replace(NUMERIC, token => spokenNumber(token, pack) ?? token);
}
