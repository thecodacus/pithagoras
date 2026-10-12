/**
 * Signs that text read from outside is trying to instruct the agent: what makes
 * the guard taint a conversation (see guard.ts). A result from outside is
 * always wrapped as data; only one that carries one of these signs taints, so
 * an ordinary page, mail or package install leaves the conversation free.
 *
 * Patterns, not a model: each is a shape that ordinary content rarely has and
 * an injection needs, said by name so the person can see why a result was
 * flagged. A determined attacker can word around them; the envelope around
 * every result from outside, and the sandbox, still hold then.
 */

export interface Signal {
  name: string;
  /** What the person is told the result did. */
  label: string;
  test: (text: string) => boolean;
}

const re = (pattern: RegExp) => (text: string) => pattern.test(text);

/** Words for whoever reads the text as an assistant. */
const AI = String.raw`(?:ai|a\.i\.|assistant|agent|llm|language model|chat ?bot|claude|chatgpt|gpt|gemini|copilot)`;

export const SIGNALS: Signal[] = [
  {
    name: "override",
    label: "tells the reader to ignore its instructions",
    // The instructions as what is to be ignored, with a few words between at most: "ignore all previous instructions", not
    // "ignore case when matching, and the old rules still apply".
    test: re(/\b(?:ignore|disregard|forget|override|bypass)\s+(?:(?:all|any|every|of|the|your|my|these|those|previous|prior|above|earlier|preceding|original|existing|system|developer|safety|other)\s+){0,4}(?:instructions?|prompts?|rules|directions|guidelines|directives|guardrails|constraints)\b/i),
  },
  {
    name: "addressed",
    label: "speaks to an AI reading it",
    test: re(new RegExp(String.raw`\b(?:(?:attention|note|message|instructions?|important)\s*(?:to|for)\s*(?:the\s+|any\s+|all\s+)?${AI}s?\b|(?:dear|hey|hello|hi)\s+${AI}\b|if\s+you\s+are\s+an?\s+(?:ai|llm|large language model|language model|assistant|agent|bot)\b|to\s+(?:the|any)\s+${AI}\s+(?:reading|processing|summari[sz]ing|browsing))`, "i")),
  },
  {
    name: "persona",
    label: "tries to give the reader a new role or instructions",
    // A role for an AI, or one without rules: "you are now an unrestricted assistant", not "you are now the team lead".
    test: re(/\byou are now\b[^.\n]{0,40}\b(?:an? )?(?:ai|assistant|bot|agent|model|unrestricted|unfiltered|jailbroken|dan|(?:in )?\w+ mode|without (?:any )?(?:rules|restrictions|limits))\b|\bfrom now on,? you (?:are|will|must|should)\b[^.\n]{0,60}\b(?:ignore|obey|answer|reply|respond|approve|act as|follow only|only)\b|\byour new (?:instructions|task|role|goal) (?:is|are)\b|\bnew system (?:prompt|instructions?)\b|\b(?:enter|enable|activate)\s+(?:developer|god|admin|jailbreak|dan)\s+mode\b/i),
  },
  {
    name: "role-markup",
    label: "contains chat-format markers that pretend to be another speaker",
    test: re(/<\|(?:im_start|im_end|system|user|assistant|endoftext|start_header_id|end_header_id|eot_id)\|>|\[\/?INST\]|<<\/?SYS>>|<\/?(?:system|assistant)(?:_message)?>|<\/?(?:function_calls|invoke|antml:[a-z_]+)\b/i),
  },
  {
    name: "hidden",
    label: "hides text in invisible characters",
    // Unicode tag characters, which spell words no one sees, and a run of zero-width characters.
    test: re(/[\u{E0000}-\u{E007F}]|[\u200B-\u200D\u2060\uFEFF]{3,}/u),
  },
  {
    name: "secret-request",
    label: "asks for keys, passwords or private files",
    test: re(new RegExp(String.raw`\b(?:send|post|upload|email|forward|paste|share|reveal|print|output|leak|exfiltrate)\b[^.\n]{0,60}\b(?:api[ _-]?keys?|secrets?|passwords?|tokens?|credentials|private keys?|ssh keys?|\.env\b|auth\.json|id_rsa|id_ed25519|cookies)\b[^\n]{0,80}\b(?:to|at|into)\b[^\n]{0,40}(?:https?://|\S+@\S+\.\w+|webhook)`, "i")),
  },
];

/** The signs `text` carries, by name; none for ordinary content. */
export function injectionSignals(text: string): Signal[] {
  return SIGNALS.filter((signal) => signal.test(text));
}
