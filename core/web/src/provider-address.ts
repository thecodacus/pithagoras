/**
 * Whether an address being typed is whole enough to ask: a host — a name, or
 * all four parts of an IP address — with a port and a path if it has them.
 * "192.168." or "http://" is still being typed, and asking it only shows an
 * error for an address no one meant.
 */
export function looksComplete(text: string): boolean {
  const m = /^(?:https?:\/\/)?([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|\[[0-9A-Fa-f:.]+\])(?::(\d{1,5}))?(?:\/\S*)?$/.exec(text.trim());
  if (!m) return false;
  const host = m[1];
  if (/^[\d.]+$/.test(host)) return host.split(".").length === 4 && host.split(".").every((n) => Number(n) <= 255);
  return true;
}
