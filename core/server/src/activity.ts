import { nanoid } from "nanoid";
import { getDb } from "./db.js";

/**
 * What an agent noticed on its own: the notes its heartbeat leaves for the
 * person it works for. Newest first, kept until somebody deletes them.
 */

export interface Note {
  id: string;
  agent_id: string;
  session_id: string | null;
  title: string;
  detail: string;
  at: string;
  read_at: string | null;
}

/** Long enough for a paragraph and a list of what was looked at; a report belongs in a chat. */
export const MAX_TITLE = 200;
export const MAX_DETAIL = 4000;

export function addNote(agentId: string, sessionId: string | null, title: string, detail: string): Note {
  const id = nanoid(12);
  getDb()
    .prepare("INSERT INTO activity (id, agent_id, session_id, title, detail) VALUES (?, ?, ?, ?, ?)")
    .run(id, agentId, sessionId, title.slice(0, MAX_TITLE), detail.slice(0, MAX_DETAIL));
  return getDb().prepare("SELECT * FROM activity WHERE id = ?").get(id) as Note;
}

export function listNotes(agentId: string, limit = 100): Note[] {
  return getDb()
    .prepare("SELECT * FROM activity WHERE agent_id = ? ORDER BY at DESC, rowid DESC LIMIT ?")
    .all(agentId, limit) as Note[];
}

export function unreadNotes(agentId: string): number {
  return (getDb().prepare("SELECT count(*) AS n FROM activity WHERE agent_id = ? AND read_at IS NULL").get(agentId) as { n: number }).n;
}

/** How many notes an agent has left so far: a look is told apart from the next by the difference. */
export function countNotes(agentId: string): number {
  return (getDb().prepare("SELECT count(*) AS n FROM activity WHERE agent_id = ?").get(agentId) as { n: number }).n;
}

export function markNotesRead(agentId: string): void {
  getDb().prepare("UPDATE activity SET read_at = datetime('now') WHERE agent_id = ? AND read_at IS NULL").run(agentId);
}

/** False when there was no such note of this agent's. */
export function markNoteRead(agentId: string, id: string): boolean {
  const note = getDb().prepare("SELECT 1 FROM activity WHERE agent_id = ? AND id = ?").get(agentId, id);
  getDb().prepare("UPDATE activity SET read_at = datetime('now') WHERE agent_id = ? AND id = ? AND read_at IS NULL").run(agentId, id);
  return Boolean(note);
}

/** False when there was no such note of this agent's. */
export function deleteNote(agentId: string, id: string): boolean {
  return getDb().prepare("DELETE FROM activity WHERE agent_id = ? AND id = ?").run(agentId, id).changes > 0;
}

export function deleteNotesOf(agentId: string): void {
  getDb().prepare("DELETE FROM activity WHERE agent_id = ?").run(agentId);
}
