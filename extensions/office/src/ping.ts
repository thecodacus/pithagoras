/**
 * Wake on comment mention (plan 5.4). Server-side only.
 *
 * On every docx persist (callback status 2/6 fires the `onPersisted` hooks), the saved buffer is
 * re-parsed (`parseDocx`) and its word/comments.xml comments are diffed against the last-seen set
 * kept in `<root>/state/<docId>.json`. Each NEW comment is scanned for mentions (grammar below);
 * per resolved mention, per target chat: a grant on this one doc (deduped by comment id), an audit
 * line, a queued wake text (`officeWakeMessage`), and `chats.tell(chatId, {type:"ping"})` so the
 * target's pi extension drains the queue off its UI_RECEIVE bell (drain side = T-TOOLS' factory,
 * plan 5.4 step 4; this module only QUEUES). The seen set is written back AFTER processing.
 *
 * First-save decision (plan leaves it open): a persist with NO prior state file records the whole
 * comment set as baseline WITHOUT resolving mentions -- a freshly created document's comments carry
 * no user intent to wake anyone, and pinging them would ring a bell on the doc's own creator.
 * Corrupt/undecodable state file: logged, previous set treated as EMPTY (every current comment is
 * then "new", its mentions processed once; the immediately-following write restores a sane file).
 * Erring toward notifying beats silently dropping a mention after a corruption event. A re-send of
 * an already-seen comment adds nothing (pure id diff), so normal re-saves never double-ping or
 * double-grant.
 *
 * v1 wakes docx ONLY: xlsx comments live in xl/commentsN.xml + VML anchors (plan 5.4 wording
 * correction -- "xlsx has no comments" was false), deferred to M4, so the hook is a no-op for
 * non-docx docs. onPersisted hands over (docId, buffer) only, so this module resolves the meta
 * itself via store.getDoc(docId, root) and checks meta.ext.
 */
import fs from "node:fs";
import path from "node:path";
import { portal } from "./host";
import { getDoc } from "./store";
import { parseDocx, diffComments, type Comment } from "./ooxml";
import { onPersisted } from "./callback";

/** A line the audit seam records per resolved mention (subject = doc title; reason carries what happened; chatId = woken home). T-WIRE may swap in a real audit sink later. */
export type PingAuditEntry = { subject: string; reason: string; chatId: string };

/** Injection seams for wirePing. Every function form is LAZY by design: the defaults read portal() only when actually used, and tests pass plain fns so they never reach the real portal. `root` overrides dataDir() for the store/state layout. */
export type PingDeps = {
  root?: string;
  folders?: () => { path: string; name: string; kind: "agent" | "project" | "chat"; home?: boolean }[];
  inFolder?: (folderPath: string) => { id: string; title?: string }[];
  tell?: (chatId: string, data: unknown) => Promise<boolean> | boolean;
  record?: (entry: PingAuditEntry) => void;
  log?: (line: string) => void;
};

/** One queued wake entry, docs' `wakes` pattern: text is what pi is handed, details ride along for the drain side. */
export type WakeEntry = { text: string; details: { docId: string; commentId: string } };

let cfg: PingDeps = {};
let hookRegistered = false;
/** chatId -> wake entries queued server-side (docs' `wakes` pattern). Drained by the office pi extension on UI_RECEIVE. */
const wakes = new Map<string, WakeEntry[]>();

function root(): string {
  return cfg.root ?? portal().dataDir();
}
function folders(): { path: string; name: string; kind: "agent" | "project" | "chat"; home?: boolean }[] {
  return (cfg.folders ?? (() => portal().folders.list()))();
}
function inFolder(p: string): { id: string; title?: string }[] {
  return (cfg.inFolder ?? ((fp) => portal().chats.inFolder(fp)))(p);
}
function logLine(line: string): void {
  (cfg.log ?? ((l) => portal().log(l)))(line);
}
function record(entry: PingAuditEntry): void {
  // Lazy default is a one-line log (T-WIRE may pass a real audit sink later via wirePing({record})).
  (cfg.record ?? ((e: PingAuditEntry) => logLine(`office ping: ${e.subject}: ${e.reason} (woken ${e.chatId})`)))(entry);
}

/** server.ts calls ONCE at boot. Later calls (unit tests) only update the seams -- the onPersisted hook is registered exactly once per process. */
export function wirePing(opts?: PingDeps): void {
  if (opts) cfg = { ...cfg, ...opts };
  if (!hookRegistered) {
    hookRegistered = true;
    onPersisted(handlePersisted);
  }
}

/** Test seam: drop the module-level seams, hook flag and queued wakes. */
export function __resetPingForTests(): void {
  cfg = {};
  hookRegistered = false;
  wakes.clear();
}

/** Remove and return what is queued for a chat (the office pi extension calls this on its UI_RECEIVE bell, docs' hearPings pattern). */
export function drainWakeQueue(chatId: string): WakeEntry[] {
  const entries = wakes.get(chatId);
  if (!entries) return [];
  wakes.delete(chatId);
  return entries;
}

/** The exact plan-5.4 wake text shape, following docs' wakeMessage(): doc title, quoted comment (every line prefixed "> "), and the standing-grant sentence with the office_* pointer. The doc id is NOT embedded in the text: it rides in WakeEntry.details ({docId, commentId}) per plan 5.4 step 2, which the drain side hands to pi's sendMessage. `author` is included because an office mention is one specific person's ask (docs' template omits it; the office one does not). */
export function officeWakeMessage(docTitle: string, author: string, commentText: string): string {
  return [
    `${author} asked you in a comment on the office document "${docTitle}":`,
    ...commentText.split("\n").map((line) => `> ${line}`),
    "You have edit access to this document for this task; answer with the office_* tools.",
  ].join("\n");
}

/** The mention grammar (plan 5.4, user decision):
 *  - literal "@agent" token -> the doc's OWNER home chat (meta.owner); ownerless docs: logged + skipped.
 *  - "@project:<name>" and any other bare "@<name>" -> case-insensitive EXACT display-name match among folders of kind "project"|"agent". The contract supersedes the plan's narrower split ("@project:" -> projects, bare -> agents): both forms search both kinds; names are non-whitespace runs, so folder names containing spaces cannot be mentioned in v1 (documented limitation).
 *  Unresolvable names and DUPLICATE names (two folders sharing a display name, e.g. agent "Twin" and project "Twin") get no wake and a log line -- no silent disambiguation (plan risk item). */
const MENTION_RE = /(?<![\w.])(?:@(project:(\S+)|agent(?![\w-])|([A-Za-z0-9_][\w-]*)))/g;

type Mention = { owner: boolean; name: string | null };

function parseMentions(text: string): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    if (m[1] === "agent") out.push({ owner: true, name: null });
    else if (m[2] !== undefined) out.push({ owner: false, name: m[2].replace(/[.,;:!?)\]}"']+$/, "") }); // trailing sentence punctuation is not part of the folder name
    else out.push({ owner: false, name: m[3] });
  }
  return out;
}

function statePath(rootDir: string, docId: string): string {
  return path.join(rootDir, "state", `${docId}.json`);
}

/** Last-seen comment ids. Missing file -> null (first save). Undecodable or bad shape -> empty set with a log line (module header). */
function readSeen(rootDir: string, docId: string): { ids: Set<string>; first: boolean } | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(statePath(rootDir, docId), "utf8"));
    if (typeof raw !== "object" || raw === null || !Array.isArray((raw as Record<string, unknown>).ids)) throw new Error("bad shape");
    return { ids: new Set((raw as { ids: unknown[] }).ids.filter((x) => typeof x === "string")), first: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    logLine(`office ping: state file ${statePath(rootDir, docId)} is corrupt -- treating the last-seen set as empty`);
    return { ids: new Set(), first: false };
  }
}

function writeSeen(rootDir: string, docId: string, ids: Iterable<string>): void {
  const p = statePath(rootDir, docId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = path.join(path.dirname(p), `.${path.basename(p)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ ids: [...new Set(ids)] }, null, 2));
  fs.renameSync(tmp, p);
}

/**
 * Minimal internal index writer -- store.ts exposes no grant mutation (checked its exports), and plan
 * 5.4 requires the grant persisted BEFORE the bell rings (the woken pi's office_* tools read docsForHome,
 * which reads index.json, and no other task has a seam to add it). Mirrors store.writeIndex: fresh read,
 * mutate one doc, atomic temp+rename. Dedupe is by (chatId, commentId): a re-sent comment never adds a
 * second row. If grant mutations are centralized in store.ts later, this helper goes away.
 */
function addGrant(rootDir: string, docId: string, chatId: string, commentId: string, at: number): boolean {
  const p = path.join(rootDir, "index.json");
  const raw = JSON.parse(fs.readFileSync(p, "utf8")) as { docs?: { docId?: string; grants?: { chatId: string; commentId: string; at: number }[] }[] };
  const doc = (raw.docs ?? []).find((d) => d.docId === docId);
  if (!doc) {
    logLine(`office ping: document ${docId} vanished from index between resolve and grant -- skipped`);
    return false;
  }
  const grants = (doc.grants ??= []);
  if (grants.some((g) => g.chatId === chatId && g.commentId === commentId)) return false; // dedupe before adding
  grants.push({ chatId, commentId, at });
  const tmp = path.join(path.dirname(p), `.${path.basename(p)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
  fs.renameSync(tmp, p);
  return true;
}

/** Resolve one mention to a home chat id, or null (reason logged). */
function resolveMention(mention: Mention, metaOwner: string | null): string | null {
  if (mention.owner) {
    if (!metaOwner) {
      logLine("office ping: @agent in a comment on an ownerless document -- no wake");
      return null;
    }
    return metaOwner; // plan 2.1: meta.owner IS the creating agent/project's home chat id
  }
  const name = mention.name;
  if (!name) return null;
  const matches = folders().filter((f) => (f.kind === "project" || f.kind === "agent") && f.name.toLowerCase() === name!.toLowerCase());
  if (matches.length === 0) {
    logLine(`office ping: @${name} in a comment matches no agent or project -- no wake`);
    return null;
  }
  if (matches.length > 1) {
    logLine(`office ping: @${name} is ambiguous (${matches.map((f) => `${f.kind}:${f.name}`).join(", ")}) -- no silent disambiguation, no wake`);
    return null;
  }
  // Home chat per plan 2.1 (and the tools contract's own resolution): a folder's workspace path is exactly what
  // chats.folder(id) resolves to, so the sessions working in that folder (chats.inFolder) are its home chats.
  // Deterministic pick: lowest id (the extension queues wakes per chat; any session of the home answers).
  const chats = inFolder(matches[0]!.path).sort((a, b) => a.id.localeCompare(b.id));
  if (chats.length === 0) {
    logLine(`office ping: folder "${matches[0]!.name}" has no sessions to wake -- no wake`);
    return null;
  }
  return chats[0]!.id;
}

function processComment(docId: string, title: string, owner: string | null, c: Comment): void {
  const mentions = parseMentions(c.text);
  if (mentions.length === 0) return;
  const at = Date.now();
  // Dedupe per comment AND per pass: one audit/grant/queue/tell per target chat, however often it is mentioned.
  for (const chatId of new Set(mentions.map((m) => resolveMention(m, owner)).filter((x): x is string => x !== null))) {
    addGrant(root(), docId, chatId, c.id, at);
    record({ subject: title, reason: `comment mention ${c.id} by ${c.author}: access to this document granted and home woken`, chatId });
    const queue = wakes.get(chatId) ?? [];
    if (!queue.some((e) => e.details.docId === docId && e.details.commentId === c.id)) {
      queue.push({ text: officeWakeMessage(title, c.author, c.text), details: { docId, commentId: c.id } });
      wakes.set(chatId, queue);
    }
    const told = (cfg.tell ?? ((id: string, data: unknown) => portal().chats.tell(id, data)))(chatId, { type: "ping" });
    if (told && typeof (told as Promise<boolean>).catch === "function") {
      (told as Promise<boolean>).catch((e: unknown) => logLine(`office ping: tell ${chatId} failed: ${(e as Error)?.message ?? e}`));
    }
  }
}

/** The registered onPersisted handler. Exported so unit tests call it directly without the real callback machinery. */
export function handlePersisted(docId: string, buffer: Buffer): void {
  try {
    const rootDir = cfg.root ?? portal().dataDir();
    const meta = getDoc(docId, rootDir);
    if (!meta) return; // deleted between fetch and persist -- nothing to diff
    if (meta.ext !== "docx") return; // v1: docx only, xlsx comments deferred to M4
    const { comments } = parseDocx(buffer);
    const prev = readSeen(rootDir, docId);
    if (prev === null) { // first save: baseline recorded, no wakes (module header)
      writeSeen(rootDir, docId, comments.map((c) => c.id));
      return;
    }
    // Write the seen set AFTER processing and only with ids handled successfully: a comment whose wake failed
    // stays unseen and is re-reported by diffComments on the next persist (retry), while one later failure must
    // not leave earlier comments permanently unseen either.
    const added = diffComments([...prev.ids].map((id): Comment => ({ id, author: "", text: "" })), comments).added;
    const seen = new Set(prev.ids);
    for (const c of added) {
      try {
        processComment(docId, meta.title, meta.owner, c);
        seen.add(c.id);
      } catch (err) {
        logLine("office ping: comment " + c.id + " of " + docId + " could not be processed and stays unseen for retry: " + ((err as Error)?.message ?? err));
      }
    }
    writeSeen(rootDir, docId, [...seen]);
  } catch (err) {
    logLine(`office ping: persist of ${docId} failed: ${(err as Error)?.message ?? err}`);
  }
}
