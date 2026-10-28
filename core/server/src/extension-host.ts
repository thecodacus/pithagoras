import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import semver from "semver";
import express, { type NextFunction, type Request, type RequestHandler, type Response, type Router } from "express";
import { agentOf, defaultAgent, listAgents } from "./agents.js";
import { dataDirOf } from "./extension-data.js";
import { childSessions, getSession, getSetting, listSessions, putSetting, recordAudit, sessionsByWorkspace, setServerHalfOffers, setServerHalvesAsked, setTrustedMcpServers, toolExceptions, trustedMcpServers, untrustMcpServer, type SessionRow } from "./db.js";
import { EXECUTOR_KIND } from "./executor-kind.js";
import { takes, type ServerHalf } from "./extension-ui.js";
import { moduleAt } from "./half-modules.js";
import { spawnHalf, type IsolatedChild } from "./isolated-half.js";
import { asAgent, runAsAgent, sandboxEnv } from "./sandbox/exec.js";
import { identityOf } from "./sandbox/identity.js";
import { sandboxOn, sandboxSupport } from "./sandbox/policy.js";
import { folderFiles } from "./folder-files.js";
import { baseDir, setAgentAccess, type AgentAccess } from "./workspace-files.js";
import { sendFile } from "./send-file.js";
import { watchStream } from "./login-streams.js";
import { requestPerson } from "./auth.js";
import { personsEnv } from "./background.js";
import { gitAt } from "./git.js";
import { chatOwner, folderAllowed, folderLabel, listFolders } from "./agent-folders.js";
import { handoffDone, takeHandoff } from "./handoff.js";
import { modelEndpoint, modelOf, modelProviders, type LiveModel } from "./models.js";
import { mcpServer } from "./api/mcp.js";
import { holdMemory } from "./memory-holder.js";
import { provideMode } from "./chat-modes.js";
import { logFileLine, onLogLine, scrubSecrets, type LogLine } from "./logs.js";
import type { Chat, ChatLife as Life, Ran, ServerPortal, Upgrade, VoiceProvider } from "@pithagoras/extension-api/server";
import type { ChatAnswer, ChildRun } from "./child-chats.js";

/**
 * An extension's server half: a module of the package's that the portal loads
 * into its own process, once, for all chats.
 *
 * A package's pi extension runs inside a chat's pi: one per chat, gone when
 * the chat is left alone, and not there at all where pi runs in a container.
 * What has to outlive that is here: the package's own routes, the processes
 * it starts, and what it tells the pages open on a chat. What it keeps for a
 * chat it keeps where the chat's pi works, in the chat's folder; what the
 * portal itself must run on, and no agent may change, it keeps in a folder of
 * the portal's data folder (`dataDir`).
 * It is what the portal's own Files has, written into the server, and what the
 * Terminal, Git and Canvases extensions use; a package gets it by naming a module:
 *
 *   "pithagoras": { "server": "./server.js" }
 *
 *   export default function (portal) {
 *     portal.router.get("/notes", (req, res) => res.json({ notes }));
 *     return () => { ... };   // called when the package goes, or the portal stops
 *   }
 *
 * The module is plain JavaScript, loaded as it is. It runs with the portal's
 * own rights, as the package's pi extension does on the host.
 *
 * Or in a process of its own (`"isolated": true` beside `"server"`, and every
 * package installed from an extension's data folder): the same `portal`, its
 * calls made across to this one (isolated-half.ts), where a loop that never
 * yields or a heap that grows without end ends that process, and not the
 * portal's.
 */

// What a server half is given is the public contract, @pithagoras/extension-api/server: the portal implements it here.
export type { Chat, ServerPortal } from "@pithagoras/extension-api/server";
export { folderFiles };

/**
 * Who the agents of some chats are, for what `files.*` is asked with `likeParent`: the user and groups the sandbox runs each as (`asAgent`,
 * exec.ts), for the agent the sandbox runs the chat by: from the workspace stored for the chat, as sandbox/tools.ts has it, never from the path the
 * folder leads to now, which an agent can lead elsewhere with a link (into another agent's home, say). And who the agents named by their ids are,
 * for what core reads of an agent's own (see AgentUse). Nothing while the sandbox is off: the agent is the portal's own user then. A chat or an
 * agent that is not known throws, which is a refusal. Whether the sandbox is on and who an agent is are a few processes (`getent`) and a listing
 * asks for each file: they are kept for a second. That is of the sandbox and its agents, not of any folder.
 */
let sandboxIsOn = { at: 0, on: false };
const agentAccess = new Map<string, { at: number; access: AgentAccess }>();
function agentAccessFor(chats: readonly string[], ids: readonly string[]): AgentAccess[] | undefined {
  const now = Date.now();
  if (now - sandboxIsOn.at > 1000) sandboxIsOn = { at: now, on: sandboxOn() };
  if (!sandboxIsOn.on) return undefined;
  const found = new Map<number, AgentAccess>();
  // The agents are read once for all the chats named, not for each: a call may name many.
  const agents = listAgents();
  const add = (agent: ReturnType<typeof defaultAgent>) => {
    let known = agentAccess.get(agent.id);
    if (!known || now - known.at > 1000) {
      const who = identityOf(agent, sandboxSupport());
      known = { at: now, access: { uid: who.uid, groups: [who.gid, who.shared] } };
      agentAccess.set(agent.id, known);
    }
    found.set(known.access.uid, known.access);
  };
  let first: ReturnType<typeof defaultAgent> | undefined;
  for (const id of chats) {
    const row = getSession(id);
    if (!row) throw new Error("No such chat");
    add(agentOf(row.workspace, agents) ?? (first ??= defaultAgent()));
  }
  for (const id of ids) {
    const agent = agents.find((a) => a.id === id);
    if (!agent) throw new Error("No such agent");
    add(agent);
  }
  return [...found.values()];
}
setAgentAccess(agentAccessFor);

interface Running {
  half: ServerHalf;
  router: Router;
  stops: (() => unknown)[];
  opens: ((chatId: string) => unknown)[];
  life: EventEmitter;
  events: ((chatId: string, event: Record<string, unknown>) => void)[];
  factories: ((pi: any, chat: Chat) => void)[];
  upgrade?: Upgrade;
  holds: Map<string, number>;
  /** What it gives the extensions that build on it (`provide`), and what each it builds on gave it (`extensions.use`). */
  provider?: (consumer: { name: string }) => unknown;
  apis: Map<string, unknown>;
  /** The extensions it may use, as it started: those it requires, and the optional ones that were there in a version it takes. */
  uses: Set<string>;
  /** Its file's revision and those of all it builds on, as it started: a change in any is a start anew. See plan. */
  sig: string;
  /** The tools its pi extension registers now, where that follows its settings (`tools.offer`). */
  offers?: () => OfferedTool[];
  /** What it is told when the portal deletes a folder the agents work in (`folders.on("removed")`). */
  removed: ((folder: string) => void)[];
  /** Its stops have run, or are running: what it registers after that would never be let go. */
  stopped?: boolean;
  /** Where it offers voice mode to listen and speak (`voice.provide`). */
  voice?: VoiceProvider;
  /**
   * Where its code is: the folder of its module, where it really is (as Node names a module), as a path and as an
   * address. An error whose stack goes through it is its own, where nothing else says whose it is (see whose).
   */
  where: string[];
  /** How it crashed, once it has (see crashed). */
  crash?: ServerHalfCrash;
  /** What a call into it is answered with once it has crashed. */
  answer?: Error;
  /** What waits on its code now, its start, a tool's call or a handler in a chat's pi: each is ended at once should it crash. */
  waiting: Set<(error: Error) => void>;
  /** The answers of its routes that are still open: answered should it crash (see crashed). */
  responses: Set<Response>;
  /** Its process, where it runs in one of its own (`isolated`): what its `portal` there calls is applied to this one's. */
  child?: IsolatedChild;
}

/** How a server half crashed: an error of its code reached the process, or its code called `process.exit()`. */
export interface ServerHalfCrash {
  name: string;
  /** The revision that crashed: another one is started again. */
  rev: string;
  at: string;
  error: string;
  stack?: string;
}

/**
 * The server half whose code runs now. Set around all the portal calls of a half's: its module as it starts, its
 * routes and what their request, answer and upgraded socket say later (see heardAs), its handlers, and what it adds
 * to a chat's pi: its tools' calls, handlers and commands; and kept, as Node keeps it, by what that code starts in
 * turn: its timers, promises, callbacks, sockets and processes. An error that reaches the process from there, and a
 * line printed there, is that half's (see catchExtensionCrashes, and said). The portal's own work it asks for (a chat
 * told, the chats reloaded, a turn of a chat's pi) runs outside it.
 */
const scope = new AsyncLocalStorage<Running>();

/**
 * What `emitter` tells its listeners runs as `ext`'s code: an object the portal made and handed to the half (a
 * request to its routes, the answer, an upgrade's socket), whose events Node would otherwise run as the portal's.
 */
function heardAs(ext: Running, emitter: EventEmitter): void {
  const emit = emitter.emit;
  emitter.emit = function (this: EventEmitter, ...args: Parameters<EventEmitter["emit"]>) {
    return scope.run(ext, () => emit.apply(this, args));
  };
}

/**
 * The folders the portal deleted, the latest last, each with when (ms), and by package the time up to which its server
 * half has been told of them: one that was not running then, switched off, removed or failing to start, is told when
 * it next starts. The latest few hundred are kept.
 */
const REMOVED = "folders_removed";
const TOLD = "folders_told";
const KEPT_REMOVED = 300;
type Removal = { folder: string; at: number };

/** A setting the host keeps as JSON, or `none` where there is none, or it cannot be read. */
function kept<T>(key: string, none: T): T {
  try {
    return JSON.parse(getSetting(key) ?? "null") ?? none;
  } catch {
    return none;
  }
}

/** The portal deleted a folder the agents worked in, `folder` being where it really was: each server half running is told now, and it is kept for the others. */
export function folderRemoved(folder: string): void {
  const removals = kept<Removal[]>(REMOVED, []);
  // Later than the one before, even within a millisecond or with the clock set back: a half is told what it missed by when it was.
  const at = Math.max(Date.now(), (removals.at(-1)?.at ?? 0) + 1);
  putSetting(REMOVED, JSON.stringify([...removals, { folder, at }].slice(-KEPT_REMOVED)));
  const told = kept<Record<string, number>>(TOLD, {});
  for (const ext of running.values()) {
    for (const handler of ext.removed) guarded(ext, "hearing of a folder that was removed", () => handler(folder));
    told[ext.half.name] = at;
  }
  putSetting(TOLD, JSON.stringify(told));
}

/**
 * The time up to which a package's server half has been told of the folders deleted, as it starts. A package seen for
 * the first time starts from the latest: what it keeps is of no folder deleted before.
 */
function toldUpTo(name: string): number {
  const told = kept<Record<string, number>>(TOLD, {});
  if (told[name] === undefined) {
    told[name] = kept<Removal[]>(REMOVED, []).at(-1)?.at ?? 0;
    putSetting(TOLD, JSON.stringify(told));
  }
  return told[name];
}

/** A server half that has just started is told of each folder deleted after `since`, while it was not running, once. */
function tellMissed(ext: Running, since: number): void {
  const missed = kept<Removal[]>(REMOVED, []).filter((removal) => removal.at > since);
  if (!missed.length) return;
  for (const { folder } of missed) for (const handler of ext.removed) guarded(ext, "hearing of a folder that was removed", () => handler(folder));
  const told = kept<Record<string, number>>(TOLD, {});
  told[ext.half.name] = missed[missed.length - 1].at;
  putSetting(TOLD, JSON.stringify(told));
}

/** A tool a server half says it offers now: see `tools.offer`. */
type OfferedTool = { name: string; description?: string };

/**
 * What each running server half that follows its settings offers now, by its name: the tools lists read it (shownTools).
 * One whose answer fails is left out, as if it had said nothing: its tools are listed as they were remembered.
 */
export function offeredTools(): Map<string, OfferedTool[]> {
  const offered = new Map<string, OfferedTool[]>();
  for (const ext of running.values()) {
    if (!ext.offers) continue;
    const said = guarded(ext, "saying which tools it offers", () => ext.offers!());
    if (Array.isArray(said)) offered.set(ext.half.name, said.filter((t) => typeof t?.name === "string" && t.name !== ""));
  }
  return offered;
}
setServerHalfOffers(offeredTools);

/** Each running server half that offers voice mode a place to listen and speak (`voice.provide`), by its name. */
export function voiceProviders(): Map<string, VoiceProvider> {
  return new Map([...running.values()].flatMap((ext) => (ext.voice ? [[ext.half.name, ext.voice] as const] : [])));
}

const running = new Map<string, Running>();
/** Those running and the one starting: what an error's stack is looked through for (see whose). */
const live = new Set<Running>();
/** Of each package, the last half that was stopped or failed to start: what it left going is still known by its stack. */
const left = new Map<string, Running>();
/** Why a package's server half is not running, by the package's name. */
const failures = new Map<string, string>();
/** The crash a package's server half is held off for, by the package's name: until another revision of it is wanted, or it is switched off and on. */
const crashes = new Map<string, ServerHalfCrash>();
/** What server halves tell the pages open on a chat, by chat: `{ extension, data }` as it goes on the wire. Heard by the chat's event stream. */
export const pagePushes = new EventEmitter();
pagePushes.setMaxListeners(0);

// No `mode` key for a chat in Standard, and no `kind` for a task, rather than one that is undefined.
const chatOf = (row: SessionRow): Chat => ({
  id: row.id,
  title: row.title,
  workspace: row.workspace,
  status: row.status,
  ...(row.kind !== "task" ? { kind: row.kind } : {}),
  ...(row.mode ? { mode: row.mode } : {}),
  ...(row.parent_id ? { parent: row.parent_id } : {}),
  // Said for each chat a server half made, which alone can be kept out of the lists.
  ...(row.parent_id || row.creator ? { listed: row.listed === 1 } : {}),
  ...(row.unattended ? { unattended: true as const } : {}),
});
const say = (name: string, text: string) => console.log(`[extension ${name}] ${text}`);
/**
 * An extension's handler failing is the extension's: said, and nothing of the
 * portal's stops for it. What comes back never throws and never rejects: a
 * handler that returned a promise is answered with one that settles either way.
 * It runs as the extension's code (see scope).
 */
const guarded = (ext: Running, what: string, fn: () => unknown) =>
  scope.run(ext, () => {
    const failed = (e: unknown) => {
      console.error(`[extension ${ext.half.name}] ${what} failed:`, e);
      return undefined;
    };
    try {
      const result = fn();
      return result instanceof Promise ? result.catch(failed) : result;
    } catch (e) {
      return failed(e);
    }
  });

/**
 * What each server half said lately, by its name: its `[extension <name>]` lines, and what was printed while its code
 * ran. The oldest go once there are more than these. Kept for as long as the portal runs, whatever becomes of the half,
 * for whoever looks into why it stopped.
 */
const SAID_LINES = 200;
const SAID_CHARS = 100_000;
const said = new Map<string, { lines: LogLine[]; chars: number }>();
const OWN_LINE = /^\[extension ([^\]\s]+)\]/;
// The half whose code printed it first: one cannot write into another's lines by naming it.
onLogLine((line) => {
  const name = scope.getStore()?.half.name ?? OWN_LINE.exec(line.text)?.[1];
  if (!name) return;
  let kept = said.get(name);
  if (!kept) said.set(name, (kept = { lines: [], chars: 0 }));
  kept.lines.push(line);
  kept.chars += line.text.length;
  while (kept.lines.length > 1 && (kept.lines.length > SAID_LINES || kept.chars > SAID_CHARS)) kept.chars -= kept.lines.shift()!.text.length;
});

/** How many of a half's last lines a call that its crash ended is answered with, and at most how long they are together. */
const LAST_LINES = 20;
const LAST_CHARS = 8000;
/** The last lines a half said, as a log file has them. */
function lastLines(name: string): string {
  const out: string[] = [];
  let size = 0;
  for (const line of [...(said.get(name)?.lines ?? [])].reverse()) {
    const text = logFileLine(line);
    if (out.length === LAST_LINES || (out.length && size + text.length > LAST_CHARS)) break;
    out.unshift(text.length > LAST_CHARS ? `${text.slice(0, LAST_CHARS)}…` : text);
    size += text.length;
  }
  return out.join("\n");
}

/** What a crash was, said in a line: an error as it says itself, anything else thrown as Node would print it. */
const describe = (error: unknown) => (error instanceof Error ? String(error) : typeof error === "string" ? error : inspect(error));

/**
 * The half an error is of: the one whose code it came from (see scope); else, for one that came by a way Node does
 * not follow (a listener of an emitter the half does not own, a `queueMicrotask`), the one whose folder its stack goes
 * through, running or, for what one left going, stopped. None, for an error of the portal's own.
 */
function whose(error: unknown): Running | undefined {
  const own = scope.getStore();
  const stack = (error as { stack?: unknown } | null | undefined)?.stack;
  if (own || typeof stack !== "string") return own;
  // Its frames alone: a stack starts with the error's message, which may name any folder (a package's, in what pi install said).
  const frames = stack.split("\n").filter((line) => line.trimStart().startsWith("at "));
  const through = (ext: Running) => ext.where.some((at) => frames.some((frame) => frame.includes(at)));
  return [...live].find(through) ?? [...left.values()].find(through);
}

/**
 * A half crashed: an error of its code reached the process, or it called `process.exit()`. It is said, with its last
 * lines kept beside it; the half and those that build on it are stopped, and it is held off until another revision of
 * it is installed or it is switched off and on (see syncServerHalves); what waits on it, its start, a tool's call or a
 * handler in a chat's pi, ends at once, and so does what its routes had not answered. The portal and its chats go on.
 * Code of a half that had been stopped already (a timer it left) is said, and what waits on it ends. Each later error
 * of a half that crashed is said, and nothing more.
 */
function crashed(ext: Running, error: unknown): void {
  const name = ext.half.name;
  if (ext.crash) {
    console.error(`[extension ${name}] code of its server half that had crashed failed again:`, error);
    return;
  }
  const crash: ServerHalfCrash = { name, rev: ext.half.rev, at: new Date().toISOString(), error: describe(error), ...(error instanceof Error && error.stack ? { stack: error.stack } : {}) };
  ext.crash = crash;
  const held = ext.stopped ? "" : " It is off until another revision of it is installed, or it is switched off and on.";
  if (ext.stopped) {
    console.error(`[extension ${name}] code of its server half that had been stopped failed:`, error);
  } else {
    crashes.set(name, crash);
    console.error(`[extension ${name}] its server half crashed.${held}`, error);
    // Outside its code: what is stopped and started now is not the crashed half's doing.
    scope.exit(() => syncServerHalves(asked!).catch((e) => console.error(`[extensions] could not stop ${name} and what builds on it after it crashed:`, e)));
    // Once what runs now is done: a route whose code called process.exit() is answered as one that threw.
    setImmediate(() => {
      for (const res of ext.responses) {
        if (!res.headersSent) res.status(503).json({ error: `Its server half crashed: ${crash.error}` });
        else if (!res.writableEnded) res.destroy();
      }
    });
  }
  const last = lastLines(name);
  // It goes to the model: nothing in it that looks like a secret.
  ext.answer = new Error(scrubSecrets(`The server half of ${name} crashed: ${crash.error}. The call was not answered.${held}${last ? `\n\nIts last lines:\n${last}` : ""}`));
  for (const end of ext.waiting) end(ext.answer);
}

/**
 * Makes an error that reaches the process from a server half's code that half's crash (see crashed), and so is a
 * call of `process.exit()` from there: the portal goes on. Uncaught exceptions and unhandled rejections both: in Node
 * 22 an error thrown by a timer, an immediate, a `process.nextTick`, an I/O callback (a file read, a socket, a server's
 * connection, a child process's exit) and a module's top level as it is imported, and a promise that rejects with
 * nobody to hear it (an async function's, a `.then`'s, a failed fetch), are known by the half whose code started them;
 * one thrown by a listener of an emitter something else owns, or by a `queueMicrotask` callback, is known by its stack.
 * An error that is no half's is given back to Node, which ends the portal as it always has. Called once, as the portal
 * starts (server.ts).
 */
export function catchExtensionCrashes(): void {
  const exit = process.exit;
  const giveBack = () => {
    process.off("uncaughtException", onException);
    process.off("unhandledRejection", onRejection);
    process.exit = exit;
  };
  function onException(error: unknown) {
    const ext = whose(error);
    if (ext) return crashed(ext, error);
    giveBack();
    // Thrown again with nobody to catch it: printed, and the portal ended with 1.
    process.nextTick(() => {
      throw error;
    });
  }
  function onRejection(reason: unknown) {
    const ext = whose(reason);
    if (ext) return crashed(ext, reason);
    giveBack();
    // Rejected again with nobody to hear it: Node's own handling, which ends the portal.
    void Promise.reject(reason);
  }
  process.on("uncaughtException", onException);
  process.on("unhandledRejection", onRejection);
  process.exit = ((code?: number | string | null) => {
    const error = new Error(`It called process.exit(${code ?? ""})`);
    const ext = whose(error);
    if (!ext) return exit.call(process, code);
    crashed(ext, error);
    // Its code goes no further, as it would not have.
    throw error;
  }) as typeof process.exit;
}

/** How long a server half may take to start, and to stop: one that hangs must not hold up every other, or the portal's own stop. */
let START_MS = 15_000;
let STOP_MS = 5_000;
/**
 * What ends a server half that runs in a process of its own: its process not answering for this long, its heap over
 * this (V8 aborts it), and its memory over this, where the system says it (Linux).
 */
let HANG_MS = 10_000;
let HEAP_MB = 512;
let RSS_MB = 1024;
/** How long a page that opens a chat waits for what such a half tells it first. */
const OPEN_MS = 2_000;
/** Other limits, for a test that cannot wait that long. */
export function setLimits(start: number, stop: number, more: { hang?: number; heapMb?: number; rssMb?: number } = {}): void {
  START_MS = start;
  STOP_MS = stop;
  HANG_MS = more.hang ?? HANG_MS;
  HEAP_MB = more.heapMb ?? HEAP_MB;
  RSS_MB = more.rssMb ?? RSS_MB;
}

/** `work`, or a rejection once it has taken longer than `ms`. */
export function within<T>(ms: number, work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`It had not finished ${what} after ${ms / 1000} seconds`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** What a server half says to a page, as it goes on the wire, or nothing where it cannot be written as JSON. */
function wire(name: string, data: unknown): string | undefined {
  try {
    return JSON.stringify({ extension: name, data: data ?? null });
  } catch (e) {
    console.error(`[extension ${name}] what it said to a page could not be sent:`, e);
    return undefined;
  }
}

/** How the host reaches what only the session manager can do, which it cannot import: the manager imports it. */
let tellChat: (chatId: string, extension: string, data: unknown) => Promise<boolean> = async () => false;
let toolOffered: (chatId: string, tool: string) => "direct" | "lazy" | undefined = () => undefined;
let reloadChats: () => Promise<{ reloaded: number; waiting: number }> = async () => ({ reloaded: 0, waiting: 0 });
let liveModel: LiveModel = async () => undefined;
/** Child chats (child-chats.ts): made, run, stopped and deleted by the session manager. */
let childChats: {
  create: (options: unknown, creator: string) => SessionRow;
  start: (options: unknown, creator: string) => SessionRow;
  lastAnswer: (chatId: string) => ChatAnswer | undefined;
  run: (chatId: string, message: string, options: { steer?: boolean }) => Promise<ChildRun>;
  abort: (chatId: string) => Promise<void>;
  remove: (chatId: string) => Promise<void>;
} = {
  create: () => {
    throw new Error("Child chats are not available here");
  },
  start: () => {
    throw new Error("Chats are not started here");
  },
  lastAnswer: () => undefined,
  run: async () => ({ status: "error", answer: "", error: "Child chats are not available here" }),
  abort: async () => {},
  remove: async () => {},
};
export function setChatBridge(
  bridge: { tell: typeof tellChat; offers: typeof toolOffered; reload: typeof reloadChats; model: LiveModel } & typeof childChats,
): void {
  tellChat = bridge.tell;
  toolOffered = bridge.offers;
  reloadChats = bridge.reload;
  liveModel = bridge.model;
  childChats = { create: bridge.create, start: bridge.start, lastAnswer: bridge.lastAnswer, run: bridge.run, abort: bridge.abort, remove: bridge.remove };
}
/** How a server half chooses voice mode's source, and asks which it is: the voice settings are the voice routes', which import the host. */
let voiceSource: { choose(name: string, chosen: boolean): void; chosen(): string } = { choose: () => {}, chosen: () => "" };
export function setVoiceChooser(source: typeof voiceSource): void {
  voiceSource = source;
}

function whoOf(chatId: string) {
  const row = getSession(chatId);
  if (!row) throw new Error("No such chat");
  return { row, who: identityOf(agentOf(row.workspace) ?? defaultAgent(), sandboxSupport()) };
}

function runPlain(argv: string[], input: Buffer | string | undefined, options: { cwd: string; signal?: AbortSignal }): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv;
    const child = spawn(cmd, args, { cwd: options.cwd, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    options.signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    const out: Buffer[] = [];
    let err = "";
    child.stdout!.on("data", (d: Buffer) => out.push(d));
    child.stderr!.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out), stderr: err.trim() }));
    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

function portalFor(ext: Running): ServerPortal {
  const name = ext.half.name;
  const folder = (id: string) => {
    const row = getSession(id);
    if (!row) throw new Error("No such chat");
    return baseDir(row.workspace);
  };
  /** A chat this package made (a child, or one it started in a folder), or a refusal that says why it is not one. */
  const ownChat = (id: string) => {
    const row = getSession(id);
    // One that is gone (deleted by the person, or with its project or agent while the half was away) is said to be
    // gone, not to be another's: a half that kept its id tells the two apart.
    if (!row) throw new Error(`There is no chat ${id}: it was deleted, or never was`);
    if (!row.creator) throw new Error(`${id} is no chat a package made: only a child chat or a chat a package started is prompted, stopped or removed`);
    if (row.creator !== name) throw new Error(`The chat ${id} was made by another package: only that one may prompt, stop or remove it`);
  };
  const dataDir = () => {
    const dir = dataDirOf(name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Where it really is, as `files` take a base: the data folder can be reached through a link.
    return realpathSync(dir);
  };
  return {
    version: 1,
    extension: name,
    executor: EXECUTOR_KIND,
    log: (text) => say(name, text),
    audit: {
      record(entry) {
        const { subject, reason, chatId } = entry ?? {};
        if (typeof subject !== "string" || subject === "" || (reason !== undefined && typeof reason !== "string") || (chatId !== undefined && typeof chatId !== "string")) {
          throw new TypeError("record takes { subject, reason?, chatId? }: what it was done to, a text that is not empty, and two texts");
        }
        // Under its name, of the one kind an extension writes: never a row that reads as the guard's. The chat is not
        // looked up: one deleted meanwhile is still named by its id, as in the guard's rows.
        recordAudit({ kind: "extension", tool: name, subject, reason, sessionId: chatId });
      },
    },
    provide(factory) {
      if (typeof factory !== "function") throw new TypeError("provide takes a function: (consumer) => what that consumer is given");
      ext.provider = factory;
    },
    folders: {
      list: () => listFolders(),
      allowed: (folder) => folderAllowed()(folder),
      on(event, handler) {
        if (event !== "removed") throw new TypeError(`There is no folder event "${String(event)}": there is "removed"`);
        ext.removed.push(handler);
      },
      label: (folder) => {
        const { name, home, newChats } = folderLabel(folder);
        return { name, ...(home ? { home: true as const } : {}), ...(newChats ? { newChats: true as const } : {}) };
      },
    },
    handoffs: {
      take: (what) => takeHandoff(what, dataDir()),
      done: (what) => handoffDone(what, dataDir()),
    },
    tools: {
      offer(names) {
        if (typeof names !== "function") throw new TypeError("offer takes a function: () => the tools offered now");
        ext.offers = names;
      },
      exceptions(names) {
        if (!Array.isArray(names) || !names.every((name) => typeof name === "string")) throw new TypeError("exceptions takes a list of tool names");
        const { byDefault, chats, routines } = toolExceptions(names);
        return { byDefault, chats: chats.map(({ id, title, kind }) => ({ id, title, kind })), routines };
      },
    },
    voice: {
      provide(provider) {
        if (
          typeof provider?.label !== "string" ||
          typeof provider.state !== "function" ||
          typeof provider.transcribe !== "function" ||
          typeof provider.speak !== "function" ||
          (provider.use !== undefined && typeof provider.use !== "function")
        ) {
          throw new TypeError(
            "provide takes { label, state, transcribe, speak, use? }: what it is called, what it offers now, how it recognises and speaks, and what it is told as voice mode is used",
          );
        }
        // Asked by voice mode as the extension's code.
        ext.voice = {
          label: provider.label,
          state: () => scope.run(ext, () => provider.state()),
          transcribe: (wav, options) => scope.run(ext, () => provider.transcribe(wav, options)),
          speak: (text, options) => scope.run(ext, () => provider.speak(text, options)),
          use: async (inUse) => scope.run(ext, () => provider.use?.(inUse)),
        };
      },
      choose(chosen) {
        if (typeof chosen !== "boolean") throw new TypeError("choose takes true, to be voice mode's source, or false, to stop being it");
        voiceSource.choose(name, chosen);
      },
      chosen: () => voiceSource.chosen() === name,
    },
    extensions: {
      use(of) {
        if (ext.half.requires?.[of] === undefined && ext.half.optional?.[of] === undefined) {
          throw new Error(`${of} is not one ${name} builds on: name it in "requires" or "optional" under "pithagoras" in its package.json`);
        }
        const provider = running.get(of);
        // An optional one that is not there, or not in a version this one takes: nothing. A required one is there, or this would not be running.
        if (!ext.uses.has(of) || !provider?.provider) return undefined;
        // Made by the one it builds on, as that one's code.
        if (!ext.apis.has(of)) ext.apis.set(of, scope.run(provider, () => provider.provider!({ name })));
        return ext.apis.get(of) as never;
      },
      // The portal's own work, which it asks for: not its code (see scope). Imported when first asked: it installs
      // through what starts and stops these halves, which imports this module. Not while this half starts, nor once it
      // stopped: an install waits for the server halves to follow it, which would wait for this one.
      install(folder, options) {
        if (typeof folder !== "string" || (options?.note !== undefined && typeof options.note !== "string")) {
          throw new TypeError("install takes a folder in this extension's dataDir(), and { note? }: a text");
        }
        if (running.get(name) !== ext) return Promise.reject(new Error("extensions.install is not available while its server half is starting or stopped"));
        return scope.exit(async () => (await import("./extension-installs.js")).installFor(dataDir(), folder, options?.note));
      },
      remove(of) {
        if (typeof of !== "string") throw new TypeError("remove takes the name of a package");
        if (running.get(name) !== ext) return Promise.reject(new Error("extensions.remove is not available while its server half is starting or stopped"));
        return scope.exit(async () => (await import("./extension-installs.js")).removeFor(name, of));
      },
      status(of, options) {
        if (typeof of !== "string") throw new TypeError("status takes the name of a package");
        return scope.exit(async () => (await import("./extension-installs.js")).statusOf(of, options));
      },
    },
    models: {
      of: (chatId) => scope.exit(() => modelOf(chatId, liveModel)),
      endpoint: (provider, id) => modelEndpoint(provider, id),
      list: () => modelProviders(),
    },
    mcp: {
      get: (server) => mcpServer(server),
      // The portal's own work, which it asks for: not its code (see scope).
      set: (server, entry, options = {}) =>
        scope.exit(async () => {
          // Imported when first asked: it installs packages through what starts and stops these halves, which imports this module.
          const { setMcpServer } = await import("./mcp-entry.js");
          await setMcpServer(server, entry);
          // Counted as the person's own on the extension's word, and no longer once the server is gone: Settings → Guard
          // lists only the servers there are, so a name left trusted could not be taken out, and would trust whatever
          // server is given that name next.
          if (entry === undefined) untrustMcpServer(server);
          else if (options.trusted === true) setTrustedMcpServers([...trustedMcpServers(), server]);
          return reloadChats();
        }),
    },
    memory: {
      hold(holder) {
        const { label, rule } = holder ?? {};
        if (typeof label !== "string" || !label.trim() || typeof rule !== "string" || !rule.trim() || typeof holder.on !== "function") {
          throw new TypeError("hold takes { label, rule, on }: two texts, and a function that says whether it holds the memory now");
        }
        // Its module still running after its half stopped, or failed to start: what it asks now would never be let go.
        if (ext.stopped) {
          say(name, "cannot hold the agent's memory: its server half is not running");
          return;
        }
        // Let go when the half stops. What it says of itself is the extension's: one that fails, or does not answer true, holds nothing.
        ext.stops.push(holdMemory(name, { label, rule, on: () => guarded(ext, "saying whether it holds the agent's memory", () => holder.on()) === true }));
      },
    },
    modes: {
      provide(mode) {
        const { id, label, description, confirm } = mode ?? {};
        const text = (value: unknown) => typeof value === "string" && value.trim() !== "";
        if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(id) || !text(label) || !text(description) || (confirm !== undefined && !text(confirm))) {
          throw new TypeError('provide takes { id, label, description, confirm? }: an id of lower-case letters, digits and "-", and texts');
        }
        // "custom/<id>" is what a chat stores for a mode the person made.
        if (name === "custom") throw new TypeError('A package called "custom" cannot offer modes: its modes would be taken for the person\'s own');
        const stored = `${name}/${id}`;
        // Its module still running after its half stopped, or failed to start: what it offers now would never go.
        if (ext.stopped) {
          say(name, `cannot offer the mode ${id}: its server half is not running`);
          return stored;
        }
        ext.stops.push(provideMode(name, { id, label, description, ...(confirm !== undefined ? { confirm } : {}) }));
        return stored;
      },
    },
    router: ext.router,
    http: {
      json: express.json,
      raw: express.raw,
      text: express.text,
      upgrade: (handler) => {
        ext.upgrade = handler;
      },
      endWithLogin: watchStream,
      // Read from the request's login as it came: the route's request, or an upgrade's, which no Express has seen.
      person: (req) => requestPerson(req),
      // A file of no type said is sent as bytes, to be saved: it is drawn by nothing.
      send: (req, res, file, options = {}) =>
        sendFile(req, res, { ...file, mimeType: file.mimeType ?? "application/octet-stream" }, options.cache ?? "private, no-cache", options.download ?? (file.mimeType ? undefined : file.name)),
    },
    chats: {
      get: (id) => {
        const row = getSession(id);
        return row && chatOf(row);
      },
      list: () => listSessions().map(chatOf),
      inFolder: (where) => {
        // One session of every kind for each agent that has some that work in `where`. What an agent can reach is the same from each of its sessions: the
        // sandbox runs a session as the agent its stored workspace belongs to (`agentOf`, else the first agent), whatever the path is that leads to `where`.
        // So the stored workspaces (one query, a row for each: an agent can make many that are links to one folder) are looked at once each, and one that
        // leads there is resolved (as `folder` does for a chat) only while its agent has none yet.
        const agents = listAgents();
        const first = defaultAgent();
        const found = new Map<string, Chat>();
        for (const row of sessionsByWorkspace()) {
          const key = (agentOf(row.workspace, agents) ?? first)?.id ?? "";
          if (found.has(key)) continue;
          try {
            if (baseDir(row.workspace) === where) found.set(key, chatOf(row));
          } catch {
            // Its folder is gone: it works in none.
          }
        }
        return [...found.values()];
      },
      folder,
      owner: (id) => {
        const row = getSession(id);
        return row ? chatOwner(row.workspace) : undefined;
      },
      send: (chatId, data) => {
        const text = wire(name, data);
        if (text) pagePushes.emit(chatId, text);
      },
      onOpen: (handler) => void ext.opens.push(handler),
      on: (event, handler) => void ext.life.on(event, handler),
      onEvent: (handler) => void ext.events.push(handler),
      // The chat's pi, started and run by the portal: not the extension's code (see scope).
      tell: (chatId, data) => scope.exit(() => tellChat(chatId, name, data)),
      reload: () => scope.exit(() => reloadChats()),
      offers: (chatId, tool) => toolOffered(chatId, tool),
      extend: (factory) => void ext.factories.push(factory),
      // A child chat is the package's that made it: only it prompts, stops or removes one. The person does all of
      // that on the child's own page, and its parent's delete takes it with it.
      create: (options) => chatOf(childChats.create(options, name)),
      start: (options) => chatOf(childChats.start(options, name)),
      // Found again without the ids kept: the children of a chat this package made, listed or not (chats.list leaves
      // the unlisted out), after a restart of the half or a lost record.
      children: (parent) => childSessions(String(parent)).filter((row) => row.creator === name).map(chatOf),
      prompt: async (chatId, message, options = {}) => {
        ownChat(chatId);
        if (typeof message !== "string" || !message.trim()) throw new TypeError("A child chat is sent a message with words in it");
        return scope.exit(() => childChats.run(chatId, message, { steer: options?.steer === true }));
      },
      // From what the portal keeps, so a half that started again (in a process of its own, maybe) finds how a run ended
      // while it was away.
      lastAnswer: (chatId) => {
        ownChat(chatId);
        return childChats.lastAnswer(chatId);
      },
      abort: async (chatId) => {
        ownChat(chatId);
        await scope.exit(() => childChats.abort(chatId));
      },
      remove: async (chatId) => {
        ownChat(chatId);
        await scope.exit(() => childChats.remove(chatId));
      },
      hold: (chatId) => {
        ext.holds.set(chatId, (ext.holds.get(chatId) ?? 0) + 1);
        let held = true;
        return () => {
          if (!held) return;
          held = false;
          const left = (ext.holds.get(chatId) ?? 1) - 1;
          if (left > 0) ext.holds.set(chatId, left);
          else ext.holds.delete(chatId);
        };
      },
    },
    sandbox: {
      on: sandboxOn,
      personEnv: personsEnv,
      spawnAs: (chatId) => {
        if (!sandboxOn()) return { argv: [], env: { ...process.env } };
        const { who } = whoOf(chatId);
        return { argv: asAgent(who), env: sandboxEnv(process.env, who) };
      },
      run: (chatId, argv, options = {}) => {
        const cwd = options.cwd ?? folder(chatId);
        if (!sandboxOn()) return runPlain(argv, options.input, { cwd, signal: options.signal });
        return runAsAgent(whoOf(chatId).who, argv, options.input, { cwd, signal: options.signal });
      },
    },
    files: folderFiles,
    git: { at: gitAt },
    dataDir,
  };
}

async function stop(ext: Running): Promise<void> {
  running.delete(ext.half.name);
  ext.stopped = true;
  // Its process ends with its stops: a call into it from a chat not loaded again since is answered at once.
  if (ext.child) ext.answer ??= new Error("Its server half was stopped; the chat has the new one at its next step");
  for (const fn of ext.stops.reverse()) await guarded(ext, "stopping", () => within(STOP_MS, Promise.resolve().then(fn), "stopping"));
  ext.life.removeAllListeners();
  live.delete(ext);
  left.set(ext.half.name, ext);
}

async function start(half: ServerHalf, sig: string, uses: Set<string>): Promise<void> {
  const ext: Running = { half, router: express.Router(), stops: [], opens: [], life: new EventEmitter(), events: [], factories: [], holds: new Map(), apis: new Map(), uses, sig, removed: [], where: [], waiting: new Set(), responses: new Set() };
  // Read before it starts: a folder deleted while it does is one it missed.
  const since = toldUpTo(half.name);
  try {
    const file = realpathSync(half.file);
    const folder = dirname(file);
    ext.where = [folder + sep, `${pathToFileURL(folder).href}/`];
    live.add(ext);
    // By its revision, after its first, and so is every file of its folder it imports: the same files changed are other
    // modules, and the ones already loaded are not served again (half-modules.ts). Or in a process of its own, which
    // imports it as it is. As its own code, and given up on at once should it crash meanwhile.
    const stopper = await within(
      START_MS,
      callInto(ext, () =>
        half.isolated
          ? startApart(ext, file)
          : import(moduleAt(file, half.rev)).then((module: any) => {
              if (typeof module.default !== "function") throw new Error("Its module has no default export to call");
              return module.default(portalFor(ext));
            }),
      ).catch((e) => {
        throw ext.crash ? new Error(`It crashed as it started: ${ext.crash.error}`) : e;
      }),
      "starting",
    );
    if (typeof stopper === "function") ext.stops.push(stopper);
    running.set(half.name, ext);
    failures.delete(half.name);
    say(half.name, "server half started");
    tellMissed(ext, since);
  } catch (e) {
    ext.stopped = true;
    for (const fn of ext.stops.reverse()) await guarded(ext, "stopping", () => within(STOP_MS, Promise.resolve().then(fn), "stopping"));
    live.delete(ext);
    left.set(half.name, ext);
    failures.set(half.name, (e as Error)?.message || String(e));
    console.error(`[extension ${half.name}] its server half could not be started:`, e);
  }
}

/**
 * Starts a half in a process of its own, with the `portal` a half in this process would have, which what it calls
 * there is applied to: what stops it, where its default export returned that.
 */
async function startApart(ext: Running, file: string): Promise<(() => unknown) | undefined> {
  // Outside its code: what its process says is the portal's to handle, not the half's (see scope).
  const child = scope.exit(() =>
    spawnHalf(file, {
      name: ext.half.name,
      executor: EXECUTOR_KIND,
      portal: portalFor(ext),
      limits: { stop: STOP_MS, hang: HANG_MS, heapMb: HEAP_MB, rssMb: RSS_MB },
      crashed: (reason) => crashed(ext, reason),
      crash: () => ext.crash?.error,
      answer: () => ext.answer,
      // Its own lines, as a line its code printed here would be (see said): one cannot write into another's by naming it.
      print: (stream, line) => scope.run(ext, () => (stream === "out" ? console.log(line) : console.error(line))),
      callAs: (of, call) => {
        const provider = running.get(of);
        return provider ? callInto(provider, call) : Promise.reject(new Error(`${of} is not running`));
      },
      agentAccess: agentAccessFor,
      life: ext.life,
    }),
  );
  ext.child = child;
  // The first of its stops, so it runs last: what it registered is let go of before its process ends.
  ext.stops.push(() => child.stop());
  const { stops } = await child.ready;
  return stops ? () => child.ask("stop", {}) : undefined;
}

/**
 * How the halves that are wanted are to run, as they build on one another (`pithagoras.requires` and `optional`): the
 * order to start them in, an extension before those that build on it; those that cannot start, and why (what they
 * require is not there, or not in a version they take, or they build on themselves through others); and what each may
 * use: what it requires, and the optional ones that are there in a version it takes.
 */
function plan(halves: ServerHalf[]): { order: ServerHalf[]; blocked: Map<string, string>; uses: Map<string, Set<string>> } {
  const byName = new Map(halves.map((half) => [half.name, half]));
  const blocked = new Map<string, string>();
  const uses = new Map<string, Set<string>>();
  const order: ServerHalf[] = [];
  const visiting: string[] = [];
  const visit = (half: ServerHalf): boolean => {
    if (uses.has(half.name)) return true;
    if (blocked.has(half.name)) return false;
    if (visiting.includes(half.name)) {
      const circle = [...visiting.slice(visiting.indexOf(half.name)), half.name];
      for (const name of circle) blocked.set(name, `It builds on itself, through ${circle.join(" → ")}`);
      return false;
    }
    visiting.push(half.name);
    const using = new Set<string>();
    let why: string | undefined;
    for (const [dep, range] of Object.entries(half.requires ?? {})) {
      const provider = byName.get(dep);
      if (!semver.validRange(range)) why ??= `It asks for ${dep} at "${range}", which is not a version range`;
      else if (!provider) why ??= `It needs ${dep} (${range}), which is not installed, or is switched off`;
      else if (!takes(range, provider.version)) why ??= `It needs ${dep} ${range}, and ${dep} ${provider.version ?? "with no version"} is installed`;
      else if (provider.isolated) why ??= `It needs ${dep}, whose server half runs in a process of its own and gives nothing to build on`;
      else if (!visit(provider)) why ??= `It needs ${dep}, which cannot start: ${blocked.get(dep) ?? "it builds on itself"}`;
      else using.add(dep);
    }
    for (const [dep, range] of Object.entries(half.optional ?? {})) {
      const provider = byName.get(dep);
      if (provider && !provider.isolated && takes(range, provider.version) && visit(provider)) using.add(dep);
    }
    visiting.pop();
    // Blocked by a circle met while looking at what it builds on.
    if (blocked.has(half.name)) return false;
    if (why) {
      blocked.set(half.name, why);
      return false;
    }
    uses.set(half.name, using);
    order.push(half);
    return true;
  };
  for (const half of halves) visit(half);
  return { order, blocked, uses };
}

/**
 * An extension's signature as things are now: its revision, whether it runs in a process of its own, and for each it
 * builds on that one's signature, or that it is not running. One whose signature is no longer the one it started with
 * holds what a provider that changed, came or went gave it, or nothing where there is something now, or runs where it
 * is no longer to run, and is started anew.
 */
function signature(half: ServerHalf, uses: Set<string>): string {
  const of = (dep: string) => `${dep}=${(uses.has(dep) && running.get(dep)?.sig) || "-"}`;
  return [half.rev, half.isolated ? "isolated" : "", ...Object.keys(half.requires ?? {}).map(of), ...Object.keys(half.optional ?? {}).map(of)].join(" ");
}

/** Stops an extension, and before it those that build on it, theirs first. */
async function stopWithDependents(ext: Running): Promise<void> {
  if (running.get(ext.half.name) !== ext) return;
  for (const other of [...running.values()].reverse()) {
    if (other !== ext && (other.half.requires?.[ext.half.name] !== undefined || other.half.optional?.[ext.half.name] !== undefined)) await stopWithDependents(other);
  }
  await stop(ext);
}

/** What was last asked to run: what a crash brings the halves in line with again (see crashed). None before the first ask. */
let asked: ServerHalf[] | undefined;
/**
 * The names of the server halves the last bringing in line asked for: of the installed packages, those switched on that
 * have one, whether it runs, crashed, waits on one it builds on or failed to start. The tools lists read it (shownTools):
 * the tools a half registers are listed while it is one of these. Undefined before the first, as the portal starts,
 * when which are installed and switched on is not known here yet.
 */
export const askedHalves = (): Set<string> | undefined => asked && new Set(asked.map((half) => half.name));
setServerHalvesAsked(askedHalves);
/**
 * Where the halves stand, as the last bringing in line left them: of each asked to run, whether it runs, and why not.
 * Each change of that is made by one, whoever asked for it (an install, a switch, a crash: see crashed), a hold lifted
 * included, and is in this as it ends.
 */
let standing = "";
let queue: Promise<void> = Promise.resolve();
/**
 * Bring what is running in line with `halves`: the installed packages that are
 * switched on and have a server half. One gone or changed is stopped, one new
 * or changed is started, and so is one that builds on another that was (see
 * signature): those that build on another are stopped before it, and started
 * after it. One that crashed is stopped, and not started again while it is the
 * revision that crashed and has not been left out (switched off) since. One at
 * a time: a second ask waits for the first.
 */
export function syncServerHalves(halves: ServerHalf[]): Promise<void> {
  asked = halves;
  const run = async () => {
    for (const [name, crash] of crashes) if (halves.find((half) => half.name === name)?.rev !== crash.rev) crashes.delete(name);
    const { order, blocked, uses } = plan(halves);
    const wanted = new Map(order.map((half) => [half.name, half]));
    // What is not wanted any more, or changed, or crashed, goes, with what builds on it: the latest started first.
    for (const ext of [...running.values()].reverse()) {
      const half = wanted.get(ext.half.name);
      if (!half || crashes.has(half.name) || ext.sig !== signature(half, uses.get(half.name)!)) await stopWithDependents(ext);
    }
    for (const name of [...failures.keys()]) if (!halves.some((half) => half.name === name)) failures.delete(name);
    for (const [name, why] of blocked) failures.set(name, why);
    // Started in order, what each builds on before it; then again for any whose provider has only now started (one
    // that failed before, say), until nothing more changes.
    for (let round = 0; round <= order.length; round++) {
      for (const half of order) {
        if (running.has(half.name)) continue;
        const crash = crashes.get(half.name);
        if (crash) {
          failures.set(half.name, `It crashed at ${crash.at}: ${crash.error}. It stays off until another revision of it is installed, or it is switched off and on.`);
          continue;
        }
        // What it requires did not start after all: it is said why, and it waits for the next change.
        const down = Object.keys(half.requires ?? {}).find((dep) => !running.has(dep));
        if (down) {
          failures.set(half.name, `It needs ${down}, whose server half could not start`);
          continue;
        }
        await start(half, signature(half, uses.get(half.name)!), uses.get(half.name)!);
      }
      const stale = [...running.values()].find((ext) => wanted.has(ext.half.name) && ext.sig !== signature(ext.half, uses.get(ext.half.name)!));
      if (!stale) break;
      await stopWithDependents(stale);
    }
    standing = JSON.stringify(halves.map((half) => [half.name, running.has(half.name), failures.get(half.name) ?? null]));
  };
  return (queue = queue.then(run, run));
}

/**
 * Where the server halves stand, as the last bringing in line left them (see standing). What every page follows of
 * what is installed is said with it (extensionsRevision in api/extensions.ts): a crash reaches every open page so.
 */
export const serverHalvesStanding = (): string => standing;

/** What was last asked for is done: every half that should run is running, or has said why not. Never rejects. */
export const serversSettled = (): Promise<void> => queue.catch(() => {});

/** Whether a package's server half is running now. */
export const isServing = (name: string): boolean => running.has(name);

/** Every server half stopped, as the portal stops. */
export function stopServerHalves(): Promise<void> {
  return syncServerHalves([]);
}

/** Why a package's server half is not running, if it is not. */
export const serverFailure = (name: string): string | undefined => failures.get(name);

/**
 * Where a package's server half stands, for whoever looks into it (the agent that is making the extension, a person in
 * Settings): whether it runs, why not, the crash it is held off for, and the lines it said lately.
 */
export function serverHalfStatus(name: string): { running: boolean; failure?: string; crash?: ServerHalfCrash; lines: LogLine[] } {
  const failure = failures.get(name), crash = crashes.get(name);
  return {
    running: running.has(name),
    ...(failure ? { failure } : {}),
    ...(crash ? { crash } : {}),
    lines: [...(said.get(name)?.lines ?? [])],
  };
}

/**
 * The extension a path under /api/x belongs to, and the rest of the path. A
 * package's name is one or two parts of the path (`@scope/name`), each read as
 * a browser wrote it. The rest is handed on as it came, not read here: the
 * package's routes read it, once.
 */
function owner(path: string): { ext: Running; rest: string } | undefined {
  const parts = path.split("/").slice(1);
  for (const ext of running.values()) {
    const name = ext.half.name.split("/");
    if (parts.length < name.length) continue;
    try {
      if (!name.every((part, i) => decodeURIComponent(parts[i]) === part)) continue;
    } catch {
      continue;
    }
    return { ext, rest: `/${parts.slice(name.length).join("/")}` };
  }
  return undefined;
}

/** Mounted at /api/x, after the login: hands a request to the routes of the package its path names. */
export const extensionRoutes: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  const was = req.url;
  const at = was.indexOf("?");
  const found = owner(at === -1 ? was : was.slice(0, at));
  if (!found) return next();
  const { ext } = found;
  // A route may hold its answer open, as a stream: ended with the login it was asked under, like the portal's own, and
  // answered should the half crash first.
  const unwatch = watchStream(() => res.destroy());
  ext.responses.add(res);
  res.once("close", () => {
    unwatch();
    ext.responses.delete(res);
  });
  // The package's routes are written from its own root, whatever it is called.
  req.url = found.rest + (at === -1 ? "" : was.slice(at));
  // In its own process, which answers it whole: what it does not take is its own 404.
  if (ext.child) return ext.child.proxy(req, res);
  // They run as its code, and so do the listeners it puts on the request and the answer; what the portal does when
  // they hand the request on is not.
  heardAs(ext, req);
  heardAs(ext, res);
  scope.run(ext, () =>
    ext.router(req, res, (error?: unknown) => {
      req.url = was;
      scope.exit(() => next(error));
    }),
  );
};

/** Whether an upgrade is asked of some extension's routes: checked for the login before it is said whether there is one to take it. */
export const isExtensionUrl = (url: string | undefined): url is string => !!url?.startsWith("/api/x/");

/** The upgrade handler of the package a URL under /api/x names, with the URL as its routes see it. */
export function extensionUpgrade(url: string | undefined): Upgrade | undefined {
  if (!isExtensionUrl(url)) return undefined;
  const at = url.indexOf("?");
  const found = owner((at === -1 ? url : url.slice(0, at)).slice("/api/x".length));
  const handler = found?.ext.upgrade;
  if (!found || !handler) return undefined;
  // In its own process: the stream is joined to it there, and is none of the portal's code.
  if (found.ext.child) {
    return (req, socket, head) => {
      req.url = found.rest + (at === -1 ? "" : url.slice(at));
      handler(req, socket, head);
    };
  }
  return (req, socket, head) => {
    req.url = found.rest + (at === -1 ? "" : url.slice(at));
    // The stream is the half's from here: what its socket says later runs as its code.
    heardAs(found.ext, socket);
    guarded(found.ext, "an upgrade", () => handler(req, socket, head));
  };
}

/** What one handler of `ext`'s says a page that opens `chatId` is told first; asked of its process, where it has one. */
function opening(ext: Running, handler: (chatId: string) => unknown, chatId: string): unknown {
  const data = guarded(ext, "what a page is told first", () => handler(chatId));
  if (!ext.child) return data;
  // The answer comes in time, or is nothing.
  return within(OPEN_MS, Promise.resolve(data), "saying what a page is told first").catch((e) => console.error(`[extension ${ext.half.name}]`, e.message));
}

/**
 * What each server half tells a page that opens a chat, each as it goes on the wire, written by `write` (the stream's
 * writer, which hears pagePushes while the stream is open). A half in the portal's process is written at once; one in
 * a process of its own when its answer comes, if the stream is still open then. Its answer and what it sends later
 * come by one channel, so the page never has an answer older than a push it already has.
 */
export function openingPushes(chatId: string, write: (text: string) => void): void {
  for (const ext of running.values()) {
    for (const handler of ext.opens) {
      const data = opening(ext, handler, chatId);
      const say = (said: unknown) => {
        const text = said !== undefined && !(said instanceof Promise) ? wire(ext.half.name, said) : undefined;
        if (text) write(text);
      };
      if (ext.child) void (data as Promise<unknown>).then((said) => pagePushes.listeners(chatId).includes(write) && say(said));
      else say(data);
    }
  }
}

/**
 * What one package's server half tells a page that opens a chat, as it would
 * say it now: for a browser half that came into the page after the chat's
 * stream had opened, and so was not there to be told.
 */
export async function openingFor(chatId: string, name: string): Promise<unknown[]> {
  const ext = running.get(name);
  if (!ext) return [];
  const said = ext.opens.map((handler) => opening(ext, handler, chatId));
  // Asked of its process: each answer as it comes, in time.
  const data = ext.child ? await Promise.all(said) : said;
  return data.filter((one) => one !== undefined && !(one instanceof Promise) && wire(name, one) !== undefined);
}

/** A chat's pi started or stopped, the chat was deleted, or the run it was started for is over (finished). */
export function chatLife(event: Life, chatId: string): void {
  for (const ext of running.values()) {
    for (const handler of ext.life.listeners(event)) guarded(ext, `hearing a chat was ${event}`, () => handler(chatId));
    if (event === "deleted") ext.holds.delete(chatId);
  }
}

/** Something a chat's pi said. Called for every event, a token at a time: nothing is done where nobody listens. */
export function chatEvent(chatId: string, event: Record<string, unknown>): void {
  for (const ext of running.values()) {
    for (const handler of ext.events) guarded(ext, "hearing a chat's event", () => handler(chatId, event));
  }
}

/** Whether a server half is keeping this chat's pi. */
export function extensionHolds(chatId: string): boolean {
  for (const ext of running.values()) if (ext.holds.has(chatId)) return true;
  return false;
}

/**
 * The pi extensions a chat's pi is given for the server halves, one for each
 * that adds to it: what it asked to add, registered for this chat. Asked for at
 * each load, so a reload has what was installed since.
 */
export function hostExtensions(chatId: string): { name: string; factory: (pi: any) => void }[] {
  // One for each package, by its name: pi files what each registers under it, so its tools are a group of their own
  // in the settings, as a package's pi extension's are, and not one heap of every server half's.
  return [...running.values()]
    .filter((ext) => ext.factories.length)
    .map((ext) => ({
      name: ext.half.name,
      factory: (pi: any) => {
        const row = getSession(chatId);
        if (!row) return;
        // What it registers is its code too: its tools' calls, its handlers and its commands run as that, and a crash of it
        // ends them at once. A handler of a half that crashed is not called again: it has no more say in the chat. A turn
        // it asks for is the chat's pi's work, not its code.
        const own = Object.create(pi, {
          registerTool: { value: (tool: any) => pi.registerTool({ ...tool, execute: (...args: unknown[]) => callInto(ext, () => tool.execute(...args)) }) },
          on: { value: (event: string, handler: (...args: unknown[]) => unknown) => pi.on(event, (...args: unknown[]) => (ext.crash ? undefined : callInto(ext, () => handler(...args)))) },
          // One with no handler is left to pi to refuse.
          registerCommand: {
            value: (name: string, options: any) =>
              pi.registerCommand(name, typeof options?.handler === "function" ? { ...options, handler: (...args: unknown[]) => callInto(ext, () => options.handler(...args)) } : options),
          },
          sendMessage: { value: (...args: unknown[]) => scope.exit(() => pi.sendMessage(...args)) },
          sendUserMessage: { value: (...args: unknown[]) => scope.exit(() => pi.sendUserMessage(...args)) },
        });
        // In its own process: its one factory here asks it there, and registers on `own` what its factories registered.
        // pi waits for that, and keeps its failure as the chat's load error.
        if (ext.child) return ext.factories[0](own, chatOf(row));
        for (const factory of ext.factories) {
          let added: unknown;
          try {
            // As its code (see scope).
            added = scope.run(ext, () => factory(own, chatOf(row)));
          } catch (e) {
            // pi keeps it as the chat's load error, which the chat is told (see loadErrors in pi/sdk-client.ts), and
            // loads nothing of the package's in that chat.
            console.error(`[extension ${ext.half.name}] adding to a chat's pi failed:`, e);
            throw e;
          }
          // One that fails later, after pi has loaded it, is in the log alone.
          if (added instanceof Promise) guarded(ext, "adding to a chat's pi", () => added);
        }
      },
    }));
}

/**
 * A call into a server half, its start or from a chat: run as the half's code, and answered at once with its crash,
 * and its last lines, should it crash before the call is done (see crashed). The agent reads that as the call's error,
 * in the same turn, and the chat goes on. One whose half has crashed already is answered so without being called.
 */
function callInto<T>(ext: Running, call: () => T | PromiseLike<T>): Promise<T> {
  if (ext.answer) return Promise.reject(ext.answer);
  return new Promise<T>((resolve, reject) => {
    // Ended by its crash as soon as that comes: where the call fails with it (it called process.exit), the crash is the answer.
    ext.waiting.add(reject);
    scope
      .run(ext, async () => call())
      .then(resolve, reject)
      .finally(() => ext.waiting.delete(reject));
  });
}
