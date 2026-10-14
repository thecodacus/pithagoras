/**
 * Telling packages apart, and saying how used and how recent one is.
 * Kept apart from the components so the tests can reach them.
 */

import { formatRelative, t } from "./i18n";

/** The npm name in a pi package spec: `npm:@scope/pkg@1.2.0` is `@scope/pkg`. Anything else is itself. */
export function packageName(spec: string): string {
  if (!spec.startsWith("npm:")) return spec;
  const bare = spec.slice(4);
  const at = bare.lastIndexOf("@");
  return at > 0 ? bare.slice(0, at) : bare;
}

/** 198311 as "198k", 1_013_749 as "1.0M". */
export function compactCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${n < 10_000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") : Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/**
 * How long ago, in the one unit that says it best, in the language shown —
 * written out, where time.ts is terse: a package's age runs to months and
 * years, which "{n}d ago" does not.
 */
export function ago(iso: string | undefined, now = Date.now()): string {
  const then = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(then)) return "";
  const s = Math.max(0, (now - then) / 1000);
  const steps: [number, Intl.RelativeTimeFormatUnit][] = [[60, "second"], [60, "minute"], [24, "hour"], [30, "day"], [12, "month"], [Infinity, "year"]];
  let v = s;
  for (const [size, unit] of steps) {
    if (v < size) {
      const n = Math.floor(v);
      return unit === "second" ? t("just now") : formatRelative(-n, unit);
    }
    v /= size;
  }
  return "";
}

/** A package's link, when it goes to a web page — never one that runs script, which a published package could give. */
export function webLink(url: string | undefined): string | undefined {
  return url && /^https?:\/\//i.test(url.trim()) ? url.trim() : undefined;
}
