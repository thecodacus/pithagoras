import { msg } from "./i18n";

/**
 * Context the portal attaches to a message, and what to call it.
 *
 * The agent needs to be told who is speaking and what it said while nobody was
 * talking to it. A person reading the transcript does not — they wrote the
 * message, so seeing their own words buried under three framing blocks is
 * noise. Folded away rather than dropped: it is still what the model saw, and
 * when a reply looks strange this is usually why.
 *
 * Keep in step with FRAMING_TAGS in the server's channels/framing.ts, which a test compares.
 */
export const CONTEXT_BLOCKS: { tag: string; label: string }[] = [
  { tag: "speaker", label: msg("Speaker") },
  { tag: "sent-since-you-last-spoke", label: msg("Sent while idle") },
  { tag: "answer-from-primary", label: msg("Answer") },
  { tag: "channel-instructions", label: msg("Channel instructions") },
  { tag: "routine", label: msg("Routine") },
];

const TAGS = CONTEXT_BLOCKS.map((b) => b.tag).join("|");
const label = (tag: string) => CONTEXT_BLOCKS.find((b) => b.tag === tag)!.label;

// The opening tag may carry attributes, as <routine name="..."> does.
const LEADING = new RegExp(`^<(${TAGS})(?:\\s[^>]*)?>([\\s\\S]*?)</\\1>\\s*`);
const CLOSING = new RegExp(`</(${TAGS})>$`);

/**
 * The person's words, and the blocks the portal wrapped around them.
 *
 * Only the run of blocks before the words and the run after them: the portal
 * puts its blocks there, and a block in the middle was typed by whoever wrote
 * the message, who must not be able to have it shown as the portal's own.
 */
export function splitContext(raw: string): { text: string; blocks: { label: string; body: string }[] } {
  let text = raw.trim();
  const before: { label: string; body: string }[] = [];
  const after: { label: string; body: string }[] = [];
  for (let m = LEADING.exec(text); m; m = LEADING.exec(text)) {
    before.push({ label: label(m[1]), body: m[2].trim() });
    text = text.slice(m[0].length);
  }
  for (let close = CLOSING.exec(text); close; close = CLOSING.exec(text)) {
    const tag = close[1];
    // The last opening of the same tag before it, so an earlier one stays in the words.
    const open = [...text.slice(0, close.index).matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>`, "g"))].pop();
    if (!open) break;
    after.unshift({ label: label(tag), body: text.slice(open.index + open[0].length, close.index).trim() });
    text = text.slice(0, open.index).trimEnd();
  }
  return { text, blocks: [...before, ...after].filter((b) => b.body) };
}
