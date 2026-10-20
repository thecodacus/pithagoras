import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { LuArrowLeft, LuArrowRight, LuEllipsis, LuPencil, LuPlus, LuTrash2 } from "react-icons/lu";
import type { Board, Card, Column } from "../types";
import { portal, t, tp } from "../portal";
import { cardsIn } from "./board-view";
import { CardTile } from "./CardTile";
import type { DropAt } from "./drag";
import { Menu } from "./Menu";

/**
 * A column of the board: its name and how many cards it holds, its cards top first, and a card added at its bottom.
 * Its menu renames it, moves it left or right, and deletes it.
 */
export function ColumnView({
  board,
  column,
  dragged,
  drop,
  onOpen,
  onGrab,
  onMove,
  onArchive,
  onAdd,
  onRename,
  onShift,
  onRemove,
  cardRef,
}: {
  board: Board;
  column: Column;
  /** The card being dragged, wherever it is. */
  dragged: string | null;
  /** Where it would go now, when that is in this column. */
  drop: DropAt | null;
  onOpen: (card: Card) => void;
  onGrab: (card: Card, e: PointerEvent<HTMLElement>) => void;
  onMove: (card: Card, column: string, index: number) => void;
  onArchive: (card: Card) => void;
  /** Adds a card at the bottom; resolves once it is there. */
  onAdd: (title: string) => Promise<boolean>;
  onRename: (name: string) => Promise<boolean>;
  /** Moves the column one place, -1 left or 1 right. */
  onShift: (by: -1 | 1) => void;
  onRemove: () => void;
  cardRef: (card: string, el: HTMLButtonElement | null) => void;
}) {
  const cards = cardsIn(board, column.id);
  const place = board.columns.indexOf(column);
  const [renaming, setRenaming] = useState(false);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const opener = useRef<HTMLButtonElement>(null);

  // The field has the keyboard once it is there, and the button that opened it once it is gone again.
  const wasAdding = useRef(false);
  useEffect(() => {
    if (adding) field.current?.focus();
    else if (wasAdding.current) opener.current?.focus();
    wasAdding.current = adding;
  }, [adding]);

  const add = async () => {
    const text = title.trim();
    if (!text || busy) return;
    setBusy(true);
    const ok = await onAdd(text);
    setBusy(false);
    // Kept open for the next one.
    if (ok) setTitle("");
    field.current?.focus();
  };
  const stopAdding = () => {
    setAdding(false);
    setTitle("");
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void add();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      stopAdding();
    }
  };

  // The line where the dragged card would go: before the card at that place among the others, or at the end.
  const others = cards.filter((c) => c.id !== dragged);
  const dropBefore = drop ? (others[drop.index]?.id ?? null) : undefined;
  const line = <li className="kb-drop" aria-hidden />;

  return (
    <section className="kb-column" data-kb-column={column.id} aria-label={t("Column {name}", { name: column.name })}>
      <header className="kb-column-head">
        {renaming ? (
          <RenameField
            name={column.name}
            onDone={async (name) => {
              if (name !== null && name !== column.name && !(await onRename(name))) return false;
              setRenaming(false);
            }}
          />
        ) : (
          <h3 className="kb-column-name" title={column.name}>
            {column.name}
          </h3>
        )}
        <span className="kb-column-count">
          <span aria-hidden>{cards.length}</span>
          <span className="sr-only">{tp(cards.length, "{n} card", "{n} cards")}</span>
        </span>
        <Menu
          label={t("Actions for column {name}", { name: column.name })}
          className="kb-icon-button"
          items={[
            { label: t("Rename"), icon: LuPencil, onSelect: () => setRenaming(true) },
            { label: t("Move left"), icon: LuArrowLeft, disabled: place === 0, onSelect: () => onShift(-1) },
            { label: t("Move right"), icon: LuArrowRight, disabled: place === board.columns.length - 1, onSelect: () => onShift(1) },
            { label: t("Delete column"), icon: LuTrash2, danger: true, disabled: board.columns.length === 1, onSelect: onRemove },
          ]}
        >
          <LuEllipsis aria-hidden />
        </Menu>
      </header>
      <ol className="kb-cards" data-kb-cards aria-label={t("Cards in {name}", { name: column.name })}>
        {cards.map((card) => (
          <Fragment key={card.id}>
            {dropBefore === card.id && line}
            <li>
              <CardTile
                board={board}
                card={card}
                dragged={card.id === dragged}
                onOpen={onOpen}
                onGrab={onGrab}
                onMove={onMove}
                onArchive={onArchive}
                menuRef={(el) => cardRef(card.id, el)}
              />
            </li>
          </Fragment>
        ))}
        {dropBefore === null && line}
        {!cards.length && !drop && <li className="kb-column-empty">{t("No cards")}</li>}
      </ol>
      <footer className="kb-column-foot" data-kb-nodrag>
        {adding ? (
          <div className="kb-add-card">
            <textarea
              ref={field}
              rows={2}
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={onKey}
              placeholder={t("What is the card for?")}
              aria-label={t("Title of the new card in {name}", { name: column.name })}
              className={`${portal.ui.classes.inputSmall} kb-new-card`}
            />
            <div className="flex items-center gap-2">
              <button type="button" className={portal.ui.classes.primarySmall} onClick={() => void add()} disabled={!title.trim() || busy}>
                {t("Add card")}
              </button>
              <button type="button" className={portal.ui.classes.ghost} onClick={stopAdding}>
                {t("Cancel")}
              </button>
            </div>
          </div>
        ) : (
          <button ref={opener} type="button" className="kb-add" onClick={() => setAdding(true)} aria-label={t("Add a card to {name}", { name: column.name })}>
            <LuPlus aria-hidden />
            {t("Add a card")}
          </button>
        )}
      </footer>
    </section>
  );
}

/** A name being changed in place: Enter keeps it, Escape leaves it as it was (null). `onDone` says false when it could not be kept, and the field stays. */
export function RenameField({ name, onDone, label }: { name: string; onDone: (name: string | null) => Promise<boolean | void> | void; label?: string }) {
  const [value, setValue] = useState(name);
  const busy = useRef(false);
  const finish = async (next: string | null) => {
    // Enter, then the blur of the field going: once.
    if (busy.current) return;
    busy.current = true;
    if ((await onDone(next === null || !next.trim() ? null : next.trim())) === false) busy.current = false;
  };
  return (
    <input
      autoFocus
      value={value}
      maxLength={60}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void finish(value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          void finish(null);
        }
      }}
      onBlur={() => void finish(value)}
      aria-label={label ?? t("Name of the column")}
      className={`${portal.ui.classes.inputSmall} kb-rename`}
    />
  );
}
