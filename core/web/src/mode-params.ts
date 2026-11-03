import type { ChatMode } from "./api";
import { labelOf, msg } from "./i18n";

/**
 * The model parameters a mode of the person's can set (see ModeParams in the server's chat-modes.ts): in the order the
 * settings page and the lines under a mode list them, with what their names are on the page.
 */
export const MODE_PARAMS = ["temperature", "topP", "topK", "minP", "maxTokens"] as const;
export type ModeParamKey = (typeof MODE_PARAMS)[number];
/** What a mode sets: each field where it is set. */
export type ModeParams = NonNullable<ChatMode["params"]>;

const NAMES: Record<ModeParamKey, string> = {
  temperature: msg("Temperature"),
  topP: msg("Top P"),
  topK: msg("Top K"),
  minP: msg("Min P"),
  maxTokens: msg("Max tokens"),
};

/** What a parameter is called on the page. */
export const paramName = (key: ModeParamKey): string => labelOf(NAMES, key);

/** The parameters a mode sets as one line, "Temperature 0.2 · Top P 0.9"; empty where it sets none. */
export const paramsLine = (params: ModeParams | undefined): string =>
  MODE_PARAMS.filter((key) => params?.[key] !== undefined)
    .map((key) => `${paramName(key)} ${params![key]}`)
    .join(" · ");
