import { useSyncExternalStore } from "react";
import { api, type McpMigrationView } from "./api";

/**
 * What the move to pi's own MCP support did (core/server/src/mcp-migration-run.ts), kept once for both places that show it:
 * the line at the top of the page that says it until it is read, and the report under Settings → MCP, which stays. Asked
 * for once, when the first of them is drawn: it changes only when the portal is upgraded, and when the person reads it.
 */

let snap: McpMigrationView | null = null;
let asked = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

function ask(): void {
  if (asked) return;
  asked = true;
  api.mcpMigration().then(
    (view) => {
      snap = view;
      emit();
    },
    // A portal that cannot say has no report to show; asked again when the page is loaded again.
    () => void (asked = false),
  );
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  ask();
  return () => void listeners.delete(listener);
}

/** The report the server has, or null while it has none (and while it is being asked). */
export function useMcpMigration(): { view: McpMigrationView | null; dismiss: () => Promise<void> } {
  const view = useSyncExternalStore(subscribe, () => snap);
  return {
    view,
    dismiss: async () => {
      await api.dismissMcpMigration();
      if (snap) snap = { ...snap, notice: false };
      emit();
    },
  };
}
