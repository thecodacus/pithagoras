/**
 * What the boards take, checked the same way for the page's routes and the agent's tools: each refusal says what was
 * wrong in words that both the person and an agent can act on.
 */

/** Why something was refused: input that is not right, something that is not there, or a clash with what is there. */
export class KanbanError extends Error {
  constructor(
    readonly code: "invalid" | "missing" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

export const LIMITS = {
  boards: 200,
  boardName: 80,
  boardDescription: 2000,
  columns: 20,
  columnName: 60,
  /** Cards on one board, archived ones included. */
  cards: 2000,
  title: 200,
  description: 20_000,
  labels: 12,
  label: 32,
  assignee: 80,
  note: 2000,
} as const;

/** How many lines of a card's activity are kept: the newest. */
export const ACTIVITY_KEPT = 50;

const invalid = (message: string) => new KanbanError("invalid", message);

/** One line of text: spaces and line breaks run together, at most `max` characters, and not empty unless `empty`. */
export function line(value: unknown, what: string, max: number, { empty = false } = {}): string {
  if (typeof value !== "string") throw invalid(`${what} must be text`);
  const text = value.replace(/\s+/g, " ").trim();
  if (!text && !empty) throw invalid(`${what} must not be empty`);
  if (text.length > max) throw invalid(`${what} is at most ${max} characters (it has ${text.length})`);
  return text;
}

/** Text of several lines, as it was written but for spaces at its ends: at most `max` characters, empty allowed. */
export function prose(value: unknown, what: string, max: number): string {
  if (typeof value !== "string") throw invalid(`${what} must be text`);
  const text = value.replace(/\r\n?/g, "\n").trim();
  if (text.length > max) throw invalid(`${what} is at most ${max} characters (it has ${text.length})`);
  return text;
}

/**
 * Labels: a list of short texts, or one text of them separated by commas. Each is one line; empty ones are left out,
 * and one that is there already, whatever its capitals, is not added twice.
 */
export function labels(value: unknown): string[] {
  const given = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(given)) throw invalid("Labels must be a list of texts");
  const kept: string[] = [];
  for (const item of given) {
    const label = line(item, "A label", LIMITS.label, { empty: true });
    if (label && !kept.some((k) => k.toLowerCase() === label.toLowerCase())) kept.push(label);
  }
  if (kept.length > LIMITS.labels) throw invalid(`A card has at most ${LIMITS.labels} labels`);
  return kept;
}

/** A due day, `YYYY-MM-DD`, or none: null, or an empty text. */
export function due(value: unknown): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) throw invalid("A due date is a day written YYYY-MM-DD, or empty for none");
  const day = value.trim();
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) throw invalid(`${day} is not a day of the calendar`);
  return day;
}

/** A place in a list: a whole number from 0, or nothing for the end. */
export function index(value: unknown, what = "The place"): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw invalid(`${what} must be a whole number from 0`);
  return value;
}

/** Today, as `YYYY-MM-DD` on this machine's calendar: a card due before it is overdue. */
export function today(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
