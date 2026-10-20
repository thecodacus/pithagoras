import { useState } from "react";
import { LuArchive, LuArchiveRestore, LuBot, LuTrash2, LuUser } from "react-icons/lu";
import type { Activity, Board, Card, CardField } from "../types";
import { Link, Select, msg, portal, t, tp } from "../portal";
import type { CardPatch } from "./api";
import { cardsIn } from "./board-view";
import { Label } from "./CardTile";

/**
 * A card, whole: every field to change, the column it is in, archiving and deleting it, and its activity, newest
 * first, with a note to add. The board it is drawn from keeps coming in while the dialog is open (an agent moved the
 * card, wrote a note): what the person changed in a field stays theirs until it is saved, and the rest shows what is
 * there now.
 */

type Draft = Partial<Record<CardField, string>>;

/** A field's value as the dialog has it: labels as one text, and no due day as an empty one. */
const valueOf = (card: Card, field: CardField): string => (field === "labels" ? card.labels.join(", ") : field === "due" ? (card.due ?? "") : card[field]);

/** What saving sends of a field the person changed. */
function patchOf(draft: Draft): CardPatch {
  const patch: CardPatch = {};
  if (draft.title !== undefined) patch.title = draft.title;
  if (draft.description !== undefined) patch.description = draft.description;
  if (draft.labels !== undefined) patch.labels = draft.labels.split(",").map((l) => l.trim()).filter(Boolean);
  if (draft.assignee !== undefined) patch.assignee = draft.assignee;
  if (draft.due !== undefined) patch.due = draft.due || null;
  return patch;
}

const FIELD_NAMES: Record<CardField, string> = { title: msg("title"), description: msg("description"), labels: msg("labels"), assignee: msg("assignee"), due: msg("due date") };

/** What was done, in a line. */
function said(entry: Activity): string {
  switch (entry.did) {
    case "created":
      return t("Made in {column}", { column: entry.column ?? "" });
    case "edited":
      return t("Changed the {fields}", { fields: (entry.fields ?? []).map((f) => t(FIELD_NAMES[f])).join(", ") });
    case "moved":
      return t("Moved from {from} to {to}", { from: entry.from ?? "", to: entry.to ?? "" });
    case "archived":
      return t("Archived");
    case "restored":
      return t("Restored to {column}", { column: entry.column ?? "" });
    case "noted":
      return t("Wrote a note");
  }
}

/** Who did it: the person, or an agent with a link to its chat. */
function Who({ entry }: { entry: Activity }) {
  if (entry.by.kind === "person")
    return (
      <span className="kb-who">
        <LuUser aria-hidden />
        {t("You")}
      </span>
    );
  return (
    <span className="kb-who is-agent">
      <LuBot aria-hidden />
      {t("Agent")}
      <Link to={`/s/${encodeURIComponent(entry.by.chat.id)}`} className="kb-who-chat" label={t("Open the chat {title}", { title: entry.by.chat.title })}>
        {entry.by.chat.title}
      </Link>
    </span>
  );
}

export function CardDialog({
  board,
  cardId,
  onClose,
  onEdit,
  onMove,
  onArchive,
  onRestore,
  onDelete,
  onNote,
}: {
  board: Board;
  cardId: string;
  onClose: () => void;
  /** Each resolves true once done, false when it was refused (and said so). */
  onEdit: (card: Card, patch: CardPatch) => Promise<boolean>;
  onMove: (card: Card, column: string) => Promise<boolean>;
  onArchive: (card: Card) => Promise<boolean>;
  onRestore: (card: Card) => Promise<boolean>;
  onDelete: (card: Card) => Promise<boolean>;
  onNote: (card: Card, text: string) => Promise<boolean>;
}) {
  const { ui } = portal;
  portal.locale.use();
  const card = board.cards.find((c) => c.id === cardId);
  const [draft, setDraft] = useState<Draft>({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  if (!card)
    return (
      <ui.Modal title={t("Card")} onClose={onClose} footer={<button type="button" className={ui.classes.button} onClick={onClose}>{t("Close")}</button>}>
        <p className="px-5 py-6 text-sm text-fg-muted">{t("This card is not on the board any more: it was deleted.")}</p>
      </ui.Modal>
    );

  const value = (field: CardField) => draft[field] ?? valueOf(card, field);
  const changed = (Object.keys(draft) as CardField[]).filter((field) => draft[field] !== valueOf(card, field));
  const set = (field: CardField) => (text: string) => setDraft((d) => ({ ...d, [field]: text }));
  const column = board.columns.find((c) => c.id === card.column);
  const run = async (work: () => Promise<boolean>) => {
    setBusy(true);
    try {
      return await work();
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!value("title").trim()) return;
    const patch = patchOf(Object.fromEntries(changed.map((f) => [f, draft[f]])) as Draft);
    if (await run(() => onEdit(card, patch))) onClose();
  };
  const addNote = async () => {
    if (!note.trim()) return;
    if (await run(() => onNote(card, note))) setNote("");
  };
  const remove = async () => {
    const yes = await ui.confirm({ title: t("Delete the card “{title}”?", { title: card.title }), message: t("It is gone for good, with its activity. Archiving keeps it instead."), confirmLabel: t("Delete"), danger: true, deletes: true });
    if (yes && (await run(() => onDelete(card)))) onClose();
  };

  const footer = (
    <div className="flex w-full flex-wrap items-center gap-2">
      <button type="button" className={`${ui.classes.ghost} text-danger`} onClick={() => void remove()} disabled={busy}>
        <LuTrash2 aria-hidden className="h-3.5 w-3.5" />
        {t("Delete")}
      </button>
      {card.archived ? (
        <button type="button" className={ui.classes.ghost} onClick={() => void run(() => onRestore(card))} disabled={busy}>
          <LuArchiveRestore aria-hidden className="h-3.5 w-3.5" />
          {t("Restore")}
        </button>
      ) : (
        <button type="button" className={ui.classes.ghost} onClick={() => void run(() => onArchive(card)).then((ok) => ok && onClose())} disabled={busy}>
          <LuArchive aria-hidden className="h-3.5 w-3.5" />
          {t("Archive")}
        </button>
      )}
      <span className="flex-1" />
      <button type="button" className={ui.classes.button} onClick={onClose}>
        {t("Cancel")}
      </button>
      <button type="button" className={ui.classes.primarySmall} onClick={() => void save()} disabled={busy || !changed.length || !value("title").trim()}>
        {t("Save")}
      </button>
    </div>
  );

  const activity = [...card.activity].reverse();
  return (
    <ui.Modal
      title={card.title}
      subtitle={`${card.id} · ${card.archived ? t("Archived, from {column}", { column: column?.name ?? "" }) : (column?.name ?? "")}`}
      onClose={onClose}
      footer={footer}
      wide
      unsaved={changed.length > 0}
    >
      <div className="kb-dialog grid gap-5 overflow-y-auto px-5 py-4 md:grid-cols-[minmax(0,1fr)_16rem]">
        <form
          className="grid content-start gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <ui.Field label={t("Title")}>
            <input className={ui.classes.input} value={value("title")} maxLength={200} onChange={(e) => set("title")(e.target.value)} />
          </ui.Field>
          <ui.Field label={t("Description")} hint={t("Plain text, or Markdown: it is shown as it is written.")}>
            <textarea className={`${ui.classes.input} kb-description`} rows={6} value={value("description")} onChange={(e) => set("description")(e.target.value)} />
          </ui.Field>
          <ui.Field label={t("Labels")} hint={t("Separated by commas.")}>
            <input className={ui.classes.input} value={value("labels")} onChange={(e) => set("labels")(e.target.value)} />
          </ui.Field>
          {!!value("labels").trim() && (
            <div className="kb-card-labels -mt-1">
              {value("labels")
                .split(",")
                .map((l) => l.trim())
                .filter(Boolean)
                .map((l, i) => (
                  <Label key={`${l}${i}`} label={l} />
                ))}
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <ui.Field label={t("Assignee")} hint={t("A person, or an agent.")}>
              <input className={ui.classes.input} value={value("assignee")} maxLength={80} onChange={(e) => set("assignee")(e.target.value)} />
            </ui.Field>
            <ui.Field label={t("Due date")}>
              <input type="date" className={ui.classes.input} value={value("due")} onChange={(e) => set("due")(e.target.value)} />
            </ui.Field>
          </div>
          {/* A Select is a button: not inside a label, which would pass every click on it to the list. */}
          {!card.archived && (
            <div>
              <span className="text-xs text-fg-muted">{t("Column")}</span>
              <div className="mt-1">
                <Select
                  aria-label={t("Column")}
                  value={card.column}
                  onChange={(next) => void run(() => onMove(card, next))}
                  options={board.columns.map((c) => ({ value: c.id, label: c.name, hint: tp(cardsIn(board, c.id).length, "{n} card", "{n} cards") }))}
                />
              </div>
            </div>
          )}
        </form>
        <section aria-label={t("Activity")} className="kb-activity">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-subtle">{t("Activity")}</h3>
          <div className="mb-3 grid gap-2">
            <textarea
              className={`${ui.classes.inputSmall} kb-note`}
              rows={2}
              value={note}
              maxLength={2000}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t("Write a note…")}
              aria-label={t("A note on the card")}
            />
            <button type="button" className={`${ui.classes.button} justify-center`} onClick={() => void addNote()} disabled={busy || !note.trim()}>
              {t("Add note")}
            </button>
          </div>
          <ol className="grid gap-2">
            {activity.map((entry, i) => (
              <li key={`${entry.at}-${i}`} className="kb-entry">
                <div className="flex items-baseline gap-2">
                  <Who entry={entry} />
                  <time className="ml-auto shrink-0 text-[11px] text-fg-faint" dateTime={new Date(entry.at).toISOString()}>
                    {portal.format.dateTime(entry.at, { dateStyle: "short", timeStyle: "short" })}
                  </time>
                </div>
                <p className="text-xs text-fg-muted">{said(entry)}</p>
                {entry.note && <p className="kb-entry-note">{entry.note}</p>}
              </li>
            ))}
          </ol>
        </section>
      </div>
    </ui.Modal>
  );
}
