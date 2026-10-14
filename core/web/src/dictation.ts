/**
 * Whisper answers a stretch of silence or noise with a note in brackets —
 * "[BLANK_AUDIO]", "(silence)", "[Music]" — instead of nothing. Dictated into
 * a message box that is junk, so a transcript made only of such notes is empty.
 * Brackets inside a sentence are left alone: "see (a) below" is what was said.
 */
export function cleanTranscript(text: string): string {
  const trimmed = text.trim();
  return /^(?:\s*[[(][^\])]*[\])])+\s*$/.test(trimmed) ? "" : trimmed;
}

/**
 * `text` put into `value` where the caret is, spaced like a word.
 *
 * Spoken text carries no leading or trailing space, so pasting it in raw would
 * glue it to the neighbouring words. A space is added only where one is missing
 * and only between words, never at the start or end of the box or after a
 * newline. The returned caret sits just after what was inserted, so the next
 * phrase continues from there.
 */
export function insertAtCaret(
  value: string,
  start: number,
  end: number,
  text: string,
): { value: string; caret: number } {
  const from = Math.max(0, Math.min(start, value.length));
  const to = Math.max(from, Math.min(end, value.length));
  const before = value.slice(0, from);
  const after = value.slice(to);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^\s/.test(after) ? " " : "";
  const inserted = lead + text + trail;
  return { value: before + inserted + after, caret: before.length + inserted.length };
}
