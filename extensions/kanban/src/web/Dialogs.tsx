import { useState } from "react";
import { LuArchiveRestore, LuPanelRight } from "react-icons/lu";
import type { Board, Card, Column } from "../types";
import { Select, portal, t, tp } from "../portal";
import { Label } from "./CardTile";

/** The board's smaller dialogs: a board's name, the archived cards, and where a column's cards go when it is deleted. */

/** A new board's name, or a board's name and description. Resolves true once it is saved. */
export function BoardForm({ board, onSave, onClose }: { board?: Board; onSave: (name: string, description: string) => Promise<boolean>; onClose: () => void }) {
  const { ui } = portal;
  const [name, setName] = useState(board?.name ?? "");
  const [description, setDescription] = useState(board?.description ?? "");
  const [busy, setBusy] = useState(false);
  const unsaved = name !== (board?.name ?? "") || description !== (board?.description ?? "");
  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const ok = await onSave(name.trim(), description.trim());
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <ui.Modal
      title={board ? t("Rename the board") : t("New board")}
      onClose={onClose}
      unsaved={unsaved}
      footer={
        <div className="flex w-full justify-end gap-2">
          <button type="button" className={ui.classes.button} onClick={onClose}>
            {t("Cancel")}
          </button>
          <button type="button" className={ui.classes.primarySmall} disabled={!name.trim() || busy} onClick={() => void save()}>
            {board ? t("Save") : t("Make the board")}
          </button>
        </div>
      }
    >
      <form
        className="grid gap-3 px-5 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <ui.Field label={t("Name")}>
          <input autoFocus className={ui.classes.input} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </ui.Field>
        {board ? (
          <ui.Field label={t("Description")} hint={t("What the board is for: the agents read it too.")}>
            <textarea className={ui.classes.input} rows={3} value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} />
          </ui.Field>
        ) : (
          <p className="text-xs text-fg-subtle">{t("It starts with the columns To do, In progress and Done, which you can rename, move and add to.")}</p>
        )}
      </form>
    </ui.Modal>
  );
}

/** The archived cards of a board, newest first: each opened, or restored to its column. */
export function ArchivedCards({ board, onOpen, onRestore, onClose }: { board: Board; onOpen: (card: Card) => void; onRestore: (card: Card) => Promise<boolean>; onClose: () => void }) {
  const { ui } = portal;
  const cards = board.cards.filter((c) => c.archived).sort((a, b) => b.updated - a.updated);
  const columnOf = (card: Card) => board.columns.find((c) => c.id === card.column)?.name ?? "";
  return (
    <ui.Modal title={t("Archived cards")} subtitle={board.name} onClose={onClose}>
      <div className="max-h-[60vh] overflow-y-auto px-5 py-4">
        {cards.length ? (
          <ul className="grid gap-2" aria-label={t("Archived cards")}>
            {cards.map((card) => (
              <li key={card.id} className="flex items-center gap-2 rounded-xl border border-line bg-raised/40 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-fg">{card.title}</p>
                  <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-fg-subtle">
                    <span>{t("From {column}", { column: columnOf(card) })}</span>
                    <span aria-hidden>·</span>
                    <span>{portal.format.date(card.updated)}</span>
                    {card.labels.map((label) => (
                      <Label key={label} label={label} />
                    ))}
                  </p>
                </div>
                <button type="button" className={ui.classes.ghost} onClick={() => onOpen(card)} aria-label={t("Open card {title}", { title: card.title })}>
                  <LuPanelRight aria-hidden className="h-3.5 w-3.5" />
                  {t("Open")}
                </button>
                <button type="button" className={ui.classes.ghost} onClick={() => void onRestore(card)} aria-label={t("Restore card {title}", { title: card.title })}>
                  <LuArchiveRestore aria-hidden className="h-3.5 w-3.5" />
                  {t("Restore")}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <ui.Empty>{t("No archived cards on this board.")}</ui.Empty>
        )}
      </div>
    </ui.Modal>
  );
}

/**
 * A column with cards is deleted once its cards have somewhere to go. Resolves true once it is gone. `column` is the
 * column as it was when the dialog opened: it is found in the board by its id, as the board keeps coming in.
 */
export function RemoveColumn({ board, column, onRemove, onClose }: { board: Board; column: Column; onRemove: (to: string) => Promise<boolean>; onClose: () => void }) {
  const { ui } = portal;
  const others = board.columns.filter((c) => c.id !== column.id);
  const name = board.columns.find((c) => c.id === column.id)?.name ?? column.name;
  const [to, setTo] = useState(others[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const count = board.cards.filter((c) => c.column === column.id).length;
  const remove = async () => {
    setBusy(true);
    const ok = await onRemove(to);
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <ui.Modal
      title={t("Delete the column “{name}”?", { name })}
      onClose={onClose}
      footer={
        <div className="flex w-full justify-end gap-2">
          <button type="button" className={ui.classes.button} onClick={onClose}>
            {t("Cancel")}
          </button>
          <button type="button" className={`${ui.classes.button} text-danger`} disabled={busy || !to} onClick={() => void remove()}>
            {t("Move them and delete the column")}
          </button>
        </div>
      }
    >
      <div className="grid gap-3 px-5 py-4">
        <p className="text-sm text-fg-muted">{tp(count, "It holds {n} card, archived ones included. Choose the column it goes to.", "It holds {n} cards, archived ones included. Choose the column they go to.")}</p>
        <div>
          <span className="text-xs text-fg-muted">{t("Move the cards to")}</span>
          <div className="mt-1">
            <Select aria-label={t("Move the cards to")} value={to} onChange={setTo} options={others.map((c) => ({ value: c.id, label: c.name }))} />
          </div>
        </div>
      </div>
    </ui.Modal>
  );
}
