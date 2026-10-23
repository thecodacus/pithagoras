/**
 * The browser half's pure helpers: no React, no portal, no DOM of their own -- so they can be unit-tested from
 * the node side exactly as the server half's seams are. Everything that needs the portal sits in portal.tsx and web/.
 */

/**
 * The document open on the Office page, out of its address: `?doc=<id>` says it (the same convention the docs
 * extension uses for `?folder=&doc=`). Encoded ids come back decoded; anything else means the list view.
 */
export function parseDocQuery(search: string): string | null {
  // Tolerated as it comes from the page's address -- a query, or even an address with its path still on it.
  const query = search.includes("?") ? search.slice(search.indexOf("?") + 1) : search;
  const doc = new URLSearchParams(query).get("doc");
  return doc && doc !== "" ? doc : null;
}

/**
 * What POST /settings refuses on its side (400 invalid_image_tag), refused here in the input before it is sent:
 * a floating image tag moves under you and breaks the co-editing keys, so the pinning warning is enforced, not
 * only said. The same words of the server's rule, mirrored client-side.
 */
export function floatingTag(tag: string): boolean {
  return /:(latest|stable)$/i.test(tag) || tag.endsWith("@latest");
}

/** How many are in a document right now, out of the polled locks map: every doc has an entry, empty when nobody. */
export function editorsIn(locks: Record<string, { id: string; name?: string }[]> | undefined, docId: string): number {
  return (locks?.[docId] ?? []).length;
}
