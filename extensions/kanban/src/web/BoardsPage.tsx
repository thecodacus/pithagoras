import { useEffect } from "react";
import { boardsPage, lastBoard, portal } from "../portal";
import { BoardView } from "./Board";

/**
 * The Boards page, at /x/pithagoras-kanban/boards: the board it shows is in its address (`?board=b-…`), so that a link
 * keeps it and Back goes through the boards looked at. Without one, it shows the board last opened here, or the first.
 */
export function BoardsPage() {
  const { search } = portal.useLocation();
  const board = new URLSearchParams(search).get("board");
  useEffect(() => {
    if (board) lastBoard.set(board);
  }, [board]);
  return (
    <div className="kb-page">
      <BoardView board={board} fallback={lastBoard.get()} layout="page" onPick={(id, replace) => portal.navigate(boardsPage(id ?? undefined), { replace })} />
    </div>
  );
}
