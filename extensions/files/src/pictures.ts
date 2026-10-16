import { insideFolder } from "./helpers";

/**
 * Pictures from the chat's folder, in Markdown Files draws as a page.
 *
 * The agent writes `![chart](plots/chart.png)`: a path in the folder it works
 * in. As a URL that means nothing to the page, and the Markdown renderer
 * blocks a relative image outright, so each such path is turned into the
 * portal's address for that file before rendering. An address that is already
 * one — a web picture, a data: URL, one of the portal's own — is left alone.
 * A path outside the folder is left as written too: the server would refuse
 * it anyway, and this way it is not quietly sent somewhere else.
 *
 * `base` is the folder the markdown itself lies in, relative to the chat's
 * folder: a relative path is read from there, as a viewer of the file would.
 */

const IMAGE = /!\[([^\]\n]*)\]\(\s*(<[^>\n]*>|[^()\s]+)(\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
const ADDRESS = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/api\/|#)/i;

export function folderPictures(markdown: string, folder: string, url: (path: string) => string, base = ""): string {
  if (!markdown.includes("![")) return markdown;
  return markdown.replace(IMAGE, (whole, alt: string, raw: string, title = "") => {
    const target = raw.startsWith("<") ? raw.slice(1, -1).trim() : raw;
    if (!target || ADDRESS.test(target)) return whole;
    let decoded = target;
    try {
      decoded = decodeURI(target);
    } catch {
      // Not percent-encoded after all; the path is taken as written.
    }
    const inside = insideFolder(folder, base && !decoded.startsWith("/") ? `${base}/${decoded}` : decoded);
    if (!inside) return whole;
    return `![${alt}](<${url(inside)}>${title})`;
  });
}
