/**
 * What tells a call of the portal's own generate_image or edit_image from a
 * call of a tool of that name that an extension brings: a field on the
 * `tool_execution_start` event of the portal's own call (see the SDK client).
 *
 * The page draws the portal's call as a preview of the picture being made,
 * from the start of the call: a call that is still going, failed, or was cut
 * off has no picture yet to tell it by. The picture it ends with is a file
 * like any other call's (see file-outputs.ts). In a module of its own, with
 * nothing it imports, so that the page can take it from here.
 */
export const GENERATED_PICTURE_MARK = "portalImage";
