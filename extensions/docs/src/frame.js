/**
 * What the editor leaves as it is around a document's Markdown. The editor
 * writes the Markdown it holds in its own way, which is the way most of it is
 * written by hand; three things it cannot hold are kept apart and put back:
 *
 * - a byte order mark, and a YAML front matter block (`---` … `---`) at the
 *   top, which read as Markdown are a rule and a heading, and are written back
 *   as other text
 * - the line ending: a document written with CRLF is shown with line feeds, and
 *   is written back with CRLF
 *
 * No editor and no browser in it, so that it can be tried on its own.
 */

/** The line of `text` that starts at `at`, without its ending, and where the next one starts. */
function lineAt(text, at) {
  const end = text.indexOf("\n", at);
  const next = end < 0 ? text.length : end + 1;
  const line = text.slice(at, end < 0 ? text.length : end);
  return { line: line.endsWith("\r") ? line.slice(0, -1) : line, next };
}

/**
 * Where the front matter at the top of `text` ends, after the blank lines
 * that follow it, or `from` when there is none. It is one only when it looks
 * like YAML (a `key:` line, and only keys, list items, comments, indented
 * lines and blank ones between its two marks): `---` … `---` with prose in it
 * is two rules, which Markdown has.
 */
export function frontMatterEnd(text, from) {
  const first = lineAt(text, from);
  if (!/^---[ \t]*$/.test(first.line)) return from;
  let keys = 0;
  for (let at = first.next; at < text.length; ) {
    const { line, next } = lineAt(text, at);
    if (/^(---|\.\.\.)[ \t]*$/.test(line)) {
      if (!keys) return from;
      let end = next;
      for (;;) {
        const blank = lineAt(text, end);
        if (end >= text.length || blank.line.trim() !== "") return end;
        end = blank.next;
      }
    }
    if (/^[A-Za-z0-9_"'][^:]*:(\s|$)/.test(line)) keys++;
    else if (line.trim() !== "" && !/^\s/.test(line) && !line.startsWith("#") && !line.startsWith("- ")) return from;
    at = next;
  }
  return from;
}

/** How many line breaks `text` has, and how many of them are CRLF. */
const breaks = (text) => ({ all: text.match(/\n/g)?.length ?? 0, crlf: text.match(/\r\n/g)?.length ?? 0 });

/**
 * `markdown` as the editor takes it: `body` with line feeds only, and what is
 * kept apart (`head`, `eol`). The line ending is the body's, or the head's
 * where the body has no line break (a front matter block and one line).
 */
export function frame(markdown) {
  const bom = markdown.startsWith("\uFEFF") ? 1 : 0;
  const end = frontMatterEnd(markdown, bom);
  const head = markdown.slice(0, end);
  const rest = markdown.slice(end);
  const { all, crlf } = breaks(rest);
  const counted = all ? { all, crlf } : breaks(head);
  return { head, body: rest.replace(/\r\n?/g, "\n"), eol: counted.crlf * 2 > counted.all ? "\r\n" : "\n" };
}

/**
 * What the editor wrote (`body`) with what was kept apart put back. A front
 * matter block that ended the text with no line break (`---` and nothing after
 * it) is given one before what is written after it: glued to the closing
 * marks, it would not close.
 */
export const unframe = ({ head, eol }, body) => {
  const glued = body !== "" && head !== "" && !/[\n\uFEFF]$/.test(head);
  return head + (glued ? eol : "") + (eol === "\r\n" ? body.replace(/\n/g, "\r\n") : body);
};
