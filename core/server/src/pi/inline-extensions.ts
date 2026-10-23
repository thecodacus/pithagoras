/**
 * The names of the portal's own inline extensions in a chat's pi, in a module of their own: the database tells what a
 * server half registered from what the portal's own registered by them (shownTools), and cannot wait on everything a
 * chat's pi needs, which reads the database in turn.
 */
import { ASK_QUESTION_SOURCE } from "./ask-question.js";
import { CODEMODE_SOURCE } from "./codemode.js";

/** The portal's own extension that gives pi's tools again, run as the chat's agent, while the sandbox is on. */
export const SANDBOX = "sandbox";

/**
 * The names of the portal's own inline extensions in a chat's pi (see the factories in create, pi/sdk-client.ts), which
 * pi files what each registers under as `<inline:name>`. A server half's factory is filed by its package's name the same
 * way (hostExtensions in extension-host.ts), so a package of one of these names would pass for the portal's own.
 */
export const INLINE_EXTENSIONS: readonly string[] = [
  "voice-first",
  "cross-model-thinking",
  "guard",
  "tools-gateway",
  SANDBOX,
  "routines",
  ASK_QUESTION_SOURCE,
  "ask-primary",
  "report",
  CODEMODE_SOURCE,
  "heartbeat",
];
