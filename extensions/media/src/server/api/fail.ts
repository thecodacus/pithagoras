import type { Response } from "express";
import { refusalOf } from "../file-error";
import { portal } from "../host";

/** A refusal's status, by its code (see FileRefusal). */
const STATUS = { invalid: 400, missing: 404, conflict: 409, exists: 409, too_large: 413, failed: 500, unsaved: 409 } as const;

/** A refusal about a file as its status, its words and its code; anything else is a 500, said in the log. */
export function fail(res: Response, e: unknown) {
  const code = refusalOf(e);
  // With its code: the page tells a conflict from "exists" (both 409) by that, not by the sentence.
  if (code) return res.status(STATUS[code]).json({ error: (e as Error).message, code });
  portal().log(`files: ${(e as Error)?.stack ?? e}`);
  res.status(500).json({ error: "Could not read or change the files" });
}
