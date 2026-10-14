/**
 * Turn a human workspace name into a directory name.
 *
 *   "Cool Project"   -> "cool-project"
 *   "  My   App!  "  -> "my-app"
 */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-") // anything else (incl. spaces) becomes a hyphen
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "") // no leading/trailing separators
    .slice(0, 64);
}

/** A slug is usable as a directory name and can't escape its parent. */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(slug) && slug !== "." && slug !== "..";
}

/**
 * A slug for `desired` that is not among `taken`: the slug itself, else the
 * first of `-2`, `-3` … that is free. `fallback` stands in for a name with
 * nothing in it that a slug can keep.
 */
export function freeSlug(desired: string, taken: Iterable<string>, fallback: string): string {
  const used = new Set(taken);
  const base = slugify(desired) || fallback;
  if (!used.has(base)) return base;
  for (let n = 2; n < 500; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
  throw new Error(`Could not find a free slug for "${desired}"`);
}
