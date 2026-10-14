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
function frontMatterEnd(text, from) {
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

/** `markdown` as the editor takes it: `body` with line feeds only, and what is kept apart (`head`, `eol`). */
export function frame(markdown) {
  const bom = markdown.startsWith("﻿") ? 1 : 0;
  const end = frontMatterEnd(markdown, bom);
  const rest = markdown.slice(end);
  const crlf = (rest.match(/\r\n/g)?.length ?? 0) * 2 > (rest.match(/\n/g)?.length ?? 0);
  return { head: markdown.slice(0, end), body: rest.replace(/\r\n?/g, "\n"), eol: crlf ? "\r\n" : "\n" };
}

/** What the editor wrote (`body`) with what was kept apart put back. */
export const unframe = ({ head, eol }, body) => head + (eol === "\r\n" ? body.replace(/\n/g, "\r\n") : body);
