import { useEffect, useRef, type CSSProperties, type PointerEvent } from "react";
import { LuAlignLeft, LuArchive, LuArrowDown, LuArrowRight, LuArrowUp, LuCalendar, LuEllipsis, LuMessageSquareText, LuPanelRight, LuUser } from "react-icons/lu";
import type { Board, Card } from "../types";
import { portal, t, tp } from "../portal";
import { cardsIn, dayOf, overdue } from "./board-view";
import { fingerHolds } from "./drag";
import { Menu, SEPARATOR, type MenuItem } from "./Menu";

/**
 * A card on the board: its title, labels, assignee and due date, opened by a click, dragged by the pointer from
 * anywhere on it (see drag.ts), and moved by the keyboard from its menu.
 */

/** A label's hue, the same for the same label wherever it is. */
export const hueOf = (label: string) => {
  let hash = 0;
  for (const ch of label.toLowerCase()) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  return hash % 360;
};

export function Label({ label }: { label: string }) {
  return (
    <span className="kb-label" style={{ "--kb-hue": hueOf(label) } as CSSProperties}>
      {label}
    </span>
  );
}

/** A due day as the page's language writes it, with the year where it is not this one. */
export function dueText(due: string) {
  const day = dayOf(due);
  return portal.format.date(day, { day: "numeric", month: "short", ...(day.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
}

/** What a card shows of itself: on the board, and under the pointer while it is dragged. */
export function CardFace({ card }: { card: Card }) {
  const late = overdue(card);
  const notes = card.activity.filter((a) => a.note).length;
  return (
    <>
      <span className="kb-card-title">{card.title}</span>
      {card.labels.length > 0 && (
        <span className="kb-card-labels">
          {card.labels.map((label) => (
            <Label key={label} label={label} />
          ))}
        </span>
      )}
      {(card.assignee || card.due || card.description || notes > 0) && (
        <span className="kb-card-meta">
          {card.assignee && (
            <span className="kb-card-assignee" title={t("Assigned to {name}", { name: card.assignee })}>
              <LuUser aria-hidden />
              <span>{card.assignee}</span>
            </span>
          )}
          {card.due && (
            <span className={`kb-card-due${late ? " is-late" : ""}`} title={late ? t("Overdue: due {day}", { day: dueText(card.due) }) : t("Due {day}", { day: dueText(card.due) })}>
              <LuCalendar aria-hidden />
              <span>{late ? t("Overdue · {day}", { day: dueText(card.due) }) : dueText(card.due)}</span>
            </span>
          )}
          {card.description && <LuAlignLeft aria-label={t("Has a description")} role="img" className="kb-card-mark" />}
          {notes > 0 && (
            <span className="kb-card-notes" title={tp(notes, "{n} note", "{n} notes")}>
              <LuMessageSquareText aria-hidden />
              <span aria-hidden>{notes}</span>
              <span className="sr-only">{tp(notes, "{n} note", "{n} notes")}</span>
            </span>
          )}
        </span>
      )}
    </>
  );
}

export function CardTile({
  board,
  card,
  dragged,
  onOpen,
  onGrab,
  onMove,
  onArchive,
  menuRef,
}: {
  board: Board;
  card: Card;
  /** It is the card being dragged: it stays where it was, faint, until it is dropped. */
  dragged: boolean;
  onOpen: (card: Card) => void;
  onGrab: (card: Card, e: PointerEvent<HTMLElement>) => void;
  /** Moves it by the keyboard: to a column, at an index among its cards. */
  onMove: (card: Card, column: string, index: number) => void;
  onArchive: (card: Card) => void;
  menuRef: (el: HTMLButtonElement | null) => void;
}) {
  const here = cardsIn(board, card.column);
  const at = here.indexOf(card);
  const items: (MenuItem | typeof SEPARATOR)[] = [
    { label: t("Open"), icon: LuPanelRight, onSelect: () => onOpen(card) },
    SEPARATOR,
    { label: t("Move up"), icon: LuArrowUp, disabled: at <= 0, onSelect: () => onMove(card, card.column, at - 1) },
    { label: t("Move down"), icon: LuArrowDown, disabled: at === here.length - 1, onSelect: () => onMove(card, card.column, at + 1) },
    ...board.columns
      .filter((c) => c.id !== card.column)
      .map((c) => ({ label: t("Move to {column}", { column: c.name }), icon: LuArrowRight, onSelect: () => onMove(card, c.id, cardsIn(board, c.id).length) })),
    SEPARATOR,
    { label: t("Archive"), icon: LuArchive, onSelect: () => onArchive(card) },
  ];
  // While a finger drags it, the board does not scroll under the finger. React's own touch listeners cannot say so.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    const still = (e: TouchEvent) => fingerHolds() && e.preventDefault();
    el?.addEventListener("touchmove", still, { passive: false });
    return () => el?.removeEventListener("touchmove", still);
  }, []);
  return (
    <div ref={root} className={`kb-card${dragged ? " is-dragged" : ""}`} onPointerDown={(e) => onGrab(card, e)} data-kb-card={card.id}>
      {/* Named by what it shows, title first: what a reader hears of the card. */}
      <button type="button" className="kb-card-open" onClick={() => onOpen(card)}>
        <CardFace card={card} />
      </button>
      <Menu label={t("Actions for card {title}", { title: card.title })} items={items} className="kb-card-menu" buttonRef={menuRef}>
        <LuEllipsis aria-hidden />
      </Menu>
    </div>
  );
}
