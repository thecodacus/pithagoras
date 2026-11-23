import type { ChatMode } from "./api";
import { labelOf, msg } from "./i18n";

/** What a mode sets: the temperature, where it is set (see ModeParams in the server's chat-modes.ts). */
export type ModeParams = NonNullable<ChatMode["params"]>;

const NAMES = { temperature: msg("Temperature") };

/** What the temperature is called on the page. */
export const temperatureName = (): string => labelOf(NAMES, "temperature");

/** What a mode sets as one line, "Temperature 0.2"; empty where it sets nothing. */
export const paramsLine = (params: ModeParams | undefined): string =>
  params?.temperature === undefined ? "" : `${temperatureName()} ${params.temperature}`;
