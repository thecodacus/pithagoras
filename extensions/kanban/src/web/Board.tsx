import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { LuArchive, LuEllipsis, LuExternalLink, LuPencil, LuPlus, LuSquareKanban, LuTrash2 } from "react-icons/lu";
import type { Board, Card, Column } from "../types";
import { Select, boardsPage, portal, t, tp } from "../portal";
import { api, type CardPatch } from "./api";
import { cardsIn, moved, overdue } from "./board-view";
import { CardDialog } from "./CardDialog";
import { CardFace } from "./CardTile";
import { ColumnView, RenameField } from "./ColumnView";
import { ArchivedCards, BoardForm, RemoveColumn } from "./Dialogs";
import { useCardDrag } from "./drag";
import { Menu, SEPARATOR, type MenuItem } from "./Menu";
import { reason, useBoard, useBoardList } from "./use-board";

/**
 * A board, as the Boards page and a chat's panel both draw it: which board (a switcher, with making, renaming and
 * deleting one), its columns side by side, its cards, and every dialog of it. The page lays it out with the portal's
 * page header; the panel in a bar of its own, and its columns one under another where it is narrow (client.css).
 *
 * The board is kept up to date as it changes elsewhere (use-board.ts), without closing a dialog or dropping a card
 * being dragged.
 */

export interface BoardViewProps {
  /** The board to show, or none yet. */
  board: string | null;
  /** The board to show when `board` is none or is gone, if it is there; the first board otherwise. */
  fallback?: string | null;
  /** Another board was chosen; `replace` when it stands in for one that was not there, not a step of the person's. */
  onPick: (id: string | null, replace: boolean) => void;
  layout: "page" | "panel";
  /** Changes when something says the board changed (an agent's call ended): it is asked for at once. */
  nudge?: unknown;
  /** Says whether a dialog is open or a card is held, with something that would be lost if it went. */
  onBusy?: (open: boolean) => void;
}

export function BoardView({ board: wanted, fallback, onPick, layout, nudge, onBusy }: BoardViewProps) {
  const { ui } = portal;
  portal.locale.use();
  const list = useBoardList();
  const shown = useBoard(wanted);
  const board = shown.board;
  const [error, setError] = useState<string | null>(null);
  const [card, setCard] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | "new" | "rename" | "archived" | { remove: Column }>(null);
  const [addingColumn, setAddingColumn] = useState(false);
  const scroller = useRef<HTMLDivElement | null>(null);
  const menus = useRef(new Map<string, HTMLButtonElement>());
  const focusAfter = useRef<string | null>(null);

  // No board asked for, or one that is gone: the fallback, else the first there is.
  useEffect(() => {
    if (!list.list || (wanted && !shown.gone)) return;
    const there = list.list.boards.filter((b) => b.id !== wanted);
    const next = there.find((b) => b.id === fallback)?.id ?? there[0]?.id ?? null;
    if (next !== wanted) onPick(next, true);
  }, [list.list, wanted, shown.gone, fallback]);

  // Another board: what was open on the one before is not on it.
  useEffect(() => {
    setCard(null);
    setDialog(null);
  }, [wanted]);

  // Asked for at once when told something changed; as it is drawn, it is being asked for already.
  const told = useRef(nudge);
  useEffect(() => {
    if (nudge === told.current) return;
    told.current = nudge;
    void shown.refresh();
    void list.refresh();
  }, [nudge]);

  // After a card was moved by the keyboard, the keyboard is on it in its new place.
  useEffect(() => {
    const id = focusAfter.current;
    if (!id || !board) return;
    focusAfter.current = null;
    menus.current.get(id)?.focus();
  }, [board]);

  /** Does a change, and shows the board it answers with; says why when it was refused. */
  const act = async (work: () => Promise<Board>): Promise<boolean> => {
    try {
      shown.apply(await work());
      setError(null);
      void list.refresh();
      return true;
    } catch (e) {
      setError(reason(e));
      // What is shown may be what was refused: as it is on the server.
      void shown.refresh();
      return false;
    }
  };

  /** Moves a card, shown where it goes at once; what a look brings meanwhile waits for the answer, which is newer. */
  const move = async (target: Card, column: string, index: number) => {
    if (!board) return false;
    const release = shown.hold();
    shown.preview(moved(board, target.id, column, index));
    try {
      return await act(() => api.moveCard(board.id, target.id, column, index));
    } finally {
      release();
    }
  };
  const { dragging, grab } = useCardDrag({ board, hold: shown.hold, scroller: () => scroller.current, onDrop: (c, at) => void move(c, at.column, at.index) });
  const held = dragging !== null;
  useEffect(() => onBusy?.(card !== null || dialog !== null || held), [card, dialog, held]);

  const createBoard = async (name: string) => {
    try {
      const made = await api.createBoard(name);
      setError(null);
      await list.refresh();
      onPick(made.id, false);
      return true;
    } catch (e) {
      setError(reason(e));
      return false;
    }
  };
  const deleteBoard = async (which: Board) => {
    const count = which.cards.length;
    const yes = await ui.confirm({
      title: t("Delete the board “{name}”?", { name: which.name }),
      message: tp(count, "Its {n} card goes with it, archived or not. This cannot be undone.", "Its {n} cards go with it, archived or not. This cannot be undone."),
      confirmLabel: t("Delete"),
      danger: true,
      deletes: true,
    });
    if (!yes) return;
    try {
      await api.deleteBoard(which.id);
      setError(null);
      await list.refresh();
      const next = list.list?.boards.find((b) => b.id !== which.id)?.id ?? null;
      onPick(next, true);
    } catch (e) {
      setError(reason(e));
    }
  };
  const removeColumn = async (column: Column) => {
    if (!board) return;
    if (board.cards.some((c) => c.column === column.id)) return setDialog({ remove: column });
    const yes = await ui.confirm({ title: t("Delete the column “{name}”?", { name: column.name }), confirmLabel: t("Delete"), danger: true, deletes: true });
    if (yes) await act(() => api.removeColumn(board.id, column.id));
  };

  const boards = list.list?.boards ?? [];
  // A board just made elsewhere may not be in the list yet: it is in the switcher all the same.
  const options = [...boards.map((b) => ({ value: b.id, label: b.name })), ...(board && !boards.some((b) => b.id === board.id) ? [{ value: board.id, label: board.name }] : [])];
  const archived = board?.cards.filter((c) => c.archived).length ?? 0;
  const boardItems: (MenuItem | typeof SEPARATOR)[] = [
    { label: t("New board"), icon: LuPlus, onSelect: () => setDialog("new") },
    ...(board
      ? [
          { label: t("Rename the board"), icon: LuPencil, onSelect: () => setDialog("rename") },
          { label: t("Archived cards ({n})", { n: archived }), icon: LuArchive, onSelect: () => setDialog("archived") },
          ...(layout === "panel" ? [{ label: t("Open on the Boards page"), icon: LuExternalLink, onSelect: () => portal.navigate(boardsPage(board.id)) }] : []),
          SEPARATOR,
          { label: t("Delete the board"), icon: LuTrash2, danger: true, onSelect: () => void deleteBoard(board) },
        ]
      : []),
  ];
  const switcher = (
    <div className="kb-switcher">
      {options.length > 0 && <Select aria-label={t("Board")} size="sm" className="kb-switcher-select" value={board?.id ?? wanted ?? ""} onChange={(id) => onPick(id, false)} options={options} />}
      <Menu label={t("Board actions")} items={boardItems} className="kb-icon-button">
        <LuEllipsis aria-hidden />
      </Menu>
    </div>
  );

  let body: ReactNode;
  if (!list.list && list.error) body = <ui.LoadFailed error={list.error} onRetry={list.refresh} />;
  else if (list.list && !boards.length && !wanted) body = <NoBoards onMake={createBoard} />;
  else if (!board && shown.error && !shown.gone) body = <ui.LoadFailed error={shown.error} onRetry={shown.refresh} />;
  else if (!board) body = <ui.RowsSkeleton rows={4} label={t("Loading the board…")} />;
  else
    body = (
      <div className="kb-columns" ref={scroller} aria-label={t("Columns of {name}", { name: board.name })} role="group">
        {board.columns.map((column, i) => (
          <ColumnView
            key={column.id}
            board={board}
            column={column}
            dragged={dragging?.card.id ?? null}
            drop={dragging?.at?.column === column.id ? dragging.at : null}
            onOpen={(c) => setCard(c.id)}
            onGrab={grab}
            onMove={(c, col, index) => {
              focusAfter.current = c.id;
              void move(c, col, index);
            }}
            onArchive={(c) => void act(() => api.archiveCard(board.id, c.id))}
            onAdd={(title) => act(() => api.addCard(board.id, column.id, title))}
            onRename={(name) => act(() => api.renameColumn(board.id, column.id, name))}
            onShift={(by) => void act(() => api.moveColumn(board.id, column.id, i + by))}
            onRemove={() => void removeColumn(column)}
            cardRef={(id, el) => (el ? menus.current.set(id, el) : menus.current.delete(id))}
          />
        ))}
        <div className="kb-column is-new">
          {addingColumn ? (
            <RenameField
              name=""
              label={t("Name of the new column")}
              onDone={async (name) => {
                if (name !== null && !(await act(() => api.addColumn(board.id, name)))) return false;
                setAddingColumn(false);
              }}
            />
          ) : (
            <button type="button" className="kb-add" onClick={() => setAddingColumn(true)}>
              <LuPlus aria-hidden />
              {t("Add a column")}
            </button>
          )}
        </div>
      </div>
    );

  const cards = board?.cards.filter((c) => !c.archived) ?? [];
  const late = cards.filter((c) => overdue(c)).length;

  return (
    <div className="kb-board" data-layout={layout}>
      {layout === "page" ? (
        <ui.PageHeader
          icon={<LuSquareKanban />}
          title={board?.name ?? t("Boards")}
          description={board?.description || t("Columns of cards, for you and the agents to keep track of work. An agent's changes show here as it makes them.")}
          action={switcher}
          className="kb-page-header"
        >
          {board && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <ui.Stat value={cards.length} label={tp(cards.length, "card", "cards")} />
              {late > 0 && <ui.Stat value={late} label={t("overdue")} tone="text-danger" />}
              <button type="button" className={ui.classes.ghost} onClick={() => setDialog("archived")}>
                <LuArchive aria-hidden className="h-3.5 w-3.5" />
                {t("Archived cards ({n})", { n: archived })}
              </button>
            </div>
          )}
        </ui.PageHeader>
      ) : (
        <div className="kb-bar">{switcher}</div>
      )}
      {(error || list.error) && (
        <ui.ErrorBanner className="kb-error" onClose={() => setError(null)}>
          {error ?? list.error}
        </ui.ErrorBanner>
      )}
      {body}

      {board && card && (
        <CardDialog
          board={board}
          cardId={card}
          onClose={() => setCard(null)}
          onEdit={(c, patch: CardPatch) => act(() => api.editCard(board.id, c.id, patch))}
          onMove={(c, column) => move(c, column, cardsIn(board, column).length)}
          onArchive={(c) => act(() => api.archiveCard(board.id, c.id))}
          onRestore={(c) => act(() => api.restoreCard(board.id, c.id))}
          onDelete={(c) => act(() => api.deleteCard(board.id, c.id))}
          onNote={(c, text) => act(() => api.noteCard(board.id, c.id, text))}
        />
      )}
      {dialog === "new" && <BoardForm onSave={createBoard} onClose={() => setDialog(null)} />}
      {dialog === "rename" && board && <BoardForm board={board} onSave={(name, description) => act(() => api.renameBoard(board.id, { name, description }))} onClose={() => setDialog(null)} />}
      {dialog === "archived" && board && (
        <ArchivedCards
          board={board}
          onOpen={(c) => {
            setDialog(null);
            setCard(c.id);
          }}
          onRestore={(c) => act(() => api.restoreCard(board.id, c.id))}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog && typeof dialog === "object" && board && (
        <RemoveColumn board={board} column={dialog.remove} onRemove={(to) => act(() => api.removeColumn(board.id, dialog.remove.id, to))} onClose={() => setDialog(null)} />
      )}
      {/* The card under the pointer, over everything, in an element of the extension's for its styles to reach. */}
      {dragging &&
        createPortal(
          <div data-extension={portal.extension} style={{ display: "contents" }}>
            <div className="kb-ghost kb-card" style={{ left: dragging.x - dragging.dx, top: dragging.y - dragging.dy, width: dragging.width }} aria-hidden>
              <div className="kb-card-open">
                <CardFace card={dragging.card} />
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

/** No board yet: the first one made here. */
function NoBoards({ onMake }: { onMake: (name: string) => Promise<boolean> }) {
  const { ui } = portal;
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="kb-none">
      <ui.Empty>
        <p className="mb-3">{t("No boards yet. Make one here, or ask an agent to make one with its kanban tools.")}</p>
        <form
          className="mx-auto flex max-w-sm gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!name.trim() || busy) return;
            setBusy(true);
            if (await onMake(name.trim())) setName("");
            setBusy(false);
          }}
        >
          <input className={ui.classes.inputSmall} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={t("Name of the board")} aria-label={t("Name of the board")} />
          <button type="submit" className={`${ui.classes.primarySmall} shrink-0`} disabled={!name.trim() || busy}>
            {t("Make the board")}
          </button>
        </form>
      </ui.Empty>
    </div>
  );
}
