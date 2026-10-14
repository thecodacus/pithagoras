import { sizeRatio } from "./picture-call";
import type { Item } from "./transcript";

/**
 * What the page knows of a clip that is being made, before it exists: from the call the agent made, for the frame
 * that holds its place (see components/VideoCall.tsx). The same as picture-call.ts is for a picture.
 */

/** The portal's tool that makes a clip. */
export const isVideoTool = (name: string): boolean => name === "generate_video";

/**
 * Whether a call is drawn as a clip rather than as a tool card: a call of the portal's own generate_video, which
 * says so when it starts, and one from before that, which says so when it ends with a clip. A tool of that name
 * that an extension brings is the plain card it always was, in every state.
 */
export const isVideoCall = (item: Extract<Item, { kind: "tool" }>): boolean => isVideoTool(item.name) && (item.portalVideo === true || !!item.video);

export interface VideoCall {
  /** What it is of, on one line: the title the agent gave, or else the prompt. */
  title: string;
  /** Width over height, when the call says what shape the clip will have: the size asked for. */
  ratio?: number;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");
const oneLine = (s: string, n: number): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

/** The call as the agent made it: `args` are its parameters. */
export function videoCall(args: unknown): VideoCall {
  const input = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const ratio = sizeRatio(input.size);
  return { title: oneLine(text(input.title) || text(input.prompt), 120), ...(ratio ? { ratio } : {}) };
}

/**
 * What went wrong with a clip, from the text a failed call gave back: all of it, on one line's worth of white space.
 * The picture's version is kept to a few lines for its small card; a clip's message says what the server sent, and is
 * what a person reads to find out why, so none of it is left out.
 */
export const failureReason = (output: string | undefined): string => (output ?? "").replace(/\s+/g, " ").trim();
