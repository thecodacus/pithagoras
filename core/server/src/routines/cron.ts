/**
 * A small five-field cron matcher.
 *
 * No dependency for this: the grammar that matters here is `*`, `*​/n`, ranges,
 * lists and plain numbers, which is a page of code. Seconds are not supported —
 * a routine that runs a language model has no business firing every second.
 */

export const SHORTHANDS: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

interface Field {
  min: number;
  max: number;
  values: Set<number>;
}

// Day of week runs to 7 because cron takes both 0 and 7 as Sunday; 7 is
// stored as 0. The names are the ones cron accepts, in any case.
const FIELDS: [name: string, min: number, max: number, names?: string[]][] = [
  ["minute", 0, 59],
  ["hour", 0, 23],
  ["day of month", 1, 31],
  ["month", 1, 12, ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]],
  ["day of week", 0, 7, ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]],
];

function parseField(raw: string, min: number, max: number, label: string, names?: string[]): Field {
  const values = new Set<number>();
  if (names) {
    raw = raw.replace(/[a-z]{3}/gi, (name) => {
      const i = names.indexOf(name.toLowerCase());
      if (i < 0) throw new Error(`Bad ${label}: "${name}"`);
      return String(i + min);
    });
  }

  for (const part of raw.split(",")) {
    const piece = part.trim();
    if (!piece) throw new Error(`Empty ${label}`);

    const [range, stepText] = piece.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Bad step in ${label}: "${piece}"`);

    let from: number;
    let to: number;
    if (range === "*") {
      from = min;
      to = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-").map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) {
        throw new Error(`Bad range in ${label}: "${piece}"`);
      }
      from = a;
      to = b;
    } else {
      const n = Number(range);
      if (!Number.isInteger(n)) throw new Error(`Bad ${label}: "${piece}"`);
      from = n;
      to = stepText === undefined ? n : max;
    }

    if (from < min || to > max || from > to) {
      throw new Error(`${label} out of range in "${piece}" — expected ${min}-${max}`);
    }
    for (let v = from; v <= to; v += step) values.add(label === "day of week" && v === 7 ? 0 : v);
  }

  return { min, max, values };
}

export interface Cron {
  expression: string;
  fields: Field[];
}

/** Throws with a readable reason, which is what the UI shows. */
export function parseCron(input: string): Cron {
  const expression = (SHORTHANDS[input.trim().toLowerCase()] ?? input).trim();
  const parts = expression.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `Expected five fields (minute hour day month weekday), got ${parts.length}. Try "0 9 * * *" or "@daily".`
    );
  }
  return {
    expression,
    fields: parts.map((raw, i) => parseField(raw, FIELDS[i][1], FIELDS[i][2], FIELDS[i][0], FIELDS[i][3])),
  };
}

export const isValidCron = (input: string): string | null => {
  try {
    parseCron(input);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
};

/** Whether the day of `at` is one the schedule names. */
function dayMatches(cron: Cron, at: Date): boolean {
  const [, , dom, , dow] = cron.fields;
  // cron's long-standing oddity: with both day fields restricted, either one
  // matching is enough. Restricting only one means that one must match.
  const domAny = dom.values.size === 31;
  const dowAny = dow.values.size === 7;
  const domHit = dom.values.has(at.getDate());
  const dowHit = dow.values.has(at.getDay());

  if (domAny && dowAny) return true;
  if (domAny) return dowHit;
  if (dowAny) return domHit;
  return domHit || dowHit;
}

function matches(cron: Cron, at: Date): boolean {
  const [minute, hour, , month] = cron.fields;
  if (!minute.values.has(at.getMinutes())) return false;
  if (!hour.values.has(at.getHours())) return false;
  if (!month.values.has(at.getMonth() + 1)) return false;
  return dayMatches(cron, at);
}

/**
 * The next firing strictly after `from`.
 *
 * Steps forward by the biggest unit that cannot match: a month that is not
 * named is skipped whole, then a day, then an hour, and only the minutes of an
 * hour that fits are tried one by one. "@yearly" is a few dozen steps, not half
 * a million.
 */
export function nextRun(cron: Cron, from: Date = new Date()): Date | null {
  const [minute, hour, , month] = cron.fields;
  const at = new Date(from.getTime());
  at.setSeconds(0, 0);
  at.setMinutes(at.getMinutes() + 1);

  const limit = new Date(at.getTime() + 366 * 24 * 60 * 60 * 1000);
  while (at <= limit) {
    if (!month.values.has(at.getMonth() + 1)) {
      at.setMonth(at.getMonth() + 1, 1);
      at.setHours(0, 0, 0, 0);
    } else if (!dayMatches(cron, at)) {
      at.setDate(at.getDate() + 1);
      at.setHours(0, 0, 0, 0);
    } else if (!hour.values.has(at.getHours())) {
      at.setHours(at.getHours() + 1, 0, 0, 0);
    } else if (!minute.values.has(at.getMinutes())) {
      at.setMinutes(at.getMinutes() + 1);
    } else {
      return new Date(at.getTime());
    }
  }
  // A schedule like "30 2 30 2 *" — half past two on the 30th of February.
  return null;
}

/** Whether a routine that last ran at `since` is due at `now`. */
export function isDue(cron: Cron, now: Date, since: Date | null): boolean {
  const at = new Date(now.getTime());
  at.setSeconds(0, 0);
  if (!matches(cron, at)) return false;
  // The tick runs more often than once a minute, so without this a routine
  // fires repeatedly for the whole minute it is due.
  return !since || since.getTime() < at.getTime();
}
