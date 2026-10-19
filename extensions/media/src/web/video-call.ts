import { sizeRatio } from "./picture-call";

/**
 * What the page knows of a clip that is being made, before it exists: from the call the agent made, for the frame
 * that holds its place (see VideoCall.tsx). The same as picture-call.ts is for a picture.
 */

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

/** The call as the agent made it: `input` is its parameters. */
export function videoCall(input: Record<string, unknown>): VideoCall {
  const ratio = sizeRatio(input.size);
  return { title: oneLine(text(input.title) || text(input.prompt), 120), ...(ratio ? { ratio } : {}) };
}

/**
 * What went wrong with a clip, from the text a failed call gave back: all of it, on one line's worth of white space.
 * The picture's version is kept to a few lines for its small card; a clip's message says what the server sent, and is
 * what a person reads to find out why, so none of it is left out.
 */
export const failureReason = (output: string | undefined): string => (output ?? "").replace(/\s+/g, " ").trim();
