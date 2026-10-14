/** Links between the notes of the agent's memory, as the Memory page follows them. */

/** Where a link inside the memory leads, from the note it is in; undefined for one to the web. */
export function insidePath(href: string | undefined, from: string): string | undefined {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) return undefined;
  const dir = from.slice(0, from.lastIndexOf("/") + 1) || "/";
  const raw = new URL(href, `http://memory${dir}`).pathname;
  // A "%" that is not an escape — "100%.md" — is taken as it is written.
  let path = raw;
  try {
    path = decodeURIComponent(raw);
  } catch {
    // Left as written.
  }
  // A folder's link is to its index.
  return path.endsWith("/") ? `${path}index.md` : path;
}

export const NOTE_LINK = "/memory?note=";

/**
 * Its links inside the memory, made into links to this page: written
 * relative to the note, as Understory writes them, they are refused by the
 * markdown renderer, and followed they would lead nowhere in the portal.
 */
export function linkNotes(markdown: string, from: string): string {
  return markdown.replace(/\]\(\s*<?([^)\s>]+)>?((?:\s+"[^"]*")?)\s*\)/g, (whole, href: string, title: string) => {
    const inside = insidePath(href, from);
    return inside ? `](${NOTE_LINK}${encodeURIComponent(inside)}${title})` : whole;
  });
}
