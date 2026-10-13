import { Type } from "typebox";

/**
 * A string that is one of `values`, as a JSON schema `enum`.
 *
 * The union of constants typebox makes of literals is about twice as long in every request, and pi checks
 * both the same way before a tool runs: a value outside the list is refused.
 */
export function oneOf<const T extends readonly string[]>(values: T, description?: string) {
  return Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...(description ? { description } : {}) });
}
