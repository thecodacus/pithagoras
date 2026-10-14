/**
 * The two kinds of UI request an extension sends.
 *
 * pi has the one event for both. A dialog stops the extension until somebody
 * answers; everything else (a status line, a widget, a title, a notice) is
 * news that nobody waits on, and an extension sends it on its own clock: one
 * refreshes its status every second whether or not anything is going on.
 */
const DIALOGS = new Set(["select", "confirm", "input", "editor", "questions"]);

/** Whether this UI request waits for an answer. What is not known is one-way. */
export function isDialog(method: unknown): boolean {
  return typeof method === "string" && DIALOGS.has(method);
}

/**
 * Whether a conversation has somebody to answer a dialog: a chat of theirs in the portal's pages and a
 * conversation they started on the Agent page, where the dialog is drawn. A routine or a heartbeat run
 * and a chat reached through a channel (`viaChannel`: see onChannel, for the portal's own pages are no
 * channel) have nobody, so a dialog there is answered at once with its no-answer value and shown nowhere.
 */
export function showsDialogs(session: { kind: string }, viaChannel: boolean): boolean {
  return session.kind === "task" || (session.kind === "agent" && !viaChannel);
}
