import { calledToolOf } from "./pi/tools-gateway-names.js";

/**
 * What tells the portal's own generate_image from a tool of that name that an
 * extension brings: a field in the `details` of the answer, next to `path` and
 * `title`, which only the portal's tool sets.
 *
 * The page draws a picture from such an answer by its path in the chat's
 * folder, a promise only the portal's tool keeps. Another extension's
 * `generate_image` may answer with a path of its own kind, an absolute one, or
 * one relative to somewhere else; taken for a picture here it would show a
 * broken thumbnail, or the wrong file. In a module of its own, with nothing
 * it imports but the names of the lazy tools' gateway (which imports nothing either), so that the page can
 * take it from here as it takes `below`.
 *
 * The same field is on the `tool_execution_start` event of the portal's own
 * call (see the SDK client), so that a call that is still going, failed, or was
 * cut off is told from an extension's too: those have no answer with a path.
 */
export const GENERATED_PICTURE_MARK = "portalImage";

/** A picture the agent put in front of the person with show_image, or made or changed for them with generate_image or edit_image: its path in the chat's folder. */
export interface ShownPicture {
  path: string;
  title?: string;
}

/**
 * The picture a show_image, generate_image or edit_image call ended with, when it succeeded.
 *
 * All answer with a path in the chat's folder and a title. generate_image and
 * edit_image are taken only with the mark the portal's own tool sets: an
 * extension may bring a tool of that name, whose path is not one in the
 * chat's folder. Here rather than in the page, so that a channel that sends the
 * picture on reads the same calls as the page that draws it.
 */
export function shownPicture(payload: any): ShownPicture | undefined {
  if (payload?.isError) return undefined;
  // A lazy tool's call ends as one of `tools`; the portal says on it which tool that was.
  const name = calledToolOf(payload);
  const details = payload?.result?.details;
  if (name === "generate_image" || name === "edit_image" ? details?.[GENERATED_PICTURE_MARK] !== true : name !== "show_image") return undefined;
  if (typeof details?.path !== "string" || !details.path) return undefined;
  return { path: details.path, ...(typeof details.title === "string" && details.title ? { title: details.title } : {}) };
}
