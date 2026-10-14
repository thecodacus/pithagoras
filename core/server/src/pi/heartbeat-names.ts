/**
 * Names a heartbeat is known by, in a module of their own: the guard reads the
 * note tool's name as it loads, and must not wait on everything the tool needs.
 */

/** The role a heartbeat turn runs as: read-only, unless a standing rule says more. */
export const HEARTBEAT_ROLE = "heartbeat";

/** The tool a heartbeat leaves its notes with. */
export const NOTE_TOOL = "activity_note";
