/**
 * Pictures from the chat's folder, in a canvas.
 *
 * The agent writes `![chart](plots/chart.png)`: a path in the folder it works
 * in. As a URL that means nothing to the page, and the Markdown renderer
 * blocks a relative image outright, so each such path is turned into the
 * portal's address for that file before rendering. An address that is already
 * one — a web picture, a data: URL, one of the portal's own — is left alone.
 * A path outside the folder is left as written too: the portal would refuse
 * it anyway, and this way it is not quietly sent somewhere else.
 */

const IMAGE = /!\[([^\]\n]*)\]\(\s*(<[^>\n]*>|[^()\s]+)(\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
const ADDRESS = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/api\/|#)/i;

/** `where` relative to `dir`, when it is `dir` or inside it, by the text of the path. */
function below(dir: string, where: string): string | undefined {
  const base = dir.replace(/\/+$/, "");
  if (where === base) return "";
  return where.startsWith(base + "/") ? where.slice(base.length + 1) : undefined;
}

/** A path in the chat's folder, relative to it, from one the agent wrote: absolute in the folder, or relative to it. */
export function insideFolder(folder: string, given: string): string | undefined {
  let text = given;
  if (text.startsWith("/")) {
    const under = below(folder, text);
    if (under === undefined) return undefined;
    text = under;
  }
  const parts: string[] = [];
  for (const part of text.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!parts.pop()) return undefined;
    } else parts.push(part);
  }
  return parts.length ? parts.join("/") : undefined;
}

export function canvasPictures(markdown: string, folder: string, url: (path: string) => string): string {
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
    const inside = insideFolder(folder, decoded);
    if (!inside) return whole;
    return `![${alt}](<${url(inside)}>${title})`;
  });
}

/** The portal's address for a picture in a chat's folder. */
export const pictureUrl = (chat: string, path: string) => `/api/sessions/${chat}/picture?path=${encodeURIComponent(path)}`;
