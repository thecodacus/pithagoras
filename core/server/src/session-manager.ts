import { createHash } from "node:crypto";
import { LiveEvents } from "./live-events.js";
import type { Timings } from "./llama-progress.js";
import { toolCallEnded, toolCallsCutOff, toolCallStarted } from "./tool-debug.js";
import { ModelErrors, plainFailure } from "./model-errors.js";
import { EventEmitter } from "node:events";
import { hasPrimary, lower, type PersonRow, type Role } from "./people.js";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { agentHome } from "./agent-home.js";
import { agentAt } from "./agents.js";
import { HEARTBEAT_ROLE } from "./pi/heartbeat-names.js";
import path from "node:path";
import type { Draft, LoadError, PiClient, PiTool, PromptTaken } from "./pi/types.js";
import { effectiveOff, exceptionsFor, heldOffUnshown, toolEnabled, toolSource } from "./tool-policy.js";
import { scriptedMark } from "./tool-layers.js";
import { unlisted } from "./mcp-offer.js";
import { projectOf } from "./workspaces.js";
import { findServerBuiltin, picturesRefused, runBuiltin } from "./pi/builtins.js";
import { dropMessage, SessionEditError, userTexts, type Scope } from "./pi/session-edit.js";
import { AUDIO_MESSAGE_PREFIX } from "./pi/voice-first.js";
import { isDialog, showsDialogs } from "./pi/ui-requests.js";
import { ASK_QUESTION_TOOL, asksQuestions, describeAnswers, readAnswers, type Answers, type Question } from "./pi/ask-question.js";
import { CODEMODE_TOOL } from "./pi/codemode.js";
import { CHAT_QUESTION, CHAT_QUESTION_END, holdAnswers, openChatQuestion, openChatQuestions, takeHeldAnswers, type ChatQuestion, type QuestionOutcome } from "./questions.js";
import { forgetTaint } from "./pi/guard.js";
import { neutralise } from "./channels/framing.js";
import { textOf } from "./pi/entries.js";
import { removeSessionFiles } from "./session-files.js";
import { dropImages, forLog, forPi, loadImages, removeImages, storedIn, type Attached } from "./prompt-images.js";
import { BACKGROUND_SUPPORTED, listJobs, startedWhen, type BackgroundJob } from "./background.js";
import { forgetSession as forgetLlamaProxy } from "./llama-progress.js";
import { chatEvent, chatLife, extensionHolds, serversSettled, setChatBridge } from "./extension-host.js";
import { forTranscript } from "./stored-event.js";
import { buildExecutor, type Executor } from "./executors/index.js";
import { EXECUTOR_KIND } from "./executor-kind.js";
import { describeToolCall } from "./tool-summary.js";
import { withFiles } from "./output-files.js";
import { shownFiles, type ShownFile } from "./file-outputs.js";
import { baseDir, readPicture } from "./workspace-files.js";
import { readVideo } from "./video-files.js";
import {
  appendEvent,
  deleteEvent,
  deleteEventsAfter,
  deleteEventsBetween,
  dropVersion,
  dropVersionsAt,
  atomically,
  deleteEventSeqs,
  saveVersion,
  takeVersion,
  findVersion,
  bumpReloads,
  type MessageVersion,
  versionSeqs,
  getSession,
  latestSeq,
  restoreEvents,
  notePromptQueued,
  sentMessage,
  sentMessages,
  hasAnswer,
  chatSaid,
  modeOf,
  modeHoldsCodemode,
  parseToolsOff,
  unsettledMessages,
  unansweredCommands,
  chatModel,
  keepChatModel,
  getSettings,
  markOrphanedSessionsInterrupted,
  openDetachedSubagents,
  openSubagentsIn,
  sessionTools,
  setSessionTools,
  toolDefaultsForSession,
  agentHomes,
  agentIdOf,
  type AgentHome,
  routineOf,
  remembered,
  rememberTools,
  knownTools,
  recordAudit,
  shownTools,
  mcpCatalogueFor,
  mcpView,
  withdrawnMcpTools,
  type McpView,
  browserAllowlist,
  routineExemptions,
  updateSession,
  type EventRow,
  type SessionRow,
  anySessionRunning,
  onChannel,
  dialogHost,
  lazyMarks,
  lazyToolNames,
  lazySetLabels,
  childSessions,
  deleteSession,
} from "./db.js";
import { newChildChat, type ChildRun } from "./child-chats.js";

/**
 * Thinking markers that escape into the answer.
 *
 * A reasoning model sometimes closes a thought inside the text it means to say,
 * and a stray </think> then travels to whoever is reading — a chat window, a
 * Telegram message. Stripped where the text leaves the portal rather than in
 * the stored events, so the record of what the model actually produced stays
 * intact.
 */
export const stripThinkingMarkers = (text: string): string =>
  text.replace(/<\/?think(ing)?>/gi, "").trim();

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * What of pi's file a version keeps: what follows the start it shares with
 * the file put in its place — the conversation cut back, or the version
 * switched to — and a hash of that start to check it by. That start is what
 * the chat goes on from while this version is away; pi adds to the end of
 * it. Not what the cut alone would leave: pi writes its settings into a
 * conversation it opens again, before what it is sent, and those belong to
 * this version, not the one it goes back onto. Every version keeping the
 * whole file was megabytes per retry on a long chat, and could not tell
 * whether what it went back onto was still there.
 */
export function keptFile(original: string | undefined, cut: string | undefined): Pick<MessageVersion, "file" | "filePrefix" | "prefixHash"> {
  if (original === undefined) return { file: null, filePrefix: null, prefixHash: null };
  let at = 0;
  const most = Math.min(original.length, cut?.length ?? 0);
  while (at < most && original.charCodeAt(at) === cut!.charCodeAt(at)) at++;
  // Not between the halves of a character outside the basic plane — an emoji
  // edited to another — which stored alone would come back as U+FFFD.
  if (at > 0 && original.charCodeAt(at - 1) >= 0xd800 && original.charCodeAt(at - 1) <= 0xdbff) at--;
  return { file: original.slice(at), filePrefix: at, prefixHash: sha(original.slice(0, at)) };
}

/**
 * pi's file as a version had it, made from the file there is now: its start,
 * if it is the one the version went on from, and the rest the version kept.
 * Undefined where there was no file then and is none now. Refused where the
 * start is not the same — the file replaced, or never there when the version
 * was kept — rather than showing one conversation while the agent has another.
 */
function fileFor(v: MessageVersion, now: string | undefined): string | undefined {
  const gone = () =>
    new SessionEditError("unsupported", "The agent's record of this chat has changed since that version was kept, so it cannot be brought back.");
  if (v.filePrefix === null) {
    if (now !== undefined) throw gone();
    return undefined;
  }
  if (now === undefined || now.length < v.filePrefix || sha(now.slice(0, v.filePrefix)) !== v.prefixHash) throw gone();
  return now.slice(0, v.filePrefix) + (v.file ?? "");
}

/** Writes pi's file beside it, then renames it over, so a crash mid-write leaves the old one rather than half of each. */
function rewrite(file: string, text: string): void {
  const tmp = `${file}.edit`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

const SESSION_ROOT = path.resolve(process.env.SESSION_DIR || "./data/sessions");
/** Where a container's pi finds a session's folder: see ContainerExecutor. */
const CONTAINER_SESSION_DIR = "/sessions/";
/** What can go with a message besides its text. */
export interface PromptOptions {
  voice?: boolean;
  /** Pictures, already checked and kept: see prompt-images.ts. */
  images?: Attached[];
  /** Mid-run, go into the run that is going instead of waiting for it to end. */
  steer?: boolean;
  /**
   * Told the seq of the transcript line that records the message, and whether it waits for a run that is going,
   * as soon as it is recorded: a caller that waits for what happens to this message (runChild) cannot tell it from
   * another with the same words by reading the transcript. Not told for a command, which has no such line.
   */
  onRecorded?: (seq: number, queued: boolean) => void;
}

/** A message sent into a run, until pi takes it in: see SessionManager.waiting. */
interface Waiting {
  seq: number;
  message: string;
  /** How many pictures went with it, to tell apart messages with the same words. */
  images: number;
  /** Being handed to pi right now; settles once pi has queued it or refused it. */
  handing?: Promise<void>;
  /** In pi's queue, so pi's settling of the run means it was taken in. */
  inPi?: boolean;
  /**
   * Where pi queued it and the words it queued, when the client can say: what
   * the agent is handed, a template expanded and an input handler's rewrite
   * applied. See takeIn.
   */
  queuedAs?: Queued;
  /**
   * What its portal_prompt said, carried by the event that places it: a page
   * that loads only the end of a long chat may not have the prompt itself.
   */
  prompt: Record<string, unknown>;
}

/** A message in pi's queue: see PromptTaken. */
type Queued = Omit<Extract<PromptTaken, { outcome: "queued" }>, "outcome">;

/** pi's queue, lane by lane, as its last queue_update had it. */
type PiQueue = Record<Queued["lane"], string[]>;

/** Its words as pi has them, without the note a spoken turn carries. */
const unspoken = (text: string) => (text.startsWith(AUDIO_MESSAGE_PREFIX) ? text.slice(AUDIO_MESSAGE_PREFIX.length) : text);

/** What a page drops when a message is taken out: see deleteEventsBetween. */
type Removed = { from: number; to: number | null; also?: number[]; kept?: number[] };

/** Pictures sent with messages, a folder per chat: see prompt-images.ts. */
const IMAGE_ROOT = path.resolve(process.env.DATA_DIR || "./data", "images");

/**
 * An extension's failure, said with its package's name rather than a path:
 * pi names the file, or "command:<name>" for a command that threw.
 */
export function extensionFailure(where: unknown, error: unknown): string {
  const path = String(where ?? "");
  const command = /^command:(.+)$/.exec(path)?.[1];
  // An inline extension, the portal's own or what a server half adds to a chat's pi, is named by pi as <inline:name>.
  const who = command ? `/${command}` : (/node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(path)?.[1] ?? /^<inline:(.+)>$/.exec(path)?.[1] ?? extensionName(path) ?? "An extension");
  return `${who} failed: ${String(error ?? "no reason given").trim()}`;
}

/**
 * An extension outside a package, by its file: "my-ext" for extensions/my-ext.ts,
 * and the folder's name for one whose file is only its entry point, such as
 * extensions/my-ext/index.ts or my-ext/dist/index.js.
 */
function extensionName(path: string): string | undefined {
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (!/\.[cm]?[jt]s$/.test(parts.at(-1) ?? "")) return undefined;
  let name = parts.pop()!.replace(/\.[cm]?[jt]s$/, "");
  while (/^(index|main|extension|dist|src|lib|build)$/.test(name) && parts.length) name = parts.pop()!;
  return name || undefined;
}

/**
 * The name a slash command is run by, as pi reads it: everything after the
 * slash up to the first space. "deploy.prod" for "/deploy.prod --now".
 */
export function commandName(text: string): string | undefined {
  const t = text.trim();
  if (!t.startsWith("/")) return undefined;
  const space = t.indexOf(" ");
  return (space === -1 ? t.slice(1) : t.slice(1, space)) || undefined;
}

/**
 * A command's failure, said as it ends, so that a channel that sent it hears
 * it once, and not as well as the page's own report of the send failing.
 */
export class CommandFailed extends Error {}

/** Text without the colour and cursor codes a terminal would act on, as the chat's stripAnsi. */
function plain(text: unknown): string {
  return String(text ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim();
}

/**
 * A conversation with the agent may manage routines: one reached through a channel or the Agent page, and a chat
 * that works in an agent's own home (the "+" in the sidebar), which is the same conversation stored as a task. A
 * task in a repository or a project has no business rescheduling anything, and a routine run is excluded, since a
 * routine that can create routines can build a chain unwatched.
 */
const hasRoutineTools = (session: SessionRow) =>
  session.kind === "agent" || (session.kind === "task" && agentAt(session.workspace) !== undefined);

/** Whether the conversation gets the ask_question tool: see asksQuestions. */
const canAsk = (session: SessionRow) => {
  const host = dialogHost(session);
  return asksQuestions({ kind: host.kind, role: session.role }, onChannel(host));
};

/**
 * The chat's own switches turning the code tool off where its mode switches it on (modeHoldsCodemode): refused. With a
 * `code`, so that the page says it in its own language.
 */
export class CodemodeHeld extends Error {
  readonly code = "codemode-held";
  constructor() {
    super("This chat's mode works through the code tool, so it stays on: start a chat in Standard mode to work without it.");
  }
}

/**
 * A command sent to pi and not yet answered. `inRun`: sent into a run, whose
 * next start is not the command's doing.
 */
type InHand = { seq: number; name: string; said: number; inRun: boolean; error?: string };

/** The extension UI requests a person sees in the chat: a line, a dialog, a view, the box filled. */
const SHOWN = new Set(["notify", "select", "confirm", "input", "editor", "custom", "setEditorText", "set_editor_text"]);

/**
 * Events that must not be persisted.
 *
 * Beyond noise, extension dialogs are strictly live: a stored
 * extension_ui_request would be replayed to every future reader, so reloading
 * the page reopened a dialog whose extension had long since stopped waiting.
 */
const EPHEMERAL_EVENTS = new Set([
  "queue_update",
  "extension_ui_request",
  "extension_ui_cancel",
  // Prefill progress: a hundred rows per long prompt, and meaningless once the
  // answer has arrived. Delivered to whoever is watching, never stored.
  "portal_prefill",
  // A model being loaded before the prompt can be read: news only while it lasts.
  "portal_model",
  // A subagent's reply as it streams; its finished messages are stored.
  "portal_subagent_live",
  // Tells a page which stretch of its transcript is gone. Stored, it would be
  // replayed to a reader who never saw what it refers to.
  "portal_removed",
  // Pages load the chat again: see reloadPages. A page that missed it hears it from the count.
  "portal_reload",
  // The versions of a chat's messages, which a stream also starts with.
  "portal_versions",
  // What an extension says to its browser half: the two keep their own state, and a page that opens later asks.
  "portal_extension_ui",
]);

/** How long a chat's pi may go unused before it is let go: see startReaper. */
const IDLE_STOP_MS = 20 * 60_000;

/** How far apart a job's start and its chat's tool call may be, and still be the call's: see startedBy. */
const JOB_CLOCK_SLACK_MS = 500;
/** How many tool calls a chat remembers the time of: a chat that has made more has forgotten its oldest. */
const CALL_WINDOWS_KEPT = 5000;

/** What a channel's ask hands pi, once it is its turn: the words, and pictures already checked and kept. */
export type PreparedPrompt = { message: string; images?: Attached[]; onAccepted?: () => void };

/** A picture or a clip a call gave the person, read from the chat's folder for a channel to send on. */
export interface SentFile {
  /** Base64. */
  data: string;
  mimeType: string;
  /** Its file name in the chat's folder. */
  name: string;
  title?: string;
}
type AskMessage = string | (() => PreparedPrompt);

interface LiveSession {
  client: PiClient;
  executor: Executor;
}

/**
 * Owns every running pi process.
 *
 * The important property: a run is tied to this manager, not to any HTTP
 * request. Once a prompt is accepted the browser can disappear — output keeps
 * streaming into the event log, and a later reconnect replays it.
 */
class SessionManager extends EventEmitter {
  private live = new Map<string, LiveSession>();
  private stopping = new WeakSet<PiClient>();
  /** The pis being let go, by chat: a new one is not started beside the old one's shutdown. */
  private releasing = new Map<string, Promise<void>>();
  /**
   * Chats being deleted: from `discard` to the end of the delete. Letting a pi
   * go takes as long as its extensions need, and a message that comes in
   * meanwhile — another tab, a channel — finds the row and would start a new pi
   * for a chat that is about to be gone, to run the message in its folder.
   */
  private discarding = new Set<string>();
  private stream = new LiveEvents(appendEvent);
  /** Model failures pi has not recovered from: see model-errors.ts. */
  private modelErrors = new ModelErrors();

  /**
   * What a page that attaches is shown beyond the stored events: the message being written, the dialogs
   * (confirm, select, input, editor) an extension is waiting on, and the agent's questions still open.
   * Dialogs are live events and never stored, so without this a reload or a visit to another chat lost the
   * dialog. A question is stored, and sent again here for a page that loads only the end of a long chat,
   * which may not reach back to where it was asked: the page draws each question once.
   */
  liveSnapshot(sessionId: string) {
    const dialogs = (this.live.get(sessionId)?.client.openDialogRequests?.() ?? [])
      .filter((req) => req.method !== "questions")
      .map((req) => this.stream.ephemeral(sessionId, "extension_ui_request", req));
    const questions = this.openQuestions(sessionId).map((q) => this.stream.ephemeral(sessionId, CHAT_QUESTION, q));
    return [...this.stream.snapshot(sessionId), ...dialogs, ...questions];
  }

  /**
   * The agent's questions in a chat that are still open. One nobody waits on any more, whose wait is up, ends
   * here: its timer went with the portal that asked it.
   */
  openQuestions(sessionId: string): ChatQuestion[] {
    const now = Date.now();
    return openChatQuestions(sessionId).filter((q) => {
      if (q.until === undefined || q.until > now || this.waitedOn(sessionId, q.id)) return true;
      this.endQuestion(sessionId, q.id, "expired");
      return false;
    });
  }

  /** Whether the run that asked a question is still waiting for its answer. */
  private waitedOn(sessionId: string, id: string): boolean {
    return (this.live.get(sessionId)?.client.openDialogRequests?.() ?? []).some((req) => req.id === id);
  }

  /** A question's record: how it ended, and the answers when it was answered. See questions.ts. */
  private endQuestion(sessionId: string, id: string, outcome: QuestionOutcome, answers?: Answers): void {
    this.record(sessionId, CHAT_QUESTION_END, { of: id, outcome, ...(answers ? { answers } : {}) });
  }
  /** In-flight ask() per session, so messages in one chat are answered in turn. */
  private asking = new Map<string, Promise<string>>();
  /**
   * Who sent the message being handled, per session.
   *
   * Per message rather than per session because a group conversation has many
   * senders: the guard asks this at tool-call time so capability follows whoever
   * is actually speaking, not whoever spoke first.
   */
  private speaker = new Map<string, PersonRow>();

  /**
   * Touches nothing outside itself: anything that imports this module builds
   * the manager, a test the agent runs from inside a chat among them, with the
   * portal's DATA_DIR and SESSION_DIR in its environment. Each session's folder
   * is made when its pi starts.
   */
  constructor() {
    super();
    this.setMaxListeners(0);
  }

  /**
   * Chats left running by the previous server, marked interrupted.
   *
   * Called by the server on startup, before any pi is launched, rather than by
   * the constructor. Done on construction, a test run from inside a chat marked
   * the very chat running it as interrupted — which took away its Stop button
   * while it was still waiting on the command. Only a run that died with the
   * previous server is marked, so an interrupted chat has nothing running.
   *
   * Returns the conversations on a channel it cut off — a run that was going,
   * or a message that never reached the agent — whose people have not heard
   * that: the channel acknowledged their messages, and will not send them again.
   */
  recoverOrphans(): string[] {
    const orphaned = markOrphanedSessionsInterrupted();
    if (orphaned.length > 0) {
      console.log(`[portal] marked ${orphaned.length} session(s) interrupted (server restarted mid-run)`);
    }
    // Said in the conversation too, so what the run left open is settled
    // there for good, and not taken up again as running by the next run.
    for (const id of orphaned) this.record(id, "portal_status", { status: "interrupted", restarted: true });
    const unsent = this.settleOrphanedMessages();
    // A subagent in the background ran in the last server's process, in a chat
    // that may well have been idle: nothing above ends it, and it would show
    // as running for good.
    for (const open of openDetachedSubagents()) {
      this.record(open.sessionId, "portal_subagent", {
        type: "portal_subagent", op: "end", id: open.id, detached: true, status: "stopped", error: "The portal restarted while it ran",
      });
    }
    // A command's end is written when pi answers it. One the last server was
    // holding never will be: it failed, with what it threw if it did. The page
    // cannot tell one still waiting on a dialog from one that never will.
    for (const c of unansweredCommands()) {
      this.record(c.sessionId, "portal_command_end", { of: c.seq, error: c.error ?? "The portal restarted before it answered" });
    }
    // Answers the last server took while it was stopping: they go to the agent now, as one given after a restart does.
    for (const held of takeHeldAnswers()) this.passOnAnswers(held.sessionId, held.questions, held.answers);
    return [...new Set([...orphaned, ...unsent])].filter((id) => {
      const row = getSession(id);
      return Boolean(row?.channel_slug && row.channel_key);
    });
  }

  /**
   * Messages sent into a run the previous server did not live to see through.
   *
   * The list of what was waiting died with it, and left alone they sat at the
   * foot of the chat under everything said since. pi's file says which of them
   * it took in: one found there beyond the messages already accounted for was
   * read, and the rest never reached it. Put where the run ended, which is as
   * near as can be told to where the agent read them.
   */
  private settleOrphanedMessages(): string[] {
    const lost: string[] = [];
    const bySession = new Map<string, ReturnType<typeof unsettledMessages>>();
    for (const m of unsettledMessages()) bySession.set(m.sessionId, [...(bySession.get(m.sessionId) ?? []), m]);
    for (const [sessionId, list] of bySession) {
      const said = this.saidInFile(sessionId);
      // pi's file could not be read, so which of them it took in cannot be
      // told. Marked as that rather than as never sent: one it did read and
      // answer, offered again as "not sent", would be sent twice.
      if (!said) {
        this.record(sessionId, "portal_unsent", {
          seqs: list.map((m) => m.seq),
          prompts: Object.fromEntries(list.map((m) => [m.seq, m.prompt])),
          restarted: true,
          unsure: true,
        });
        lost.push(sessionId);
        continue;
      }
      // Each by the words pi was given, where it said what it made of them: a
      // template is in the file as what it expanded to.
      const words = (m: { message: string; prompt?: Record<string, unknown>; payload?: Record<string, unknown> }) =>
        unspoken(String((m.prompt ?? m.payload)?.queuedAs ?? m.message));
      const left = new Map<string, number>();
      for (const text of said) left.set(text, (left.get(text) ?? 0) + 1);
      const orphans = new Set(list.map((m) => m.seq));
      for (const m of sentMessages(sessionId)) {
        if (!orphans.has(m.seq)) left.set(words(m), (left.get(words(m)) ?? 0) - 1);
      }
      const unsent: typeof list = [];
      for (const m of list) {
        if ((left.get(words(m)) ?? 0) > 0) {
          left.set(words(m), left.get(words(m))! - 1);
          this.record(sessionId, "portal_taken", { seq: m.seq, prompt: m.prompt });
        } else unsent.push(m);
      }
      if (unsent.length) {
        this.record(sessionId, "portal_unsent", {
          seqs: unsent.map((m) => m.seq),
          prompts: Object.fromEntries(unsent.map((m) => [m.seq, m.prompt])),
          restarted: true,
        });
        lost.push(sessionId);
      }
    }
    return lost;
  }

  /**
   * What the person said, as pi's file for a session has it; undefined when
   * that cannot be read. No file at all is nothing said: pi writes it with the
   * first message it takes in. A container's pi names it by where the file is
   * inside the container, which is the session's own folder here.
   */
  private saidInFile(sessionId: string): string[] | undefined {
    const session = getSession(sessionId);
    let file = session?.pi_session_file;
    if (!file) return [];
    if (session?.executor !== "host" && file.startsWith(CONTAINER_SESSION_DIR)) {
      file = path.join(SESSION_ROOT, sessionId, file.slice(CONTAINER_SESSION_DIR.length));
    }
    try {
      return userTexts(readFileSync(file, "utf8"));
    } catch (e) {
      console.error(`[portal] could not read the history of ${sessionId}: ${(e as Error).message}`);
      return undefined;
    }
  }

  isRunning(sessionId: string): boolean {
    return this.live.get(sessionId)?.client.running ?? false;
  }

  /** A pi process is up or starting for it: only then is there anything for discard() to stop. */
  isLoaded(sessionId: string): boolean {
    return this.live.has(sessionId) || this.starting.has(sessionId);
  }

  /** What the chat's last load could not load (see PiClient.loadErrors): nothing while its pi is not running, or where the executor cannot say. */
  loadErrors(sessionId: string): LoadError[] {
    return this.live.get(sessionId)?.client.loadErrors?.() ?? [];
  }

  /** Stream updates in memory; persist completed messages and lifecycle metadata. */
  private record(sessionId: string, type: string, payload: unknown): EventRow | undefined {
    // A status line or a widget describes the chat; nobody is using it. An
    // extension that refreshes one every second kept the idle clock at zero, and
    // the reaper never let go of the chat. What an extension says to its
    // browser half is the same: said on its own clock, with nobody there.
    if (type !== "portal_extension_ui" && (type !== "extension_ui_request" || isDialog((payload as { method?: unknown })?.method))) this.touch(sessionId);
    if (EPHEMERAL_EVENTS.has(type)) {
      // Still deliver it to anyone attached right now, with a negative seq so
      // it can never be confused with a stored event during replay.
      // Timed like a stored one, so a page can say how long it has lasted.
      // Numbered by the live stream's own count: two in one millisecond had
      // the same seq, and a page telling them apart by it took the second for
      // the first. A subagent's stream is kept there too, for a page that
      // opens mid-message.
      this.emit(
        `session:${sessionId}`,
        type === "portal_subagent_live" ? this.stream.subagentLive(sessionId, payload) : this.stream.ephemeral(sessionId, type, payload),
      );
      return undefined;
    }
    const row = this.stream.record(sessionId, type, payload);
    this.emit(`session:${sessionId}`, row);
    return row;
  }

  /**
   * Messages sent mid-run that pi has not taken in yet, oldest first.
   *
   * Shown waiting at the foot of the conversation until pi takes one in —
   * after the step it is on for a steer, at the end of the run for a
   * follow-up — and then where that happened, which is where the agent read
   * it. A Stop drops what is still waiting: pi would keep it queued and slip
   * it into the next run, unasked.
   */
  private waiting = new Map<string, Waiting[]>();

  /**
   * The tail of the messages on their way to pi, per session: each resolves
   * once pi has accepted it or refused it. See submit().
   */
  private sending = new Map<string, Promise<void>>();

  /** A run's failure, reported ahead of its agent_settled: see the client's forward(). */
  private failed = new Set<string>();

  /**
   * Messages handed to pi while it was idle, per session, whose own start has
   * not come yet. Each starts the run it is handed to, so the first message
   * from the person in that run is it — whatever pi made of its words — and
   * not a waiting one that happens to say the same. One that was waiting its
   * turn behind another is placed by it.
   */
  private fresh = new Map<string, { waiting?: Waiting }[]>();

  /** What pi says is in its queue, per session, from its queue_update events. */
  private piQueue = new Map<string, PiQueue>();

  /**
   * Slash commands pi queued into a run — a template, a skill — per session,
   * with the words pi queued. Not chat messages, so nothing waits for them on
   * the page; kept so a Stop that drops one can say so. See dropWaiting.
   */
  private queuedCommands = new Map<string, { command: string; queued: Queued }[]>();

  /** Places a message sent into a run where pi took it in. */
  private placeTaken(sessionId: string, message: Waiting): void {
    if (this.unwait(sessionId, message)) this.record(sessionId, "portal_taken", { seq: message.seq, prompt: message.prompt });
  }

  /** pi started a message from the person: the waiting one it is, now in place. */
  private takeIn(sessionId: string, content: unknown): void {
    const starting = this.fresh.get(sessionId);
    if (starting?.length) {
      const [own] = starting.splice(0, 1);
      if (!starting.length) this.fresh.delete(sessionId);
      if (own.waiting) this.placeTaken(sessionId, own.waiting);
      return;
    }
    const text = textOf(content);
    const images = Array.isArray(content) ? content.filter((c) => c?.type === "image").length : 0;
    const list = this.waiting.get(sessionId) ?? [];
    // As pi finds it in its own queue: the steers first, then the follow-ups,
    // each by the words pi queued, oldest first — a typed steer overtakes a
    // spoken follow-up sent before it. One whose client could not say what pi
    // queued, by the words it was sent with: exactly, or with the note a
    // spoken turn carries, and with as many pictures — a picture on its own
    // has no words, and every message ends with none.
    const inLane = (lane: Queued["lane"]) => list.find((m) => m.queuedAs?.lane === lane && m.queuedAs.text === text);
    const taken =
      inLane("steering") ??
      inLane("followUp") ??
      list.find((m) => !m.queuedAs && (text === m.message || text === AUDIO_MESSAGE_PREFIX + m.message) && images === m.images);
    if (taken) {
      this.placeTaken(sessionId, taken);
      return;
    }
    const commands = this.queuedCommands.get(sessionId) ?? [];
    const command = commands.findIndex((c) => c.queued.text === text);
    if (command >= 0) commands.splice(command, 1);
    if (!commands.length) this.queuedCommands.delete(sessionId);
  }

  /** Whether pi still holds a message, taking it off `queue` if so. */
  private stillQueued(queue: PiQueue, message: { message: string; queuedAs?: Queued }): boolean {
    for (const lane of message.queuedAs ? [message.queuedAs.lane] : (["steering", "followUp"] as const)) {
      const at = queue[lane].findIndex((text) =>
        message.queuedAs ? text === message.queuedAs.text : text === message.message || text === AUDIO_MESSAGE_PREFIX + message.message,
      );
      if (at < 0) continue;
      queue[lane].splice(at, 1);
      return true;
    }
    return false;
  }

  /**
   * The run is over. Anything that was in pi's queue, is not any more, and
   * was not matched when pi started it was taken in all the same, and is put
   * here. One pi still holds stays waiting: a Stop that could not take it out
   * leaves it for the next run. One still on its way to pi is not placed
   * either: it goes into the run it starts, and is placed when that run takes
   * it in.
   */
  private settleWaiting(sessionId: string): void {
    const now = this.piQueue.get(sessionId);
    const queue: PiQueue = { steering: [...(now?.steering ?? [])], followUp: [...(now?.followUp ?? [])] };
    const list = this.waiting.get(sessionId) ?? [];
    const taken = list.filter((m) => m.inPi && !this.stillQueued(queue, m));
    for (const m of taken) this.placeTaken(sessionId, m);
    const commands = (this.queuedCommands.get(sessionId) ?? []).filter((c) =>
      this.stillQueued(queue, { message: c.command, queuedAs: c.queued }),
    );
    if (commands.length) this.queuedCommands.set(sessionId, commands);
    else this.queuedCommands.delete(sessionId);
  }

  /**
   * Stopped before pi took them in: out of pi's queue, and marked as never
   * sent. Without a client, pi is gone and its queue with it. One not handed
   * to pi yet finds itself gone from the list and is never sent: see submit().
   *
   * A pi whose queue cannot be cleared — one in a container, which has no
   * command for it — keeps what it holds, and goes on to read it. Those stay
   * waiting, to be placed where it does, rather than shown as not sent.
   *
   * A slash command pi had queued goes with the rest; it has no line on the
   * page to mark, so a notice says it never ran.
   *
   * `only`, when given, limits it to those: see abort().
   */
  private dropWaiting(sessionId: string, client?: PiClient, only?: Set<Waiting>): void {
    const list = this.waiting.get(sessionId) ?? [];
    const commands = this.queuedCommands.get(sessionId) ?? [];
    if (!list.length && !commands.length) return;
    let cleared = !client;
    if (client?.clearQueue) {
      try {
        client.clearQueue();
        cleared = true;
      } catch (e) {
        console.error(`[portal] could not clear the queue of ${sessionId}: ${(e as Error).message}`);
      }
    }
    if (cleared) {
      this.queuedCommands.delete(sessionId);
      for (const c of commands) {
        this.record(sessionId, "portal_notice", {
          text: `${c.command.split("\n")[0]} was dropped before the agent read it, so it never ran.`,
          error: true,
        });
      }
    }
    const dropped = list.filter((m) => (!only || only.has(m)) && (cleared || !m.inPi));
    if (!dropped.length) return;
    const rest = list.filter((m) => !dropped.includes(m));
    if (rest.length) this.waiting.set(sessionId, rest);
    else this.waiting.delete(sessionId);
    this.record(sessionId, "portal_unsent", {
      seqs: dropped.map((m) => m.seq),
      prompts: Object.fromEntries(dropped.map((m) => [m.seq, m.prompt])),
    });
  }

  /**
   * Takes back messages sent mid-run that pi has not read yet: `seq` is
   * dropped for good, or — with `direct` — sent first, after the run is
   * stopped. Whatever else waits keeps its order and goes in behind.
   *
   * pi can only empty its queue as a whole, so that is what is done, and the
   * messages that stay are sent again, as they were: the same words, pictures
   * and lane, under new numbers, in the order they were sent. Sent now, the
   * others go in as follow-ups, since the run they steered is gone.
   */
  async takeBackWaiting(sessionId: string, seq: number, direct: boolean): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live?.client.clearQueue) throw new SessionEditError("unsupported", "This agent's queue cannot be changed.");
    // Into pi's queue first, where the clearing below reaches them.
    await this.whenHanded(sessionId);
    // Nothing awaited from here to the clearing: what pi takes in meanwhile is
    // seen by takeIn, and is not on the list any more.
    const pulled = (this.waiting.get(sessionId) ?? []).filter((m) => m.inPi);
    const chosen = pulled.find((m) => m.seq === seq);
    if (!chosen) throw new SessionEditError("busy", "The agent has taken that message in already.");
    live.client.clearQueue();
    const rest = pulled.filter((m) => m !== chosen);
    const again = direct ? [chosen, ...rest] : rest;
    for (const m of pulled) {
      this.unwait(sessionId, m);
      deleteEvent(m.seq);
      this.tellRemoved(sessionId, { from: m.seq, to: m.seq + 1 });
    }
    // The pictures of the messages sent again stay on disk; a dropped one's go.
    if (!direct) dropImages(IMAGE_ROOT, sessionId, storedIn(chosen.prompt));
    if (direct && live.client.running) await this.abort(sessionId);
    for (const m of again) {
      const images = loadImages(IMAGE_ROOT, sessionId, storedIn(m.prompt));
      // Sent now, the others wait for the run the chosen one starts: as
      // steers, pi would read them in its first model request, together with
      // it. Behind it, as follow-ups, they are answered after it.
      const steer = !direct && m.prompt.steer === true;
      await this.prompt(sessionId, m.message, {
        ...(m.prompt.voice === true ? { voice: true } : {}),
        ...(images.length ? { images } : {}),
        ...(steer ? { steer: true } : {}),
      });
    }
  }

  /** Takes one message off the waiting list; false if it was no longer on it. */
  private unwait(sessionId: string, message: Waiting): boolean {
    const list = this.waiting.get(sessionId) ?? [];
    if (!list.includes(message)) return false;
    const rest = list.filter((m) => m !== message);
    if (rest.length) this.waiting.set(sessionId, rest);
    else this.waiting.delete(sessionId);
    return true;
  }

  /**
   * Until the messages being handed to pi right now are in its queue, where a
   * Stop can take them out. pi's preflight is asynchronous — extension input
   * handlers run first — and one that landed after the queue was cleared would
   * be picked up by the run as it wound down, or start the next one. Bounded:
   * a handler stuck on something is not a reason for Stop to hang.
   */
  private async whenHanded(sessionId: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const handing = (this.waiting.get(sessionId) ?? []).flatMap((m) => (m.handing ? [m.handing] : []));
      const left = deadline - Date.now();
      if (!handing.length || left <= 0) return;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all(handing),
        new Promise<void>((resolve) => (timer = setTimeout(resolve, left))),
      ]);
      clearTimeout(timer);
    }
  }

  /**
   * Compact on request.
   *
   * Marked running for the same reason a prompt is: it takes a model call and
   * a minute, and without it the composer showed nothing, the transcript
   * showed nothing, and there was no Stop to press — a long compaction was
   * indistinguishable from a hung portal.
   */
  async compact(sessionId: string): Promise<void> {
    // One at a time. A second request used to overwrite the tracked promise,
    // and whichever finished first then cleared it and published idle while
    // the other was still going — which is exactly the state prompt() checks
    // for before deciding it is safe to start.
    const inFlight = this.compacting.get(sessionId);
    if (inFlight) return inFlight;

    // Before starting pi, not after: on a cold session that takes seconds, and
    // those are exactly the seconds with no activity line and no Stop.
    this.mark(sessionId, "running");
    const run = (async () => {
      const client = await this.ensureClient(sessionId);
      // Stop pressed while pi was still starting. There was nothing to abort
      // at the time, so it is honoured here instead of starting a compaction
      // that the user has already asked not to happen.
      if (this.cancelPending.delete(sessionId)) return;
      await client.compact();
    })();
    // Held so a Stop, and the next prompt, can wait for it — see abort().
    this.compacting.set(sessionId, run);
    try {
      await run;
    } finally {
      this.compacting.delete(sessionId);
      this.cancelPending.delete(sessionId);
      // No agent run, so no agent_settled arrives to clear it.
      this.mark(sessionId, "idle");
    }
  }

  /**
   * Push a change to pi's settings file into every session already open.
   *
   * Without this, tuning compaction would apply to sessions started later and
   * to nothing you can currently see. Failures are swallowed per session: one
   * client that cannot reload is not a reason to fail the save.
   */
  async refreshSettings(): Promise<number> {
    const live = [...this.live.values()];
    const done = await Promise.all(
      live.map((s) =>
        s.client
          .refreshSettings?.()
          .then(() => true)
          .catch(() => false) ?? Promise.resolve(false),
      ),
    );
    return done.filter(Boolean).length;
  }

  /** A changed context limit reaches the chats that are open, not just the ones started later. */
  applyContextLimits(): void {
    // One chat at a time, like refreshSettings: one that is mid-teardown is not a
    // reason for the others to keep the old window, or for the save to fail after
    // the value has been stored.
    for (const [id, s] of this.live) {
      try {
        s.client.applyContextLimit?.();
      } catch (e) {
        console.error(`[portal] could not apply the context window to ${id}: ${(e as Error).message}`);
      }
    }
  }

  /** How far llama.cpp has got through the prompt. Straight out to the browser. */
  reportPrefill(sessionId: string, prefill: unknown): void {
    this.record(sessionId, "portal_prefill", prefill);
  }

  /**
   * What extensions currently show about themselves in a session: the status
   * lines and text widgets pi's TUI would draw in its footer. Kept here, not
   * only streamed, so a page opened later sees them too.
   */
  private extensionUi = new Map<string, { statuses: Map<string, string>; widgets: Map<string, string[]> }>();

  private noteExtensionUi(sessionId: string, msg: any): void {
    let ui = this.extensionUi.get(sessionId);
    if (!ui) this.extensionUi.set(sessionId, (ui = { statuses: new Map(), widgets: new Map() }));
    if (msg.method === "setStatus" && typeof msg.statusKey === "string") {
      const text = plain(msg.statusText);
      if (text) ui.statuses.set(msg.statusKey, text);
      else ui.statuses.delete(msg.statusKey);
    }
    if (msg.method === "setWidget" && typeof msg.widgetKey === "string") {
      const lines = Array.isArray(msg.widgetContent) ? msg.widgetContent.map(plain) : [];
      if (lines.some(Boolean)) ui.widgets.set(msg.widgetKey, lines);
      else ui.widgets.delete(msg.widgetKey);
    }
  }

  /**
   * Commands sent and not yet answered, per session, with how much each has
   * shown, and the error it threw: pi reports that apart from the answer,
   * which counts a command that threw as handled.
   */
  private commandsInHand = new Map<string, InHand[]>();

  /**
   * Sessions whose agent is in a run, from pi's agent_start to agent_settled.
   * Not the session's status, which a command sent marks running as well.
   */
  private inRun = new Set<string>();

  /** The extensions whose failure has been said since the last run began, per session. */
  private failuresSaid = new Map<string, Set<string>>();

  private startCommand(sessionId: string, message: string): InHand {
    const text = message.trim();
    const row = this.record(sessionId, "portal_command", { text });
    const command: InHand = { seq: row?.seq ?? -1, name: commandName(text) ?? text, said: 0, inRun: this.inRun.has(sessionId) };
    this.commandsInHand.set(sessionId, [...(this.commandsInHand.get(sessionId) ?? []), command]);
    return command;
  }

  /**
   * How a command ended: run by an extension, a run started or queued, or
   * failed. `quiet` when it showed nothing at all — no line, no dialog, no
   * run — so the chat can say it ran and had nothing to say.
   */
  private endCommand(sessionId: string, command: InHand, end: { outcome?: string; said?: boolean; error?: string }) {
    const inHand = this.commandsInHand.get(sessionId) ?? [];
    // Ended already, when pi went away before it answered.
    if (!inHand.includes(command)) return;
    const list = inHand.filter((c) => c !== command);
    if (list.length) this.commandsInHand.set(sessionId, list);
    else this.commandsInHand.delete(sessionId);
    const error = end.error ?? command.error;
    this.record(sessionId, "portal_command_end", {
      of: command.seq,
      ...(error ? { error } : { outcome: end.outcome ?? "handled" }),
      ...(!error && !end.said && command.said === 0 && end.outcome === "handled" ? { quiet: true } : {}),
    });
  }

  /**
   * pi went before answering the commands it had: they end as failed, rather
   * than running for good and lending their names to notices of later ones.
   */
  private dropCommands(sessionId: string) {
    for (const command of this.commandsInHand.get(sessionId) ?? []) {
      this.record(sessionId, "portal_command_end", { of: command.seq, error: "pi stopped before it answered" });
    }
    this.commandsInHand.delete(sessionId);
  }

  /**
   * Tool calls running in each chat, its subagents' included, by call id. A
   * process pi started for one and one an extension started look the same
   * from outside; only while a call is running can a process be one.
   */
  private calls = new Map<string, Set<string>>();

  /**
   * When each chat's tool calls ran, in `Date.now()`'s time, for telling which of
   * the jobs in a folder a chat started: see startedBy. The calls still going are
   * `open`, by call id. Dropped with its pi.
   */
  private callWindows = new Map<string, { all: { from: number; to?: number }[]; open: Map<string, { from: number; to?: number }> }>();

  private noteCall(sessionId: string, msg: any): void {
    const sub = msg.type === "portal_subagent" && msg.op === "event" ? msg.event ?? {} : undefined;
    const event = sub ?? msg;
    // By call, a subagent's under its own name: one ended mid-call takes its calls with it.
    if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
      const call = `${sub ? `${msg.id}:` : ""}${String(event.toolCallId ?? "")}`;
      const subagent = sub ? String(msg.id) : undefined;
      if (event.type === "tool_execution_start") toolCallStarted(sessionId, call, event.toolName, subagent, event.args);
      else toolCallEnded(sessionId, call, event.toolName, Boolean(event.isError), subagent);
    }
    if (msg.type === "portal_subagent" && msg.op === "end") {
      toolCallsCutOff(sessionId, `${msg.id}:`);
    }
    const id = `${sub ? `${msg.id}:` : ""}${String(event.toolCallId ?? "")}`;
    let calls = this.calls.get(sessionId);
    if (event.type === "tool_execution_start") {
      if (!calls) this.calls.set(sessionId, (calls = new Set()));
      calls.add(id);
      if (BACKGROUND_SUPPORTED) this.openWindow(sessionId, id);
    }
    if (event.type === "tool_execution_end") {
      calls?.delete(id);
      this.closeWindows(sessionId, (open) => open === id);
    }
    // A subagent that ended took whatever it was running with it.
    if (msg.type === "portal_subagent" && msg.op === "end") {
      for (const c of [...(calls ?? [])]) if (c.startsWith(`${msg.id}:`)) calls!.delete(c);
      this.closeWindows(sessionId, (open) => open.startsWith(`${msg.id}:`));
    }
    if (calls && !calls.size) this.calls.delete(sessionId);
  }

  private openWindow(sessionId: string, id: string): void {
    let windows = this.callWindows.get(sessionId);
    if (!windows) this.callWindows.set(sessionId, (windows = { all: [], open: new Map() }));
    const window = { from: Date.now() };
    windows.all.push(window);
    windows.open.set(id, window);
    // Dropped a few hundred at a time, not one by one.
    if (windows.all.length > CALL_WINDOWS_KEPT + 500) windows.all.splice(0, 500);
  }

  private closeWindows(sessionId: string, ended: (id: string) => boolean): void {
    const windows = this.callWindows.get(sessionId);
    const now = Date.now();
    for (const [id, window] of windows?.open ?? []) {
      if (!ended(id)) continue;
      window.to = now;
      windows!.open.delete(id);
    }
  }

  /**
   * Whether this chat's own tool call was running when the job began, which is
   * what a job of the chat looks like from here: whatever the agent or an
   * extension started for a call. Another chat in the same folder shows the same
   * jobs, and is not held up by them. A little either side, for the two clocks
   * that are compared, and for an event that came a moment after its call began.
   */
  private startedBy(sessionId: string, job: BackgroundJob): boolean {
    const at = startedWhen(job);
    return (this.callWindows.get(sessionId)?.all ?? []).some((w) => at >= w.from - JOB_CLOCK_SLACK_MS && at <= (w.to ?? Infinity) + JOB_CLOCK_SLACK_MS);
  }

  /** The model a running chat is on now; undefined when it is not running here. */
  async currentModel(sessionId: string): Promise<{ provider: string; id: string } | undefined> {
    const client = this.live.get(sessionId)?.client;
    if (!client) return undefined;
    const { model } = await client.getState();
    return model?.provider && model.id ? { provider: model.provider, id: model.id } : undefined;
  }

  /** Whether a tool call is running in the chat: see calls. */
  callsRunning(sessionId: string): boolean {
    return this.calls.has(sessionId);
  }

  /** Extension status lines and widgets for a session, as they are now. */
  extensionState(sessionId: string): { statuses: { key: string; text: string }[]; widgets: { key: string; lines: string[] }[] } {
    const ui = this.extensionUi.get(sessionId);
    return {
      statuses: ui ? [...ui.statuses].map(([key, text]) => ({ key, text })) : [],
      widgets: ui ? [...ui.widgets].map(([key, lines]) => ({ key, lines })) : [],
    };
  }

  /**
   * A message for, or a stop to, a subagent an extension announced. False
   * when the session is not running here or its executor cannot reach the
   * extensions — the container one cannot.
   */
  subagentInput(sessionId: string, id: string, text: string): boolean {
    return this.live.get(sessionId)?.client.subagentInput?.(id, text) ?? false;
  }

  subagentStop(sessionId: string, id: string): boolean {
    return this.live.get(sessionId)?.client.subagentStop?.(id) ?? false;
  }

  /**
   * What a page says to an extension's own half in a chat, starting the chat's
   * pi if it is not running: a panel opened on a chat left alone for a while
   * still reaches its extension. False where the executor cannot reach the
   * extensions.
   */
  async tellExtension(sessionId: string, extension: string, data: unknown): Promise<boolean> {
    // Asked before pi is started: where it runs in a container there is nobody to tell, and a container
    // started only to find that out would be left running.
    if (EXECUTOR_KIND !== "host") return false;
    const client = await this.ensureClient(sessionId);
    return client.tellExtension?.(extension, data) ?? false;
  }

  /** How a running chat's model is offered a tool now (see PiClient.offers); nothing for a chat whose pi is not running. */
  toolOffered(sessionId: string, tool: string): "direct" | "lazy" | undefined {
    return this.live.get(sessionId)?.client.offers?.(tool);
  }

  /** The session's model is being loaded, or has finished loading. */
  reportModelLoad(sessionId: string, load: unknown): void {
    this.record(sessionId, "portal_model", load);
  }

  /** What llama.cpp measured for the answer it just finished: kept on that answer's message_end. */
  reportTimings(sessionId: string, timings: Timings): void {
    this.stream.timings(sessionId, timings);
  }

  /**
   * Start pi for a session, once.
   *
   * Two callers arriving on a cold session both used to get past the check
   * below and both launch. The later `live.set()` then dropped the first on
   * the floor: a pi session still running, still subscribed to its own events,
   * with an executor nobody would ever clean up — and a Stop that reached
   * whichever one happened to be in the map.
   *
   * askNow() makes it easy to hit, because it starts a client of its own
   * before it prompts, and any two requests landing together on a session
   * nobody has opened yet will do it.
   */
  private async ensureClient(sessionId: string, insideEdit = false): Promise<PiClient> {
    this.refuseIfDiscarded(sessionId);
    this.touch(sessionId);
    // A client started now would read the file the edit is about to rewrite, and
    // go on holding the conversation as it was.
    if (!insideEdit) await this.whenEditable(sessionId);
    const existing = this.live.get(sessionId);
    if (existing?.client.running) return existing.client;

    const starting = this.starting.get(sessionId);
    if (starting) return starting;

    // Cleared whether it worked or not, so a failed start does not leave the
    // session unable to try again.
    const launch = this.startClient(sessionId).finally(() => this.starting.delete(sessionId));
    this.starting.set(sessionId, launch);
    return launch;
  }

  private async startClient(sessionId: string): Promise<PiClient> {
    // What the installed extensions' server halves add to a chat's pi is added as it loads: they are started first.
    await serversSettled();
    // The pi that was let go still has its extensions winding down, on the same
    // conversation file: the next one starts after them.
    await this.releasing.get(sessionId);
    // A delete began while this waited, or while it was held at the edit.
    this.refuseIfDiscarded(sessionId);
    const session = getSession(sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);

    // A session can outlive its folder: a routine's past runs stay, the record
    // of what it did, when the project they ran in is deleted. Said plainly,
    // rather than as whatever starting pi in no directory comes to.
    // An agent's home is made again if need be; a project is not.
    if (agentAt(session.workspace)) agentHome(session.workspace);
    if (!existsSync(session.workspace)) {
      throw new Error(`The folder this chat worked in, ${session.workspace}, is gone. Its history can still be read, but it cannot go on.`);
    }
    const executor = buildExecutor(EXECUTOR_KIND, SESSION_ROOT);
    mkdirSync(path.join(SESSION_ROOT, sessionId), { recursive: true });

    // The session's own choices win over the portal defaults. Without this a
    // restart relaunched pi on the default model, quietly undoing the pick.
    const settings = getSettings();
    const chosen = chatModel(session, settings);
    const client = await executor.launch({
      sessionId,
      workspacePath: session.workspace,
      provider: chosen.provider,
      model: chosen.model || undefined,
      thinkingLevel: session.thinking_level || settings.thinkingLevel || undefined,
      sessionFile: session.pi_session_file || undefined,
      routineTools: hasRoutineTools(session),
      questions: canAsk(session),
      // A child chat's go where its parent's would: see dialogHost.
      dialogs: showsDialogs(dialogHost(session), onChannel(dialogHost(session))),
      // A routine run gets the report tool instead: it is the one kind of
      // session with nobody on the other end to read what it found.
      routineSlug: session.kind === "routine" ? session.routine_slug : undefined,
      // A routine may be exempted from taint rules, read per call as the allowlist is; nothing else can be.
      exemptNow: () => (session.kind === "routine" ? routineExemptions(session.routine_slug) : new Set<string>()),
      // Re-read per call: a list that has to wait for a restart to hold is a setting that looks broken.
      allowlistNow: browserAllowlist,
      // The session's settled role picks the context files; the live one gates
      // each tool call, so a group conversation follows whoever is speaking.
      role: session.role,
      ...this.toolsFor(sessionId),
      codemode: modeOf(session.mode)?.codemode ? "only" : undefined,
      // The instructions of a mode the person made, read each time pi builds the prompt (as it starts, reloads or is
      // told its tools): an edit reaches the chats in the mode with the push that follows it (applyToolDefaults), and
      // a mode that was deleted says nothing.
      modeLines: () => {
        const mode = modeOf(getSession(sessionId)?.mode);
        return mode?.instructions ? [mode.instructions] : [];
      },
      // A chat that names no model is reopened on the model of its last answer,
      // and after a spoken turn on the voice model that would be the voice's.
      rememberChatModel: (provider, model) => keepChatModel(sessionId, provider, model),
      canReloadNow: () => this.canReloadNow(sessionId),
      // A heartbeat is the agent looking around on its own: its own context,
      // but held to reading by a role of its own. See heartbeat.ts.
      ...(session.kind === "heartbeat"
        ? { heartbeatAgent: agentAt(session.workspace)?.id, whoNow: () => ({ role: HEARTBEAT_ROLE }) }
        : { whoNow: () => ({ role: this.speakerRole(sessionId), key: this.speakerKey(sessionId) }) }),
    });

    // pi writes the file lazily, so it usually does not exist yet at launch.
    // Recorded the first time it appears, and again whenever pi works from
    // another: from then on this exact conversation is what gets reopened. One
    // that went missing was left recorded, and every launch after it began a
    // new conversation all the same.
    let recordedFile = session.pi_session_file;
    const rememberSessionFile = () => {
      const file = client.sessionFile;
      if (!file || file === recordedFile) return;
      // A file pi has not written yet, in place of one that was recorded: it
      // did not find the conversation, and this chat starts over for the agent.
      // Said once it has something to forget — an answer; a chat whose first
      // message failed never had a file to lose.
      if (recordedFile && !existsSync(file) && hasAnswer(sessionId)) {
        this.record(sessionId, "portal_notice", {
          text: "The saved conversation of this chat could not be found, so the agent starts without it. The messages stay here, but it does not remember them.",
          warning: true,
        });
      }
      recordedFile = file;
      updateSession(sessionId, { pi_session_file: file });
    };
    rememberSessionFile();

    // What this session registered, written down as soon as it exists. The
    // settings page offers a default per tool, and needing to open a chat
    // before you can say "off everywhere" would be the wrong way round.
    void client
      .getTools?.()
      .then((tools) => {
        // A lazy tool that this chat was started with, because nobody had seen it before, is taken out of its list again.
        if (rememberTools(tools.map(remembered)).length) return this.applyToolDefaults();
      })
      .catch(() => {
        // A session that cannot list its tools still works; the catalogue
        // simply stays as it was.
      });

    // A new pi process knows nothing of what the last one was retrying.
    this.modelErrors.forget(sessionId);
    client.on("event", (event) => {
      // A client stopped for an edit or a restart can still have a settle in
      // hand; it speaks for a conversation that is no longer this one.
      if (this.stopping.has(client)) return;
      // The end of a call that gave files says what they are, for everything that hears of it: see output-files.ts.
      const msg = withFiles(event, session.workspace);
      // The installed extensions' server halves hear all of it, as it is said.
      chatEvent(sessionId, msg);
      rememberSessionFile();
      // A run the portal started failed after pi had accepted it. Said here,
      // before its agent_settled, so an ask() waiting on it fails instead of
      // answering with what was said so far — and the session stays in error
      // rather than going idle when the settle follows.
      if (msg.type === "portal_failed") {
        const failure = String(msg.error ?? "The run failed");
        this.failed.add(sessionId);
        updateSession(sessionId, { status: "error", last_error: failure });
        this.record(sessionId, "portal_status", { status: "error", error: failure });
        return;
      }
      if (msg.type === "agent_start") this.failed.delete(sessionId);
      this.noteCall(sessionId, msg);
      if (msg.type === "queue_update") {
        const lane = (texts: unknown) => (Array.isArray(texts) ? texts.map(String) : []);
        const queue = { steering: lane(msg.steering), followUp: lane(msg.followUp) };
        if (queue.steering.length || queue.followUp.length) this.piQueue.set(sessionId, queue);
        else this.piQueue.delete(sessionId);
      }
      // A model failure reaches no other place in the stream. Noted before the
      // event that settles it, so an ask() finishing on agent_settled has it.
      const modelFailure = this.modelErrors.take(sessionId, msg);
      if (modelFailure) this.record(sessionId, "portal_notice", { text: modelFailure, error: true });
      if (msg.type === "extension_ui_request") this.noteExtensionUi(sessionId, msg);
      // The agent's questions are kept with the chat until they end, rather than live as the dialogs are.
      if (msg.type === "extension_ui_request" && msg.method === "questions") {
        this.record(sessionId, CHAT_QUESTION, {
          id: msg.id,
          ...(msg.title ? { title: msg.title } : {}),
          questions: msg.questions,
          ...(typeof msg.until === "number" ? { until: msg.until } : {}),
        });
      } else if (msg.type === "extension_ui_cancel" && typeof msg.id === "string" && openChatQuestion(sessionId, msg.id)) {
        // A restart stops the run that waits, so that its tool returns, but the question stays open: the portal
        // that starts next draws it again, and its answers go to the agent as a message (see respondUi).
        const outcome = msg.reason === "expired" ? "expired" : "stopped";
        if (!(this.closing && outcome === "stopped")) this.endQuestion(sessionId, msg.id, outcome);
      } else this.record(sessionId, msg.type, forTranscript(msg));
      // Anything a command in hand shows for itself: see endCommand. Only what
      // a person sees in the chat — a line, a dialog, a run, a message — and
      // not a status or widget, which any extension updates on its own clock.
      // A run is one only for a command sent while none was going: into one,
      // the next start is its queued follow-up's.
      if (
        (msg.type === "extension_ui_request" && SHOWN.has(msg.method)) ||
        (msg.type === "message_end" && msg.message?.role === "custom" && msg.message.display)
      ) {
        for (const c of this.commandsInHand.get(sessionId) ?? []) c.said++;
      }
      if (msg.type === "agent_start") {
        for (const c of this.commandsInHand.get(sessionId) ?? []) if (!c.inRun) c.said++;
      }
      // An extension that failed — its command, or a handler of its — says so
      // in the chat. pi's TUI prints it; here it went nowhere. A command that
      // threw is answered as handled, and this is where it says otherwise: the
      // error goes on its line. The notice is kept, marked as that command's,
      // for whoever asked through a channel, whose answer it is.
      if (msg.type === "extension_error") {
        const threw = /^command:(.+)$/.exec(String(msg.extensionPath ?? ""))?.[1];
        const command = threw ? this.commandsInHand.get(sessionId)?.find((c) => c.name === threw && !c.error) : undefined;
        if (command) command.error = String(msg.error ?? "it threw");
        // A handler that throws on every event says so once a run, not on
        // every tool call: once per extension, whatever each error says — one
        // that names an offset, or a count, differs every time. A command's
        // own is always its own.
        const text = extensionFailure(msg.extensionPath, msg.error);
        const who = String(msg.extensionPath ?? "");
        const said = this.failuresSaid.get(sessionId) ?? new Set<string>();
        if (command || !said.has(who)) {
          if (!command) this.failuresSaid.set(sessionId, said.add(who));
          this.record(sessionId, "portal_notice", {
            text,
            error: true,
            from: "extension",
            // The reason, for a server that dies before the command's end is written.
            ...(command ? { of: command.seq, reason: command.error } : {}),
          });
        }
      }
      // A view drawn for pi's terminal: nothing in a browser can draw it.
      // Said, rather than the command seeming to do nothing.
      if (msg.type === "extension_ui_request" && msg.method === "custom") {
        // Named only when it can only be the command's: during a run, a tool
        // can open one too.
        const inHand = this.commandsInHand.get(sessionId) ?? [];
        const owner = inHand.length === 1 && !this.inRun.has(sessionId) ? inHand[0] : undefined;
        this.record(sessionId, "portal_notice", {
          text: `${owner ? `/${owner.name} opens` : "An extension opened"} a view made for pi's terminal, which the browser cannot show.`,
          warning: true,
          from: "extension",
          ...(owner ? { command: owner.seq } : {}),
        });
      }
      // What an extension says with notify — the answer to a command like
      // /bg-update, or news from a job — is a line pi's TUI prints and then
      // forgets. Here the request is live-only, so without this nothing showed
      // and the command seemed to do nothing. Kept in the chat like the
      // output of a builtin.
      if (msg.type === "extension_ui_request" && msg.method === "notify") {
        const text = plain(msg.message);
        // The answer of the one command in hand, as far as can be told: pi
        // does not say which extension spoke. A channel hears only its own.
        const inHand = this.commandsInHand.get(sessionId) ?? [];
        if (text) {
          this.record(sessionId, "portal_notice", {
            text,
            ...(msg.notifyType === "error" ? { error: true } : msg.notifyType === "warning" ? { warning: true } : {}),
            from: "extension",
            ...(inHand.length === 1 ? { command: inHand[0].seq } : {}),
          });
        }
      }
      // Status follows pi's own run state rather than being guessed at the
      // moments the portal happens to know about. agent_start covers a run
      // nobody here asked for — a queued follow-up picked up on its own, a
      // routine, a message that arrived through a channel.
      if (msg.type === "agent_start") {
        this.runsStarted.set(sessionId, (this.runsStarted.get(sessionId) ?? 0) + 1);
        this.inRun.add(sessionId);
        this.failuresSaid.delete(sessionId);
        this.mark(sessionId, "running");
      }
      if (msg.type === "message_start" && msg.message?.role === "user") this.takeIn(sessionId, msg.message.content);
      // agent_settled, not agent_end: agent_end fires once per agent run, and
      // a run is followed by retries, auto-compaction and any queued message,
      // all of it still the model working. Settling on agent_end is what made
      // the Stop button disappear halfway through.
      if (msg.type === "agent_settled") {
        this.inRun.delete(sessionId);
        this.settleWaiting(sessionId);
        if (!this.failed.delete(sessionId)) this.mark(sessionId, "idle");
        if (client.reloadDue) void this.reloadSettled(sessionId, client);
      }
    });

    client.on("stderr", (chunk: string) => {
      const text = chunk.trim();
      if (text) this.record(sessionId, "stderr", { text });
    });

    client.on("exit", ({ code, signal }: { code: number | null; signal: string | null }) => {
      if (this.stopping.has(client)) return;
      if (this.live.get(sessionId)?.client && this.live.get(sessionId)?.client !== client) return;
      this.live.delete(sessionId);
      this.stream.clear(sessionId);
      this.forgetPi(sessionId);
      const current = getSession(sessionId);
      // A clean exit after a finished run is normal; anything else is a failure
      // worth surfacing in the UI rather than leaving as a silent stall.
      if (current?.status === "running") {
        const message = `pi exited unexpectedly (code=${code} signal=${signal})`;
        updateSession(sessionId, { status: "error", last_error: message });
        this.record(sessionId, "portal_status", { status: "error", error: message });
      }
      executor.cleanup?.(sessionId).catch(() => {});
    });

    // One copy, here: what an extension puts in the box outlives the pi that
    // put it there, and a send from the box finds it.
    client.useDrafts?.({ get: () => this.drafts.get(sessionId), set: (text, caret) => this.setDraft(sessionId, text, caret) });
    this.live.set(sessionId, { client, executor });
    chatLife("started", sessionId);
    this.touch(sessionId);

    return client;
  }

  /**
   * Compaction in flight, per session. A cancelled one is still running until
   * pi has unwound it, and both Stop and the next prompt have to wait.
   */
  private compacting = new Map<string, Promise<void>>();

  /** Runs pi has started, per session: whether one began while something else was going. */
  private runsStarted = new Map<string, number>();

  /** A Stop that arrived before there was anything to stop. */
  private cancelPending = new Set<string>();

  /**
   * Stops pressed with no pi to abort, counted per session. A message that was
   * waiting for pi to start when one came is not sent: see submit().
   */
  private stops = new Map<string, number>();

  /**
   * Every Stop pressed, per session, whether pi was up or not. What is waiting
   * on a run reads it before and after, to tell one that was stopped from one
   * that finished: see ask's onStopped.
   */
  private aborts = new Map<string, number>();

  /** Client startup in flight, so two callers cannot launch two of them. */
  private starting = new Map<string, Promise<PiClient>>();

  /** When each running pi last did anything — said an event, was started, was used — for letting an idle one go. */
  private activity = new Map<string, number>();

  private touch(sessionId: string): void {
    if (this.live.has(sessionId)) this.activity.set(sessionId, Date.now());
  }

  private reaper?: NodeJS.Timeout;

  /**
   * Lets the pi of a chat nobody has used for a while go, every minute.
   *
   * Each is a whole pi, every extension loaded and the conversation in memory,
   * or a container of up to a few gigabytes. Nothing else ever released one:
   * thirty people on a channel held thirty, and a routine run in a clean
   * session each hour left twenty-four a day. The chat is not lost — the next
   * message starts pi again from its file — but only where pi can pick it up
   * again: a container's cannot yet (see `Executor.resumes`), so one that was let
   * go would meet the next message as a stranger, and its chats are kept.
   * Started by the server, so that anything that imports this builds no timer.
   */
  startReaper(everyMs = 60_000): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => void this.reapIdle().catch((e) => console.error(`[portal] could not stop idle sessions: ${(e as Error).message}`)), everyMs);
    this.reaper.unref();
  }

  /** The sessions whose pi it stopped. `now` and `idleMs` are for a test to set. */
  async reapIdle(idleMs = IDLE_STOP_MS, now = Date.now()): Promise<string[]> {
    const stopped: string[] = [];
    for (const [id, { client, executor }] of [...this.live]) {
      if (now - (this.activity.get(id) ?? now) < idleMs || this.inUse(id, client)) continue;
      // A pi that cannot carry on its conversation when it is started again
      // would make the next message a new one: not let go for being idle.
      if (executor.resumes === false) continue;
      // Letting pi go tells its extensions, and one that started a build or a
      // dev server in the background ends it then, with nobody told. Its jobs
      // are not use of the chat as far as pi knows, so they are looked for here.
      const seen = this.activity.get(id);
      if (await this.holdsJobs(id)) continue;
      // The look took a moment: the chat may have been used, or let go, since.
      if (this.live.get(id)?.client !== client || this.activity.get(id) !== seen || this.inUse(id, client)) continue;
      await this.stop(id);
      stopped.push(id);
    }
    return stopped;
  }

  /**
   * Whether something this chat started is still running in its folder, whatever
   * ran it: see background.ts. Not the jobs of the other chats that work there:
   * thirty conversations in an agent's home would be held by one dev server.
   * `fresh`: the folder is looked at now, not as it was up to a second ago, for
   * a chat that has only just made its last call.
   */
  async holdsJobs(sessionId: string, fresh = false): Promise<boolean> {
    const workspace = getSession(sessionId)?.workspace;
    if (!BACKGROUND_SUPPORTED || !workspace) return false;
    const jobs = await listJobs(workspace, false, fresh).catch(() => []);
    return jobs.some((job) => job.state !== "exited" && this.startedBy(sessionId, job));
  }

  /** Whether stopping this chat's pi would take something with it: a run, a command, a dialog, a subagent, an edit. */
  private inUse(sessionId: string, client: PiClient): boolean {
    return (
      !client.running ||
      this.isBusy(sessionId) ||
      this.compacting.has(sessionId) ||
      this.editing.has(sessionId) ||
      this.starting.has(sessionId) ||
      (this.prompting.get(sessionId) ?? 0) > 0 ||
      this.sending.has(sessionId) ||
      this.waiting.has(sessionId) ||
      this.commandsInHand.has(sessionId) ||
      this.calls.has(sessionId) ||
      this.backgroundWork(sessionId) ||
      // An extension's server half asked for this chat's pi to be kept while work of its own goes on.
      extensionHolds(sessionId) ||
      client.isIdle?.() === false ||
      (client.dialogsOpen?.() ?? 0) > 0
    );
  }

  /** Move a session's status and tell whoever is watching, in that order. */
  private mark(sessionId: string, status: "running" | "idle"): void {
    if (getSession(sessionId)?.status === status) return;
    updateSession(sessionId, status === "running" ? { status, last_error: null } : { status });
    this.record(sessionId, "portal_status", { status });
  }

  /**
   * Submit a prompt.
   *
   * The session is marked running before anything else, because starting pi
   * for the first message in a session takes seconds and the composer has
   * nothing to show for them otherwise.
   *
   * False when a Stop got there first and the message was never sent.
   * `stopsBefore` is how many Stops the session had had when the caller began to
   * start pi for it, for one that started it before asking: see askNow.
   */
  async prompt(sessionId: string, message: string, options?: PromptOptions, insideEdit = false, stopsBefore?: number): Promise<boolean> {
    // Before the session is marked as anything: nothing of it is to be written once it is going.
    this.refuseIfDiscarded(sessionId);
    // Callers ask first, where there is someone to tell; this is so that one
    // which did not is refused too, before the session is marked as anything.
    const refused = options?.images?.length ? await picturesRefused(message) : undefined;
    if (refused) throw new SessionEditError("unsupported", refused);
    // Behind an edit in progress, not through it: see withEdit.
    if (!insideEdit) await this.whenEditable(sessionId);
    // A reload that came due while something went on that it would have cut off, and that nothing has taken since:
    // before this message starts a run, so the run's first request has the tools as they are now. Not where a run
    // is going or a message is on its way to pi: a step of that run takes it. Read from the status, which says both,
    // not from isBusy(): that counts a message ask() is sending, and so this one where ask() sent it.
    const due = this.live.get(sessionId)?.client;
    if (!insideEdit && due?.reloadDue && getSession(sessionId)?.status !== "running") await this.reloadSettled(sessionId, due);
    this.prompting.set(sessionId, (this.prompting.get(sessionId) ?? 0) + 1);
    try {
      return await this.promptNow(sessionId, message, options, insideEdit, stopsBefore);
    } finally {
      const left = (this.prompting.get(sessionId) ?? 1) - 1;
      if (left) this.prompting.set(sessionId, left);
      else this.prompting.delete(sessionId);
    }
  }

  /**
   * Prompts on their way in, per session, past the wait for an edit: an edit
   * whose run failed does not go back over one. See settleEdit.
   */
  private prompting = new Map<string, number>();

  private async promptNow(sessionId: string, message: string, options: PromptOptions | undefined, insideEdit: boolean, stopsBefore?: number): Promise<boolean> {
    this.mark(sessionId, "running");
    // Same reason as in abort(): a session mid-compaction is detached from
    // agent events, and a prompt started there is invisible.
    await this.settleCompaction(sessionId);
    // The compaction published idle on its way out, after this prompt had
    // already claimed the session. Without this the composer loses its Stop
    // and isBusy() reads false for however long pi takes to answer.
    this.mark(sessionId, "running");
    const logged = { images: false, queued: false, command: false, failedOnLine: false };
    try {
      return await this.submit(sessionId, message, options, insideEdit, logged, stopsBefore);
    } catch (e) {
      const busy = this.live.get(sessionId)?.client.isIdle?.() === false;
      // A command refused: its line in the chat says so, and why. The chat
      // itself did not fail, and saying it did put the same error there twice.
      // Only while pi is still up: one that died has said so, and set the
      // chat in error, before the refusal got here.
      if (logged.failedOnLine) {
        if (!busy && this.live.has(sessionId)) this.mark(sessionId, "idle");
        throw new CommandFailed((e as Error).message);
      }
      // Refused on its way into a run that goes on — a message queued into
      // it, or a command sent beside it: that run is not what failed, and
      // will settle the session itself. Marked failed, the page would take
      // every call still open in it for one that was cut off.
      const failure = plainFailure((e as Error).message);
      if (!((logged.queued || logged.command) && busy)) {
        updateSession(sessionId, { status: "error", last_error: failure });
        this.record(sessionId, "portal_status", { status: "error", error: failure });
      }
      throw failure === (e as Error).message ? e : new Error(failure);
    } finally {
      // Pictures no event names are never shown again, so they are not kept:
      // a message that never got there, or a command that went to pi without a
      // chat line. An edit's are the original message's, which an undo brings back.
      if (!insideEdit && !logged.images && options?.images?.length) dropImages(IMAGE_ROOT, sessionId, options.images);
    }
  }

  private async submit(
    sessionId: string,
    message: string,
    options?: PromptOptions,
    insideEdit = false,
    logged = { images: false, queued: false, command: false, failedOnLine: false },
    stopsBefore = this.stops.get(sessionId) ?? 0,
  ): Promise<boolean> {
    const client = await this.ensureClient(sessionId, insideEdit);
    const images = options?.images ?? [];
    // Stop pressed while pi was still starting for it. There was no run to
    // abort then, so it is honoured here: the message goes back to the person
    // as not sent, where it would otherwise be answered seconds later.
    if ((this.stops.get(sessionId) ?? 0) !== stopsBefore) {
      const prompt = {
        message,
        ...(options?.voice ? { voice: true } : {}),
        ...(images.length ? { images: forLog(images) } : {}),
        queued: true,
      };
      const row = this.record(sessionId, "portal_prompt", prompt);
      if (row) {
        logged.images = images.length > 0;
        this.record(sessionId, "portal_unsent", { seqs: [row.seq], prompts: { [row.seq]: prompt } });
      }
      updateSession(sessionId, { status: "idle" });
      this.record(sessionId, "portal_status", { status: "idle", aborted: true });
      return false;
    }
    // Sent from the box, which the page empties as it sends: said here too,
    // or a command reading the box would find itself there.
    if (this.drafts.get(sessionId)?.text.trim() === message.trim()) this.setDraft(sessionId, "");

    // A slash command is an instruction to the agent, not something said in the
    // conversation, so it should not appear as a chat message — its dialog or
    // output is the feedback. Matched against the real command list rather than
    // a bare leading slash, so a message that merely starts with a path like
    // "/etc/hosts is wrong" is still shown.
    const isCommand = await this.looksLikeCommand(client, message);
    logged.command = isCommand;

    // Portal builtins never reach the model — they act on the session itself.
    const builtin = /^\/([\w-]+)\s*(.*)$/.exec(message.trim());
    const serverBuiltin = builtin ? await findServerBuiltin(builtin[1]) : undefined;
    // A command runs in the portal's own process, with its full rights, and no
    // tool call is made that the guard could refuse: it is for the primary user
    // alone. Refused as a command that failed, which the chat is not.
    if ((isCommand || serverBuiltin) && this.speakerRole(sessionId) !== "primary") {
      recordAudit({
        kind: "refused",
        reason: "A command is for the primary user alone",
        subject: message.trim().slice(0, 200),
        personKey: this.speakerKey(sessionId),
        sessionId,
      });
      // The line the caller leaves the word to: the page empties the box as it
      // sends, so without one the text would be gone and nothing said why.
      const refusal = "Commands can only be run by the primary user.";
      this.endCommand(sessionId, this.startCommand(sessionId, message), { error: refusal });
      logged.failedOnLine = true;
      throw new Error(refusal);
    }
    // A command is not a chat message, but it is in the chat: a line that
    // says it was sent, and then whether it is running, done, started a run,
    // or failed. Without one a command that answers nothing looked unsent.
    const command = isCommand || serverBuiltin ? this.startCommand(sessionId, message) : undefined;
    if (serverBuiltin) {
      // Not awaited: /compact is a model call and would hold the request open.
      // Same contract as a prompt — accept it, report through the event stream.
      // Whether a run was going is read before it starts: afterwards, pi can
      // still read as busy with the builtin's own work, a compaction unwinding.
      const during = client.isIdle?.() === false;
      const runs = this.runsStarted.get(sessionId) ?? 0;
      void (async () => {
        try {
          const text = await runBuiltin(serverBuiltin.name, builtin![2], client);
          this.record(sessionId, "portal_notice", { text });
          if (command) this.endCommand(sessionId, command, { outcome: "handled", said: true });
        } catch (e) {
          // Marked as the command's, as an extension's failure is: its line says it.
          this.record(sessionId, "portal_notice", { text: (e as Error).message, error: true, ...(command ? { of: command.seq } : {}) });
          if (command) this.endCommand(sessionId, command, { error: (e as Error).message });
        } finally {
          // Sent into a run, or overtaken by one — started, or on its way to
          // pi — it must not end it: the run settles the session itself, and
          // a page told idle would take every call still open for one that
          // was cut off. Sent from idle, nothing else will clear it.
          const overtaken = (this.runsStarted.get(sessionId) ?? 0) !== runs || this.sending.has(sessionId);
          if (!during && !overtaken && !this.compacting.has(sessionId)) this.mark(sessionId, "idle");
        }
      })();
      return true;
    }

    // Into a run that is going, it waits for pi to take it in. So does one
    // behind a message still on its way to pi: pi reads as idle through the
    // whole of that one's preflight — extension handlers, a compaction check —
    // and only then starts the run this one will be queued into.
    const ahead = isCommand ? undefined : this.sending.get(sessionId);
    const queued = !isCommand && (ahead !== undefined || (client.isIdle ? !client.isIdle() : false));
    logged.queued = queued;
    let waiting: Waiting | undefined;
    const prompt = {
      message,
      ...(options?.voice ? { voice: true } : {}),
      ...(images.length ? { images: forLog(images) } : {}),
      ...(queued ? { queued: true } : {}),
      // Taken in after the current step, rather than when the run ends.
      ...(queued && options?.steer ? { steer: true } : {}),
    };
    const row = isCommand ? undefined : this.record(sessionId, "portal_prompt", prompt);
    if (row) {
      logged.images = images.length > 0;
      options?.onRecorded?.(row.seq, queued);
      if (queued) {
        waiting = { seq: row.seq, message, images: images.length, prompt };
        this.waiting.set(sessionId, [...(this.waiting.get(sessionId) ?? []), waiting]);
      }
    }
    // Starts a run of its own, when it does: its start is not a waiting
    // message's. See fresh.
    let own: { waiting?: Waiting } | undefined;
    const unfresh = () => {
      const starting = this.fresh.get(sessionId);
      if (!own || !starting?.includes(own)) return;
      starting.splice(starting.indexOf(own), 1);
      if (!starting.length) this.fresh.delete(sessionId);
    };
    // One at a time into pi, in the order they were sent, each once the one
    // before has been accepted — by then its run has begun, and pi queues
    // this one into it instead of starting a second run alongside. A command
    // does not wait: it runs beside a run rather than in it.
    let handed!: () => void;
    const mine = new Promise<void>((resolve) => (handed = resolve));
    const tail = ahead ? ahead.then(() => mine) : mine;
    if (!isCommand) this.sending.set(sessionId, tail);
    let taken: PromptTaken | void;
    try {
      // pi sends a model that cannot see pictures a line saying one was left
      // out, and nothing else. The person is told here, where they can pick
      // another model — and before the answer, which is where it explains it.
      if (images.length) {
        const model = await client.getState().catch(() => undefined);
        const input = model?.model.input;
        if (input && !input.includes("image")) {
          this.record(sessionId, "portal_notice", {
            text: `${model!.model.name} cannot see pictures, so ${images.length === 1 ? "the picture was" : "the pictures were"} left out. Pick a model that takes images to send ${images.length === 1 ? "it" : "them"}.`,
            error: true,
          });
        }
      }
      if (ahead) await ahead;
      // Stopped while it was on its way: already marked as not sent, and pi
      // would otherwise start a run with it that nobody asked for.
      if (waiting && !this.waiting.get(sessionId)?.includes(waiting)) return false;
      // Whether it starts a run is read now, with nothing awaited between here
      // and the prompt: a run that began while this one waited its turn would
      // queue it, and its start taken for this one's put a waiting message in
      // the wrong place. Set before the prompt: pi can start the run, and the
      // message, before the prompt comes back.
      if (!isCommand && (client.isIdle ? client.isIdle() : !queued)) {
        own = { waiting };
        this.fresh.set(sessionId, [...(this.fresh.get(sessionId) ?? []), own]);
      }
      const sent = client.prompt(message, {
        voice: options?.voice,
        ...(images.length ? { images: forPi(images) } : {}),
        ...(options?.steer ? { steer: true } : {}),
      });
      if (waiting) waiting.handing = sent.then(() => {}, () => {});
      try {
        taken = await sent;
      } catch (e) {
        if (command) {
          this.endCommand(sessionId, command, { error: (e as Error).message });
          logged.failedOnLine = true;
        }
        unfresh();
        // Refused, so never queued: nothing for pi to take in. Out of the
        // transcript too — its words go back to the box they came from, and
        // left there as well it would wait at the foot of the chat for good.
        if (waiting && this.unwait(sessionId, waiting)) {
          deleteEvent(waiting.seq);
          this.tellRemoved(sessionId, { from: waiting.seq, to: waiting.seq + 1 });
          logged.images = false;
        }
        throw e;
      }
      if (taken && taken.outcome !== "started") unfresh();
      if (taken?.outcome === "queued") {
        const queuedAs = { lane: taken.lane, text: taken.text };
        if (isCommand) {
          this.queuedCommands.set(sessionId, [...(this.queuedCommands.get(sessionId) ?? []), { command: message, queued: queuedAs }]);
        } else if (!waiting && row) {
          // A run began in the moment it was handed over, and pi queued it:
          // it waits for that run to take it in after all, like any other,
          // and is moved to where it does.
          const late = { queued: true, ...(options?.steer ? { steer: true } : {}) };
          waiting = { seq: row.seq, message, images: images.length, prompt: { ...prompt, ...late } };
          this.waiting.set(sessionId, [...(this.waiting.get(sessionId) ?? []), waiting]);
          notePromptQueued(row.seq, late);
        }
        if (waiting) {
          waiting.queuedAs = queuedAs;
          // Kept with the message where pi made something else of it, for a
          // server that dies before pi reads it: see settleOrphanedMessages.
          if (unspoken(taken.text) !== message) notePromptQueued(waiting.seq, { queuedAs: taken.text });
        }
      } else if (taken?.outcome === "handled" && waiting) {
        // An extension took it and no run will: this is where it went in.
        this.placeTaken(sessionId, waiting);
      }
      if (command) this.endCommand(sessionId, command, { outcome: taken ? taken.outcome : "handled" });
      if (waiting) {
        waiting.handing = undefined;
        waiting.inPi = true;
      }
    } finally {
      handed();
      if (this.sending.get(sessionId) === tail) this.sending.delete(sessionId);
    }
    // A slash command completes inside prompt() without ever starting an agent
    // turn, so no agent_settled arrives to clear the status. Settle it here
    // rather than leaving "working" on screen forever. Asking pi rather than
    // assuming: a message sent mid-run is queued and returns from prompt()
    // immediately, with the model still going.
    if (client.isIdle?.()) {
      // Taken without a run — an extension handled it — so no start of its
      // own is coming, and the next one must not be taken for it.
      unfresh();
      this.mark(sessionId, "idle");
    }
    return true;
  }

  /**
   * Take a message back out of the conversation.
   *
   * Out of pi's record as well as the transcript: see session-edit.ts for why
   * the second half is the point. Refused while a run is going — the agent
   * would be answering something that is being removed underneath it.
   */
  async removeMessage(sessionId: string, seq: number, scope: Scope): Promise<void> {
    await this.withEdit(sessionId, async () => {
      // Its own other versions, and those of the messages after it: those went
      // on from a conversation with it in, and would bring it back. Its own,
      // left, would pass to the message after it. Versions kept inside other
      // branches are left: this message was never in those.
      const sent = sentMessages(sessionId);
      const at = sent.findIndex((m) => m.seq === seq);
      const anchors = at < 0 ? [] : [sent[at - 1]?.seq ?? 0, ...sent.slice(at).map((m) => m.seq)];
      // With the cut: forgotten afterwards, a failure left the message gone
      // from the file and the transcript without the page being told.
      const { removed } = await this.cut(sessionId, seq, scope, { within: () => dropVersionsAt(sessionId, anchors) });
      this.tellRemoved(sessionId, removed);
      this.tellVersions(sessionId);
    });
  }

  /** Edits waiting to finish, by session. */
  private editing = new Map<string, Promise<void>>();

  /**
   * One edit at a time on a conversation, and nothing else starting pi on it.
   *
   * An edit rewrites the file pi reads and drops events; a prompt arriving in
   * the middle would open a client on the old conversation, or have its own
   * event deleted with the tail. Held from before the busy check to after the
   * replacement is sent or the old conversation is back. Other callers wait for
   * it rather than fail — a message from a channel arrives a moment late instead
   * of not at all — while a second edit is refused.
   */
  private async withEdit<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    if (this.editing.has(sessionId)) {
      throw new SessionEditError("busy", "This conversation is already being edited.");
    }
    let release!: () => void;
    this.editing.set(sessionId, new Promise<void>((resolve) => (release = resolve)));
    try {
      return await work();
    } finally {
      this.editing.delete(sessionId);
      release();
    }
  }

  private async whenEditable(sessionId: string): Promise<void> {
    for (let edit = this.editing.get(sessionId); edit; edit = this.editing.get(sessionId)) await edit;
  }

  /**
   * The removal itself, without telling anyone, and with a way back.
   *
   * Two things are changed — pi's file and the transcript — and they have to
   * stay in step. The file goes first, since a message gone from the screen but
   * still remembered by the agent is the worse of the two ways to be wrong. If
   * the transcript then fails to update, the file is put back. `undo` does the
   * same later, for a caller whose next step failed.
   */
  private async cut(
    sessionId: string,
    seq: number,
    scope: Scope,
    options: {
      /** Keep what goes as a version of the message, to switch back to: see message_versions. */
      keep?: boolean;
      /** More to write in the same transaction as the cut: all of it lands, or none. */
      within?: () => void;
      /**
       * What pi's file will be once this is done, where not the cut itself —
       * another version switched to — made from the file as it is once pi
       * has stopped, which is when it is read. What the kept version shares
       * with it is the conversation it goes back onto. May refuse by throwing:
       * nothing has changed yet.
       */
      becomes?: (now: string | undefined) => string | undefined;
    } = {},
  ): Promise<{ removed: Removed; undo: () => Promise<void> }> {
    const { keep = false, within, becomes } = options;
    const session = getSession(sessionId);
    if (!session) throw new SessionEditError("missing", "Unknown session");
    if (this.isBusy(sessionId) || this.compacting.has(sessionId)) {
      throw new SessionEditError("busy", "Stop the run first — the agent is still working.");
    }
    // Editing restarts the chat's pi, which a subagent in the background goes with, and one of its child chats waits on.
    const working = this.stillWorking(sessionId);
    if (working) throw new SessionEditError("busy", working);

    const sent = sentMessages(sessionId);
    const ordinal = sent.findIndex((m) => m.seq === seq);
    if (ordinal < 0) throw new SessionEditError("missing", "That message is not in this conversation");

    // Released before the file changes: a live pi holds the conversation in
    // memory and would write its own version back over the edit. The next
    // prompt reopens it from the file. One still starting — the model picker
    // and the command list launch it without a run — is waited for first, or it
    // would go live on the old conversation once the file was rewritten.
    await this.settleStart(sessionId);
    await this.stop(sessionId);

    // Read again: that launch may have been the one to record the file.
    const file = getSession(sessionId)?.pi_session_file ?? session.pi_session_file;
    const write = (text: string) => rewrite(file!, text);
    let original: string | undefined;
    let cutText: string | undefined;
    if (file && existsSync(file)) original = readFileSync(file, "utf8");
    const replacement = becomes?.(original);
    if (original !== undefined) {
      cutText = dropMessage(
        original,
        // In pi's file as pi queued it, where it made something else of it.
        sent.slice(0, ordinal + 1).map((m) => String(m.payload.queuedAs ?? m.message)),
        ordinal,
        scope,
      );
      write(cutText);
    } else if (session.executor !== "host") {
      throw new SessionEditError("unsupported", "Messages cannot be edited in a container session.");
    }

    // Where the message sits, not the seq it was sent at: one sent into a run
    // was read later, and what the agent did in between is still in its file.
    const from = sent[ordinal].at;
    const to = scope === "tail" ? null : (sent[ordinal + 1]?.at ?? null);
    // The events and the version that keeps them go together, or neither
    // does: kept after the fact, a version that failed to save lost the turn.
    let gone: ReturnType<typeof deleteEventsBetween>;
    let kept: number | undefined;
    try {
      ({ gone, kept } = atomically(() => {
        const gone = deleteEventsBetween(sessionId, from, to);
        const kept =
          keep && scope === "tail"
            ? saveVersion(sessionId, { anchor: sent[ordinal - 1]?.seq ?? 0, seq, rows: gone.rows, ...keptFile(original, replacement ?? cutText) })
            : undefined;
        within?.();
        return { gone, kept };
      }));
    } catch (e) {
      if (original !== undefined) write(original);
      throw e;
    }
    const undo = async () => {
      const working = this.stillWorking(sessionId);
      if (working) throw new SessionEditError("busy", working);
      // A client started since would hold the edited conversation in memory.
      await this.settleStart(sessionId);
      await this.stop(sessionId);
      // The transcript first, in one go, and the file last: a disk that
      // failed the step being undone can fail this write too, and done first
      // it left the conversation shown gone and its version unreachable.
      atomically(() => {
        restoreEvents(gone.rows);
        if (kept !== undefined) dropVersion(kept);
      });
      if (original !== undefined) write(original);
    };
    return { removed: { from, to, also: gone.also, kept: gone.kept }, undo };
  }

  /**
   * Replace a message: everything from it onwards goes, and the new text is
   * sent in its place.
   *
   * Answered, and the conversation let go, once pi has the replacement — not
   * once it has answered it: on a long chat the model can read for minutes
   * before it says anything, and holding the edit that long held every steer,
   * channel message and routine sent to the chat behind it. Until the answer
   * comes the conversation it replaced can still come back: see settleEdit.
   */
  async editMessage(sessionId: string, seq: number, message: string): Promise<void> {
    const edit = await this.withEdit(sessionId, async () => {
      // Read before the cut takes the event away: a retried or rewritten
      // message goes with the pictures it was sent with.
      const images = loadImages(IMAGE_ROOT, sessionId, storedIn(sentMessage(sessionId, seq)?.payload));
      if (!message.trim() && !images.length) throw new SessionEditError("empty", "A message needs words or a picture");
      // Before the cut, which would otherwise be done only to be undone.
      const refused = images.length ? await picturesRefused(message) : undefined;
      if (refused) throw new SessionEditError("unsupported", refused);
      // What followed is kept, as the message's earlier version, and goes from
      // the page now: shown until the answer came, the replacement looked
      // added under the old conversation rather than put in its place.
      const { removed, undo } = await this.cut(sessionId, seq, "tail", { keep: true });
      const before = latestSeq();
      this.tellRemoved(sessionId, { ...removed, to: before + 1 });
      const answered = this.firstAnswer(sessionId);
      try {
        await this.prompt(sessionId, message, images.length ? { images } : undefined, true);
      } catch (e) {
        answered.cancel();
        // The replacement never got to the agent, so the conversation it was
        // meant to replace is still the conversation: nothing may be lost to a
        // model that was down or a client that would not start.
        await this.revertEdit(sessionId, undo, before);
        throw e;
      }
      // Now that the replacement has its place: the versions are its.
      this.tellVersions(sessionId);
      // Nothing else could be sent while the edit held the chat: what comes
      // after this is the chat going on from the replacement.
      return { undo, before, sent: latestSeq(), answered: answered.promise };
    });
    void this.settleEdit(sessionId, edit);
  }

  /**
   * An edit whose replacement pi has taken, once its run has answered or
   * failed.
   *
   * Answered, it stands. Failed before a word of answer — the model down, the
   * run refused — the conversation it replaced comes back, as it would have
   * had the replacement been refused outright. Unless the chat has gone on
   * from the replacement in the meantime — something else sent, or on its
   * way — when going back would take that with it: the edit stands then, with
   * the error that says what happened to its run, and the old conversation is
   * one of the message's versions.
   */
  private async settleEdit(
    sessionId: string,
    edit: { undo: () => Promise<void>; before: number; sent: number; answered: Promise<void> },
  ): Promise<void> {
    const failure = await edit.answered.then(
      () => undefined,
      (e: Error) => e,
    );
    if (!failure) return;
    try {
      await this.withEdit(sessionId, async () => {
        const since = sentMessages(sessionId).some((m) => m.seq > edit.sent);
        if (since || this.prompting.get(sessionId) || this.sending.has(sessionId)) return;
        await this.revertEdit(sessionId, edit.undo, edit.before);
        this.record(sessionId, "portal_notice", {
          text: `The edited message got no answer (${failure.message}), so the conversation is back as it was.`,
          error: true,
        });
      });
    } catch (e) {
      // Another edit got there first: it is working on the conversation as
      // it now stands, replacement and all.
      console.error(`[portal] could not settle the edit of ${sessionId}: ${(e as Error).message}`);
    }
  }

  /**
   * The conversation an edit replaced, back; what the replacement recorded,
   * gone. The page had already dropped the old one, so it loads the chat again.
   */
  private async revertEdit(sessionId: string, undo: () => Promise<void>, before: number): Promise<void> {
    await undo();
    // The transcript recorded the replacement, and whatever its run did
    // before it failed. The error that says why stays.
    deleteEventsAfter(sessionId, before);
    this.reloadPages(sessionId);
  }

  /**
   * Events came back under the seqs they had, below where every page's
   * stream has read to: each page holding the chat loads it again. Told live;
   * a page that was away hears it from the count its stream starts with,
   * which is not the one it last saw (see bumpReloads). Not a row in the
   * transcript, which every page replayed and every version kept a copy of.
   */
  private reloadPages(sessionId: string): void {
    this.record(sessionId, "portal_reload", { reloads: bumpReloads(sessionId) });
    this.tellVersions(sessionId);
  }

  /**
   * Tells each page holding the chat what went from it. Said live only, so the
   * count a stream starts with goes up too: a page that was away when it was
   * said loads the chat again rather than keep what went. The pages that heard
   * it take the new count from it, and do not.
   */
  private tellRemoved(sessionId: string, removed: Removed): void {
    this.record(sessionId, "portal_removed", { ...removed, reloads: bumpReloads(sessionId) });
  }

  /** Tells each page holding the chat the versions of its messages, which changed: see messageVersions. */
  private tellVersions(sessionId: string): void {
    this.record(sessionId, "portal_versions", { versions: this.messageVersions(sessionId) });
  }

  /**
   * Shows another version of a message: what followed it when it was sent
   * the time that `to` names. What follows it now is kept as a version in
   * turn, and the agent's own record of the conversation goes back with it —
   * the next message goes on from what is on screen.
   */
  async switchVersion(sessionId: string, seq: number, to: number): Promise<void> {
    await this.withEdit(sessionId, async () => {
      const sent = sentMessages(sessionId);
      const ordinal = sent.findIndex((m) => m.seq === seq);
      if (ordinal < 0) throw new SessionEditError("missing", "That message is not in this conversation");
      const anchor = sent[ordinal - 1]?.seq ?? 0;
      const wanted = findVersion(sessionId, anchor, to);
      if (!wanted) throw new SessionEditError("missing", "That version of the message is gone");
      // pi's file as it was then, from the start the two have in common, now:
      // checked once pi has stopped and before anything changes, so one that
      // cannot be is refused.
      const file = getSession(sessionId)?.pi_session_file;
      let restored: string | undefined;
      const { undo } = await this.cut(sessionId, seq, "tail", { keep: true, becomes: (now) => (restored = fileFor(wanted, now)) });
      // Taken out of the kept versions and put back in the transcript in one
      // go: a failure between the two lost the version asked for. Anything
      // failing puts the conversation back as it was, with both versions.
      let target: ReturnType<typeof takeVersion>;
      try {
        target = atomically(() => {
          const t = takeVersion(sessionId, anchor, to);
          if (t) restoreEvents(t.rows);
          return t;
        });
      } catch (e) {
        await undo();
        throw e;
      }
      if (!target) {
        await undo();
        throw new SessionEditError("missing", "That version of the message is gone");
      }
      if (file && restored !== undefined) {
        try {
          rewrite(file, restored);
        } catch (e) {
          const { id: _, ...back } = target;
          try {
            atomically(() => {
              deleteEventSeqs(back.rows.map((r) => r.seq));
              saveVersion(sessionId, back);
            });
          } catch (inner) {
            // Kept or not, it must not stay in the transcript beside what
            // comes back below: the version is lost rather than shown mixed
            // with the other. The error that says why the switch failed is the
            // one to report.
            console.error(`[portal] could not keep the version of ${sessionId} a failed switch was taking: ${(inner as Error).message}`);
            deleteEventSeqs(back.rows.map((r) => r.seq));
          }
          await undo();
          throw e;
        }
      }
      this.reloadPages(sessionId);
    });
  }

  /**
   * The versions of each message that has more than one, by the seq of the
   * one shown: the seqs of all of them, oldest first, that one among them.
   */
  messageVersions(sessionId: string): Record<number, number[]> {
    const kept = versionSeqs(sessionId);
    if (!kept.length) return {};
    const byAnchor = new Map<number, number[]>();
    for (const v of kept) byAnchor.set(v.anchor, [...(byAnchor.get(v.anchor) ?? []), v.seq]);
    const sent = sentMessages(sessionId);
    const out: Record<number, number[]> = {};
    sent.forEach((m, i) => {
      const others = byAnchor.get(sent[i - 1]?.seq ?? 0);
      if (others) out[m.seq] = [...others, m.seq].sort((a, b) => a - b);
    });
    return out;
  }

  /**
   * Resolves once the run a prompt is starting has answered — a reply from
   * the model that is not an error — or was stopped, or once pi has taken
   * the prompt without a run at all. Rejects if the run fails first, or ends
   * without an answer: a model that is down is retried, recorded as an error
   * reply, and settled, without anything ever throwing. Attached before the
   * prompt is sent, since all of it can happen before the prompt returns.
   */
  private firstAnswer(sessionId: string): { promise: Promise<void>; cancel: () => void } {
    const key = `session:${sessionId}`;
    let cancel!: () => void;
    const promise = new Promise<void>((resolve, reject) => {
      let started = false;
      let error: string | undefined;
      const done = (failure?: string) => {
        cancel();
        if (failure === undefined) resolve();
        else reject(new Error(failure));
      };
      const onEvent = (row: { type: string; payload: string }) => {
        let p: any = {};
        try {
          p = JSON.parse(row.payload);
        } catch {
          return;
        }
        if (row.type === "agent_start") started = true;
        else if (row.type === "message_end" && p.message?.role === "assistant") {
          if (p.message.stopReason !== "error") done();
          else error = String(p.message.errorMessage ?? error ?? "The model answered with an error");
        } else if (row.type === "portal_status" && p.status === "error") done(String(p.error ?? error ?? "The run failed"));
        // Stopped by the person: the edit is what they stopped, not undid.
        else if (row.type === "portal_status" && p.status === "idle" && p.aborted) done();
        else if (row.type === "agent_settled") done(error ?? "The run ended without an answer");
        // Idle with no run begun: an extension took it, and that is all.
        else if (row.type === "portal_status" && p.status === "idle") done(started ? (error ?? "The run ended without an answer") : undefined);
      };
      cancel = () => this.off(key, onEvent);
      this.on(key, onEvent);
    });
    // A prompt refused outright throws on its own; nothing waits on this then.
    promise.catch(() => {});
    return { promise, cancel };
  }

  /**
   * Prompt and wait for the answer.
   *
   * The inverse of prompt(), which returns the moment pi accepts a message —
   * the property the whole portal is built on. A channel needs the opposite:
   * somebody is sitting in a chat waiting for a reply, so this blocks until the
   * turn finishes and hands back what the agent said.
   *
   * Serialised per session. Two messages arriving in the same chat while the
   * agent is still working would otherwise interleave, and both callers would
   * see whichever agent_end came first.
   */
  ask(
    sessionId: string,
    message: AskMessage,
    opts: {
      beforeTurn?: () => Promise<void> | void;
      timeoutMs?: number;
      /**
       * Relays what happens during the run — assistant prose as each stretch
       * completes, and the name of every tool as it starts.
       */
      onReply?: (text: string) => void | Promise<void>;
      /**
       * Whether prose goes through onReply as well as tool lines.
       *
       * When it does, ask() resolves with "" — it has all been handed over, and
       * returning it too would post everything twice. When it does not, only
       * tool lines are relayed and the prose comes back at the end, which is
       * what a channel showing activity but not partial answers wants.
       */
      streamText?: boolean;
      /**
       * Called when the run ended because somebody pressed Stop, before ask()
       * hands back what the agent had written by then. Without it a stopped run
       * reads as one that finished, and a routine records half an answer as done.
       */
      onStopped?: () => void;
      /**
       * An extension asking the user something mid-run. The browser draws a
       * modal for these; a channel has to ask in the chat and wait for the
       * next message, so it needs to know one is open.
       */
      onUi?: (request: any) => void;
      /**
       * A picture a call gave the person (see file-outputs.ts), read from the
       * chat's folder: a channel has no page to draw it on, so it is sent on
       * as it is shown. `onVideo` is the same for a clip. A file the channel
       * has no way to send is named in the reply instead.
       */
      onPicture?: (picture: SentFile) => void | Promise<void>;
      onVideo?: (video: SentFile) => void | Promise<void>;
    } = {}
  ): Promise<string> {
    const previous = this.asking.get(sessionId) ?? Promise.resolve("");
    const next = previous
      .catch(() => "")
      .then(async () => {
        await this.waitForIdle(sessionId, opts.timeoutMs ?? 15 * 60_000);
        await opts.beforeTurn?.();
        return this.askNow(
          sessionId,
          message,
          opts.timeoutMs ?? 15 * 60_000,
          opts.onReply,
          opts.streamText,
          opts.onUi,
          opts.onStopped,
          { picture: opts.onPicture, video: opts.onVideo }
        );
      });
    // Kept only while it is the newest, so a finished chain is not held forever.
    this.asking.set(sessionId, next);
    void next.catch(() => {}).finally(() => {
      if (this.asking.get(sessionId) === next) this.asking.delete(sessionId);
    });
    return next;
  }

  private async waitForIdle(sessionId: string, timeoutMs: number): Promise<void> {
    if (getSession(sessionId)?.status !== "running") return;
    await new Promise<void>((resolve, reject) => {
      const key = `session:${sessionId}`;
      const finish = (error?: Error) => { clearTimeout(timer); this.off(key, check); error ? reject(error) : resolve(); };
      const check = () => { if (getSession(sessionId)?.status !== "running") finish(); };
      const timer = setTimeout(() => finish(new Error("Previous turn is still running")), timeoutMs);
      this.on(key, check);
      check();
    });
  }

  private async askNow(
    sessionId: string,
    message: AskMessage,
    timeoutMs: number,
    onReply?: (text: string) => void | Promise<void>,
    streamText = true,
    onUi?: (request: any) => void,
    onStopped?: () => void,
    send: { picture?: (picture: SentFile) => void | Promise<void>; video?: (video: SentFile) => void | Promise<void> } = {}
  ): Promise<string> {
    // Counted before pi is started here, not in submit: a Stop that comes while
    // it starts is counted by then, and submit would take it for one that was
    // there before the message.
    const stopsBefore = this.stops.get(sessionId) ?? 0;
    const abortsBefore = this.aborts.get(sessionId) ?? 0;
    await this.ensureClient(sessionId);
    const prepared: PreparedPrompt = typeof message === "function" ? message() : { message };

    // pi emits one assistant message per stretch of talking, broken up by tool
    // calls. Each is flushed as it closes so a channel can relay progress
    // rather than sitting silent while a long task runs.
    let current = "";
    const all: string[] = [];
    let settle: (() => void) | undefined;
    let fail: ((e: Error) => void) | undefined;

    // Delivery is the channel's problem; a failure there must not take down the
    // run that produced it.
    const relay = (line: string) => void Promise.resolve(onReply?.(line)).catch(() => {});

    const flush = () => {
      const done = current.trim();
      current = "";
      if (!done) return;
      all.push(done);
      if (streamText) relay(done);
    };

    // The command this ask sent, once its line is written: what an extension
    // says for it is the answer. What one says for anything else is not.
    let mine: number | undefined;
    const onEvent = (row: { seq?: number; type: string; payload: string }) => {
      let payload: any = {};
      try {
        payload = JSON.parse(row.payload);
      } catch {
        return;
      }
      switch (row.type) {
        case "message_update": {
          const inner = payload.assistantMessageEvent ?? {};
          // Thinking deltas are not the answer, and nobody in a chat wants them.
          if (inner.type === "text_delta" && typeof inner.delta === "string") {
            current += inner.delta;
          }
          break;
        }
        case "message_end":
          flush();
          break;

        // What a call gave the person is part of the answer, whatever the
        // channel relays of the work: a picture or a clip is sent on as it is
        // shown, where the channel can send one, and any other file is named,
        // as is one the channel failed to send. The words that go with it are
        // the agent's, after it.
        case "tool_execution_end": {
          const files = shownFiles(payload);
          if (!files.length) break;
          flush();
          for (const file of files) {
            const name = () => {
              const named = `📎 ${file.title ? `${file.title} (${file.path})` : file.path}`;
              all.push(named);
              if (streamText) relay(named);
            };
            const to = file.kind === "picture" ? send.picture : file.kind === "video" ? send.video : undefined;
            const read = to && this.fileShown(sessionId, file);
            if (read) void Promise.resolve(to!({ ...read, ...(file.title ? { title: file.title } : {}) })).catch(name);
            else name();
          }
          break;
        }

        case "tool_execution_start": {
          if (!onReply) break;
          // Prose first: a tool line landing mid-sentence reads badly.
          flush();
          const { name, detail } = describeToolCall(payload);
          relay(detail ? `⚙ ${name} · ${detail}` : `⚙ ${name}`);
          break;
        }
        case "portal_command":
          if (mine === undefined && payload.text === prepared.message.trim()) mine = row.seq;
          break;
        // Output from a builtin like /session or /compact, or a model failure
        // pi gave up on. It is the answer as far as whoever asked is concerned,
        // so it goes back like any other. One pi recovered from never gets here.
        case "portal_notice":
          // An extension's news, or its failure, belongs to a channel only if it
          // was for the command that channel sent.
          if (payload.from === "extension" && (mine === undefined || (payload.of !== mine && payload.command !== mine))) break;
          flush();
          if (typeof payload.text === "string" && payload.text.trim()) {
            all.push(payload.text.trim());
            if (streamText) relay(payload.text.trim());
          }
          break;

        // An extension is blocking on an answer. Handed straight over: whoever
        // is asking has to put the question somewhere a human will see it.
        case "extension_ui_request":
          // Only a question ends the text so far. A status line or a widget
          // lands anywhere, mid-word included, and cut the reply there.
          if (isDialog(payload.method)) flush();
          onUi?.(payload);
          break;

        // The dialog gave up waiting.
        case "extension_ui_cancel":
          onUi?.({ ...payload, cancelled: true });
          break;

        // Anything not closed by a message_end still belongs to the answer.
        // Not the end of the work, though — a retry, a compaction or a queued
        // message all come after it, and answering here cut them off.
        case "agent_end":
          flush();
          break;

        case "agent_settled":
          flush();
          settle?.();
          break;

        case "portal_status":
          if (payload.status === "error") fail?.(new Error(String(payload.error ?? "run failed")));
          // Settled on idle, not only on agent_end. A slash command completes
          // without ever starting an agent turn, so waiting for agent_end hung
          // until the timeout — and because asks are serialised per session,
          // every later message in that chat queued behind it.
          if (payload.status === "idle") {
            flush();
            settle?.();
          }
          break;
      }
    };

    // Attached before prompting: a fast reply would otherwise finish before
    // anyone was listening.
    this.on(`session:${sessionId}`, onEvent);
    const timer = setTimeout(
      () => fail?.(new Error(`The agent did not finish within ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs
    );

    try {
      const finished = new Promise<void>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      });
      // A prompt that is refused — the model is down, pi will not start —
      // publishes its error before it throws, and that rejects `finished` while
      // nothing is waiting on it yet. The throw below is what reaches the
      // caller; left unhandled, this one took the whole portal down with it.
      finished.catch(() => {});
      // Stopped before it was sent: nothing for the channel to wait on, and what
      // it had to tell the agent is still to be told.
      const images = prepared.images ?? [];
      if ((await this.prompt(sessionId, prepared.message, images.length ? { images } : undefined, false, stopsBefore)) === false) {
        onStopped?.();
        return "";
      }
      prepared.onAccepted?.();
      await finished;
      // Counted by abort() before it asks pi to stop, so it is in by the time the run settles.
      if ((this.aborts.get(sessionId) ?? 0) !== abortsBefore) onStopped?.();
      // Already relayed piece by piece; handing it back would post it twice.
      return onReply && streamText ? "" : all.join("\n\n").trim();
    } finally {
      clearTimeout(timer);
      this.off(`session:${sessionId}`, onEvent);
    }
  }

  /**
   * A picture or a clip in the chat's folder, as the page would fetch it:
   * checked by its bytes, and never through a link out of the folder.
   * Undefined for one that is gone since, or is no longer one: there is
   * nothing to send then. Read for the chat's agent, whose tool named it, so
   * that a file the sandbox closed to the agent is not sent on (see AgentUse).
   */
  private fileShown(sessionId: string, file: ShownFile): Omit<SentFile, "title"> | undefined {
    const session = getSession(sessionId);
    if (!session) return undefined;
    try {
      const { bytes, mimeType, name } = (file.kind === "video" ? readVideo : readPicture)(baseDir(session.workspace), file.path, { likeParent: true, chats: [sessionId] });
      return { data: bytes.toString("base64"), mimeType, name };
    } catch {
      return undefined;
    }
  }

  /** Who is speaking in the conversation now: see speakerRole. */
  setSpeaker(sessionId: string, person: PersonRow): void {
    this.speaker.set(sessionId, person);
  }

  /**
   * The role in force right now.
   *
   * Falls back to the conversation's own role, never to "primary". Only channel
   * messages identify a speaker; a message sent through the portal's prompt
   * endpoint identifies nobody, and defaulting to primary there handed a
   * colleague's conversation full privileges — the conversation is still theirs,
   * and they still read whatever comes back.
   */
  speakerRole(sessionId: string): Role {
    const live = this.speaker.get(sessionId);
    if (live) return live.role;
    const row = getSession(sessionId);
    // A conversation on a channel that nobody is known to have spoken in since a
    // primary user was named — begun before that, by a sender who named nobody —
    // is a stranger's: its row says primary only because that is where every
    // row starts. Not one begun on the Agent page: nobody is named there, it is
    // the owner who is signed in.
    if (onChannel(row) && !row?.last_person_key && hasPrimary()) return "guest";
    return (row?.role as Role) ?? "guest";
  }

  /** Who is speaking, surviving a restart via the session's own record. */
  speakerKey(sessionId: string): string | undefined {
    return this.speaker.get(sessionId)?.key ?? getSession(sessionId)?.last_person_key ?? undefined;
  }

  currentSpeaker(sessionId: string): PersonRow | undefined {
    return this.speaker.get(sessionId);
  }

  /**
   * Whether a subagent is working in the background here, or one of the chat's child chats is (see child-chats.ts):
   * its chat looks idle, and stopping it, or loading it again, would end the subagent or cut off what waits on the child.
   */
  backgroundWork(sessionId: string): boolean {
    return (this.live.get(sessionId)?.client.subagentsRunning?.() ?? 0) > 0 || this.childWorking(sessionId);
  }

  /** Whether a child chat of this one has a run going, or a message on its way to one. */
  private childWorking(sessionId: string): boolean {
    return childSessions(sessionId).some((child) => this.isBusy(child.id) || this.prompting.has(child.id));
  }

  /** Why an edit of the chat has to wait for what works in its background, or nothing. */
  private stillWorking(sessionId: string): string | undefined {
    if ((this.live.get(sessionId)?.client.subagentsRunning?.() ?? 0) > 0) return "A subagent is still working in the background here. Wait for its answer, or stop it, first.";
    if (this.childWorking(sessionId)) return "A child chat of this chat is still working. Wait for it to finish, or stop it, first.";
    return undefined;
  }

  /** Whether anything at all is using the model: a turn running, or a message waiting for one. */
  anyBusy(): boolean {
    if (this.asking.size) return true;
    return anySessionRunning();
  }

  /**
   * Whether a run is in flight. Checked before queueing an interrupt, which
   * would otherwise wait politely behind the very task it means to stop.
   */
  isBusy(sessionId: string): boolean {
    if (this.asking.has(sessionId)) return true;
    return getSession(sessionId)?.status === "running";
  }

  /** Access the live client for config reads and writes, starting pi if needed. */
  client(sessionId: string): Promise<PiClient> {
    return this.ensureClient(sessionId);
  }

  /** True when the message invokes a command pi actually knows about. */
  private async looksLikeCommand(client: PiClient, message: string): Promise<boolean> {
    const name = commandName(message);
    if (!name) return false;
    try {
      const commands = await client.getCommands();
      return commands.some((c) => c.name === name);
    } catch {
      return false;
    }
  }

  /** What is in each chat's box, as its page last said: an extension can read it. */
  private drafts = new Map<string, Draft>();

  /** `caret`: what is selected in the box, where a paste goes; the end without one. */
  setDraft(sessionId: string, text: string, caret?: { start: number; end: number }): void {
    if (text) this.drafts.set(sessionId, { text, caret });
    else this.drafts.delete(sessionId);
  }

  /**
   * Answer an extension dialog for a live session, or one of the agent's questions. A question's answer, or
   * that it was cancelled, is written down as its record. When nothing waits for it any more (the portal
   * restarted, or the chat's pi was let go, while it was open) the answers go to the agent as a message.
   */
  respondUi(sessionId: string, id: string, response: { cancelled?: boolean; value?: unknown }): boolean {
    const asked = openChatQuestion(sessionId, id);
    const waiting = this.live.get(sessionId)?.client.respondUi(id, response) ?? false;
    if (!asked) return waiting;
    if (!waiting && asked.until !== undefined && asked.until <= Date.now()) {
      this.endQuestion(sessionId, id, "expired");
      return false;
    }
    const answers = response.cancelled ? undefined : readAnswers(asked.questions, response.value);
    // While the portal stops, a message would start a pi that it no longer lets go, cut off as it exits. The
    // answers are written down, and held for the portal that starts next to pass on (see recoverOrphans).
    this.endQuestion(sessionId, id, answers ? "answered" : "cancelled", answers);
    if (!waiting && answers && this.closing) holdAnswers(sessionId, id);
    else if (!waiting && answers) this.passOnAnswers(sessionId, asked.questions, answers);
    return true;
  }

  /** Answers to questions nothing waits for any more, sent to the agent as a message. */
  private passOnAnswers(sessionId: string, questions: Question[], answers: Answers): void {
    const message = [
      "<answer-from-primary>",
      "These are the answers to the questions you asked with ask_question. Your run ended before they came (the portal restarted while you waited, for one), so they come as this message: go on from there.",
      "",
      // What was typed in is the person's, as a channel's sender's words are: it cannot close the frame or open one.
      neutralise(describeAnswers(questions, answers)),
      "</answer-from-primary>",
    ].join("\n");
    this.prompt(sessionId, message).catch((e) => console.error(`[portal] could not pass on the answers in ${sessionId}: ${(e as Error).message}`));
  }

  /**
   * Everything off for this conversation: the portal-wide default, bent by its
   * project's exceptions and then by its own. The whole picture, including
   * tools that are not loaded right now — which is what the page has to be
   * given, or its next answer would drop the exceptions it was never shown.
   */
  offFor(
    sessionId: string,
    names: string[] = [],
    known: Iterable<string> = knownTools().map((t) => t.name),
    homes?: AgentHome[]
  ): string[] {
    return effectiveOff(
      [...names, ...known],
      toolDefaultsForSession(getSession(sessionId), homes),
      sessionTools(sessionId)
    );
  }

  /**
   * What pi is told to have off: the switches (offFor), and the MCP servers'
   * tools that the adapter's configuration no longer registers. Those are not
   * the switches' — they are listed nowhere, and nothing is written down for
   * them — but a chat that loaded one before the configuration changed still
   * has it, and the configuration is what has the last word over it.
   */
  piOff(sessionId: string, reported: Pick<PiTool, "name" | "inline">[] = [], view: McpView = mcpView(), homes?: AgentHome[]): string[] {
    const names = reported.map((t) => t.name);
    return [...new Set([...this.offFor(sessionId, names, view.known().keys(), homes), ...withdrawnMcpTools(reported, view)])].sort();
  }

  /**
   * Of the tools marked lazy, the ones this conversation has on: not offered one by one, and reached
   * through the `tools` tool. What is off (piOff) is off for good and so not among them. `sets` names
   * what they are, for the hint to the model.
   */
  piLazy(off: string[]): { tools: string[]; sets: string[] } {
    const gone = new Set(off);
    const tools = [...lazyToolNames()].filter((name) => !gone.has(name)).sort();
    return { tools, sets: lazySetLabels(tools) };
  }

  /** What pi is told about the tools when a conversation starts: the ones that are off, and the lazy ones that are on. */
  private toolsFor(sessionId: string): { toolsOff: string[]; toolsLazy: string[]; lazySets: string[]; toolsSeen: () => ReadonlySet<string> } {
    const toolsOff = this.piOff(sessionId);
    const lazy = this.piLazy(toolsOff);
    return { toolsOff, toolsLazy: lazy.tools, lazySets: lazy.sets, toolsSeen: () => new Set(knownTools().map((t) => t.name)) };
  }

  /**
   * What a running chat reported, less the MCP servers' tools the adapter's
   * configuration says no to — still loaded from before it changed, and off
   * (piOff) — with those it lists from its cache marked. And the servers' tools
   * the chat has not registered one by one, which it reaches through `mcp`: a
   * server is a group like any other, switched whole or tool by tool.
   */
  private offered(reported: PiTool[], workspace: string | null | undefined, view: McpView): Omit<PiTool, "enabled">[] {
    if (!reported.length) return [];
    const listed = reported.flatMap(({ enabled: _enabled, ...tool }) => {
      const offer = view.offers(tool);
      if (unlisted(offer)) return [];
      return [offer === "cached" ? { ...tool, cached: true as const } : tool];
    });
    const have = new Set(listed.map((t) => t.name));
    return [...listed, ...mcpCatalogueFor(workspace ?? undefined, view).filter((t) => !have.has(t.name))];
  }

  /**
   * Every tool this conversation could use, and whether it is on.
   *
   * A running session lists its own: pi builds the registry when it starts.
   * What it reports is remembered, so the settings page can offer a default
   * for a tool without a conversation being open — and so can a chat that has
   * not started yet. Before the first message there is no registry to ask, and
   * "send a message first" meant the one moment somebody wants to say "not the
   * web this time" was the one moment they could not. So an idle chat is shown
   * what the portal has seen registered (`live: false`), and what is switched
   * there is stored as this chat's own and handed to pi when it starts.
   */
  async getTools(sessionId: string): Promise<{ tools: PiTool[]; live: boolean }> {
    const client = this.live.get(sessionId)?.client;
    const reported = client?.getTools ? await client.getTools() : [];
    if (reported.length && rememberTools(reported.map(remembered)).length) await this.applyToolDefaults();
    const session = getSession(sessionId);
    const workspace = session?.workspace;
    const view = mcpView();
    const listed = this.offered(reported, workspace, view);
    // What the chat's agent, project and routine start it with, which is what it is "default" against.
    const defaults = toolDefaultsForSession(session);
    const exceptions = sessionTools(sessionId);
    const lazy = lazyMarks(view);
    const servers = view.servers;
    // Where the chat works through the code tool and has it on, no tool is lazy (see lazyOf in pi/sdk-client.ts), but an
    // MCP server's is still behind `mcp`. Read from the running pi where there is one: its presentation was fixed as it started.
    const scripted = (client ? client.codemodeOnly : modeOf(session?.mode)?.codemode) && toolEnabled(CODEMODE_TOOL, defaults, exceptions);
    // Its switch cannot turn it off here (setTools): the page shows it on and says why.
    const held = modeHoldsCodemode(session?.mode);
    // An idle chat is shown what the portal has seen registered; the tool is not there for every kind of chat (see asksQuestions).
    const asks = session ? canAsk(session) : true;
    const shown: { name: string; source: string; package?: string | null; description?: string; inline?: true; cached?: true }[] = listed.length
      ? listed
      : shownTools(workspace, view).filter((tool) => asks || !(tool.name === ASK_QUESTION_TOOL && tool.inline));
    return {
      tools: shown.map(({ name, source, package: pkg, description, inline, cached }) => {
        const mark = lazy({ name, source, package: pkg });
        return {
          name,
          ...(description !== undefined ? { description } : {}),
          source: toolSource(name, source, servers),
          // The portal's own tools are told from an extension's of the same name, so the page can group its code mode apart.
          ...(inline ? { inline: true as const } : {}),
          ...(cached ? { cached: true as const } : {}),
          enabled: toolEnabled(name, defaults, exceptions),
          ...(held && name === CODEMODE_TOOL ? { byMode: true as const } : {}),
          defaultOn: !defaults.includes(name),
          // Not offered one by one but found through the `tools` tool, or an MCP server's through `mcp`: the page says so beside the switch.
          ...scriptedMark(mark, scripted),
        };
      }),
      live: Boolean(listed.length),
    };
  }

  /**
   * Say which tools this conversation should have off.
   *
   * What is written down is the difference from the default, not the whole
   * picture: a tool that is off because the default says so is not recorded
   * here, so changing that default still reaches this conversation.
   *
   * Throws CodemodeHeld, and writes nothing, for a list that turns the code tool off in a chat whose mode switches it
   * on: the mode works through it.
   */
  async setTools(sessionId: string, wantedOff: string[]): Promise<string[]> {
    const client = this.live.get(sessionId)?.client;
    const reported = client?.getTools ? await client.getTools() : [];
    const session = getSession(sessionId);
    const held = sessionTools(sessionId);
    const defaults = toolDefaultsForSession(session);
    const holds = modeHoldsCodemode(session?.mode);
    if (wantedOff.includes(CODEMODE_TOOL) && holds) throw new CodemodeHeld();
    const workspace = session?.workspace;
    const view = mcpView();
    // Not what the adapter no longer registers: the page did not show it, so it said nothing about it.
    const listed = this.offered(reported, workspace, view);
    // What this call is answering about: the tools this session registered,
    // plus the ones it already holds an exception for. Not the portal-wide
    // catalogue — a tool that is merely not loaded in this run was not on the
    // page, so nobody said anything about it and nothing should be written
    // down in their name.
    //
    // Except when nothing is running to have registered anything: the page
    // that is answering was drawn while it was, and the tools it showed are the
    // ones the portal lists (shownTools, which is what getTools shows an idle
    // chat). Without them a tool switched *on* would be in neither list, no
    // exception would be written, and the write would answer 200 while the
    // tool went on following the default.
    const shown = (listed.length ? listed : shownTools(workspace, view)).map((t) => t.name);
    const answered = [...shown, ...held.off, ...held.on];
    // Against the project's default: an exception here is to what the chat would
    // otherwise have, so a project that switches a tool off needs no entry for it
    // in every chat, and one that is switched back on in the chat needs one.
    const own = exceptionsFor(heldOffUnshown(wantedOff, shown, held), defaults, answered, held);
    // The chat's own off for the code tool, which does not count while its mode holds the tool on (sessionTools), is
    // kept for when the mode no longer does: this list said nothing about it.
    const kept = holds && parseToolsOff(session?.tools_off).includes(CODEMODE_TOOL) ? [CODEMODE_TOOL] : [];
    setSessionTools(sessionId, { off: [...own.off, ...kept], on: own.on });
    const off = this.offFor(sessionId, listed.map((t) => t.name), view.known().keys());
    const piOff = this.piOff(sessionId, reported, view);
    await client?.setToolsOff?.(piOff, this.piLazy(piOff));
    return off;
  }

  /**
   * A default changed. Every conversation that did not disagree about the tool
   * is affected, including the ones running right now — otherwise the setting
   * would only mean anything to chats started afterwards.
   *
   * `layer` when it was one layer's exceptions that changed — a project's, an
   * agent's, a routine's, a mode's: only the chats under it are told, the others
   * have nothing new to hear. A push builds the prompt again too (pi's
   * `_setActiveTools`), so it carries a mode's new instructions as well.
   */
  async applyToolDefaults(layer?: string | { project?: string; agent?: string; routine?: string; mode?: string }): Promise<number> {
    const only = typeof layer === "string" ? { project: layer } : layer;
    // The agents' homes read once for all of them, not once for each chat.
    const homes = agentHomes();
    const affected = [...this.live.entries()].filter(([sessionId]) => {
      if (!only) return true;
      const session = getSession(sessionId);
      if (only.project !== undefined) return projectOf(session?.workspace) === only.project;
      if (only.agent !== undefined) return agentIdOf(session?.workspace, homes) === only.agent;
      if (only.routine !== undefined) return routineOf(session) === only.routine;
      if (only.mode !== undefined) return session?.mode === only.mode;
      return true;
    });
    const view = mcpView();
    const done = await Promise.all(
      affected.map(async ([sessionId, { client }]) => {
        // Per session, like refreshSettings: the default is already stored, so
        // one chat that is mid-teardown must not fail the save and leave the
        // page showing the opposite of what the database now holds.
        try {
          const listed = client.getTools ? await client.getTools() : [];
          const off = this.piOff(sessionId, listed, view, homes);
          await client.setToolsOff?.(off, this.piLazy(off));
          return true;
        } catch (e) {
          console.error(`[portal] could not apply the tool defaults to ${sessionId}: ${(e as Error).message}`);
          return false;
        }
      })
    );
    return done.filter(Boolean).length;
  }

  /**
   * pi reads which packages to load when a conversation starts, so a package
   * switched on or off reaches the open ones by reloading them. The idle ones
   * at once. A reload rebinds every extension, which is not something to do in
   * the middle of a request or a compaction — nor under an edit, whose rewrite
   * of pi's file a reload could read half-done or write over. A chat that is
   * working, or with something going on that a reload would cut off
   * (reloadCutsOff), is marked due instead (PiClient.reloadDue) and counted as
   * waiting: it is reloaded at the next step of a run, between two of its
   * requests, where nothing would be cut off, or else once the run is over or
   * before the next message starts one (reloadSettled).
   *
   * Held like an edit while it runs, so a message arriving in the middle — from
   * another tab, a channel — waits for the extensions to be back rather than
   * starting a run among half of them.
   */
  async reloadIdle(): Promise<{ reloaded: number; waiting: number }> {
    let waiting = 0;
    const done = await Promise.all(
      [...this.live.entries()].map(async ([sessionId, { client }]) => {
        if (this.isBusy(sessionId) || this.reloadCutsOff(sessionId)) {
          client.reloadDue = true;
          waiting++;
          return false;
        }
        try {
          await this.withEdit(sessionId, () => client.reload());
          return true;
        } catch (e) {
          // Due still, as a reload that fails leaves it: see PiClient.reloadDue.
          console.error(`[portal] could not reload ${sessionId}: ${(e as Error).message}`);
          waiting++;
          return false;
        }
      })
    );
    return { reloaded: done.filter(Boolean).length, waiting };
  }

  /**
   * Whether reloading the chat's pi now would cut off something that goes on
   * beside a run: a compaction, an edit, or what canReloadNow names.
   */
  private reloadCutsOff(sessionId: string): boolean {
    return this.compacting.has(sessionId) || this.editing.has(sessionId) || !this.canReloadNow(sessionId);
  }

  /**
   * Whether a reload may happen while the chat works, between two requests of
   * a run. Not while a subagent works in the background, which the reload
   * would stop, nor while an extension holds the chat's pi.
   */
  private canReloadNow(sessionId: string): boolean {
    return !this.backgroundWork(sessionId) && !extensionHolds(sessionId);
  }

  /**
   * A reload that became due while the chat worked and that no step of its run
   * could take: once the run is over, or before a message starts the next.
   * Not where pi has started the next run already, with a message it took as
   * this one ended (a step of that run takes it), nor under what a reload
   * would cut off: due until then.
   */
  private async reloadSettled(sessionId: string, client: PiClient): Promise<void> {
    if (client.isIdle?.() === false || this.reloadCutsOff(sessionId)) return;
    try {
      await this.withEdit(sessionId, () => client.reload());
    } catch (e) {
      console.error(`[portal] could not reload ${sessionId}: ${(e as Error).message}`);
    }
  }

  async abort(sessionId: string): Promise<void> {
    this.aborts.set(sessionId, (this.aborts.get(sessionId) ?? 0) + 1);
    const live = this.live.get(sessionId);
    if (!live?.client.running) {
      // Nothing to abort yet — but a compaction waiting on pi to start is
      // still going to run, and the session already shows as working with a
      // Stop button. Remembered so it is cancelled the moment it could begin.
      if (this.compacting.has(sessionId)) this.cancelPending.add(sessionId);
      this.stops.set(sessionId, (this.stops.get(sessionId) ?? 0) + 1);
      // Then waited for, like the path below. Returning here reported the Stop
      // as done while the session went on showing itself as compacting until pi
      // had finished starting — the same bounded wait, so the answer arrives
      // when the thing it describes is actually over.
      await this.settleCompaction(sessionId);
      return;
    }
    // What is sent from here on waits for the Stop to be over, and then starts
    // a run of its own. Handed over now, pi would queue it into the run being
    // stopped — the page still shows Stop while pi winds down, and the send
    // goes out as a steer — and then go on with it after the abort.
    let stopped!: () => void;
    const gate = new Promise<void>((resolve) => (stopped = resolve));
    const before = this.sending.get(sessionId);
    const tail = before ? before.then(() => gate) : gate;
    this.sending.set(sessionId, tail);
    try {
      const sentBefore = new Set(this.waiting.get(sessionId) ?? []);
      // Before the abort, which waits for the run to settle and would find them
      // still in pi's queue, ready for the next run. What is being handed to pi
      // this moment is let into the queue first, to be cleared with the rest.
      await this.whenHanded(sessionId);
      this.dropWaiting(sessionId, live.client, sentBefore);
      await live.client.abort().catch(() => {});
      // Cancelling a compaction does not end it. pi detaches the session from
      // agent events for the whole of compact() and reattaches in its own
      // finally, so between abortCompaction() returning and that finally running
      // the session is deaf. Publishing idle there lets the next prompt start
      // against a detached session — it would run with nothing reaching the
      // transcript, which is the failure this whole area keeps producing.
      await this.settleCompaction(sessionId);
      updateSession(sessionId, { status: "idle" });
      this.record(sessionId, "portal_status", { status: "idle", aborted: true });
    } finally {
      stopped();
      if (this.sending.get(sessionId) === tail) this.sending.delete(sessionId);
    }
  }

  /**
   * Resolves once any in-flight compaction has finished unwinding.
   *
   * Bounded, and it gives up by failing rather than by carrying on. A race
   * does not cancel what it lost to: the compaction is still running, the
   * session is still detached from agent events, and proceeding anyway would
   * start a turn that reaches nobody — which is the thing this wait exists to
   * prevent. Saying so leaves the session honestly busy, and the cancellation
   * Stop already issued still lands when the compaction finally unwinds.
   */
  private async settleCompaction(sessionId: string, timeoutMs = 60_000): Promise<void> {
    const inFlight = this.compacting.get(sessionId);
    if (!inFlight) return;
    let timer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      // Waiting for it to be over, not for it to have worked. The failure
      // belongs to whoever asked for the compaction.
      inFlight.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!settled) {
      throw new Error(
        "The conversation is still being compacted. Nothing else can run until it finishes.",
      );
    }
  }

  async stop(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId);
    // One that is being let go already: whoever stops it again waits for that.
    if (!live) return this.releasing.get(sessionId);
    // Said while its events are still heard: a background subagent goes with
    // its pi, and nothing else would say it ended.
    live.client.endSubagents?.("Its chat's pi was stopped");
    this.stopping.add(live.client);
    this.live.delete(sessionId);
    this.stream.clear(sessionId);
    this.forgetPi(sessionId);
    const release = this.release(sessionId, live);
    this.releasing.set(sessionId, release);
    try {
      await release;
    } finally {
      if (this.releasing.get(sessionId) === release) this.releasing.delete(sessionId);
    }
  }

  /**
   * Makes `change` to a chat that has not started, and lets its pi go if one is up or starting, so that the next start
   * reads it: its tools, the server halves' factories and its prompt are all decided at a start. Nothing is lost: the
   * chat has said nothing. False, with nothing changed, when a message or a command got there first.
   *
   * Held like an edit (withEdit): an edit of the chat's only message, or its undoing, can take that message's event
   * away while it waits for pi to stop, and a change made then would stop the pi the edit relies on. Refused while an
   * edit or a reload holds the chat (SessionEditError "busy"). A message or a start of pi that comes meanwhile waits
   * for it (whenEditable), and so starts in what was changed.
   */
  async stopUnstarted(sessionId: string, change: () => void): Promise<boolean> {
    return this.withEdit(sessionId, async () => {
      await this.settleStart(sessionId);
      if (chatSaid(sessionId) || this.isBusy(sessionId)) return false;
      change();
      await this.stop(sessionId);
      return true;
    });
  }

  /**
   * The run a chat was started for is over, and the portal stopped its pi for
   * good: a routine run in a session of its own. The server halves are told it
   * is finished, and let go of what they kept for its run. A person who goes
   * on with the chat starts its pi again, and it is told `started` as any chat is.
   */
  finished(sessionId: string): void {
    chatLife("finished", sessionId);
  }

  /**
   * Lets go of a pi the way pi's own runtime does: its extensions are told
   * first, so that they stop their timers and processes, and then it is
   * disposed. Without the first step each release left them running, and the
   * guard's hook on the conversation kept the whole pi in memory.
   */
  private async release(sessionId: string, { client, executor }: LiveSession): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.resolve()
        .then(() => client.shutdown?.())
        .catch(() => {}),
      // An extension that never answers must not keep a chat from being stopped.
      new Promise<void>((resolve) => (timer = setTimeout(resolve, this.releaseMs))),
    ]);
    clearTimeout(timer);
    client.dispose();
    // Whether or not the guard heard of the shutdown: its hook holds the pi.
    forgetTaint(sessionId);
    await executor.cleanup?.(sessionId).catch(() => {});
  }

  /** pi is gone, and what it was holding with it. */
  private forgetPi(sessionId: string): void {
    chatLife("stopped", sessionId);
    this.activity.delete(sessionId);
    this.dropCommands(sessionId);
    // Nor a subagent in the background: it ran in this pi. Stopped, the
    // bridge has said so already; crashed, nothing has — written here, once,
    // for whichever is still open.
    for (const id of openSubagentsIn(sessionId)) {
      this.record(sessionId, "portal_subagent", { type: "portal_subagent", op: "end", id, detached: true, status: "stopped", error: "Its chat's pi went away" });
    }
    // What the extensions showed went with the process that ran them: stopped
    // for a restart or a delete as much as crashed. Left, a status naming a
    // command had the page list the commands, starting pi.
    this.extensionUi.delete(sessionId);
    this.failuresSaid.delete(sessionId);
    this.inRun.delete(sessionId);
    this.calls.delete(sessionId);
    toolCallsCutOff(sessionId);
    this.callWindows.delete(sessionId);
    this.fresh.delete(sessionId);
    this.piQueue.delete(sessionId);
    this.dropWaiting(sessionId);
  }

  /** Waits for a launch that is still in flight; it is not in `live` until it has finished. */
  private async settleStart(sessionId: string): Promise<void> {
    let starting: Promise<unknown> | undefined;
    while ((starting = this.starting.get(sessionId))) await starting.catch(() => {});
  }

  /**
   * Brings a session to a stop for good, so its rows and files can go.
   *
   * stop() does nothing for a session whose process is still starting, and it
   * does not wait for a run to end. A launch that outlived the delete would then
   * make the session's folder again, and a run that was still appending would
   * write into one that is gone. So the launch is waited for, the run is aborted
   * and waited for, and only then is the process disposed.
   */
  async discard(sessionId: string): Promise<void> {
    this.discarding.add(sessionId);
    // Its child chats first, which go with it: a run of one is stopped before the parent's own, which may be waiting
    // on it. Remembered, for their files and for a delete that did not go through: by then their rows may be gone.
    // None can be made from here on (createChild).
    const children = childSessions(sessionId).map((child) => child.id);
    if (children.length) this.discardedChildren.set(sessionId, children);
    for (const child of children) await this.discard(child);
    await this.settleStart(sessionId);
    await this.abort(sessionId).catch(() => {});
    // A prompt can have started a launch while the abort was being waited for.
    await this.settleStart(sessionId);
    await this.stop(sessionId);
    // Nothing of it asks the progress proxy any more.
    forgetLlamaProxy(sessionId);
  }

  /**
   * A delete that did not go through: these chats are there to be used again.
   * Safe for one that did, whose rows are gone.
   */
  reopen(sessionIds: Iterable<string>): void {
    for (const id of sessionIds) {
      this.discarding.delete(id);
      this.reopen(this.discardedChildren.get(id) ?? []);
      this.discardedChildren.delete(id);
    }
  }

  /** The child chats of a chat being deleted, by the chat: see discard. */
  private discardedChildren = new Map<string, string[]>();

  private refuseIfDiscarded(sessionId: string): void {
    if (this.discarding.has(sessionId)) throw new Error("This chat is being deleted");
  }

  /**
   * Removes what pi wrote for a session, once its rows are gone. It never fails
   * the caller: the chat is already deleted, and a folder that will not go —
   * one a container wrote as another user — is a leftover, not an error.
   */
  removeFiles(sessionId: string): void {
    // Its child chats' first, which went with its rows: each is told to the server halves as deleted, as it is.
    for (const child of this.discardedChildren.get(sessionId) ?? []) this.removeFiles(child);
    this.discardedChildren.delete(sessionId);
    this.discarding.delete(sessionId);
    this.drafts.delete(sessionId);
    this.stops.delete(sessionId);
    this.aborts.delete(sessionId);
    chatLife("deleted", sessionId);
    // Each on its own: pi's folder is the one that can refuse, and the pictures
    // are what would then stay downloadable.
    for (const [what, remove] of [
      ["pi's files", () => removeSessionFiles(SESSION_ROOT, sessionId)],
      ["pictures", () => removeImages(IMAGE_ROOT, sessionId)],
    ] as const) {
      try {
        remove();
      } catch (e) {
        console.error(`[portal] could not remove the ${what} of session ${sessionId}:`, (e as Error).message);
      }
    }
  }

  /**
   * Deletes a chat, its child chats with it: its runs stopped and its pi let go, then its rows, then its files. A
   * delete that fails part way leaves the chat (and its children) taking messages again, as they were.
   */
  async deleteChat(sessionId: string): Promise<void> {
    // A child chat of one that is being deleted goes with it: its delete would remove its files, and tell the server
    // halves it is deleted, a second time.
    const parent = getSession(sessionId)?.parent_id;
    if (parent) this.refuseIfDiscarded(parent);
    try {
      await this.discard(sessionId);
      deleteSession(sessionId);
    } catch (e) {
      this.reopen([sessionId]);
      throw e;
    }
    // Its parent's delete began while this one's discard was going: it has this child among its own and removes the
    // files, and says deleted, in its turn (removeFiles).
    if (parent && this.discarding.has(parent)) return;
    this.removeFiles(sessionId);
  }

  /**
   * Makes a child chat for the server half of `creator`: see child-chats.ts. Not of a chat that is being deleted,
   * which would leave the child's pi and files behind it.
   */
  createChild(options: unknown, creator: string): SessionRow {
    const parent = (options as { parent?: unknown } | null | undefined)?.parent;
    if (typeof parent === "string" && this.discarding.has(parent)) throw new Error("This chat is being deleted");
    return newChildChat(options, creator);
  }

  /**
   * Sends a child chat a message and waits for the run that takes it in to end: how it ended, and the last thing it
   * said. Mid-run, `steer` takes it in after the step the run is on; without, it waits for the run to end, as a
   * person's message does. It is sent as the person its parent last heard from: a child is held to the role and the
   * person of the chat it works for. A run that fails, or a message refused, resolves as an error: it never throws
   * for the run's sake.
   */
  async runChild(childId: string, message: string, options: { steer?: boolean } = {}): Promise<ChildRun> {
    const child = getSession(childId);
    const parent = child?.parent_id ? getSession(child.parent_id) : undefined;
    if (!child || !parent) throw new Error(`There is no child chat ${childId}`);
    const person = this.speaker.get(parent.id);
    if (person) this.setSpeaker(childId, person);
    const role = lower(child.role, this.speakerRole(parent.id));
    if (role !== child.role || parent.last_person_key !== child.last_person_key) {
      updateSession(childId, { role, last_person_key: parent.last_person_key });
      // Its context files are picked by its role as its pi starts: one that was up has to start again. Not mid-run,
      // where the role of the speaker set above holds every call.
      if (role !== child.role && !this.isBusy(childId)) await this.stop(childId);
    }

    let end!: (run: ChildRun) => void;
    const ended = new Promise<ChildRun>((resolve) => (end = resolve));
    let mine: number | undefined;
    // Its message is in the run that is going: what is said from here is said to it.
    let inRun = false;
    let answer = "";
    let failure: string | undefined;
    const finish = (status: ChildRun["status"], error?: string) => end({ status, answer, ...(error ? { error } : {}) });
    const key = `session:${childId}`;
    const hear = (row: { seq?: number; type: string; payload: string }) => {
      let p: any = {};
      try {
        p = JSON.parse(row.payload);
      } catch {
        return;
      }
      // Its own line is told by prompt() (onRecorded below), not found by its words: another message with the same ones
      // can be recorded first while pi starts.
      if (row.type === "portal_taken" && mine !== undefined && p.seq === mine) inRun = true;
      else if (row.type === "portal_unsent" && mine !== undefined && Array.isArray(p.seqs) && p.seqs.includes(mine)) finish("stopped", "It was stopped before the chat read the message");
      else if (!inRun) return;
      else if (row.type === "message_end" && p.message?.role === "assistant") {
        if (p.message.stopReason === "error") failure = String(p.message.errorMessage ?? "The model answered with an error");
        else {
          failure = undefined;
          const said = (Array.isArray(p.message.content) ? p.message.content : []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("");
          if (said.trim()) answer = said;
        }
      } else if (row.type === "portal_status" && p.status === "error") finish("error", String(p.error ?? failure ?? "The run failed"));
      else if (row.type === "portal_status" && p.status === "idle") finish(p.aborted ? "stopped" : failure ? "error" : "done", failure);
    };
    this.on(key, hear);
    try {
      let sent: boolean;
      try {
        sent = await this.prompt(childId, message, {
          ...(options.steer ? { steer: true } : {}),
          onRecorded: (seq, queued) => {
            mine = seq;
            // Sent while the chat was idle, it starts the run; sent into one, it waits until pi takes it in.
            if (!queued) inRun = true;
          },
        });
      } catch (e) {
        finish("error", (e as Error).message);
        return await ended;
      }
      if (!sent) finish("stopped", "It was stopped before the message was sent");
      // A command, which is no message of the chat's: what follows is its doing, and one that did not start a run is over.
      else if (mine === undefined) {
        inRun = true;
        if (getSession(childId)?.status !== "running") finish("done");
      }
      return await ended;
    } finally {
      this.off(key, hear);
    }
  }

  /** Drop the running process so the next turn rebuilds it — used when a
   * session's role changes and its context files must be reloaded. */
  async shutdownSession(sessionId: string): Promise<void> {
    await this.stop(sessionId);
  }

  /** How long a restart waits for a run to wind down: a pi that will not is not worth holding it for. */
  abortGraceMs = 3_000;

  /** How long letting a pi go waits for its extensions to wind down: one that hangs is let go anyway. */
  releaseMs = 3_000;

  /**
   * Whether the portal is stopping. A run that ends from here on was aborted by
   * that, not finished: what waits on it (a routine, a look) says so rather
   * than recording it as done, which only the next start would otherwise undo
   * for a run that a crash cut off.
   */
  closing = false;

  async shutdown(): Promise<void> {
    this.closing = true;
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = undefined;
    // A run that is going is aborted first, as a Stop does. Disposing alone
    // dropped the answer being written: its text reaches the transcript and pi's
    // file only as its message ends, and the abort is what ends it.
    await Promise.all(
      [...this.live].map(async ([id, { client }]) => {
        const running = getSession(id)?.status === "running";
        if (!running && client.isIdle?.() !== false) return;
        // Not sent into the run that is stopping, or a message waiting in pi's
        // queue starts one of its own: settled at the next start, as after a crash.
        try {
          client.clearQueue?.();
        } catch {
          // The queue is gone with pi anyway.
        }
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          client.abort().catch(() => {}),
          new Promise<void>((resolve) => (timer = setTimeout(resolve, this.abortGraceMs))),
        ]);
        clearTimeout(timer);
        // The abort settled the run, and the session with it. The next start
        // finds it running, which is how it knows the run was cut off by a
        // restart — and says so to the chat, and to the person on a channel.
        if (running) updateSession(id, { status: "running" });
      }),
    );
    await Promise.all([...this.live.keys()].map((id) => this.stop(id)));
  }
}

export const sessions = new SessionManager();
setChatBridge({
  tell: (chatId, extension, data) => sessions.tellExtension(chatId, extension, data),
  create: (options, creator) => sessions.createChild(options, creator),
  run: (chatId, message, options) => sessions.runChild(chatId, message, options),
  abort: (chatId) => sessions.abort(chatId),
  remove: (chatId) => sessions.deleteChat(chatId),
  offers: (chatId, tool) => sessions.toolOffered(chatId, tool),
  reload: () => sessions.reloadIdle(),
  model: (chatId) => sessions.currentModel(chatId),
});
export { SESSION_ROOT, IMAGE_ROOT };
