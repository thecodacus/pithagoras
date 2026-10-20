import { LuSquareKanban } from "react-icons/lu";
import type { Portal } from "@pithagoras/extension-api";
import { msg, portal, setPortal, t } from "./portal";
import { BoardPanel } from "./web/BoardPanel";
import { BoardsPage } from "./web/BoardsPage";
import { ToolCard, describe } from "./web/ToolCard";
import { de } from "./de";
import "./client.css";

/**
 * Kanban: boards of cards in columns, for the person and the agents to keep track of work. The Boards page in the
 * sidebar, the same board in a panel beside a chat, and the cards of the agent's kanban tools in the chat, which
 * open that panel on the board a call touched. What it shows, it asks of its server half, which the tools work on too.
 */

const TOOLS = ["kanban_boards", "kanban_board", "kanban_create_board", "kanban_add_column", "kanban_add_card", "kanban_update_card", "kanban_move_card", "kanban_archive_card"];

export default function kanban(given: Portal) {
  setPortal(given);
  portal.locale.add("de", de);

  portal.slots.register("nav.page", { id: "boards", title: msg("Boards"), icon: LuSquareKanban, component: BoardsPage });

  portal.slots.register("chat.panel", {
    id: "board",
    title: msg("Board"),
    icon: LuSquareKanban,
    component: BoardPanel,
    useButton: () => {
      portal.locale.use();
      return { title: t("A kanban board beside the chat: the agent's work as it goes") };
    },
  });

  for (const tool of TOOLS) portal.slots.register("chat.tool", { id: tool, tool, component: ToolCard, describe });
}
