/**
 * The commands an extension names in its status line, so they can be run
 * from it. A status such as "bg ⬆ v2.6.5 /bg-update" says what to type; the
 * portal can type it. Only names the chat really has count: a path like
 * /tmp in a status is text, not a command.
 */

export type StatusPart = { text: string } | { command: string };

/**
 * A slash and a name, standing on its own: after a space, a bracket or a
 * quote, and before one, or before punctuation. The name ends in a letter or
 * digit, so "/bg-update:" and "/bg-update-" name /bg-update, while a path like
 * a/b is never one.
 */
const COMMAND = /(^|[\s([{"'`])\/([\w:-]*\w)(?=$|[\s.,;:!?)\]}"'`-])/g;

export function statusParts(text: string, known: ReadonlySet<string>): StatusPart[] {
  const parts: StatusPart[] = [];
  let last = 0;
  for (const m of text.matchAll(COMMAND)) {
    if (!known.has(m[2])) continue;
    const start = m.index! + m[1].length;
    if (start > last) parts.push({ text: text.slice(last, start) });
    parts.push({ command: m[2] });
    last = start + m[2].length + 1;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/** Whether a status line names anything that looks like a command, worth asking the chat for its list. */
export const mentionsCommand = (text: string) => new RegExp(COMMAND.source).test(text);
