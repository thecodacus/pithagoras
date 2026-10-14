import { Type } from "typebox";
import { fail, say } from "./tool-result.js";
import { showsDialogs } from "./ui-requests.js";
import { oneOf } from "./tool-schema.js";

/**
 * Asking the person in front of the screen something, in the chat.
 *
 * pi's `ctx.ui.select()` and `input()` draw one plain menu or one text line, so a
 * question with several parts, or an answer that is a ranking, took a string of
 * dialogs or a guess. This tool puts all of them in one place: single choice,
 * several choices, free text and putting options in order. It is the `questions`
 * request of the portal's UI context (see buildUiContext). The chat keeps it until
 * it ends and draws it above the message box (see questions.ts), and the browser
 * answers it through the same route as every dialog.
 */

export const ASK_QUESTION_TOOL = "ask_question";
/** What the portal files the tool under, as the other inline tools are: the name of its factory. */
export const ASK_QUESTION_SOURCE = "ask-question";

/**
 * Whether a conversation gets the tool: wherever the portal's own pages draw the dialog and a person answers
 * it (see showsDialogs), and not for a conversation of a lower role than the owner's.
 */
export function asksQuestions(session: { kind: string; role?: string | null }, viaChannel: boolean): boolean {
  return showsDialogs(session, viaChannel) && (!session.role || session.role === "primary");
}

export type QuestionKind = "single" | "multiple" | "text" | "ranking";

export interface QuestionOption {
  label: string;
  description?: string;
}

/** A question as the dialog draws it: every field settled, so the browser has nothing to guess. */
export interface Question {
  id: string;
  question: string;
  kind: QuestionKind;
  options: QuestionOption[];
  /** Whether a choice may be typed in instead of picked. Only for single and multiple. */
  other: boolean;
  /** An answer may be left out. */
  optional: boolean;
}

/** What the dialog sends back: the answer to each question it was given, by id. A question left empty has none. */
export type Answers = Record<string, string | string[]>;

export const MAX_QUESTIONS = 8;
export const MAX_OPTIONS = 20;
const MAX_ANSWER = 4000;

const KINDS: readonly QuestionKind[] = ["single", "multiple", "text", "ranking"];

const clip = (text: unknown, max: number) => String(text ?? "").trim().slice(0, max);

/** An answer is text as sent: a number or an object is no answer, not its string form. */
const asText = (value: unknown) => (typeof value === "string" ? clip(value, MAX_ANSWER) : "");

/**
 * The questions the model wrote, checked and completed. A mistake is thrown as a
 * message the model reads and corrects, rather than a dialog drawn half right.
 */
export function readQuestions(raw: unknown): Question[] {
  if (!Array.isArray(raw) || raw.length === 0) fail("Nothing to ask: give at least one question.");
  if (raw.length > MAX_QUESTIONS) fail(`Too many questions: ask at most ${MAX_QUESTIONS} at once.`);
  const seen = new Set<string>();
  return raw.map((entry: any, i: number) => {
    const at = `Question ${i + 1}`;
    const question = clip(entry?.question, 1000);
    if (!question) fail(`${at} has no text.`);
    const asked = entry?.kind ?? undefined;
    if (asked !== undefined && !KINDS.includes(asked)) fail(`${at}: kind must be one of ${KINDS.join(", ")}.`);

    const options: QuestionOption[] = [];
    for (const item of Array.isArray(entry?.options) ? entry.options : []) {
      // A bare string is a label: models write the short form even when the schema shows the long one,
      // so the schema takes both (pi refuses a call before it gets here otherwise).
      const label = clip(typeof item === "string" ? item : item?.label, 200);
      if (!label) continue;
      if (options.some((o) => o.label === label)) fail(`${at}: the option "${label}" is there twice.`);
      const description = typeof item === "string" ? "" : clip(item?.description, 400);
      options.push(description ? { label, description } : { label });
    }
    // Models leave the kind out, or write "single", on a question they mean to be answered in words. Turned away
    // for having no options, one sent the same call again and again. A choice with nothing to choose from is
    // answered by typing, so that is what it becomes; only a ranking cannot do without its options.
    const choice = asked === undefined || asked === "single" || asked === "multiple";
    const kind: QuestionKind = choice && !options.length ? "text" : (asked ?? "single");
    if (kind === "text" && options.length) fail(`${at}: a "text" question is answered in words and takes no options. Leave "kind" out for a choice between them.`);
    if (kind === "ranking" && options.length < 2) fail(`${at}: a ranking needs at least two options to put in order, as in "options": ["First", "Second"].`);
    if (options.length > MAX_OPTIONS) fail(`${at}: at most ${MAX_OPTIONS} options.`);

    const id = clip(entry?.id, 40) || `q${i + 1}`;
    if (seen.has(id)) fail(`${at}: the id "${id}" is used twice.`);
    seen.add(id);
    return {
      id,
      question,
      kind,
      options,
      other: (kind === "single" || kind === "multiple") && entry?.allowOther === true,
      optional: entry?.optional === true,
    };
  });
}

/**
 * What the browser sent, held to what was asked. The route that carries it takes any JSON, so an
 * answer that is not one of the options (and not a typed one where that was allowed), a ranking
 * that is not the options in some order, or a value of the wrong shape is dropped, never believed.
 */
export function readAnswers(questions: Question[], value: unknown): Answers {
  const given = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  // No prototype: the model names the ids, and `constructor` or `__proto__` must not read or write anything but an answer.
  const out: Answers = Object.create(null);
  for (const q of questions) {
    const got = Object.hasOwn(given, q.id) ? given[q.id] : undefined;
    const labels = q.options.map((o) => o.label);
    const allowed = (s: string) => labels.includes(s) || q.other;
    if (q.kind === "text") {
      const text = asText(got);
      if (text) out[q.id] = text;
    } else if (q.kind === "single") {
      const pick = asText(got);
      if (pick && allowed(pick)) out[q.id] = pick;
    } else if (q.kind === "multiple") {
      const picks = Array.isArray(got) ? [...new Set(got.map(asText).filter((s) => s && allowed(s)))] : [];
      if (picks.length) out[q.id] = picks;
    } else if (Array.isArray(got) && got.length === labels.length && labels.every((l) => got.includes(l))) {
      out[q.id] = got as string[];
    }
  }
  // A plain object for the caller; an own `__proto__` key stays a key when spread.
  return { ...out };
}

/** The answers as the model reads them: each question with what was said, and what was left. */
export function describeAnswers(questions: Question[], answers: Answers): string {
  const lines = questions.map((q, i) => {
    const got = Object.hasOwn(answers, q.id) ? answers[q.id] : undefined;
    const head = `${i + 1}. ${q.question}`;
    if (got === undefined) return `${head}\n   No answer${q.optional ? " (it was optional)" : ""}.`;
    const labels = q.options.map((o) => o.label);
    const typed = (s: string) => (q.kind !== "text" && !labels.includes(s) ? `${JSON.stringify(s)} (typed in, not one of the options)` : s);
    if (q.kind === "ranking") return `${head}\n   In order, first is best: ${(got as string[]).map((s, n) => `${n + 1}) ${s}`).join("  ")}`;
    if (Array.isArray(got)) return `${head}\n   Chosen: ${got.map(typed).join("; ")}`;
    return `${head}\n   ${q.kind === "text" ? "Answer" : "Chosen"}: ${typed(got)}`;
  });
  return `The person answered:\n\n${lines.join("\n\n")}`;
}

const optionSchema = Type.Object({
  label: Type.String({ description: "Short, distinct" }),
  description: Type.Optional(Type.String({ description: "One line, if the label is not enough" })),
});

const questionSchema = Type.Object({
  question: Type.String({ description: "Self-contained" }),
  kind: Type.Optional(oneOf(KINDS, "Default: single with options, text without. multiple: any number. ranking: all options in order, best first")),
  options: Type.Optional(Type.Array(Type.Union([Type.String(), optionSchema]), { description: "Strings, or {label, description}" })),
  allowOther: Type.Optional(Type.Boolean({ description: "single/multiple: also allow a typed answer" })),
  optional: Type.Optional(Type.Boolean({ description: "May be left unanswered" })),
  id: Type.Optional(Type.String({ description: "Default q1, q2, …" })),
});

/**
 * An ExtensionFactory — see pi's InlineExtension. `waitMs` is read when a question is asked, so a change
 * of the setting reaches the chats that are running; 0 is no limit.
 */
export function askQuestionTool(waitMs: () => number = () => 0) {
  return (pi: any): void => {
    pi.registerTool({
      name: ASK_QUESTION_TOOL,
      label: "Ask a question",
      description:
        "Ask the person questions (shown above their message box) and wait for the answers. Only when you cannot go on without a decision or fact " +
        "only they have and guessing would cost more; not for what you can find out or they already said. All questions in one call. " +
        "With options it is a choice; without, a text answer. " +
        'Example: {"questions":[{"question":"Which database?","options":["SQLite","Postgres"]},{"question":"Anything else?","optional":true}]}',
      promptSnippet: "ask the person questions (one choice, several, text, ranking) and wait for the answers",
      parameters: Type.Object({
        title: Type.Optional(Type.String({ description: "Heading for the set" })),
        questions: Type.Array(questionSchema, { description: `1 to ${MAX_QUESTIONS}` }),
      }),
      async execute(_id: string, p: any, signal: AbortSignal | undefined, _update: unknown, ctx: any) {
        const questions = readQuestions(p.questions);
        // The portal's context has it; any other, a mode with no screen, answers every dialog with its default at once.
        if (typeof ctx?.ui?.questions !== "function") fail("There is no screen to ask on in this conversation. Ask in your reply instead.");
        const title = clip(p.title, 200);
        const value = await ctx.ui.questions({ ...(title ? { title } : {}), questions }, { signal, timeout: waitMs() });
        // A stop closes the dialog with no value too. It is no answer: after a restart the questions stay open in
        // the chat, and their answers come later as a message (see respondUi in session-manager.ts).
        if (value === undefined && signal?.aborted) {
          return {
            ...say("The run was stopped before the person answered. If the questions are still open in the chat (the portal restarted, for one), their answers come later as a message: do not decide them yourself in the meantime."),
            details: { outcome: "stopped" },
          };
        }
        if (value === undefined) {
          return {
            ...say("The person cancelled the questions without answering, or the time allowed for answering ran out. Carry on with your best judgement, or ask in your reply."),
            details: { outcome: "cancelled" },
          };
        }
        return { ...say(describeAnswers(questions, readAnswers(questions, value))), details: { outcome: "answered" } };
      },
    });
  };
}
