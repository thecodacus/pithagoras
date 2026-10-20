/**
 * The parameters of Browser's tools, as JSON schemas: a server half is plain Node and has no `typebox` of pi's to
 * write them with. They are the schemas `typebox` made of them when the tools were the portal's, so that what the
 * model reads of them is the same.
 */

export const string = (description: string) => ({ type: "string", description });

export const boolean = (description: string) => ({ type: "boolean", description });

export const number = (description: string) => ({ type: "number", description });

/**
 * A string that is one of `values`, as a JSON schema `enum`.
 *
 * The union of constants typebox makes of literals is about twice as long in every request, and pi checks
 * both the same way before a tool runs: a value outside the list is refused.
 */
export const oneOf = (values: readonly string[], description: string) => ({ type: "string", enum: [...values], description });

/** The parameters, all of them required but those named `optional`; with none required, no list of them. */
export function object(properties: Record<string, unknown>, optional: string[] = []) {
  const required = Object.keys(properties).filter((name) => !optional.includes(name));
  return { type: "object", ...(required.length ? { required } : {}), properties };
}
