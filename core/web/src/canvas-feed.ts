/**
 * A chat's canvases as they change, passed from the chat's event stream to
 * the canvas panel.
 *
 * They had a stream of their own, and two per open chat is how three tabs used
 * up the six connections a browser allows one address: a fourth chat, and
 * every request its page made, waited for one of them to close. Now the
 * stream the app opens for the chat in the address carries them as well.
 */
export type CanvasMessage = { type: string; [key: string]: unknown };

/**
 * Whether the chat's stream is carrying them: "connecting", and the list
 * comes first once it is up; "up"; or "down", when the panel has to ask for
 * the list itself.
 */
export type FeedState = "connecting" | "up" | "down";

type Watcher = { message: (m: CanvasMessage) => void; state: (s: FeedState) => void };
type Row = { id: string; [key: string]: unknown };

const watchers = new Map<string, Set<Watcher>>();
const states = new Map<string, FeedState>();
/**
 * The list as the stream last left it, so a panel drawn after the stream sent
 * it has it too, rather than asking for the same list again.
 */
const latest = new Map<string, Row[]>();

function remember(sessionId: string, m: CanvasMessage) {
  const rows = latest.get(sessionId);
  if (m.type === "snapshot") latest.set(sessionId, (m.canvases as Row[]) ?? []);
  else if (!rows) return;
  else if (m.type === "delete") latest.set(sessionId, rows.filter((r) => r.id !== m.id));
  else if (m.canvas) latest.set(sessionId, [m.canvas as Row, ...rows.filter((r) => r.id !== (m.canvas as Row).id)]);
}

/** Hear a chat's canvases change, and whether the stream carries them. What is known already comes at once. */
export function watchCanvases(sessionId: string, watcher: Watcher): () => void {
  let set = watchers.get(sessionId);
  if (!set) watchers.set(sessionId, (set = new Set()));
  set.add(watcher);
  watcher.state(states.get(sessionId) ?? "down");
  const known = latest.get(sessionId);
  if (known) watcher.message({ type: "snapshot", canvases: known });
  return () => {
    set.delete(watcher);
    if (!set.size) watchers.delete(sessionId);
  };
}

/** A change to one of a chat's canvases, or on connecting all of them. */
export function canvasMessage(sessionId: string, message: CanvasMessage): void {
  remember(sessionId, message);
  for (const w of watchers.get(sessionId) ?? []) w.message(message);
}

/** Whether the chat's stream is up; see FeedState. */
export function canvasConnection(sessionId: string, state: FeedState): void {
  if (state === "down") {
    states.delete(sessionId);
    // What it left may since have changed, unheard.
    latest.delete(sessionId);
  } else states.set(sessionId, state);
  for (const w of watchers.get(sessionId) ?? []) w.state(state);
}
