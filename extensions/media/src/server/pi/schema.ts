/**
 * The parameters of Media's tools, as JSON schemas: a server half is plain Node and has no `typebox` of pi's to
 * write them with. They are the schemas `typebox` made of them when the tools were the portal's, so that what the
 * model reads of them is the same.
 */

/** A text parameter. */
export const text = (description?: string) => ({ type: "string", ...(description ? { description } : {}) });

/** A number parameter. */
export const number = (description: string) => ({ type: "number", description });

/** A list of `items`, with what else the schema says of it. */
export const list = (items: unknown, more: { minItems: number; maxItems: number; description: string }) => ({ type: "array", items, ...more });

/** The parameters, all of them required but those named `optional`. */
export const object = (properties: Record<string, unknown>, optional: string[] = []) => ({
  type: "object",
  required: Object.keys(properties).filter((name) => !optional.includes(name)),
  properties,
});
