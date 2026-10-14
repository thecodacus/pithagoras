/**
 * pi packages published on npm, for browsing rather than spelling out.
 *
 * A package says it is one with the `pi-package` keyword — the same list the
 * gallery at pi.dev/packages shows — so npm's own search finds them. Asked
 * from the server rather than the page: the page may not reach the internet
 * the portal does, and one answer serves every browser for a while.
 */

export interface CatalogPackage {
  name: string;
  version: string;
  description?: string;
  /** When this version was published. */
  date?: string;
  weekly?: number;
  author?: string;
  keywords: string[];
  npm?: string;
  homepage?: string;
  /** It says it brings a model provider. */
  provider: boolean;
}

type Json = Record<string, any>;

const REGISTRY = () => (process.env.NPM_REGISTRY_URL || "https://registry.npmjs.org").replace(/\/+$/, "");
const KEEP_MS = 10 * 60_000;
/** Searches kept at most: each word typed in the search is one. */
export const KEEP_MAX = 100;
const cache = new Map<string, { at: number; value: Promise<CatalogPackage[]> }>();

/** Room for one more: what is out of date goes, then the oldest past the limit. */
function makeRoom(now: number) {
  for (const [key, entry] of cache) if (now - entry.at >= KEEP_MS) cache.delete(key);
  // A Map keeps the order things were put in: the first is the oldest.
  for (const key of cache.keys()) {
    if (cache.size < KEEP_MAX) break;
    cache.delete(key);
  }
}

/** How many searches are kept, for the tests. */
export const keptSearches = () => cache.size;

const PROVIDER_WORDS = new Set(["provider", "pi-provider", "llm-provider", "ai-provider", "model-provider"]);

/** A link a package gives, when it is one to a web page: whatever it says goes into a link on the portal's page. */
const webLink = (url: unknown) => (typeof url === "string" && /^https?:\/\//i.test(url.trim()) ? url.trim() : undefined);

/** One search result, as the page wants it. */
export function toPackage(o: Json): CatalogPackage | undefined {
  const p = o?.package;
  if (!p || typeof p.name !== "string" || typeof p.version !== "string") return undefined;
  const keywords: string[] = Array.isArray(p.keywords) ? p.keywords.filter((k: unknown): k is string => typeof k === "string") : [];
  const description = typeof p.description === "string" ? p.description : undefined;
  return {
    name: p.name,
    version: p.version,
    description,
    date: typeof p.date === "string" ? p.date : undefined,
    weekly: typeof o.downloads?.weekly === "number" ? o.downloads.weekly : undefined,
    author: p.publisher?.username ?? p.author?.name,
    keywords,
    npm: webLink(p.links?.npm),
    homepage: webLink(p.links?.homepage) ?? webLink(p.links?.repository),
    provider: keywords.some((k) => PROVIDER_WORDS.has(k.toLowerCase())) || /\bprovider\b/i.test(description ?? ""),
  };
}

/**
 * Packages matching `text`, most used first. `topic` narrows to one kind:
 * "provider" for packages that bring models.
 */
export function searchCatalog(text: string, topic?: "provider"): Promise<CatalogPackage[]> {
  const q = text.trim().slice(0, 100);
  const key = `${topic ?? ""}\u0000${q.toLowerCase()}`;
  const had = cache.get(key);
  if (had && Date.now() - had.at < KEEP_MS) return had.value;

  const terms = ["keywords:pi-package", topic === "provider" ? "provider" : "", q].filter(Boolean).join(" ");
  const url = `${REGISTRY()}/-/v1/search?${new URLSearchParams({ text: terms, size: "40" })}`;
  const value = fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) })
    .then(async (res) => {
      if (!res.ok) throw new Error(`npm answered ${res.status}.`);
      const body = (await res.json()) as Json;
      const found = (Array.isArray(body.objects) ? body.objects : []).map(toPackage).filter(Boolean) as CatalogPackage[];
      // Only what really is one: npm's text search also matches the word elsewhere.
      const packages = found.filter((p) => p.keywords.includes("pi-package") && (topic !== "provider" || p.provider));
      // Without a search, the most used first; with one, npm's order is how well it matches.
      return q ? packages : packages.sort((a, b) => (b.weekly ?? 0) - (a.weekly ?? 0));
    })
    .catch((e: Error) => {
      cache.delete(key);
      const reason = e.name === "TimeoutError" ? "npm did not answer in time" : e.message;
      throw new Error(`Could not reach the package list (${reason}). Is the portal online?`);
    });
  cache.delete(key);
  makeRoom(Date.now());
  cache.set(key, { at: Date.now(), value });
  return value;
}
