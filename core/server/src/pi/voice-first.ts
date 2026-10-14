import { isLlamaProvider } from "../providers.js";
import { isUser, textOf } from "./entries.js";

export const AUDIO_MESSAGE_PREFIX = "[Audio mode]\n";
export const DEFAULT_VOICE_INSTRUCTIONS = 'This is a live voice conversation. Start with a short, useful spoken response before any tool calls. For a simple question, answer directly. IMPORTANT: When a request needs tools, first tell the user, in one brief plain spoken sentence, what you are going to do. While you work, think aloud now and then so the user is not left in silence: after a meaningful step, say in one short sentence of your own what you found, what you are trying next, or why you changed course, as a person working through a task would. Give one such line for a meaningful step or a run of quick ones, not one per tool call, and never repeat a line you have already said or read out tool names and arguments. Do not claim results before checking them. Keep every spoken reply brief: usually one to three short sentences, with only the essential answer or action update. Keep the response short. Use canvas tools for richer, detailed reports, rich Markdown text, detailed explanations, documents, lists, tables, and code that the user should read. When generating a report, write the full report in a canvas and give only a brief spoken summary. To show the user a picture, chart, diagram or screenshot, save it as a PNG, JPEG, GIF or WebP in the chat folder and call show_image; a canvas can also include a picture from the folder with Markdown image syntax. Pictures the user sends arrive with their message; look at them before answering. Briefly introduce or summarize the canvas in plain speech instead of reading its contents aloud. All user-facing replies in this voice turn, including updates and replies after tools, will be read aloud by text-to-speech. Write plain conversational text in short, clean sentences or simple lines. Do not use Markdown headings, bold, italics, bullet or numbered lists, tables, backticks, code fences, decorative symbols, or Markdown links. Describe steps naturally with words such as first, next, and finally. Avoid raw URLs, long file paths, and command or code dumps in spoken replies; briefly explain the result instead. Write numbers, units, and abbreviations in an easy-to-say form when it improves clarity without changing meaning. Use normal punctuation for natural pauses. You may occasionally include these exact nonverbal emotion tags when they fit the response naturally: (laugh), (cough), (clears throat), (sigh). These are speech cues, not words to explain or read literally. Use them sparingly; never add them to tool arguments or generated files. These presentation instructions apply only to user-facing speech: keep tool calls, tool arguments, code edits, and generated files in their required formats.';

/**
 * The rule for spoken replies: the instructions for how to speak, between two
 * fixed parts. What the [Audio mode] marker means and what to do without it
 * stay as they are whatever the instructions say, since the model has to get
 * those right for typed messages too (issue #26).
 *
 * `extra` follows the instructions, whatever they are: what a tool this
 * conversation has says about itself, which a person's own wording cannot
 * have left out for the tool to be there.
 */
export function audioSystemRule(instructions: string = DEFAULT_VOICE_INSTRUCTIONS, extra = ''): string {
  return 'The portal prefixes user requests sent in voice mode with [Audio mode], including microphone transcriptions and typed requests that should receive spoken replies. This paragraph only describes the marker: it does not mean any request has it. A request is spoken only when its own text begins with the line [Audio mode]. Decide the reply format from the latest user request only. When it starts with [Audio mode], follow these speaking rules for the entire reply, including updates after tools: ' + instructions.trim() + (extra ? ' ' + extra : '') + ' Do not read the marker aloud. When the latest user request has no [Audio mode] prefix, use normal chat formatting; an audio marker in older conversation history does not keep voice mode enabled.';;
}
/** The rule with the built-in instructions. */
export const AUDIO_SYSTEM_RULE = audioSystemRule();
/**
 * The instructions to speak by: the saved text, or the built-in one where none
 * is saved. Blank counts as none, so an emptied field is the way back to it.
 */
export function voiceInstructions(saved?: unknown): string {
  return typeof saved === 'string' && saved.trim() ? saved.trim() : DEFAULT_VOICE_INSTRUCTIONS;
}
/** Off for the comparison baseline: no marker on messages and no rule for them. */
export function voiceRulesOn(): boolean { return process.env.VOICE_RESPONSE_INSTRUCTIONS !== 'false'; }
export function audioMessage(text: string) { return voiceRulesOn() ? AUDIO_MESSAGE_PREFIX + text : text; }

/** Whether a message in these entries was spoken, or typed in voice mode. */
export function spokenIn(entries: readonly any[]): boolean {
  return entries.some((entry) => isUser(entry) && textOf(entry.message.content).startsWith(AUDIO_MESSAGE_PREFIX));
}

/**
 * The rule for spoken replies, in the system prompt of a conversation that has
 * had voice and no other.
 *
 * In every other one it was a paragraph about [Audio mode] that no message
 * carried, and the model took a typed message for a spoken one: in the chat
 * behind issue #26 its thinking said the message began with the marker.
 *
 * Part of pi's own system prompt, added to what the resource loader supplies,
 * so it is there whenever pi builds that prompt again — for tools that come and
 * go during a run too. Said from what the conversation holds and the message
 * being sent, as it would be after a restart: going back to typing keeps it,
 * so the model's cache of the prompt still counts; a conversation whose last
 * spoken message is edited away loses it.
 *
 * The instructions in it are read from `saved` each time a spoken message
 * turns the rule on, so a change in the settings is in from the next one.
 */
export class AudioRule {
  /** The rule as the prompt has it now; empty while it is off. */
  private said = '';
  /** What it said before, for a prompt built then that is still around: see into. */
  private readonly past = new Set<string>();
  /** What it said before the last change. */
  private before = '';
  constructor(
    private readonly saved: () => unknown = () => undefined,
    /** Asked with the instructions, each time the rule is turned on. */
    private readonly extra: () => string = () => '',
    /**
     * Whether the rule is in every conversation, spoken in or not: while the
     * voice add-on can speak. The first spoken message then leaves the prompt as
     * it was, and a local model does not read the whole conversation again for it.
     */
    private readonly always: () => boolean = () => false,
  ) {}
  lines(): string[] { return this.said ? [this.said] : []; }
  /** Whether that changed what it says. */
  set(on: boolean): boolean {
    const next = (on || this.always()) && voiceRulesOn() ? audioSystemRule(voiceInstructions(this.saved()), this.extra()) : '';
    if (next === this.said) return false;
    if (this.said) this.past.add(this.said);
    this.before = this.said;
    this.said = next;
    return true;
  }
  /**
   * What it said before the last change, again: for a change the prompt could
   * not be built with, which leaves pi's prompt as it was — with the earlier
   * wording where there was one, not with none.
   */
  undo(): void {
    if (this.said) this.past.add(this.said);
    this.said = this.before;
  }
  /**
   * `prompt` as it should be now: with the rule, after `after` where it holds
   * that and at its end where it does not, or without it.
   *
   * For a prompt built elsewhere than pi's own — an extension's, set for a
   * run — which says what it was given when it started, whatever since. That
   * can be an earlier wording of the rule, which then gives way to this one
   * where it stood.
   */
  into(prompt: string, after: string): string {
    let now = prompt;
    for (const old of this.past) {
      if (old === this.said || !now.includes(old)) continue;
      now = this.said ? now.replace(old, () => this.said) : now.replace(`\n\n${old}`, '').replace(old, '');
    }
    if (!this.said || now.includes(this.said)) return now;
    if (after && now.includes(after)) return now.replace(after, () => `${after}\n\n${this.said}`);
    return `${now}\n\n${this.said}`;
  }
}

/**
 * The providers the voice settings show for the first call of a spoken turn
 * going without thinking, and the list to go back to: the ways a llama.cpp
 * server shows up. Thinking is switched off through the chat template
 * (`enable_thinking`), which only a llama.cpp server reads. Where no list is
 * saved the portal asks isLlamaProvider instead, which also follows the kind
 * saved on the Providers page, so these names are its usual cases.
 */
export const DEFAULT_SKIP_THINKING_PROVIDERS: readonly string[] = ["llama.cpp", "llama-server", "llama-swap"];

/** Whether `list` names `provider`: as it is, or as `name=<url>`, which is how pi-llama-cpp names one per server. */
export function listsProvider(list: readonly string[], provider: string | undefined): boolean {
  return !!provider && list.some((name) => provider === name || provider.startsWith(`${name}=`));
}

/** First-call thinking is transient; formatting is governed by AudioRule. */
export class VoiceFirstTurn {
  private active = false;
  private first = false;
  /** `providers`: the list saved in the voice settings, read at each call; none saved means every llama.cpp server, as the portal knows them. */
  constructor(private readonly providers: () => readonly string[] | undefined = () => undefined) {}
  arm(first = true) { this.active = true; this.first = first; }
  reset() { this.active = false; this.first = false; }
  extension = (pi: any) => {
    pi.on('before_provider_request', (event: any, ctx: any) => {
      if (process.env.VOICE_SKIP_FIRST_THINKING === 'false') return;
      const saved = this.providers(), provider = ctx.model?.provider as string | undefined;
      if (!this.active || !this.first || !(saved === undefined ? isLlamaProvider(provider) : listsProvider(saved, provider))) return;
      const payload = { ...event.payload, chat_template_kwargs: { ...event.payload.chat_template_kwargs, enable_thinking: false } };
      delete payload.thinking_budget_tokens;
      return payload;
    });
    pi.on('turn_end', () => { this.first = false; });
    pi.on('agent_end', () => this.reset());
  };
}
