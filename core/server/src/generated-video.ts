/**
 * What tells the portal's own generate_video from a tool of that name that an
 * extension brings: a field in the `details` of the answer, next to `path` and
 * `title`, which only the portal's tool sets. The same as generated-picture.ts
 * does for generate_image, for the same reasons: the page plays a clip from such
 * an answer by its path in the chat's folder, a promise only the portal's tool
 * keeps.
 *
 * The same field is on the `tool_execution_start` event of the portal's own
 * call (see the SDK client), so that a call that is still going, failed, or was
 * cut off is told from an extension's too.
 */
export const GENERATED_VIDEO_MARK = "portalVideo";
