import { formatDate, t } from "./i18n";

/**
 * A timestamp the server wrote: UTC, with or without a zone marker, with a
 * "T" or a space — which Date would otherwise read as local time.
 */
export const serverTime = (iso: string): Date =>
  new Date(/(?:Z|[+-]\d\d:?\d\d)$/i.test(iso) ? iso : `${iso.replace(" ", "T")}Z`);

/**
 * "5m ago": how long since `then`, in the language shown. Past `dateAfterDays`
 * it is the date instead (`dateFormat`), where a count of days says less.
 */
export function sinceThen(
  then: Date | number,
  { dateAfterDays = Infinity, dateFormat }: { dateAfterDays?: number; dateFormat?: Intl.DateTimeFormatOptions } = {},
): string {
  const at = +then;
  const mins = Math.round((Date.now() - at) / 60000);
  if (!Number.isFinite(mins)) return "";
  if (mins < 1) return t("just now");
  if (mins < 60) return t("{n}m ago", { n: mins });
  if (mins < 1440) return t("{n}h ago", { n: Math.round(mins / 60) });
  if (mins >= 1440 * dateAfterDays) return formatDate(at, dateFormat);
  return t("{n}d ago", { n: Math.round(mins / 1440) });
}

/** "5m ago", from a timestamp the server wrote; what cannot be read is shown as it is. */
export const when = (iso: string): string => sinceThen(serverTime(iso)) || iso;
