import { getDb, getSetting, putSetting } from "./db.js";
import type { Answers, Question } from "./pi/ask-question.js";

/**
 * Questions a colleague's conversation could not answer on its own.
 *
 * A colleague can read and explain, and nothing else. Without this the agent's
 * only honest response to anything further is "I'd have to ask" — and then
 * nobody asks. This carries the question to the primary user and the answer
 * back to the person who asked, so the refusal turns into a round trip instead
 * of a dead end.
 *
 * The id is short and typed by a human in a chat, so it is four characters.
 */

export interface QuestionRow {
  id: string;
  session_id: string;
  person_key: string;
  person_name: string;
  /** Where the answer goes back to — the asking conversation, not the asker. */
  channel_slug: string;
  channel_key: string;
  question: string;
  asked_at: string;
  answered_at: string | null;
  answer: string | null;
  /** Set when the agent is asking permission rather than an opinion. */
  action_tool: string | null;
  action: string | null;
}

const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/**
 * Unique in the whole table: answered rows are kept, and the id is the primary
 * key, so one reused for a new question would make the insert fail.
 */
function freeId(): string {
  const used = getDb().prepare("SELECT 1 FROM questions WHERE id = ?");
  for (let attempt = 0; attempt < 500; attempt++) {
    let id = "";
    for (let i = 0; i < 4; i++) id += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    if (!used.get(id)) return id;
  }
  throw new Error("No free question id");
}

export function askQuestion(input: {
  sessionId: string;
  personKey: string;
  personName: string;
  channelSlug: string;
  channelKey: string;
  question: string;
  actionTool?: string | null;
  action?: string | null;
}): QuestionRow {
  const id = freeId();
  getDb()
    .prepare(
      `INSERT INTO questions
         (id, session_id, person_key, person_name, channel_slug, channel_key, question,
          action_tool, action)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.sessionId,
      input.personKey,
      input.personName,
      input.channelSlug,
      input.channelKey,
      input.question,
      input.action ? (input.actionTool || "bash") : null,
      input.action || null
    );
  return getQuestion(id)!;
}

/**
 * What the primary user is shown of a question beside its words: the action it
 * would allow, exactly as it would run, and how to answer, so that an approval
 * is always one of something they have read.
 */
export function offerOf(q: QuestionRow): string {
  if (!q.action) return `Reply with "#${q.id} <your answer>" and I will pass it back to them.`;
  return (
    `It wants to run, exactly once:\n\n    ${q.action.replace(/\n/g, "\n    ")}\n\nApproving runs that and nothing else.\n\n` +
    `Reply "#${q.id} approve" for this once, "#${q.id} always" to permit it from now on, or "#${q.id} no".`
  );
}

/** A question that could not be put to anybody: it waits for nobody, and nobody is asked to answer it. */
export function dropQuestion(id: string): void {
  getDb().prepare("DELETE FROM questions WHERE id = ?").run(id);
}

export const getQuestion = (id: string): QuestionRow | undefined =>
  getDb().prepare("SELECT * FROM questions WHERE id = ?").get(id) as QuestionRow | undefined;

export function recordAnswer(id: string, answer: string): void {
  getDb()
    .prepare("UPDATE questions SET answered_at = ?, answer = ? WHERE id = ?")
    .run(new Date().toISOString(), answer, id);
}

/**
 * Approval has to be a word, not a mood.
 *
 * Exactly the words the question and its buttons offer, and nothing that merely
 * begins with one: "ok, but not before Friday", "yes, after the release" and "do
 * it yourself, Priya" are answers, relayed as such, and authorise nothing, so an
 * ambiguous reply can never be read as a yes. A full stop or an exclamation mark
 * after the word does not change it.
 */
const APPROVES = /^(approve|always)[.!]*$/i;

/**
 * Standing permission, which is a different promise from "approve".
 *
 * Kept to one unmistakable word: a rule that outlives the conversation should
 * never be created by a reply that merely sounded enthusiastic, and "always check
 * with me first" is the opposite of it.
 */
const ALWAYS = /^always[.!]*$/i;

/**
 * Is this message from the primary user an answer to a waiting question?
 *
 * Matched only at the start of a message and only against an id that is
 * actually waiting, so "#tea break in 5" reaches the agent as a message rather
 * than being swallowed as an answer to something.
 */
export function readAnswer(
  text: string
): { question: QuestionRow; answer: string; approves: boolean; always: boolean } | null {
  const m = /^#([a-z2-9]{4})\b[\s:,-]*([\s\S]*)$/i.exec(text.trim());
  if (!m) return null;
  const question = getQuestion(m[1].toLowerCase());
  if (!question || question.answered_at) return null;
  const answer = m[2].trim();
  if (!answer) return null;
  return { question, answer, approves: APPROVES.test(answer), always: ALWAYS.test(answer) };
}

/**
 * The questions the agent puts to the person in a chat with ask_question (see pi/ask-question.ts).
 *
 * Kept as two of the chat's own events: `portal_question` when it is asked, and `portal_question_end` when it
 * is answered, cancelled, its wait ends or its run is stopped. Until then it is open, and every page that opens
 * the chat draws it above the message box: after a reload, a visit to another chat or a restart of the portal.
 * The two together are its record in the transcript, which goes where the chat's events go: with a message
 * edited away, and with the chat.
 */
export const CHAT_QUESTION = "portal_question";
export const CHAT_QUESTION_END = "portal_question_end";

export interface ChatQuestion {
  /** The id of the request it was asked with, which the page answers. */
  id: string;
  title?: string;
  questions: Question[];
  /** When its wait ends, in epoch ms. None: it waits until it is answered. */
  until?: number;
}

/** How a question ended: `expired` when its wait was up, `stopped` when its run was. */
export type QuestionOutcome = "answered" | "cancelled" | "expired" | "stopped";

/**
 * The question events of a chat, oldest first. The types are written into the query rather than bound, since the
 * partial index on them (idx_events_questions in db.ts) is used only by a query that repeats its WHERE.
 */
export const QUESTION_EVENTS = `SELECT type, payload FROM events WHERE session_id = ? AND type IN ('portal_question', 'portal_question_end') ORDER BY seq ASC`;

/** The questions asked in a chat that have not ended, oldest first. */
export function openChatQuestions(sessionId: string): ChatQuestion[] {
  const rows = getDb().prepare(QUESTION_EVENTS).all(sessionId) as { type: string; payload: string }[];
  const open = new Map<string, ChatQuestion>();
  for (const row of rows) {
    const payload = JSON.parse(row.payload);
    if (row.type === CHAT_QUESTION) open.set(String(payload?.id), payload);
    else open.delete(String(payload?.of));
  }
  return [...open.values()];
}

export const openChatQuestion = (sessionId: string, id: string): ChatQuestion | undefined =>
  openChatQuestions(sessionId).find((q) => q.id === id);

/**
 * Questions answered while the portal was stopping, whose answers the agent has not been sent yet (see respondUi in
 * session-manager.ts). Noted beside the settings rather than looked for among the events, which only a scan of
 * every chat would find: the portal that starts next passes them on.
 */
const HELD_ANSWERS = "held_answers";

function held(): { sessionId: string; id: string }[] {
  try {
    const list = JSON.parse(getSetting(HELD_ANSWERS) ?? "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function holdAnswers(sessionId: string, id: string): void {
  putSetting(HELD_ANSWERS, JSON.stringify([...held(), { sessionId, id }]));
}

/** The answers held by the last portal, each with its questions. Taken, so that each goes out once. */
export function takeHeldAnswers(): { sessionId: string; questions: Question[]; answers: Answers }[] {
  const list = held();
  if (!list.length) return [];
  putSetting(HELD_ANSWERS, "");
  const events = getDb().prepare(QUESTION_EVENTS);
  return list.flatMap(({ sessionId, id }) => {
    const rows = (events.all(sessionId) as { type: string; payload: string }[]).map((r) => ({ type: r.type, ...JSON.parse(r.payload) }));
    const asked = rows.find((r) => r.type === CHAT_QUESTION && r.id === id);
    const end = rows.find((r) => r.type === CHAT_QUESTION_END && r.of === id);
    return asked && end?.outcome === "answered" && end.answers ? [{ sessionId, questions: asked.questions as Question[], answers: end.answers as Answers }] : [];
  });
}
