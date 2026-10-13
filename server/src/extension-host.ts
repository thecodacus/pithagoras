import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";
import express, { type NextFunction, type Request, type RequestHandler, type Response, type Router } from "express";
import { agentOf, defaultAgent } from "./agents.js";
import { getSession, listSessions, type SessionRow } from "./db.js";
import { EXECUTOR_KIND } from "./executor-kind.js";
import type { ServerHalf } from "./extension-ui.js";
import { asAgent, runAsAgent, sandboxEnv } from "./sandbox/exec.js";
import { identityOf } from "./sandbox/identity.js";
import { sandboxOn, sandboxSupport } from "./sandbox/policy.js";
import { baseDir, resolveInside } from "./workspace-files.js";

/**
 * An extension's server half: a module of the package's that the portal loads
 * into its own process, once, for all chats.
 *
 * A package's pi extension runs inside a chat's pi: one per chat, gone when
 * the chat is left alone, and not there at all where pi runs in a container.
 * What has to outlive that is here: the package's own routes, the processes
 * it starts, and what it tells the pages open on a chat. What it keeps for a
 * chat it keeps where the chat's pi works, in the chat's folder: there is no
 * folder of the portal's for it.
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
/** What server halves tell the pages open on a chat, by chat: `{ extension, data }`. Heard by the chat's event stream. */
export const pagePushes = new EventEmitter();
pagePushes.setMaxListeners(0);

const chatOf = (row: SessionRow): Chat => ({ id: row.id, title: row.title, workspace: row.workspace, status: row.status });
const say = (name: string, text: string) => console.log(`[extension ${name}] ${text}`);
/** An extension's handler failing is the extension's: said, and nothing of the portal's stops for it. */
const guarded = (name: string, what: string, fn: () => unknown) => {
  try {
    const result = fn();
    if (result instanceof Promise) result.catch((e) => console.error(`[extension ${name}] ${what} failed:`, e));
    return result;
  } catch (e) {
    console.error(`[extension ${name}] ${what} failed:`, e);
    return undefined;
  }
};

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
      send: (chatId, data) => void pagePushes.emit(chatId, { extension: name, data: data ?? null }),
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
  };
}

async function stop(ext: Running): Promise<void> {
  running.delete(ext.half.name);
  for (const fn of ext.stops.reverse()) await guarded(ext.half.name, "stopping", fn);
  ext.life.removeAllListeners();
}

async function start(half: ServerHalf): Promise<void> {
  const ext: Running = { half, router: express.Router(), stops: [], opens: [], life: new EventEmitter(), events: [], factories: [], holds: new Map() };
  try {
    // By its revision: the same file changed is another module, and the one already loaded is not served again.
    const module: any = await import(`${pathToFileURL(half.file).href}?v=${half.rev}`);
    if (typeof module.default !== "function") throw new Error("Its module has no default export to call");
    const stopper = await module.default(portalFor(ext));
    if (typeof stopper === "function") ext.stops.push(stopper);
    running.set(half.name, ext);
    failures.delete(half.name);
    say(half.name, "server half started");
  } catch (e) {
    for (const fn of ext.stops.reverse()) await guarded(half.name, "stopping", fn);
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

/** Every server half stopped, as the portal stops. */
export function stopServerHalves(): Promise<void> {
  return syncServerHalves([]);
}

/** Why a package's server half is not running, if it is not. */
export const serverFailure = (name: string): string | undefined => failures.get(name);

/** The extension a path under /api/x belongs to, and the rest of the path: a package's name may have a slash in it. */
function owner(pathname: string): { ext: Running; rest: string } | undefined {
  for (const ext of running.values()) {
    const root = `/${ext.half.name}`;
    if (pathname === root || pathname.startsWith(`${root}/`)) return { ext, rest: pathname.slice(root.length) || "/" };
  }
  return undefined;
}

/** Mounted at /api/x, after the login: hands a request to the routes of the package its path names. */
export const extensionRoutes: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  let pathname: string;
  try {
    pathname = decodeURIComponent(req.path);
  } catch {
    return next();
  }
  const found = owner(pathname);
  if (!found) return next();
  const was = req.url;
  // The package's routes are written from its own root, whatever it is called.
  req.url = found.rest + was.slice(req.path.length);
  found.ext.router(req, res, (error?: unknown) => {
    req.url = was;
    next(error);
  });
};

/** The upgrade handler of the package a URL under /api/x names, with the URL as its routes see it. */
export function extensionUpgrade(url: string | undefined): Upgrade | undefined {
  if (!url?.startsWith("/api/x/")) return undefined;
  let pathname: string;
  const [rawPath, query = ""] = url.split("?");
  try {
    pathname = decodeURIComponent(rawPath.slice("/api/x".length));
  } catch {
    return undefined;
  }
  const found = owner(pathname);
  const handler = found?.ext.upgrade;
  if (!found || !handler) return undefined;
  return (req, socket, head) => {
    req.url = found.rest + (query ? `?${query}` : "");
    guarded(found.ext.half.name, "an upgrade", () => handler(req, socket, head));
  };
}

/** What each server half tells a page that opens a chat. */
export function openingPushes(chatId: string): { extension: string; data: unknown }[] {
  const out: { extension: string; data: unknown }[] = [];
  for (const ext of running.values()) {
    for (const handler of ext.opens) {
      const data = guarded(ext.half.name, "what a page is told first", () => handler(chatId));
      if (data !== undefined && !(data instanceof Promise)) out.push({ extension: ext.half.name, data });
    }
  }
  return out;
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
