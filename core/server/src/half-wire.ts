import { inspect } from "node:util";

/**
 * What a server half in a process of its own and the portal hand each other that is not plain data: functions and
 * errors. isolated-half.ts is the portal's side, half-runtime.ts the half's; both import this, and it imports nothing of
 * the portal's.
 */

/**
 * A function of the half's, in what it gives the portal: `{ [CHILD_FN]: id, use }`. The portal holds a stub for it, which
 * tells the half to run it (`run`, a listener: nothing comes back), asks for its answer (`call`), asks for what a page
 * that opens a chat is told first (`open`), or reads what the half worked out last (`mirror`: `tools.offer`, and
 * `memory.hold`'s `on`, which the portal asks synchronously).
 */
export const CHILD_FN = "pithagoras.fn";
export type FnUse = "run" | "call" | "open" | "mirror";

/**
 * The header the portal sends a request to the half's routes with, saying who is behind it (`http.person`): JSON, as
 * URI text. The portal sets it on every request it hands on, over whatever the request came with, and only the portal
 * reaches the half's socket.
 */
export const PERSON_HEADER = "x-pithagoras-person";

/** A function of the portal's, in what it answers a call with (a hold's release, an unwatch): `{ [PARENT_FN]: id }`. */
export const PARENT_FN = "pithagoras.portalFn";

/** A function of what an extension in the portal's process provides (`extensions.use`), by its path in it: `{ [API_FN]: path }`. */
export const API_FN = "pithagoras.apiFn";

/** An error, as it crosses: what a caller tells one from another by, and how it says itself. */
export interface CrossedError {
  name?: string;
  message: string;
  stack?: string;
  code?: unknown;
  status?: unknown;
  errno?: unknown;
  unsaved?: unknown;
  /** As a crash record has it: an error as it says itself, anything else thrown as Node would print it. */
  text: string;
}

const KEPT = ["code", "status", "errno", "unsaved"] as const;

export function errorOut(error: unknown): CrossedError {
  const text = error instanceof Error ? String(error) : typeof error === "string" ? error : inspect(error);
  if (!(error instanceof Error)) return { message: text, text };
  const crossed: CrossedError = { name: error.name, message: error.message, text, ...(error.stack ? { stack: error.stack } : {}) };
  for (const key of KEPT) {
    const value = (error as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    try {
      // What cannot be written as JSON is left behind: a synchronous answer is JSON.
      if (JSON.stringify(value) !== undefined) crossed[key] = value;
    } catch {
      // Left behind.
    }
  }
  return crossed;
}

/** The error again, where it is thrown: a TypeError as a TypeError, with its own stack, of where it is thrown now. */
export function errorIn(crossed: CrossedError): Error {
  const error = crossed.name === "TypeError" ? new TypeError(crossed.message) : new Error(crossed.message);
  if (crossed.name && crossed.name !== error.name) error.name = crossed.name;
  for (const key of KEPT) if (crossed[key] !== undefined) (error as unknown as Record<string, unknown>)[key] = crossed[key];
  return error;
}

/** Whether `value` is a plain object or a list, whose parts are looked through for functions. */
const plain = (value: unknown): value is Record<string, unknown> | unknown[] =>
  Array.isArray(value) || (typeof value === "object" && value !== null && [Object.prototype, null].includes(Object.getPrototypeOf(value)));

/**
 * `value` with each function in it, at any depth of plain objects and lists, given by `swap` (with its path), and each
 * object that `unmark` takes for a marker given by it (it gives back any other object as it is); anything else as it is.
 * What is reached twice is swapped once.
 */
export function swapped(value: unknown, swap: (fn: Function, path: string[]) => unknown, unmark?: (marker: Record<string, unknown>) => unknown): unknown {
  const seen = new Map<object, unknown>();
  const walk = (part: unknown, path: string[]): unknown => {
    if (typeof part === "function") return swap(part, path);
    if (!plain(part)) return part;
    if (seen.has(part)) return seen.get(part);
    if (unmark && !Array.isArray(part)) {
      const found = unmark(part);
      if (found !== part) return found;
    }
    const out: Record<string, unknown> | unknown[] = Array.isArray(part) ? [] : {};
    seen.set(part, out);
    // Each as a key of its own: `__proto__` from the other side is one, and set as `out.__proto__` it would be out's prototype.
    for (const [key, inner] of Object.entries(part)) Object.defineProperty(out, key, { value: walk(inner, [...path, key]), enumerable: true, writable: true, configurable: true });
    return out;
  };
  return walk(value, []);
}
