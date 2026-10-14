import type { PortalEvent } from "./api";

/** What an extension puts in the chat box: the whole of it, or a paste into it. */
export type Fill = { text: string; paste: boolean };

const boxes = new Map<string, (fill: Fill) => void>();

/**
 * The chat box of a chat, told of each fill as it arrives. They are live-only
 * and come once, as dialogs do: read back out of the events instead, each had
 * to be told apart from the ones already applied, on every streamed word.
 */
export function onFill(sessionId: string, fill: (fill: Fill) => void): () => void {
  boxes.set(sessionId, fill);
  return () => {
    if (boxes.get(sessionId) === fill) boxes.delete(sessionId);
  };
}

/** An event for a chat, as it arrives: a fill goes to its box. pi's RPC mode, outside the host, names it set_editor_text. */
export function fillFrom(sessionId: string, ev: PortalEvent): void {
  if (ev.type !== "extension_ui_request") return;
  const method = ev.payload?.method;
  if (method !== "setEditorText" && method !== "set_editor_text") return;
  boxes.get(sessionId)?.({ text: String(ev.payload.text ?? ""), paste: ev.payload.paste === true });
}
