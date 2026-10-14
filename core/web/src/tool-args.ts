/**
 * What a tool was called with, in words rather than as the JSON the model
 * wrote.
 *
 * A call's header says what it acted on in a line: the command, the file, the
 * search. For the tools that have one of those, that is all it needs. For
 * everything else it said `{"queries":["…","…"]}`, braces and quotes and all,
 * where "Queries: …, …" says the same to someone reading. Opened, each
 * parameter is a label and its value, lists as lists, rather than one block of
 * JSON per parameter.
 *
 * The line itself is the server's: a channel relays a call in the same words,
 * and one module saying it for both cannot drift apart as two copies did.
 */
export { argLabel, argsSummary } from "../../server/src/tool-summary";

export type Scalar = string | number | boolean;

export const isScalar = (v: unknown): v is Scalar => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/** Text worth showing as code, or long enough to need its own lines. */
export const isBlock = (v: string) => v.includes("\n") || v.length > 80;
