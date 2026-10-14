import { EventEmitter } from 'node:events';
import { nanoid } from 'nanoid';
import { getDb, getSession } from './db.js';

export interface CanvasRow { id: string; session_id: string; title: string; content: string; revision: number; status: string; active_call: string | null; agent_read_revision: number | null; updated_at: string; persisted: boolean; /** A write that was cut off left the document as it was before it, to go back to: see restoreCanvas. */ restorable: boolean }
export const canvasEvents = new EventEmitter();
canvasEvents.setMaxListeners(0);
// Temporary canvases survive tab reconnects, but never a server restart.
const temporary = new Map<string, CanvasRow>();
/** A temporary canvas's text from before the write that is going on, or was cut off. A stored one's is in the table. */
const prior = new Map<string, string>();
/**
 * The revision each active write started from, by call.
 *
 * A write streams in as many saved prefixes, and each one is the same write:
 * counting them made a first draft r601. Every prefix is saved as the revision
 * after this one, so a whole write is one revision however it arrives.
 */
const writeBase = new Map<string, number>();
/**
 * A stored canvas while it is being written: its latest text is held here, and
 * reaches the table at most every FLUSH_MS, and when the write ends. Saving each
 * piece as it streams in rewrote the whole document, hundreds of times a second,
 * and every other chat waited behind it.
 */
const writing = new Map<string, { row: CanvasRow; flushed: number; timer?: NodeJS.Timeout }>();
const FLUSH_MS = 750;
/** What a row is read with: the text from before a write is for restoring, and is not sent along with every row. */
const COLUMNS = 'id, session_id, title, content, revision, status, active_call, agent_read_revision, updated_at, previous_content IS NOT NULL AS restorable';
const stored = (row: CanvasRow): CanvasRow => ({ ...row, persisted: true, restorable: Boolean(row.restorable) });
const save = (next: CanvasRow) => getDb().prepare('UPDATE canvases SET title=?, content=?, revision=?, status=?, active_call=?, agent_read_revision=?, updated_at=? WHERE id=? AND session_id=?').run(next.title,next.content,next.revision,next.status,next.active_call,next.agent_read_revision,next.updated_at,next.id,next.session_id);

function flush(id: string) {
  const held = writing.get(id);
  if (!held) return;
  clearTimeout(held.timer);
  held.timer = undefined;
  held.flushed = Date.now();
  save(held.row);
}
/** The latest text of a stored canvas that is being written: kept, and put in the table once FLUSH_MS has passed since the last time. */
function hold(next: CanvasRow) {
  const held = writing.get(next.id);
  if (!held) return save(next);
  held.row = next;
  const wait = FLUSH_MS - (Date.now() - held.flushed);
  if (wait <= 0) flush(next.id);
  else if (!held.timer) {
    held.timer = setTimeout(() => flush(next.id), wait);
    held.timer.unref();
  }
}
function update(row: CanvasRow, patch: Partial<CanvasRow>): CanvasRow {
  const next = {...row,...patch};
  if (!next.persisted) temporary.set(next.id,next);
  else if (writing.has(next.id)) {
    // Whatever else changes in the middle of a write goes to the table with the text held so far.
    writing.get(next.id)!.row = next;
    flush(next.id);
  } else save(next);
  return next;
}
export function persistCanvas(session:string,id:string): CanvasRow {
  const row=readCanvas(session,id);
  if(row.persisted) return row;
  getDb().prepare('INSERT INTO canvases (id,session_id,title,content,revision,status,active_call,agent_read_revision,updated_at,previous_content) VALUES (?,?,?,?,?,?,?,?,?,?)').run(row.id,row.session_id,row.title,row.content,row.revision,row.status,row.active_call,row.agent_read_revision,row.updated_at,prior.get(id)??null);
  temporary.delete(id);
  prior.delete(id);
  // Stored in the middle of a write: what comes next is held and saved as for any stored canvas.
  if(row.active_call) writing.set(id,{row:{...row,persisted:true},flushed:Date.now()});
  return notify({...row,persisted:true});
}
export function listCanvases(session: string): CanvasRow[] {
  const rows=(getDb().prepare(`SELECT ${COLUMNS} FROM canvases WHERE session_id = ?`).all(session) as CanvasRow[]).map(row=>writing.get(row.id)?.row??stored(row));
  return [...rows,...Array.from(temporary.values()).filter(row=>row.session_id===session)].sort((a,b)=>b.updated_at.localeCompare(a.updated_at));
}
export function readCanvas(session: string, id: string): CanvasRow {
  const draft=temporary.get(id);
  if(draft?.session_id===session) return {...draft};
  const held=writing.get(id);
  if(held?.row.session_id===session) return {...held.row};
  const row=getDb().prepare(`SELECT ${COLUMNS} FROM canvases WHERE session_id = ? AND id = ?`).get(session,id) as CanvasRow | undefined;
  if(!row) throw new Error('Canvas not found in this session');
  return stored(row);
}
export function focusCanvas(session:string,id:string) { const row=readCanvas(session,id);canvasEvents.emit(session,{type:'focus',canvas:row});return row; }
function notify(row: CanvasRow) { canvasEvents.emit(row.session_id, { type: 'update', canvas: row }); return row; }
export function createCanvas(session: string, title: string): CanvasRow {
  if (!getSession(session)) throw new Error('Session not found');
  if (!title.trim() || title.length > 200) throw new Error('Title must contain 1–200 characters');
  const id = nanoid();
  temporary.set(id,{id,session_id:session,title:title.trim(),content:'',revision:0,status:'draft',active_call:null,agent_read_revision:null,updated_at:new Date().toISOString(),persisted:false,restorable:false});
  const row=readCanvas(session,id);canvasEvents.emit(session,{type:'create',canvas:row});return row;
}
/** What an earlier write left to go back to is let go: the person has taken the text over, or has gone back to it. */
function dropPrior(row: CanvasRow) {
  if(!row.restorable) return;
  if(row.persisted) getDb().prepare('UPDATE canvases SET previous_content = NULL WHERE id = ? AND session_id = ?').run(row.id,row.session_id);
  else prior.delete(row.id);
}
export function editCanvas(session: string, id: string, revision: number, title: string, content: string): CanvasRow {
  if (!title.trim() || title.length > 200 || content.length > 1_000_000) throw new Error('Invalid canvas title or content size');
  const row = readCanvas(session,id);
  if (row.active_call || row.revision !== revision) throw new Error('Canvas changed or is being written. Reload before editing.');
  dropPrior(row);
  update(row,{title:title.trim(),content,revision:row.revision+1,status:'edited',updated_at:new Date().toISOString(),restorable:false});
  return notify(readCanvas(session,id));
}
export function deleteCanvas(session: string,id: string,revision: number) {
  const row=readCanvas(session,id);
  if(row.active_call || row.revision!==revision) throw new Error('Canvas changed or is being written. Reload before deleting.');
  if(row.persisted) getDb().prepare('DELETE FROM canvases WHERE id = ? AND session_id = ?').run(id,session);
  else { temporary.delete(id); prior.delete(id); }
  canvasEvents.emit(session,{type:'delete',id});
}
/**
 * A chat is gone: its temporary canvases, and what a write still held for it,
 * go with it. They are in memory, so nothing else would ever let them go.
 */
export function forgetCanvases(session: string) {
  const gone=(row: CanvasRow)=>{ if(row.active_call) writeBase.delete(row.active_call); };
  for(const [id,row] of temporary) if(row.session_id===session) { gone(row); temporary.delete(id); prior.delete(id); }
  for(const [id,held] of writing) if(held.row.session_id===session) { gone(held.row); clearTimeout(held.timer); writing.delete(id); }
}
export function markCanvasRead(session:string,id:string): CanvasRow {
  const row=readCanvas(session,id);
  update(row,{agent_read_revision:row.revision});
  return readCanvas(session,id);
}
export function beginCanvasWrite(session: string,id: string,revision: number,call: string): CanvasRow {
  const row=readCanvas(session,id);
  if(row.agent_read_revision!==row.revision) throw new Error('Read this canvas with canvas_read before editing; it is unread or was edited by the user.');
  // A future revision cannot describe an older document; recover from model guesses.
  // Keep stale revisions and concurrent writes protected below.
  revision=Math.min(revision,row.revision);
  if(row.active_call || row.revision!==revision) throw new Error('Canvas changed or is being written. Use its current revision.');
  // The text from before is kept until the write has ended: a replace that is cut off leaves only what was
  // streamed of it, and the rest of the document would be gone. An empty document has nothing to keep, and
  // one an earlier cut-off write left keeps the text from before that one, until a write goes through.
  const next={...row,active_call:call,status:'writing',restorable:row.restorable||row.content!==''};
  if(row.persisted) {
    getDb().prepare("UPDATE canvases SET active_call=?, status='writing', previous_content=CASE WHEN previous_content IS NOT NULL THEN previous_content WHEN content = '' THEN NULL ELSE content END WHERE id=? AND session_id=?").run(call,id,session);
    writing.set(id,{row:next,flushed:Date.now()});
  } else {
    if(!row.restorable&&row.content) prior.set(id,row.content);
    temporary.set(id,next);
  }
  writeBase.set(call,row.revision);
  return notify(readCanvas(session,id));
}
export function saveCanvasPrefix(session: string,id: string,call: string,content: string): CanvasRow {
  if(content.length>1_000_000) throw new Error('Canvas exceeds one million characters');
  const row=readCanvas(session,id);
  if(row.active_call!==call) throw new Error('Canvas write is no longer active');
  // The pieces of one write are prefixes of one text, so a piece as long as the row is the text it holds. The length
  // goes first: comparing two long strings is a pass over both. Only for the first piece the row still holds the old
  // document, and a new text of the same length is not that text.
  if(row.content.length===content.length&&row.content===content) return row;
  const next={...row,content,revision:(writeBase.get(call)??row.revision)+1,updated_at:new Date().toISOString()};
  if(next.persisted) hold(next); else temporary.set(id,next);
  return notify(next);
}
export function finishCanvasWrite(session: string,id: string,call: string,interrupted: boolean) {
  const row=readCanvas(session,id);
  if(row.active_call!==call) return;
  writeBase.delete(call);
  // A write that went through has no use for the text before it. One that was cut off keeps it, to be restored.
  const keep=interrupted&&row.restorable;
  if(!keep) dropPrior(row);
  const next=update(row,{active_call:null,agent_read_revision:row.revision,status:interrupted?'interrupted':'saved',updated_at:new Date().toISOString(),restorable:keep});
  clearTimeout(writing.get(id)?.timer);
  writing.delete(id);
  return notify(next);
}
/**
 * At start: a write that was going on when the server stopped is over, as one that was cut off is (see finishCanvasWrite).
 * What it had streamed stays, and the text from before it is still there to restore.
 */
export function interruptCanvasWrites() {
  getDb().prepare("UPDATE canvases SET active_call = NULL, status = 'interrupted', agent_read_revision = revision WHERE active_call IS NOT NULL").run();
}
/** The document as it was before the write that was cut off, put back: a revision of its own, as an edit by the person is. */
export function restoreCanvas(session: string,id: string,revision: number): CanvasRow {
  const row=readCanvas(session,id);
  if(row.active_call || row.revision!==revision) throw new Error('Canvas changed or is being written. Reload before restoring.');
  const before=row.persisted?(getDb().prepare('SELECT previous_content FROM canvases WHERE id = ? AND session_id = ?').get(id,session) as {previous_content:string|null}|undefined)?.previous_content:prior.get(id);
  if(before===null||before===undefined) throw new Error('There is no earlier version of this canvas to restore');
  dropPrior(row);
  update(row,{content:before,revision:row.revision+1,status:'edited',updated_at:new Date().toISOString(),restorable:false});
  return notify(readCanvas(session,id));
}
