import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join, resolve as resolvePath } from "node:path";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";
import express, { type NextFunction, type Request, type RequestHandler, type Response, type Router } from "express";
import { agentOf, defaultAgent } from "./agents.js";
import { DATA_DIR } from "./data-dir.js";
import { getSession, listSessions, type SessionRow } from "./db.js";
import { EXECUTOR_KIND } from "./executor-kind.js";
import type { ServerHalf } from "./extension-ui.js";
import { asAgent, runAsAgent, sandboxEnv } from "./sandbox/exec.js";
import { identityOf } from "./sandbox/identity.js";
import { sandboxOn, sandboxSupport } from "./sandbox/policy.js";
import { baseDir, resolveInside } from "./workspace-files.js";
import { watchStream } from "./login-streams.js";

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
 * It is what the portal's own Files, Terminal and Canvases have, each written
 * into the server; a package gets it by naming a module:
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
 */

/** A chat, as an extension's server half is told of it. */
export interface Chat {
  id: string;
  title: string;
  /** The folder the chat works in, as the chat names it. */
  workspace: string;
  status: SessionRow["status"];
}

type Life = "started" | "stopped" | "deleted";
type Upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
type Ran = { code: number | null; stdout: Buffer; stderr: string };

export interface ServerPortal {
  /** Of this interface: raised when something an extension relies on changes. */
  version: 1;
  /** The package's name. */
  extension: string;
  /** How pi is run here: "host" is in the portal's own process, where a chat's pi and this module can reach each other. */
  executor: string;
  log(text: string): void;
  /**
   * The package's own routes, at /api/x/<package>/…, behind the portal's
   * login. No body is read for them: a route that takes JSON says so with
   * `portal.http.json()`, and one that takes a file reads the request itself.
   */
  router: Router;
  http: {
    json: typeof express.json;
    raw: typeof express.raw;
    text: typeof express.text;
    /** WebSocket upgrades under /api/x/<package>/…, already checked for the login and for the page they come from. */
    upgrade(handler: Upgrade): void;
  };
  chats: {
    get(id: string): Chat | undefined;
    list(): Chat[];
    /**
     * The folder a chat's pi works in, on this disk: where a server half reads
     * and keeps what belongs to that chat. Throws when the chat is gone or its
     * folder is.
     */
    folder(id: string): string;
    /** To what the package drew on the pages open on a chat. Nothing is stored. */
    send(chatId: string, data: unknown): void;
    /** What a page that opens a chat is told first: where things stand. Nothing, to tell it nothing. */
    onOpen(handler: (chatId: string) => unknown): void;
    /** A chat's pi was started or stopped, or the chat was deleted. */
    on(event: Life, handler: (chatId: string) => void): void;
    /** Everything a chat's pi says, as it says it: messages as they stream, tool calls, and what the package's own pi extension sends. */
    onEvent(handler: (chatId: string, event: Record<string, unknown>) => void): void;
    /** To the package's own pi extension in a chat, starting its pi if need be. False where pi does not run in the portal. */
    tell(chatId: string, data: unknown): Promise<boolean>;
    /**
     * A pi extension of the package's, made here: registered in every chat's
     * pi as it starts, so its tools hold what this module holds. Only where pi
     * runs in the portal's own process.
     */
    extend(factory: (pi: any, chat: Chat) => void): void;
    /** Keeps a chat's pi from being let go while work of the package's goes on. Returns what lets it go again. */
    hold(chatId: string): () => void;
  };
  sandbox: {
    /** Whether agents run as users of their own. */
    on(): boolean;
    /** What starts a process as a chat's agent: what to put before the command, and its environment. The portal's own while the sandbox is off. */
    spawnAs(chatId: string): { argv: string[]; env: NodeJS.ProcessEnv };
    /** Runs a command as a chat's agent, in the chat's folder unless told otherwise. Never throws for a non-zero exit. */
    run(chatId: string, argv: string[], options?: { input?: Buffer | string; cwd?: string; signal?: AbortSignal }): Promise<Ran>;
  };
  files: {
    /** `rel` inside `base`, checked: throws for `..`, an absolute path, or a link that leads out. */
    inside(base: string, rel: string): string;
  };
  /**
   * A folder of the package's own in the portal's data folder, made (closed to
   * everyone but the portal, 0700) when it is asked for. It is not in a chat's
   * folder, so with the sandbox on the agents' group has no access to it: for
   * what the portal runs as itself on, and an agent must not shape, such as a
   * git repository or a database. It lives and goes with the portal's data,
   * not with a project.
   */
  dataDir(): string;
}

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
}

const running = new Map<string, Running>();
/** Why a package's server half is not running, by the package's name. */
const failures = new Map<string, string>();
/** What server halves tell the pages open on a chat, by chat: `{ extension, data }` as it goes on the wire. Heard by the chat's event stream. */
export const pagePushes = new EventEmitter();
pagePushes.setMaxListeners(0);

const chatOf = (row: SessionRow): Chat => ({ id: row.id, title: row.title, workspace: row.workspace, status: row.status });
const say = (name: string, text: string) => console.log(`[extension ${name}] ${text}`);
/**
 * An extension's handler failing is the extension's: said, and nothing of the
 * portal's stops for it. What comes back never throws and never rejects: a
 * handler that returned a promise is answered with one that settles either way.
 */
const guarded = (name: string, what: string, fn: () => unknown) => {
  const failed = (e: unknown) => {
    console.error(`[extension ${name}] ${what} failed:`, e);
    return undefined;
  };
  try {
    const result = fn();
    return result instanceof Promise ? result.catch(failed) : result;
  } catch (e) {
    return failed(e);
  }
};

/** How long a server half may take to start, and to stop: one that hangs must not hold up every other, or the portal's own stop. */
let START_MS = 15_000;
let STOP_MS = 5_000;
/** Other limits, for a test that cannot wait that long. */
export function setLimits(start: number, stop: number): void {
  START_MS = start;
  STOP_MS = stop;
}

/** `work`, or a rejection once it has taken longer than `ms`. */
function within<T>(ms: number, work: Promise<T>, what: string): Promise<T> {
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
export function setChatBridge(bridge: { tell: typeof tellChat }): void {
  tellChat = bridge.tell;
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
  return {
    version: 1,
    extension: name,
    executor: EXECUTOR_KIND,
    log: (text) => say(name, text),
    router: ext.router,
    http: {
      json: express.json,
      raw: express.raw,
      text: express.text,
      upgrade: (handler) => {
        ext.upgrade = handler;
      },
    },
    chats: {
      get: (id) => {
        const row = getSession(id);
        return row && chatOf(row);
      },
      list: () => listSessions().map(chatOf),
      folder,
      send: (chatId, data) => {
        const text = wire(name, data);
        if (text) pagePushes.emit(chatId, text);
      },
      onOpen: (handler) => void ext.opens.push(handler),
      on: (event, handler) => void ext.life.on(event, handler),
      onEvent: (handler) => void ext.events.push(handler),
      tell: (chatId, data) => tellChat(chatId, name, data),
      extend: (factory) => void ext.factories.push(factory),
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
    files: { inside: (base, rel) => resolveInside(base, rel) },
    dataDir: () => {
      // One folder for each package, by its name written as one part of a path (a scoped name has a slash, and a dot name is no step up).
      const dir = join(resolvePath(DATA_DIR), "extension-data", encodeURIComponent(name).replace(/^\./, "%2E"));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      return dir;
    },
  };
}

async function stop(ext: Running): Promise<void> {
  running.delete(ext.half.name);
  for (const fn of ext.stops.reverse()) await guarded(ext.half.name, "stopping", () => within(STOP_MS, Promise.resolve().then(fn), "stopping"));
  ext.life.removeAllListeners();
}

async function start(half: ServerHalf): Promise<void> {
  const ext: Running = { half, router: express.Router(), stops: [], opens: [], life: new EventEmitter(), events: [], factories: [], holds: new Map() };
  try {
    // By its revision: the same file changed is another module, and the one already loaded is not served again.
    const stopper = await within(
      START_MS,
      import(`${pathToFileURL(half.file).href}?v=${half.rev}`).then((module: any) => {
        if (typeof module.default !== "function") throw new Error("Its module has no default export to call");
        return module.default(portalFor(ext));
      }),
      "starting",
    );
    if (typeof stopper === "function") ext.stops.push(stopper);
    running.set(half.name, ext);
    failures.delete(half.name);
    say(half.name, "server half started");
  } catch (e) {
    for (const fn of ext.stops.reverse()) await guarded(half.name, "stopping", () => within(STOP_MS, Promise.resolve().then(fn), "stopping"));
    failures.set(half.name, (e as Error)?.message || String(e));
    console.error(`[extension ${half.name}] its server half could not be started:`, e);
  }
}

let queue: Promise<void> = Promise.resolve();
/**
 * Bring what is running in line with `halves`: the installed packages that are
 * switched on and have a server half. One gone or changed is stopped, one new
 * or changed is started. One at a time: a second ask waits for the first.
 */
export function syncServerHalves(halves: ServerHalf[]): Promise<void> {
  const run = async () => {
    for (const ext of [...running.values()]) {
      if (!halves.some((half) => half.name === ext.half.name && half.rev === ext.half.rev)) await stop(ext);
    }
    for (const name of [...failures.keys()]) if (!halves.some((half) => half.name === name)) failures.delete(name);
    for (const half of halves) if (!running.has(half.name)) await start(half);
  };
  return (queue = queue.then(run, run));
}

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
  // A route may hold its answer open, as a stream: ended with the login it was asked under, like the portal's own.
  res.once("close", watchStream(() => res.destroy()));
  // The package's routes are written from its own root, whatever it is called.
  req.url = found.rest + (at === -1 ? "" : was.slice(at));
  found.ext.router(req, res, (error?: unknown) => {
    req.url = was;
    next(error);
  });
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
  return (req, socket, head) => {
    req.url = found.rest + (at === -1 ? "" : url.slice(at));
    guarded(found.ext.half.name, "an upgrade", () => handler(req, socket, head));
  };
}

/** What each server half tells a page that opens a chat, each as it goes on the wire. */
export function openingPushes(chatId: string): string[] {
  const out: string[] = [];
  for (const ext of running.values()) {
    for (const handler of ext.opens) {
      const data = guarded(ext.half.name, "what a page is told first", () => handler(chatId));
      const text = data !== undefined && !(data instanceof Promise) ? wire(ext.half.name, data) : undefined;
      if (text) out.push(text);
    }
  }
  return out;
}

/**
 * What one package's server half tells a page that opens a chat, as it would
 * say it now: for a browser half that came into the page after the chat's
 * stream had opened, and so was not there to be told.
 */
export function openingFor(chatId: string, name: string): unknown[] {
  const ext = running.get(name);
  if (!ext) return [];
  return ext.opens
    .map((handler) => guarded(name, "what a page is told first", () => handler(chatId)))
    .filter((data) => data !== undefined && !(data instanceof Promise) && wire(name, data) !== undefined);
}

/** A chat's pi started or stopped, or the chat was deleted. */
export function chatLife(event: Life, chatId: string): void {
  for (const ext of running.values()) {
    for (const handler of ext.life.listeners(event)) guarded(ext.half.name, `hearing a chat was ${event}`, () => handler(chatId));
    if (event === "deleted") ext.holds.delete(chatId);
  }
}

/** Something a chat's pi said. Called for every event, a token at a time: nothing is done where nobody listens. */
export function chatEvent(chatId: string, event: Record<string, unknown>): void {
  for (const ext of running.values()) {
    for (const handler of ext.events) guarded(ext.half.name, "hearing a chat's event", () => handler(chatId, event));
  }
}

/** Whether a server half is keeping this chat's pi. */
export function extensionHolds(chatId: string): boolean {
  for (const ext of running.values()) if (ext.holds.has(chatId)) return true;
  return false;
}

/**
 * The pi extension every chat's pi is given for the server halves: it
 * registers what each of them asked to add, as they are when pi loads its
 * extensions, so a reload has what was installed since.
 */
export function hostExtension(chatId: string): (pi: any) => void {
  return (pi) => {
    const row = getSession(chatId);
    if (!row) return;
    for (const ext of running.values()) {
      for (const factory of ext.factories) guarded(ext.half.name, "adding to a chat's pi", () => factory(pi, chatOf(row)));
    }
  };
}
