import { spawn, type ChildProcess } from "node:child_process";
import type { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Agent, request, type IncomingMessage } from "node:http";
import { connect } from "node:net";
import { setPriority, tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex, Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { Request, Response } from "express";
import type { Chat, ServerPortal } from "@pithagoras/extension-api/server";
import { API_FN, CHILD_FN, PARENT_FN, errorIn, errorOut, swapped, type CrossedError, type FnUse } from "./half-wire.js";
import { LOG_LINE_MAX } from "./logs.js";

/**
 * A server half in a process of its own: the portal's side of it (half-runtime.ts is the half's). The half is given a
 * `portal` there whose members that need the portal's state call the portal, and each such call is applied here to
 * the ordinary `portal` extension-host.ts builds for the half, by its member path, so that its checks, what it keeps
 * and what it lets go when the half stops are those of a half in the portal's own process.
 *
 * What it protects the portal from: a loop that never yields, a heap or a process that grows without end, a crash of
 * a native addon, and what the half starts, all of which end the half's process and not the portal's. It is no
 * security boundary: the process is the portal's user, with its environment.
 *
 * A function the half gives (a listener, what a page is told first) is a handle here, and a function the portal gives
 * back (a hold's release) a handle there: see half-wire.ts. This file imports nothing of extension-host.ts, which
 * hands it what it needs (HalfHost).
 */

// Under `npm run dev` tsx's resolve hook gives the `.ts` file, which the process then loads through the same loader:
// it is started with the portal's own execArgv.
const HALF_RUNTIME = fileURLToPath(import.meta.resolve("./half-runtime.js"));

/** How often the half is asked whether it can answer, and how often that, and its memory, are looked at. */
const PING_MS = 1000;
const CHECK_MS = 250;
/** How long the half's `chats.extend` factories may take for one load of a chat's pi. */
const EXTEND_MS = 5000;
/** How long a request the half could not be reached for waits to be answered with its crash, should its process be ending. */
const EXIT_WAIT_MS = 250;
/**
 * How long the end of its process waits for what it printed and reported to be read: its channels close then, unless
 * something it started left its group and holds them.
 */
const CLOSE_MS = 1000;
/** Linux says a process's memory in /proc; elsewhere only the cap on its heap holds. */
const PROC = existsSync("/proc/self/status");

/** What extension-host.ts gives a half that runs in a process of its own. */
export interface HalfHost {
  name: string;
  executor: string;
  /** The ordinary `portal` of the half, which what it calls is applied to. */
  portal: ServerPortal;
  limits: { stop: number; hang: number; heapMb: number; rssMb: number };
  /** It crashed, for this reason (see crashed in extension-host.ts). */
  crashed(reason: unknown): void;
  /** What its crash was, once it has crashed. */
  crash(): string | undefined;
  /** What a call into it is answered with once it has crashed or been stopped. */
  answer(): Error | undefined;
  /** One of its lines, as its process printed it. */
  print(stream: "out" | "err", line: string): void;
  /** Runs `call` as the code of `of`, an extension in the portal's process that it builds on. */
  callAs(of: string, call: () => unknown): Promise<unknown>;
  /** Who the agents of some chats are (agentAccessFor in extension-host.ts). */
  agentAccess(chats: readonly string[], ids: readonly string[]): unknown;
  /** The life of its chats (ext.life): a chat's pi that stops, or a chat deleted, lets go of what that pi was given of it. */
  life: EventEmitter;
}

/** What the half calls and is answered at once, by its member path in `portal`; `agentAccess` is the portal's alone. */
const NOW = new Set([
  "chats.get",
  "chats.list",
  "chats.inFolder",
  "chats.folder",
  "chats.offers",
  "chats.extend",
  "chats.onOpen",
  "chats.on",
  "chats.onEvent",
  "chats.hold",
  "chats.create",
  "chats.children",
  "folders.list",
  "folders.allowed",
  "folders.label",
  "folders.on",
  "tools.exceptions",
  "tools.offer",
  "models.list",
  "mcp.get",
  "sandbox.on",
  "sandbox.spawnAs",
  "sandbox.personEnv",
  "handoffs.take",
  "handoffs.done",
  "dataDir",
  "audit.record",
  "modes.provide",
  "memory.hold",
  "extensions.use",
  "http.upgrade",
  "http.endWithLogin",
  "agentAccess",
]);
/** What it calls and is answered later. */
const LATER = new Set(["models.of", "models.endpoint", "mcp.set", "chats.tell", "chats.reload", "chats.prompt", "chats.abort", "chats.remove", "sandbox.run", "extensions.install", "extensions.remove", "extensions.status"]);

/** A member of `portal` by its path, called on what it belongs to. */
function member(portal: ServerPortal, path: string): (...args: unknown[]) => unknown {
  const parts = path.split(".");
  let holder: any = portal;
  for (const part of parts.slice(0, -1)) holder = holder[part];
  const fn = holder[parts[parts.length - 1]];
  return (...args) => fn.apply(holder, args);
}

/** What the half works out itself and the portal reads (`tools.offer`, `memory.hold`'s `on`). */
const mirrored = (value: unknown) => (value as Record<string, unknown> | null)?.[CHILD_FN] !== undefined && (value as { use?: unknown }).use === "mirror";

/**
 * Each line `stream` gives, as it comes; the last one too, without its line break. Each part is looked through once, as
 * it comes. With `max`, a line that grows past it is given in its first `max` characters, and what follows of it, up to
 * its line break, is left out: the half's output may have no line break at all (a progress meter that only goes back
 * to the line's start), and would fill the portal's memory. A line that ends in the part it came in is held to it the
 * same: which parts the pipe hands the output on in is not the half's doing. Exported for a test, which hands it the
 * parts itself: a pipe's are not a test's to choose.
 */
export function lines(stream: Readable, each: (line: string) => void, max = Infinity): void {
  let rest = "";
  let cut = false;
  stream.setEncoding("utf8");
  stream.on("data", (text: string) => {
    let from = 0;
    for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", from)) {
      if (!cut) each((rest + text.slice(from, end)).slice(0, max));
      rest = "";
      cut = false;
      from = end + 1;
    }
    if (cut) return;
    rest += text.slice(from);
    if (rest.length <= max) return;
    each(rest.slice(0, max));
    rest = "";
    cut = true;
  });
  stream.on("end", () => rest && each(rest));
  stream.on("error", () => {});
}

/** Why the portal ended the half's process, or how it ended: said as it is, with no stack of the portal's, which would tell nothing of the half. */
function said(text: string): Error {
  const error = new Error(text);
  delete error.stack;
  return error;
}

/** What the half's process reported it threw, as a half in the portal's process would have thrown it: an error with its stack, or what was thrown. */
function reported(crash: CrossedError): unknown {
  if (crash.name === undefined) return crash.text;
  const error = errorIn(crash);
  if (crash.stack) error.stack = crash.stack;
  return error;
}

/** The processes of the halves that run now: each ended, with what it started, as the portal's process ends. */
const live = new Set<IsolatedChild>();
process.on("exit", () => {
  for (const child of live) child.killGroup();
});

/**
 * The Unix sessions of the halves' processes, each of which leads one of its own (it is started `detached`): what a
 * half starts is its own, as what a half in the portal's process starts is the portal's, and no agent's job in the
 * chat it runs in (see background.ts).
 */
export function halfSessions(): Set<number> {
  return new Set([...live].flatMap((child) => child.pid ?? []));
}

type Ask = { resolve: (value: any) => void; reject: (error: Error) => void; onUpdate?: (value: unknown) => void };

export class IsolatedChild {
  /** Its default export has returned, and whether it returned what stops it; rejected where it threw. */
  readonly ready: Promise<{ stops: boolean }>;
  /** What the half worked out last of what the portal asks of it synchronously. About a second old at most. */
  mirror: { offers?: unknown; memory?: boolean } = {};
  private readonly child: ChildProcess;
  /** Where the answers to its synchronous calls are written (its fd 5). */
  private readonly answers: Writable;
  private readonly folder: string;
  private readonly socket: string;
  private readonly agent = new Agent({ keepAlive: true });
  private readonly asks = new Map<number, Ask>();
  /** The portal's functions it holds, by their handle; the runs it asked for (`sandbox.run`), by its call. */
  private readonly given = new Map<number, (...args: unknown[]) => unknown>();
  private readonly runs = new Map<number, AbortController>();
  /** Each load of a chat's pi the half was asked to add to, and the latest load of each chat. */
  private readonly loads = new Map<number, any>();
  private readonly byChat = new Map<string, number>();
  private lastId = 0;
  private started = false;
  /** It has answered a ping: from then on, it is ended should it stop answering (see the check). */
  private answered = false;
  private failed = false;
  private stopping = false;
  private extended = false;
  /** Why the portal ended it (the watchdog), its own report of its crash, and how its process ended. */
  private killedFor?: Error;
  private report?: CrossedError;
  private exit?: { code: number | null; signal: NodeJS.Signals | null };
  private over = false;
  private lastPong = Date.now();
  private readonly check: ReturnType<typeof setInterval>;
  private readonly ping: ReturnType<typeof setInterval>;
  private settle!: { resolve: (value: { stops: boolean }) => void; reject: (error: Error) => void };
  /** Its process has ended, and that is handled. */
  readonly ended: Promise<void>;
  private end!: () => void;

  constructor(file: string, private readonly host: HalfHost) {
    this.ready = new Promise((resolve, reject) => (this.settle = { resolve, reject }));
    this.ended = new Promise((resolve) => (this.end = resolve));
    // The folder of its routes' socket, the portal's user's alone (mkdtemp makes it 0700).
    this.folder = mkdtempSync(join(tmpdir(), "pithagoras-"));
    this.socket = join(this.folder, "1.sock");
    const { hang, heapMb, rssMb } = host.limits;
    // A group of its own, so that what it starts is ended with it.
    this.child = spawn(process.execPath, [...process.execArgv.filter((arg) => !arg.startsWith("--inspect")), `--max-old-space-size=${heapMb}`, HALF_RUNTIME], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "ipc", "pipe", "pipe"],
      serialization: "advanced",
      env: process.env,
    });
    live.add(this);
    const pid = this.child.pid;
    // Below the portal's own work: a half that is busy leaves the portal its share.
    if (pid) setPriority(pid, 10);
    this.child.on("error", (e) => console.error(`[extension ${host.name}] its process:`, e));
    this.child.on("message", (message) => this.told(message));
    // A chat's pi that stops, or a chat deleted: what that pi was given of the half is let go of, here and there.
    host.life.on("stopped", (chatId: string) => this.dropChat(chatId));
    host.life.on("deleted", (chatId: string) => this.dropChat(chatId));
    // A line is kept to LOG_LINE_MAX characters in the log anyway (logs.ts).
    lines(this.child.stdout!, (line) => host.print("out", line), LOG_LINE_MAX);
    lines(this.child.stderr!, (line) => host.print("err", line), LOG_LINE_MAX);
    const [, , , , requests, answers] = this.child.stdio as unknown as [unknown, unknown, unknown, unknown, Readable, Writable];
    lines(requests, (line) => this.heard(line));
    this.answers = answers.on("error", () => {});
    // Its end is handled once its last lines and its crash report are read. Not on the process's "close", which waits
    // for the IPC channel too, and never comes where the portal let go of that as the process was dying.
    const read = Promise.all([this.child.stdout!, this.child.stderr!, requests].map((stream) => new Promise((resolve) => stream.once("close", resolve))));
    this.child.on("exit", (code, signal) => {
      this.exit = { code, signal };
      // What it started goes with it.
      this.killGroup();
      void Promise.race([read, new Promise((resolve) => setTimeout(resolve, CLOSE_MS).unref())]).then(() => this.ending());
    });
    // Asked from the spawn on, and once before it is told to start: it answers from its own code (half-runtime.ts) once
    // that is loaded, before the half's module is, and also while the half's start awaits. From that first answer a
    // half that stops answering is ended, while it starts too: a start that never yields would otherwise run until
    // START_MS, be no crash, and be started again at every sync.
    this.post({ t: "ping" });
    this.ping = setInterval(() => this.post({ t: "ping" }), PING_MS);
    this.ping.unref();
    let lastCheck = Date.now();
    this.check = setInterval(() => {
      const now = Date.now();
      // The portal's own process stalled: the half's answers wait in the channel, and are not late.
      if (now - lastCheck > 2 * CHECK_MS) this.lastPong += now - lastCheck;
      lastCheck = now;
      if (this.answered && now - this.lastPong > hang) {
        return this.kill(said(`It did not let its process answer for ${hang / 1000} seconds (a loop that never ends, or a long synchronous call), so its process was ended`));
      }
      // From the start: a start is bounded in time, not in memory.
      if (PROC && pid && rssKb(pid) > rssMb * 1024) this.kill(said(`Its process used more than ${rssMb} MB of memory, so it was ended`));
    }, CHECK_MS);
    this.check.unref();
    this.post({ t: "init", version: 1, name: host.name, executor: host.executor, file, socket: this.socket });
  }

  /** Its process's id, which is also its Unix session's. */
  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Told to the half, with no answer; nothing once its process has ended. */
  post(message: Record<string, unknown>): void {
    if (this.child.connected) this.child.send(message);
  }

  /** Asked of the half (see `asked` in half-runtime.ts): its answer, or its error. */
  ask(kind: string, payload: Record<string, unknown>, options: { signal?: AbortSignal; onUpdate?: (value: unknown) => void; ms?: number; what?: string } = {}): Promise<any> {
    if (this.over || !this.child.connected) return Promise.reject(this.host.answer() ?? new Error("Its server half's process has ended"));
    const id = ++this.lastId;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => this.post({ t: "abort", id });
      const done = () => {
        this.asks.delete(id);
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
      };
      this.asks.set(id, { resolve: (value) => (done(), resolve(value)), reject: (error) => (done(), reject(error)), onUpdate: options.onUpdate });
      try {
        this.child.send({ t: "ask", id, kind, ...payload });
      } catch (e) {
        done();
        return reject(e);
      }
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
      if (options.ms) timer = setTimeout(() => this.asks.get(id)?.reject(new Error(`It had not finished ${options.what} after ${options.ms! / 1000} seconds`)), options.ms);
    });
  }

  /** A stub of a function of the half's (see FnUse); a mirrored one stays a marker, for the member it is given to. */
  private stub(marker: Record<string, unknown>): unknown {
    const handle = marker[CHILD_FN];
    const use = marker.use as FnUse;
    if (use === "run") return (...args: unknown[]) => this.post({ t: "run", handle, args });
    if (use === "call") return (...args: unknown[]) => this.ask("call", { handle, args });
    if (use === "open") return (chatId: string) => this.ask("open", { handle, chatId });
    return marker;
  }

  private unmarked(value: unknown, handles?: number[]): unknown {
    return swapped(value, (fn) => fn, (marker) => {
      if (typeof marker[CHILD_FN] !== "number") return marker;
      handles?.push(marker[CHILD_FN] as number);
      return this.stub(marker);
    });
  }

  /** A synchronous call of the half's, answered on fd 5 before anything else is done; or its crash report. */
  private heard(line: string): void {
    let request: { id: number; path: string; args: unknown[]; crash?: CrossedError };
    try {
      request = JSON.parse(line);
    } catch {
      return;
    }
    if (request.crash) return void (this.report = request.crash);
    let answer: string;
    try {
      // The portal's functions in the answer are handles there.
      const value = swapped(this.now(request.path, this.unmarked(request.args) as unknown[]), (fn) => {
        const handle = ++this.lastId;
        this.given.set(handle, fn as never);
        return { [PARENT_FN]: handle };
      });
      answer = JSON.stringify({ id: request.id, value });
    } catch (e) {
      answer = JSON.stringify({ id: request.id, error: errorOut(e) });
    }
    this.answers.write(`${answer}\n`);
  }

  private now(path: string, args: unknown[]): unknown {
    if (!NOW.has(path)) throw new Error(`There is no call ${path} of the portal`);
    const portal = this.host.portal;
    switch (path) {
      case "agentAccess":
        return this.host.agentAccess(args[0] as string[], args[1] as string[]);
      // One factory of the portal's stands for all of the half's: it asks the half at each load (see extend).
      case "chats.extend":
        if (!this.extended) portal.chats.extend((own, chat) => this.extend(own, chat));
        this.extended = true;
        return undefined;
      case "http.upgrade":
        return portal.http.upgrade((req, socket, head) => this.upgrade(req, socket, head));
      case "tools.offer":
        return portal.tools.offer(mirrored(args[0]) ? () => this.mirror.offers as never : (args[0] as never));
      case "memory.hold": {
        const holder = args[0] as Record<string, unknown> | undefined;
        return portal.memory.hold((holder && mirrored(holder.on) ? { ...holder, on: () => this.mirror.memory === true } : holder) as never);
      }
      // What an extension in the portal gives it: its data copied, each function a path the half asks by (see api).
      case "extensions.use":
        return swapped(portal.extensions.use(args[0] as string), (_fn, at) => ({ [API_FN]: at }));
    }
    return member(portal, path)(...args);
  }

  /** What the half told the portal over IPC. Outside the half's code (it was started outside it): what fails here is the portal's to say. */
  private told(message: any): void {
    switch (message.t) {
      case "started":
        this.started = true;
        return this.settle.resolve({ stops: message.stops });
      case "failed":
        this.failed = true;
        // As an import that throws in the portal's process fails: with what it threw.
        return this.settle.reject(reported(message.error) as Error);
      case "pong":
        this.answered = true;
        this.lastPong = Date.now();
        return;
      case "answer":
        if (message.error) this.asks.get(message.id)?.reject(errorIn(message.error));
        else this.asks.get(message.id)?.resolve(message.value);
        return;
      case "update":
        this.asks.get(message.id)?.onUpdate?.(message.value);
        return;
      case "mirror":
        this.mirror = { offers: message.offers, memory: message.memory };
        return;
      case "call":
        return void this.later(message);
      case "api":
        return void this.api(message);
      case "abort":
        this.runs.get(message.id)?.abort();
        return;
      case "send":
        return this.host.portal.chats.send(message.chatId, message.data);
      case "pi": {
        const pi = this.loads.get(message.load);
        if (!pi || (message.method !== "sendMessage" && message.method !== "sendUserMessage")) return;
        // A turn of the chat's pi, which is the chat's: not the half's code (see hostExtensions in extension-host.ts).
        void Promise.resolve()
          .then(() => pi[message.method](...message.args))
          .catch((e: unknown) => console.error(`[extension ${this.host.name}] asking a chat's pi for a turn failed:`, e));
        return;
      }
      case "invoke": {
        const fn = this.given.get(message.handle);
        this.given.delete(message.handle);
        try {
          fn?.(...message.args);
        } catch (e) {
          console.error(`[extension ${this.host.name}] what the portal gave it failed:`, e);
        }
        return;
      }
    }
  }

  private result(id: number, reply: { value?: unknown; error?: CrossedError }): void {
    try {
      this.post({ t: "result", id, ...reply });
    } catch (e) {
      // An answer that cannot be cloned is that call's error.
      this.post({ t: "result", id, error: errorOut(e) });
    }
  }

  /** A call of the half's answered later. A run it asked for is aborted when it says so, or when its process ends. */
  private async later({ id, path, args }: { id: number; path: string; args: unknown[] }): Promise<void> {
    let reply: { value?: unknown; error?: CrossedError };
    try {
      if (!LATER.has(path)) throw new Error(`There is no call ${path} of the portal`);
      if (path === "sandbox.run") {
        const controller = new AbortController();
        this.runs.set(id, controller);
        try {
          reply = { value: await this.host.portal.sandbox.run(args[0] as string, args[1] as string[], { ...(args[2] as object), signal: controller.signal }) };
        } finally {
          this.runs.delete(id);
        }
      } else {
        reply = { value: await member(this.host.portal, path)(...args) };
      }
    } catch (e) {
      reply = { error: errorOut(e) };
    }
    this.result(id, reply);
  }

  /**
   * A function of what an extension in the portal gives the half (`extensions.use`), by its path: run as that
   * extension's code. A function in its arguments is the half's, let go of once the call is done; one in its answer
   * cannot cross.
   */
  private async api({ id, of, path, args }: { id: number; of: string; path: string[]; args: unknown[] }): Promise<void> {
    const handles: number[] = [];
    let reply: { value?: unknown; error?: CrossedError };
    try {
      let holder: any;
      let fn: any = this.host.portal.extensions.use(of);
      for (const key of path) {
        // What it gives, by its own members only (the paths it was handed, see now): never into what every object has.
        if (fn == null || !Object.hasOwn(fn, key)) throw new TypeError(`What ${of} gives has no function at ${path.join(".")}`);
        holder = fn;
        fn = fn[key];
      }
      if (typeof fn !== "function") throw new TypeError(`What ${of} gives has no function at ${path.join(".")}`);
      const given = this.unmarked(args, handles) as unknown[];
      const value = await this.host.callAs(of, () => fn.apply(holder, given));
      reply = {
        value: swapped(value, (_fn, at) => {
          throw new TypeError(`What ${path.join(".")} of ${of} answered has a function at ${at.join(".") || "its top"}, which a server half in a process of its own cannot be given`);
        }),
      };
    } catch (e) {
      reply = { error: errorOut(e) };
    }
    this.result(id, reply);
    if (handles.length) this.post({ t: "release", handles });
  }

  /**
   * What the half's `chats.extend` factories register for one load of a chat's pi, registered on `own` (the chat's
   * pi as hostExtensions in extension-host.ts gives it, whose wrapping runs each call as the half's): its tools'
   * calls, its handlers and its commands are asks of the half. pi waits for this, and keeps its failure as the chat's
   * load error.
   */
  async extend(own: any, chat: Chat): Promise<void> {
    this.dropChat(chat.id);
    const load = ++this.lastId;
    this.byChat.set(chat.id, load);
    this.loads.set(load, own);
    try {
      const { tools, handlers, commands } = (await this.ask("extend", { chat, load }, { ms: EXTEND_MS, what: "adding to a chat's pi" })) as {
        tools: { def: Record<string, unknown>; handle: number }[];
        handlers: { event: string; handle: number }[];
        commands: { name: string; options: Record<string, unknown>; handle?: number }[];
      };
      for (const { def, handle } of tools) {
        own.registerTool({
          ...def,
          // pi's ctx stays here: the half has no pi of its own to use it with.
          execute: (toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: (value: unknown) => void) => this.ask("execute", { handle, toolCallId, params }, { signal, onUpdate }),
        });
      }
      for (const { event, handle } of handlers) own.on(event, (data: unknown) => this.ask("call", { handle, args: [data] }));
      for (const { name, options, handle } of commands) {
        own.registerCommand(name, handle === undefined ? options : { ...options, handler: (args: unknown) => this.ask("call", { handle, args: [args] }) });
      }
    } catch (e) {
      this.dropChat(chat.id);
      console.error(`[extension ${this.host.name}] adding to a chat's pi failed:`, e);
      throw e;
    }
  }

  /** What a chat's pi was given of the half is let go of, there and here. */
  private dropChat(chatId: string): void {
    const load = this.byChat.get(chatId);
    if (load === undefined) return;
    this.byChat.delete(chatId);
    this.loads.delete(load);
    this.post({ t: "drop", load });
  }

  /**
   * A request to the half's routes, handed on to its process as it came and answered as it answers. Where its process
   * cannot be reached, the answer is its crash should it have crashed, else 502.
   */
  proxy(req: Request, res: Response): void {
    const up = request({ socketPath: this.socket, method: req.method, path: req.url, headers: req.headers, agent: this.agent });
    up.on("response", (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.statusMessage, answer.rawHeaders);
      answer.on("error", () => res.destroy());
      answer.pipe(res);
    });
    up.on("error", () => void this.unreachable(res));
    // The page went away before the answer was done: so does the request.
    res.on("close", () => res.writableFinished || up.destroy());
    req.pipe(up);
  }

  private async unreachable(res: Response): Promise<void> {
    // Its process may be ending, and its crash not yet said.
    if (!this.host.crash()) await Promise.race([this.ended, new Promise((resolve) => setTimeout(resolve, EXIT_WAIT_MS))]);
    if (res.headersSent) return void (res.writableEnded || res.destroy());
    const crash = this.host.crash();
    res.status(crash ? 503 : 502).json({ error: crash ? `Its server half crashed: ${crash}` : "Its server half could not be reached" });
  }

  /** A WebSocket upgrade under the half's routes, handed on to its process as the request came, and joined both ways. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const up = connect(this.socket);
    const said = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) said.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    up.write(`${said.join("\r\n")}\r\n\r\n`);
    up.write(head);
    up.pipe(socket);
    socket.pipe(up);
    up.on("error", () => socket.destroy());
    up.on("close", () => socket.destroy());
    socket.on("close", () => up.destroy());
  }

  /**
   * Ends its process: let go of (an IPC disconnect, on which it ends), and ended with what it started once it has not
   * ended within the time to stop. Its end is then no crash.
   */
  stop(): Promise<void> {
    this.stopping = true;
    if (this.child.connected) this.child.disconnect();
    const timer = setTimeout(() => this.killGroup(), this.host.limits.stop);
    return this.ended.finally(() => clearTimeout(timer));
  }

  /** The watchdog ends it, for `reason`: its crash, said now, with what the portal knows. */
  private kill(reason: Error): void {
    if (this.killedFor || this.exit) return;
    this.killedFor = reason;
    clearInterval(this.check);
    this.host.crashed(reason);
    this.killGroup();
  }

  killGroup(): void {
    try {
      process.kill(-this.child.pid!, "SIGKILL");
    } catch {
      // Gone already.
    }
  }

  /** Its process ended: a crash unless it was stopped or did not start, and every call into it is answered. */
  private ending(): void {
    if (this.over || !this.exit) return;
    this.over = true;
    clearInterval(this.check);
    clearInterval(this.ping);
    live.delete(this);
    this.agent.destroy();
    rmSync(this.folder, { recursive: true, force: true });
    for (const run of this.runs.values()) run.abort();
    const { code, signal } = this.exit;
    const how = signal ? `Its process ended by ${signal}` : `Its process ended with code ${code}`;
    // Where the watchdog ended it, that was said as its crash. A crash it reported itself is its crash, stopping or not
    // (see crashed in extension-host.ts); any other end is, unless it was stopped or did not start.
    if (!this.killedFor) {
      if (this.report) this.host.crashed(reported(this.report));
      else if (!this.stopping && !this.failed) this.host.crashed(said(how));
    }
    const answer = this.host.answer() ?? said(how);
    if (!this.started && !this.failed) this.settle.reject(answer);
    for (const ask of [...this.asks.values()]) ask.reject(answer);
    this.end();
  }
}

/** Its memory as the kernel counts it (VmRSS), in kB; nothing once it is gone. */
function rssKb(pid: number): number {
  try {
    return Number(/^VmRSS:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0);
  } catch {
    return 0;
  }
}

/** Starts a server half's module, `file`, in a process of its own. */
export function spawnHalf(file: string, host: HalfHost): IsolatedChild {
  return new IsolatedChild(file, host);
}
