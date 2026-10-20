import { useState, type ReactNode } from "react";
import { LuChevronRight, LuPanelRight, LuSquareKanban } from "react-icons/lu";
import type { ChatProps, ToolCallView } from "@pithagoras/extension-api";
import { msg, portal, t } from "../portal";
import type { CallDetails } from "../server/tools";

/**
 * A kanban tool's call in the chat: what it did, in a line (the card or the board it touched), and a way to open the
 * board beside the chat on that board. The portal's own card of the call, with what it was given and what it
 * answered, is under Details. While it runs, and when it failed, the portal's card says it best.
 */

const text = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

/** What a card in voice mode says each tool is doing. */
const DOING: Record<string, string> = {
  kanban_boards: msg("Looking at the boards"),
  kanban_board: msg("Reading a board"),
  kanban_create_board: msg("Making a board"),
  kanban_add_column: msg("Adding a column"),
  kanban_add_card: msg("Adding a card"),
  kanban_update_card: msg("Updating a card"),
  kanban_move_card: msg("Moving a card"),
  kanban_archive_card: msg("Archiving a card"),
};

/** What a card of a kanban call says in voice mode: what it does, and what of. */
export function describe(call: ToolCallView) {
  const details = call.details as CallDetails | undefined;
  const of = details?.card?.title ?? details?.board?.name ?? (text(call.input.title) || text(call.input.name) || text(call.input.board) || text(call.input.card));
  return { label: t(DOING[call.name] ?? msg("Using a board")), detail: of };
}

/** What a call did, in a line. */
function did(details: CallDetails): string {
  const card = details.card?.title ?? "";
  switch (details.did) {
    case "listed":
      return t("Looked at the boards ({n})", { n: details.boards ?? 0 });
    case "read":
      return t("Read the board");
    case "created-board":
      return t("Made the board");
    case "added-column":
      return t("Added the column “{column}”", { column: details.column ?? "" });
    case "added-card":
      return t("Added “{card}” to {column}", { card, column: details.card?.column ?? "" });
    case "updated-card":
      return t("Updated “{card}”", { card });
    case "moved-card":
      return details.from === details.column ? t("Moved “{card}” within {column}", { card, column: details.column ?? "" }) : t("Moved “{card}” from {from} to {to}", { card, from: details.from ?? "", to: details.column ?? "" });
    case "archived-card":
      return t("Archived “{card}”", { card });
  }
}

export function ToolCard({ call, card, panels }: ChatProps & { call: ToolCallView; card: ReactNode }) {
  portal.locale.use();
  const [open, setOpen] = useState(false);
  const details = call.details as CallDetails | undefined;
  if (call.status !== "done" || !details?.did) return <>{card}</>;
  const board = details.board;
  return (
    <div className="kb-call">
      <div className="kb-call-row">
        <span className="kb-call-icon" aria-hidden>
          <LuSquareKanban />
        </span>
        <span className="kb-call-text">{did(details)}</span>
        {board && <span className="kb-call-board">{board.name}</span>}
        {details.card && <code className="kb-call-id">{details.card.id}</code>}
      </div>
      <div className="kb-call-actions">
        <portal.ui.ToolLink icon={LuPanelRight} onClick={() => panels.open("board", board ? { board: board.id } : undefined)}>
          {board ? t("Open the board") : t("Open the boards")}
        </portal.ui.ToolLink>
        <button type="button" className="kb-call-more" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {t("Details")}
          <LuChevronRight aria-hidden />
        </button>
      </div>
      {open && <div className="kb-call-card">{card}</div>}
    </div>
  );
}
