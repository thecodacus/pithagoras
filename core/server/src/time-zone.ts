/**
 * The time zone the server's clock runs in, as the pages name it beside an hour
 * that is read on that clock. A container is UTC unless `TZ` says otherwise, and a
 * `TZ` that is set to nothing (a `.env` line with no value) is UTC as well, which
 * the runtime reports as "Etc/Unknown".
 */
export function serverTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone === "Etc/Unknown" ? "UTC" : zone;
}
