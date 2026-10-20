import { useEffect, useRef, useState } from "react";
import type { PanelProps } from "@pithagoras/extension-api";
import { lastBoard, portal } from "../portal";
import type { CallDetails } from "../server/tools";
import { api } from "./api";
import { BoardView } from "./Board";

/**
 * A board beside a chat. It opens on the board it was asked to show (`panels.open("board", { board })`, from a call's
 * card), else on the board this chat's agent last worked on with a kanban tool, as the server half remembers it, else
 * on the one last opened on the Boards page, else on the first.
 *
 * Each kanban call of the chat that ends has the board asked for at once, so that the person sees the agent's work as
 * it goes; and, until the person chooses a board here, the panel follows the agent to the board it works on. While a
 * dialog is open or a card is held, it waits until that is done: neither is lost to another board.
 */

/** Which board the panel shows, kept while it is open; `chosen` once the person chose it here, or a card asked for it. */
type Shown = { board?: string | null; chosen?: boolean };

/** The last kanban call of the chat that ended, and the board it was on. */
const lastCall = (items: readonly { kind: string; [key: string]: unknown }[]) => {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i] as { kind: string; name?: unknown; status?: unknown; callId?: unknown; details?: CallDetails };
    if (item.kind === "tool" && typeof item.name === "string" && item.name.startsWith("kanban_") && item.status === "done") return { id: String(item.callId ?? i), board: item.details?.board?.id ?? null };
  }
  return null;
};

export function BoardPanel({ chat, panel }: PanelProps) {
  const shown = (panel.state ?? {}) as Shown;
  const set = (next: Shown) => panel.setState({ ...shown, ...next });
  const params = panel.params as { board?: unknown } | undefined;
  const [touched, setTouched] = useState<string | null | undefined>(undefined);
  const call = portal.chats.use(chat.id, (feed) => lastCall(feed.items), (a, b) => a?.id === b?.id && a?.board === b?.board);
  /** The call the panel last went after, or the one there was as it opened. */
  const followed = useRef(call?.id);
  const [busy, setBusy] = useState(false);

  // A card asked for a board: each open is a new ask.
  useEffect(() => {
    if (params && typeof params.board === "string") set({ board: params.board, chosen: true });
  }, [params]);

  useEffect(() => {
    let live = true;
    api.touched(chat.id).then(
      (r) => live && setTouched(r.board),
      () => live && setTouched(null),
    );
    return () => {
      live = false;
    };
  }, [chat.id]);

  // The agent worked on a board: shown, unless the person chose one here; once the dialog or the drag is done.
  useEffect(() => {
    if (!call || call.id === followed.current || busy) return;
    followed.current = call.id;
    if (!shown.chosen && call.board && call.board !== shown.board) set({ board: call.board });
  }, [call?.id, busy]);

  const asked = typeof params?.board === "string" ? params.board : undefined;
  const board = shown.board !== undefined ? shown.board : (asked ?? touched);

  return (
    <div className="kb-panel">
      {/* Until the server half has said which board this chat's agent worked on, none is shown: not another for a moment. */}
      {board === undefined ? (
        <portal.ui.RowsSkeleton rows={3} />
      ) : (
        <BoardView
          board={board}
          fallback={lastBoard.get()}
          layout="panel"
          nudge={call?.id}
          onPick={(id, replace) => set({ board: id, chosen: shown.chosen || !replace })}
          onBusy={(now) => {
            setBusy(now);
            panel.keep(now);
          }}
        />
      )}
    </div>
  );
}
