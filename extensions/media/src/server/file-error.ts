import type { FileRefusal } from "@pithagoras/extension-api/server";

/**
 * A refusal about a file, with the code `portal.files` gives its own (see FileRefusal): what Media says of a
 * picture or a clip that is not there, not one, or not one it serves, as the portal's files say theirs, so that one
 * code is told from another the same way whichever said it.
 */
export class FileError extends Error {
  constructor(
    readonly code: FileRefusal,
    message: string,
  ) {
    super(message);
  }
}

const REFUSALS = new Set<string>(["invalid", "missing", "conflict", "exists", "too_large", "failed", "unsaved"]);

/** The refusal an error is, by its code: one of Media's own, or one of `portal.files`; nothing for any other error. */
export function refusalOf(e: unknown): FileRefusal | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return e instanceof Error && typeof code === "string" && REFUSALS.has(code) ? (code as FileRefusal) : undefined;
}
