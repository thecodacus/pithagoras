/**
 * What tells a call of the portal's own generate_video from a call of a tool
 * of that name that an extension brings: a field on the `tool_execution_start`
 * event of the portal's own call (see the SDK client), as generated-picture.ts
 * has for generate_image. The page draws the portal's call as the frame of the
 * clip being made, from its start.
 */
export const GENERATED_VIDEO_MARK = "portalVideo";
