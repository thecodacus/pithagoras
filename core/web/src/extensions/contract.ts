import type { ContractVersion, Feature } from "@pithagoras/extension-api";
import { t } from "../i18n";

/**
 * The version of the data contract (docs/guide/data-contract.md): its own semver, apart from the portal's and the
 * package's. A minor version adds, a major version breaks. Raised with the change that needs it, and said in the
 * guide's table.
 */
export const CONTRACT_VERSION: ContractVersion = "1.0.0";

/** What `portal.has` knows: the parts of the contract an older portal may not have. Frozen: every extension is handed this list. */
export const FEATURES: readonly Feature[] = Object.freeze([
  "data.sessions",
  "data.chats",
  "data.composer",
  "data.models",
  "data.settings",
  "data.me",
  "data.status",
  "data.prefs",
  "data.env",
  "data.media",
]);

export const has = (feature: string): boolean => (FEATURES as readonly string[]).includes(feature);

type Triple = [number, number, number];

/** A version or a range's bound, `1`, `1.2` or `1.2.3`, with `x`, `X` or `*` for a part left open; null where it is none of those. */
function partial(text: string): { major: number | null; minor: number | null; patch: number | null } | null {
  const m = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/.exec(text);
  if (!m) return null;
  const num = (part: string | undefined) => (part === undefined || /[xX*]/.test(part) ? null : Number(part));
  const major = num(m[1]);
  // A part after an open one is open too: 1.x.3 is 1.x.x.
  const minor = major === null ? null : num(m[2]);
  const patch = minor === null ? null : num(m[3]);
  return { major, minor, patch };
}

const compare = (a: Triple, b: Triple): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** The version, as three numbers; null for what is not `1.2.3` (a prerelease or build tag is none the contract has). */
function triple(version: string): Triple | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** One comparator, as the range of versions it takes: from (included) up to (excluded), or null for no bound. Null for one that is not understood. */
function bounds(comparator: string): { from: Triple | null; to: Triple | null } | { error: true } {
  const m = /^(\^|~|>=|<=|>|<|=)?\s*(.*)$/.exec(comparator);
  const op = m?.[1] ?? "";
  const p = partial(m?.[2] ?? "");
  if (!p) return { error: true };
  const { major, minor, patch } = p;
  // Open at the start: anything.
  if (major === null) return op === "<" || op === ">" ? { from: null, to: [0, 0, 0] } : { from: null, to: null };
  const lo: Triple = [major, minor ?? 0, patch ?? 0];
  // The next version up at the part the bound names last: 1.2 is below 1.3.0, 1 below 2.0.0, 1.2.3 below 1.2.4 (an exact one).
  const next: Triple = minor === null ? [major + 1, 0, 0] : patch === null ? [major, minor + 1, 0] : [major, minor, patch + 1];
  switch (op) {
    case "^": {
      // Nothing below the first part that is not zero changes.
      if (major > 0 || minor === null) return { from: lo, to: [major + 1, 0, 0] };
      if (minor > 0 || patch === null) return { from: lo, to: [0, minor + 1, 0] };
      return { from: lo, to: [0, 0, patch + 1] };
    }
    case "~":
      return { from: lo, to: minor === null ? [major + 1, 0, 0] : [major, minor + 1, 0] };
    case ">=":
      return { from: lo, to: null };
    case ">":
      return { from: next, to: null };
    case "<=":
      return { from: null, to: next };
    case "<":
      return { from: null, to: lo };
    default:
      return { from: lo, to: next };
  }
}

/**
 * Whether `version` is one `range` takes, for the ranges an extension names the interface API by: `^1.0`, `~1.2.3`,
 * `>=1.1`, `1.x`, `1.0.0`, comparators together (`>=1.1 <2`) and alternatives (`^1.0 || ^2.0`). A prerelease, a
 * hyphen range or anything else it does not read is `null`: not a range, which is told apart from one that takes
 * nothing. Same answers as the `semver` package for what it reads.
 */
export function takes(range: string, version: string = CONTRACT_VERSION): boolean | null {
  const v = triple(version);
  if (!v) return null;
  // All of it is read before any of it is matched: an alternative that takes the version must not hide one after it
  // that is not a range (`^1.0 || nonsense`, or a declaration the server cut short).
  const alternatives = range.split("||").map((alternative) => {
    const text = alternative.trim();
    // An empty alternative is any version.
    if (text === "") return [];
    // `>= 1.2` with a space after the operator is one comparator.
    return text.replace(/(\^|~|>=|<=|>|<|=)\s+/g, "$1").split(/\s+/).map(bounds);
  });
  if (alternatives.some((parts) => parts.some((b) => "error" in b))) return null;
  return alternatives.some((parts) =>
    parts.every((b) => !("error" in b) && (!b.from || compare(v, b.from) >= 0) && (!b.to || compare(v, b.to) < 0)),
  );
}

/** What an extension that declares no `pithagoras.api` is taken to need: the contract as it was first given. */
export const UNDECLARED_RANGE = "^1.0";

/**
 * What the page says, in its language, of an extension whose `pithagoras.api` this portal's contract is not one of, or
 * nothing where it is. An extension that declares nothing is taken as `UNDECLARED_RANGE`, so that a contract that breaks
 * it refuses the extensions written before it, rather than loading them against it.
 */
export function refusal(range: string | undefined, version: string = CONTRACT_VERSION): string | undefined {
  const needs = range ?? UNDECLARED_RANGE;
  const ok = takes(needs, version);
  if (ok === null) return t("Its package.json names the interface API it needs as \"{range}\", which is not a version range this portal reads", { range: needs });
  return ok ? undefined : t("Needs interface API {range}; this portal has {version}", { range: needs, version });
}
