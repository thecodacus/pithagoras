import { t } from "./i18n";

/**
 * What went wrong with the microphone, or with a recording read in place of one,
 * in words that say what to do next. The browser's own text is English whatever
 * language is shown — "Permission denied", "Requested device not found" — and
 * says nothing of where the setting is to be found. What is not one of these
 * is shown as it is.
 */
export function micError(e: unknown): string {
  const name = (e as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError")
    return t("The microphone is blocked for this site. Allow it in the browser's site settings (the icon at the left of the address), then try again.");
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError")
    return t("No microphone was found. Connect one and try again.");
  if (name === "NotReadableError" || name === "TrackStartError")
    return t("The microphone cannot be used, perhaps because another program has it. Close that and try again.");
  if (name === "EncodingError" || name === "NotSupportedError")
    return t("That file could not be read as audio. Choose a WAV or MP3 recording.");
  return (e as Error | null)?.message || t("The microphone could not be opened.");
}
