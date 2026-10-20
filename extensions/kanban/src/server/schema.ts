/**
 * The parameters of Kanban's tools, as JSON schemas: a server half is plain Node and has no `typebox` of pi's to write
 * them with (as Media's are written).
 */

/** A text parameter. */
export const text = (description: string) => ({ type: "string", description });

/** A whole number, from `minimum`. */
export const integer = (description: string, minimum = 1) => ({ type: "integer", minimum, description });

/** A yes or no. */
export const flag = (description: string) => ({ type: "boolean", description });

/** A list of texts. */
export const texts = (description: string) => ({ type: "array", items: { type: "string" }, description });

/** The parameters, all of them required but those named `optional`. */
export const object = (properties: Record<string, unknown>, optional: string[] = []) => ({
  type: "object",
  required: Object.keys(properties).filter((name) => !optional.includes(name)),
  properties,
});
