/**
 * Things said in voice mode that are for the page, not the agent.
 *
 * Only "say that again" so far. Asking the agent to repeat itself costs a
 * model turn and gets a paraphrase; the page still has the audio. The whole
 * utterance has to be the request — "say that again, but shorter" is for the
 * agent — so these match a complete, short sentence and nothing that merely
 * contains one.
 */

const REPEAT = [
  // English
  /^(?:(?:can|could|would) you |please )?(?:say|repeat) (?:that|it|this|what you said)(?: (?:again|once more))?(?: please)?$/,
  /^(?:please )?(?:say|repeat) (?:that|it) again(?: please)?$/,
  /^(?:please )?repeat(?: please)?$/,
  /^(?:sorry )?(?:what did you (?:just )?say|come again|pardon|pardon me)$/,
  /^(?:once more|one more time|again please)$/,
  // German
  /^(?:bitte )?(?:sag|sprich|wiederhole?) (?:das|es|mir das)(?: bitte)?(?: (?:noch ?(?:ein ?)?mal|erneut|nochmals))?(?: bitte)?$/,
  /^(?:bitte )?(?:sag|sprich) (?:das|es) (?:bitte )?(?:noch ?(?:ein ?)?mal|erneut|nochmals)(?: bitte)?$/,
  /^(?:kannst|könntest|würdest) du (?:das|es|mir das) (?:bitte )?(?:noch ?(?:ein ?)?mal |erneut |nochmals )?(?:sagen|wiederholen)(?: bitte)?$/,
  /^(?:bitte )?wiederholen?(?: bitte)?$/,
  /^(?:wie bitte|was hast du (?:gerade |eben )?gesagt|noch ?(?:ein ?)?mal(?: bitte)?|nochmals(?: bitte)?)$/,
];

/** A transcript as it is compared: lower case, without punctuation, one space between words. */
function normalizeUtterance(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Whether this whole utterance asks to hear the last reply again. */
export function asksToRepeat(text: string): boolean {
  const said = normalizeUtterance(text);
  if (!said || said.split(" ").length > 9) return false;
  return REPEAT.some((pattern) => pattern.test(said));
}

/**
 * Every word the patterns above accept. Keep it in step with them: a word
 * missing here makes that way of asking stop the agent before it is recognised.
 */
const REPEAT_WORDS = new Set(`
  can could would you please say repeat that it this what said again once more sorry did just come pardon me one time
  bitte sag sprich wiederhol wiederhole wiederholen das es mir noch nochmal nochein nocheinmal ein einmal mal erneut nochmals
  kannst könntest würdest du sagen wie was hast gerade eben gesagt
`.split(/\s+/).filter(Boolean));

/**
 * Whether what has been made out so far of an utterance could still be a
 * request to hear the last reply again. False as soon as it has a word no such
 * request has, or is too long to be one: then it is for the agent.
 */
export function couldAskToRepeat(partial: string): boolean {
  const said = normalizeUtterance(partial);
  if (!said) return true;
  const words = said.split(" ");
  return words.length <= 9 && words.every((word) => REPEAT_WORDS.has(word));
}
