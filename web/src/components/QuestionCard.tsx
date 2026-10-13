import { useLayoutEffect, useRef, useState } from "react";
import { LuArrowDown, LuArrowUp, LuCheck, LuMessageCircleQuestion } from "react-icons/lu";
import { api } from "../api";
import { t } from "../i18n";
import type { Item } from "../transcript";
import { codeAreaCls, inputCls, primarySmCls } from "./SettingsUi";

/** A question of the agent's ask_question tool, as the server settled it (see server/src/pi/ask-question.ts). */
export interface AgentQuestion {
  id: string;
  question: string;
  kind: "single" | "multiple" | "text" | "ranking";
  options: { label: string; description?: string }[];
  other: boolean;
  optional: boolean;
}

/** What the person has put in for one question. Kept apart from the answer sent, which is made of it. */
interface Draft {
  /** single: the pick; text: the text. */
  one: string;
  /** multiple: the picks. */
  many: string[];
  /** ranking: the options in the order the person has put them. */
  order: string[];
  /** ranking: the person moved something or kept the order, so it is theirs and not the agent's own. */
  ranked: boolean;
  /** The "other" choice is ticked, and what was typed for it. */
  otherOn: boolean;
  other: string;
}

const emptyDraft = (q: AgentQuestion): Draft => ({ one: "", many: [], order: q.options.map((o) => o.label), ranked: false, otherOn: false, other: "" });

/** The answer a draft stands for, or undefined while there is none. A ranking is one once the person has moved or kept the order: the order it starts in is the agent's. */
function answerOf(q: AgentQuestion, d: Draft): string | string[] | undefined {
  const typed = d.otherOn ? d.other.trim() : "";
  if (q.kind === "text") return d.one.trim() || undefined;
  if (q.kind === "ranking") return d.ranked ? d.order : undefined;
  if (q.kind === "single") return (d.otherOn ? typed : d.one) || undefined;
  const picks = [...d.many, ...(typed ? [typed] : [])];
  return picks.length ? picks : undefined;
}

/**
 * The agent asking the person several things at once: choose one, choose several, type, or put options in order.
 * Drawn in the chat above the message box, not over the page: the rest of the page stays as it is, and Esc
 * closes nothing. The server keeps the question until it ends, so it is back after a reload. It answers the same
 * request route as an extension's menu (see ExtensionDialog), with the answers by question.
 */
export function QuestionCard({
  sessionId,
  requestId,
  title,
  questions,
  onDone,
}: {
  sessionId: string;
  requestId: string;
  title?: string;
  questions: AgentQuestion[];
  onDone: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => Object.fromEntries(questions.map((q) => [q.id, emptyDraft(q)])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const card = useRef<HTMLElement>(null);
  const heading = title || t("Questions from the agent");

  const change = (id: string, patch: Partial<Draft>) => setDrafts((all) => ({ ...all, [id]: { ...all[id], ...patch } }));
  const answers = Object.fromEntries(questions.flatMap((q) => { const a = answerOf(q, drafts[q.id]); return a === undefined ? [] : [[q.id, a]]; }));
  const complete = questions.every((q) => q.optional || Object.hasOwn(answers, q.id));

  const respond = async (payload: { value?: unknown; cancelled?: boolean }) => {
    if (busy) return;
    if (payload.cancelled && error) { onDone(); return; }
    setBusy(true);
    setError("");
    try {
      const result = await api.respondUi(sessionId, requestId, payload);
      if (!result.ok) { setError(result.note || t("This question has expired. Your answer was not delivered.")); return; }
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // A button that is moved in the page loses the focus, and one that has just become disabled cannot have it:
  // so the row that was moved gets it back on the arrow still there to press, once the new order is drawn.
  const arrows = useRef(new Map<string, HTMLButtonElement>());
  const refocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    const key = refocus.current;
    refocus.current = null;
    const arrow = key ? arrows.current.get(key) : undefined;
    if (arrow && !arrow.disabled) arrow.focus();
    else if (key) card.current?.focus();
  });

  const move = (q: AgentQuestion, from: number, by: number) => {
    const order = [...drafts[q.id].order];
    const to = from + by;
    const label = order[from];
    [order[from], order[to]] = [order[to], order[from]];
    const next = by < 0 ? (to === 0 ? "down" : "up") : to === order.length - 1 ? "up" : "down";
    refocus.current = `${q.id}\n${label}\n${next}`;
    change(q.id, { order, ranked: true });
  };
  // "Keep this order" goes away once pressed, and the focus with it: it goes to the first row's arrow, or to the card when that row cannot move.
  const keep = (q: AgentQuestion) => {
    refocus.current = `${q.id}\n${drafts[q.id].order[0]}\ndown`;
    change(q.id, { ranked: true });
  };
  const arrow = (q: AgentQuestion, label: string, dir: "up" | "down") => (el: HTMLButtonElement | null) => {
    const key = `${q.id}\n${label}\n${dir}`;
    if (el) arrows.current.set(key, el);
    else arrows.current.delete(key);
  };

  return (
    <section
      ref={card}
      tabIndex={-1}
      aria-label={heading}
      className="float-in flex max-h-[min(32rem,50dvh)] w-full flex-col overflow-hidden rounded-2xl border border-accent/30 bg-surface shadow-pop outline-none"
    >
      <header className="flex items-center gap-3 border-b border-line px-4 py-2.5">
        <div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent/12 text-accent">
          <LuMessageCircleQuestion aria-hidden className="h-4 w-4" />
        </div>
        <h2 className="min-w-0 flex-1 text-sm font-medium text-fg">{heading}</h2>
      </header>

      {error && <p role="alert" className="border-b border-line px-4 py-3 text-sm text-danger">{error}</p>}
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        {questions.map((q) => {
          const d = drafts[q.id];
          const legend = `${q.question}${q.optional ? ` (${t("optional")})` : ""}`;
          return (
            <fieldset key={q.id} className="min-w-0" disabled={busy}>
              <legend className="mb-2 text-sm font-medium text-fg">{legend}</legend>

              {(q.kind === "single" || q.kind === "multiple") && (
                <div className="space-y-1">
                  {q.options.map((o) => (
                    <label key={o.label} className="flex cursor-pointer items-start gap-2.5 rounded-lg p-1.5 hover:bg-fg/5">
                      <input
                        type={q.kind === "single" ? "radio" : "checkbox"}
                        name={`${requestId}-${q.id}`}
                        checked={q.kind === "single" ? !d.otherOn && d.one === o.label : d.many.includes(o.label)}
                        onChange={(e) =>
                          q.kind === "single"
                            ? change(q.id, { one: o.label, otherOn: false })
                            : change(q.id, { many: e.target.checked ? [...d.many, o.label] : d.many.filter((m) => m !== o.label) })
                        }
                        className="mt-0.5 accent-current"
                      />
                      <span className="min-w-0 text-sm text-fg">
                        {o.label}
                        {o.description && <span className="mt-0.5 block text-xs text-fg-faint">{o.description}</span>}
                      </span>
                    </label>
                  ))}
                  {q.other && (
                    <div className="flex items-center gap-2.5 rounded-lg p-1.5">
                      <input
                        type={q.kind === "single" ? "radio" : "checkbox"}
                        name={`${requestId}-${q.id}`}
                        aria-label={t("Another answer")}
                        checked={d.otherOn}
                        onChange={(e) => change(q.id, { otherOn: q.kind === "single" ? true : e.target.checked })}
                        className="accent-current"
                      />
                      <input
                        value={d.other}
                        onChange={(e) => change(q.id, { other: e.target.value, otherOn: true })}
                        aria-label={t("Type your own answer")}
                        placeholder={t("Another answer")}
                        className={`${inputCls} py-1.5 text-fg`}
                      />
                    </div>
                  )}
                </div>
              )}

              {q.kind === "text" && (
                <textarea
                  rows={3}
                  aria-label={q.question}
                  value={d.one}
                  onChange={(e) => change(q.id, { one: e.target.value })}
                  className={`${codeAreaCls} resize-y font-sans text-sm text-fg`}
                />
              )}

              {q.kind === "ranking" && (
                <>
                  <p className="mb-1 text-xs text-fg-faint">{t("Best first. Move an option with the arrows.")}</p>
                  <ol className="space-y-1">
                    {d.order.map((label, i) => (
                      <li key={label} className="flex items-center gap-2 rounded-lg border border-line bg-raised/40 px-2 py-1.5">
                        <span className="w-5 text-center text-xs text-fg-subtle">{i + 1}</span>
                        <span className="min-w-0 flex-1 text-sm text-fg">
                          {label}
                          {q.options.find((o) => o.label === label)?.description && (
                            <span className="mt-0.5 block text-xs text-fg-faint">{q.options.find((o) => o.label === label)?.description}</span>
                          )}
                        </span>
                        <button
                          ref={arrow(q, label, "up")}
                          disabled={i === 0}
                          onClick={() => move(q, i, -1)}
                          aria-label={t("Move {option} up", { option: label })}
                          className="rounded-md p-1 text-fg-muted transition hover:bg-fg/10 disabled:opacity-30"
                        >
                          <LuArrowUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          ref={arrow(q, label, "down")}
                          disabled={i === d.order.length - 1}
                          onClick={() => move(q, i, 1)}
                          aria-label={t("Move {option} down", { option: label })}
                          className="rounded-md p-1 text-fg-muted transition hover:bg-fg/10 disabled:opacity-30"
                        >
                          <LuArrowDown className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    ))}
                  </ol>
                  {!d.ranked && (
                    <button type="button" onClick={() => keep(q)} className="mt-1.5 rounded-lg px-2 py-1 text-xs text-fg-muted hover:bg-fg/10">
                      {t("Keep this order")}
                    </button>
                  )}
                </>
              )}
            </fieldset>
          );
        })}
      </div>

      <footer className="flex justify-end gap-2 border-t border-line px-4 py-2.5">
        <button type="button" onClick={() => respond({ cancelled: true })} className="rounded-lg px-3 py-1.5 text-sm text-fg-muted hover:bg-fg/10">
          {t("Cancel")}
        </button>
        <button type="button" disabled={busy || !complete} onClick={() => respond({ value: answers })} className={primarySmCls}>
          <LuCheck className="h-3.5 w-3.5" /> {t("Submit")}
        </button>
      </footer>
    </section>
  );
}

/** One answer as the record shows it: a ranking in its order, several choices together. */
function shownAnswer(q: AgentQuestion, got: string | string[] | undefined): string {
  if (got === undefined) return t("No answer");
  if (!Array.isArray(got)) return got;
  return q.kind === "ranking" ? got.map((s, i) => `${i + 1}. ${s}`).join("  ") : got.join(", ");
}

/**
 * What is left of the agent's questions in the transcript once they have ended: each question, and the answer
 * given, or that they were not answered and why. The server keeps it with the chat (see questions.ts).
 */
export function QuestionRecord({ item, enter }: { item: Extract<Item, { kind: "question" }>; enter: string }) {
  const heading = item.title || t("Questions from the agent");
  const answers = item.answers ?? {};
  const ending =
    item.state === "cancelled"
      ? t("Cancelled, not answered")
      : item.state === "expired"
        ? t("Not answered: the time for answering ran out")
        : item.state === "stopped"
          ? t("Not answered: the run was stopped")
          : undefined;
  return (
    <div data-key={item.id} role="group" aria-label={heading} className={`rounded-xl border border-line bg-raised/40 px-3.5 py-2.5 text-sm${enter}`}>
      <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-fg-muted">
        <LuMessageCircleQuestion aria-hidden className="h-3.5 w-3.5 text-accent" />
        {heading}
      </div>
      <dl className="space-y-1.5">
        {item.questions.map((q) => (
          <div key={q.id}>
            <dt className="text-fg-muted">{q.question}</dt>
            {item.state === "answered" && (
              <dd className="whitespace-pre-wrap text-fg">{shownAnswer(q, Object.hasOwn(answers, q.id) ? answers[q.id] : undefined)}</dd>
            )}
          </div>
        ))}
      </dl>
      {ending && <p className="mt-1.5 text-xs text-fg-subtle">{ending}</p>}
    </div>
  );
}
