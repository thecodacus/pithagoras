/**
 * How the portal's inline tools answer pi.
 *
 * pi builds what the model reads from `content`, and marks a result as an error
 * when `execute` throws or, as of pi 1.1, when the result itself says
 * `isError: true`; anything else it is handed is taken as a success. A tool that
 * returns its own `{ output, isError }` therefore tells the model nothing, and
 * every failure looks like it worked. The portal's tools throw, which every pi
 * takes for a failure.
 */

/** A result: text the model reads. */
export const say = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

/** A failure, which pi shows the model as an error with this text. */
export function fail(text: string): never {
  throw new Error(text);
}
