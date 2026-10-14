import { t } from "./i18n";

/** The shortest password the portal takes, the same number as the server's: it says no to anything shorter, and so does the form. */
export const MIN_PASSWORD_LENGTH = 8;

/** What is wrong with a password typed twice, in words; null where it is fine to send. */
export function passwordMistake(password: string, repeat: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return t("The password has to be at least {count} characters.", { count: MIN_PASSWORD_LENGTH });
  if (password !== repeat) return t("The two passwords are not the same.");
  return null;
}
