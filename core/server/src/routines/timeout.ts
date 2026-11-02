/**
 * How long a routine's run may take, as a number of minutes: the rule every
 * way of setting it goes through, so that a routine's own limit, the portal's
 * default on the Routines page and ROUTINE_RUN_TIMEOUT_MIN are read alike.
 */

/** The most minutes a run may be given: what a timer may hold (2,147,483,647 ms). */
export const MAX_TIMEOUT_MIN = 35_791;

/** The hour every run had before any of this could be set. */
export const HOUR_MIN = 60;

/**
 * A limit as sent: a whole number of minutes from 1 to MAX_TIMEOUT_MIN sets
 * it; null, "" or 0 clears it, back to what it inherits; anything else is
 * refused, said as such.
 */
export function readTimeout(raw: unknown): { timeoutMin: number | null } | { error: string } {
  if (raw === null || raw === "" || raw === 0) return { timeoutMin: null };
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= MAX_TIMEOUT_MIN) return { timeoutMin: raw };
  return { error: `timeoutMin must be a whole number of minutes from 1 to ${MAX_TIMEOUT_MIN}, or 0 for the portal's default` };
}

/**
 * The minutes ROUTINE_RUN_TIMEOUT_MIN says, read by the same rule: whole
 * minutes from 1 to MAX_TIMEOUT_MIN, else the hour, and `say` is told what
 * was ignored, so a typo does not pass in silence. Unset or empty is the hour,
 * said to nobody.
 */
export function envTimeoutMin(raw: string | undefined, say: (problem: string) => void): number {
  const text = (raw ?? "").trim();
  if (!text) return HOUR_MIN;
  const read = /^\d+$/.test(text) ? readTimeout(Number(text)) : { error: "" };
  if ("error" in read || read.timeoutMin === null) {
    say(`ROUTINE_RUN_TIMEOUT_MIN=${JSON.stringify(text.slice(0, 20))} is not a whole number of minutes from 1 to ${MAX_TIMEOUT_MIN}; using ${HOUR_MIN}`);
    return HOUR_MIN;
  }
  return read.timeoutMin;
}
