import { existsSync, readSync, writeFileSync, writeSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Chat, ServerPortal, Upgrade } from "@pithagoras/extension-api/server";
import { folderFiles } from "./folder-files.js";
import { gitAt } from "./git.js";
import { API_FN, CHILD_FN, PARENT_FN, PERSON_HEADER, errorIn, errorOut, swapped, type FnUse } from "./half-wire.js";
import { sendFile } from "./send-file.js";
import { PI_BUILT_IN_TOOLS } from "./tool-policy.js";
import { setAgentAccess } from "./workspace-files.js";

/**
 * A server half in a process of its own (see isolated-half.ts, which starts this): the `portal` its module is given, in
 * which every member that needs the portal's own state calls the portal, and the rest (its routes, `files`, `git`,
 * `http.send`) works here. Nothing of the portal's database or extension host is loaded: what is asked of them is
 * asked of the portal.
 *
 * The channels, each in its own order (nothing may depend on the order between two of them):
 * - the IPC channel (fd 3) carries the calls that are answered later, both ways, and what is told without an answer;
 * - fd 4 carries the calls that are answered at once (`chats.get`, every registration…), as JSON lines, and the crash
 *   report just before the process ends; fd 5 carries their answers. A call waits for its answer, blocked: the
 *   portal answers each as it reads it. Every registration is such a call, so all of them are done before `started`.
 * - fd 1 and fd 2 are the half's lines, which the portal keeps as its own.
 */

const REQUESTS = 4;
const ANSWERS = 5;
/** How often what the portal asks of the half synchronously is worked out here, besides after each message. */
const MIRROR_MS = 1000;

const pause = new Int32Array(new SharedArrayBuffer(4));
/** A descriptor that would block says EAGAIN where it is non-blocking: tried again a millisecond later. */
const again = (e: unknown) => {
  if ((e as NodeJS.ErrnoException).code !== "EAGAIN") throw e;
  Atomics.wait(pause, 0, 0, 1);
};

function writeLine(fd: number, value: unknown): void {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  for (let at = 0; at < bytes.length; ) {
    try {
      at += writeSync(fd, bytes, at);
    } catch (e) {
      again(e);
    }
  }
}

let unread = Buffer.alloc(0);
const chunk = Buffer.alloc(64 * 1024);
function readLine(): string {
  for (;;) {
    const end = unread.indexOf(10);
    if (end !== -1) {
      const line = unread.subarray(0, end).toString();
      unread = unread.subarray(end + 1);
      return line;
    }
    let read = 0;
    try {
      read = readSync(ANSWERS, chunk, 0, chunk.length, null);
    } catch (e) {
      again(e);
      continue;
    }
    if (read === 0) throw new Error("The portal no longer answers");
    unread = Buffer.concat([unread, chunk.subarray(0, read)]);
  }
}

const post = (message: Record<string, unknown>) => process.send!(message);

/** The half's own functions the portal holds a stub of, by their handle; and the handles each load of a chat's pi has. */
const fns = new Map<number, (...args: any[]) => unknown>();
const loads = new Map<number, number[]>();
let lastFn = 0;
function keep(fn: (...args: any[]) => unknown, load?: number): number {
  const id = ++lastFn;
  fns.set(id, fn);
  if (load !== undefined) loads.get(load)?.push(id);
  return id;
}
/** A function of the half's as it crosses (see FnUse); anything else as it is, for the portal to refuse as it would. */
const given = (fn: unknown, use: FnUse) => (typeof fn === "function" ? { [CHILD_FN]: use === "mirror" ? 0 : keep(fn as never), use } : fn);
function fnOf(handle: number) {
  const fn = fns.get(handle);
  if (!fn) throw new Error("Nothing of this server half answers to it any more: the chat has what the half gives now at its next step");
  return fn;
}

/** What the portal answered, its functions made callable here: each tells the portal to run its own. */
const taken = (value: unknown) =>
  swapped(value, (fn) => fn, (marker) => (typeof marker[PARENT_FN] === "number" ? (...args: unknown[]) => post({ t: "invoke", handle: marker[PARENT_FN], args }) : marker));

let calls = 0;
/** A call the portal answers at once: blocked until it has. */
function callNow(path: string, ...args: unknown[]): any {
  const id = ++calls;
  writeLine(REQUESTS, { id, path, args });
  const answer = JSON.parse(readLine());
  if (answer.error) throw errorIn(answer.error);
  return taken(answer.value);
}

const answers = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
/** What the portal answers later: `message`, sent with an id of its own, which `sent` is told for what goes with it (an abort). */
function later(message: Record<string, unknown>, sent?: (id: number) => void): Promise<any> {
  const id = ++calls;
  return new Promise((resolve, reject) => {
    answers.set(id, { resolve, reject });
    try {
      post({ ...message, id });
    } catch (e) {
      answers.delete(id);
      return reject(e);
    }
    sent?.(id);
  });
}
/** A call of a member of the portal's that answers later. */
const callLater = (path: string, args: unknown[], sent?: (id: number) => void) => later({ t: "call", path, args }, sent);

/** What an extension in the portal provides: each of its functions asked of the portal, which runs it as that extension's code. */
const provided = (of: string, value: unknown) =>
  swapped(value, (fn) => fn, (marker) =>
    Array.isArray(marker[API_FN]) ? (...args: unknown[]) => later({ t: "api", of, path: marker[API_FN], args: swapped(args, (fn) => given(fn, "call")) }) : marker,
  );

const unavailable = (what: string) => () => {
  throw new Error(`${what} is not available to a server half in a process of its own`);
};

let name = "";
const factories: ((pi: any, chat: Chat) => unknown)[] = [];
let upgrade: Upgrade | undefined;
let offers: (() => unknown) | undefined;
let holdsMemory: (() => unknown) | undefined;

function portalOf(init: { name: string; executor: string }): ServerPortal {
  const router = express.Router();
  return {
    version: 1,
    extension: init.name,
    executor: init.executor,
    log: (text) => console.log(`[extension ${name}] ${text}`),
    audit: {
      record: (entry) => callNow("audit.record", entry),
    },
    provide: unavailable("provide"),
    folders: {
      list: () => callNow("folders.list"),
      allowed: (folder) => callNow("folders.allowed", folder),
      on: (event, handler) => callNow("folders.on", event, given(handler, "run")),
      label: (folder) => callNow("folders.label", folder),
    },
    handoffs: {
      take: (what) => callNow("handoffs.take", what),
      done: (what) => callNow("handoffs.done", what),
    },
    tools: {
      offer(names) {
        callNow("tools.offer", given(names, "mirror"));
        offers = names;
      },
      exceptions: (names) => callNow("tools.exceptions", names),
    },
    voice: {
      provide: unavailable("voice.provide"),
      choose: unavailable("voice.choose"),
      chosen: unavailable("voice.chosen"),
    },
    extensions: {
      use: (of) => provided(of, callNow("extensions.use", of)) as never,
      install: (folder, options) => callLater("extensions.install", [folder, options]),
      remove: (of) => callLater("extensions.remove", [of]),
      status: (of, options) => callLater("extensions.status", [of, options]),
    },
    models: {
      of: (chatId) => callLater("models.of", [chatId]),
      endpoint: (provider, id) => callLater("models.endpoint", [provider, id]),
      list: () => callNow("models.list"),
    },
    mcp: {
      get: (server) => callNow("mcp.get", server),
      set: (server, entry, options) => callLater("mcp.set", [server, entry, options]),
    },
    memory: {
      hold(holder) {
        callNow("memory.hold", { ...holder, on: given(holder?.on, "mirror") });
        holdsMemory = holder.on;
      },
    },
    modes: {
      provide: (mode) => callNow("modes.provide", mode),
    },
    router,
    http: {
      json: express.json,
      raw: express.raw,
      text: express.text,
      upgrade(handler) {
        callNow("http.upgrade");
        upgrade = handler;
      },
      endWithLogin: (end) => callNow("http.endWithLogin", given(end, "run")),
      // Said by the portal on each request it hands on (isolated-half.ts), over anything the request came with.
      person(req) {
        const said = req.headers[PERSON_HEADER];
        if (typeof said !== "string") return undefined;
        try {
          return JSON.parse(decodeURIComponent(said));
        } catch {
          return undefined;
        }
      },
      // As the portal sends it (extension-host.ts): a file of no type said is sent as bytes, to be saved.
      send: (req, res, file, options = {}) =>
        sendFile(req, res, { ...file, mimeType: file.mimeType ?? "application/octet-stream" }, options.cache ?? "private, no-cache", options.download ?? (file.mimeType ? undefined : file.name)),
    },
    chats: {
      get: (id) => callNow("chats.get", id),
      list: () => callNow("chats.list"),
      inFolder: (folder) => callNow("chats.inFolder", folder),
      folder: (id) => callNow("chats.folder", id),
      owner: (id) => callNow("chats.owner", id),
      send(chatId, data) {
        try {
          post({ t: "send", chatId, data });
        } catch (e) {
          console.error(`[extension ${name}] what it said to a page could not be sent:`, e);
        }
      },
      onOpen: (handler) => callNow("chats.onOpen", given(handler, "open")),
      on: (event, handler) => callNow("chats.on", event, given(handler, "run")),
      onEvent: (handler) => callNow("chats.onEvent", given(handler, "run")),
      tell: (chatId, data) => callLater("chats.tell", [chatId, data]),
      reload: () => callLater("chats.reload", []),
      offers: (chatId, tool) => callNow("chats.offers", chatId, tool),
      extend(factory) {
        // The portal is told of the first: it then asks this process at each chat's load (see extend below).
        if (!factories.length) callNow("chats.extend");
        factories.push(factory);
      },
      hold: (chatId) => callNow("chats.hold", chatId),
      create: (options) => callNow("chats.create", options),
      start: (options) => callNow("chats.start", options),
      lastAnswer: (chatId) => callNow("chats.lastAnswer", chatId),
      children: (parent) => callNow("chats.children", parent),
      prompt: (chatId, message, options) => callLater("chats.prompt", [chatId, message, options]),
      abort: (chatId) => callLater("chats.abort", [chatId]),
      remove: (chatId) => callLater("chats.remove", [chatId]),
    },
    sandbox: {
      on: () => callNow("sandbox.on"),
      personEnv: () => callNow("sandbox.personEnv"),
      spawnAs: (chatId) => callNow("sandbox.spawnAs", chatId),
      run(chatId, argv, options = {}) {
        // The signal stays here: an abort is told to the portal, which aborts the run.
        const { signal, ...rest } = options;
        return callLater("sandbox.run", [chatId, argv, rest], (id) => {
          const abort = () => post({ t: "abort", id });
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      },
    },
    files: folderFiles,
    git: { at: gitAt },
    dataDir: () => callNow("dataDir"),
  };
}

// Who the agents of some chats are, for `files.*` asked with `likeParent`: the portal knows (agentAccessFor in extension-host.ts).
setAgentAccess((chats, ids) => callNow("agentAccess", chats, ids));

/**
 * The half's `chats.extend` factories, run for one load of a chat's pi against a stand-in pi: what they register, each
 * function of it by its handle, for the portal to register in the chat's own pi. The stand-in has what a factory
 * registers with and the two calls that ask the chat's pi for a turn; nothing else of pi is here.
 */
async function extend(chat: Chat, load: number) {
  loads.set(load, []);
  const tools: { def: Record<string, unknown>; handle: number }[] = [];
  const handlers: { event: string; handle: number }[] = [];
  const commands: { name: string; options: Record<string, unknown>; handle?: number }[] = [];
  let taking = true;
  const only =
    <A extends unknown[]>(member: string, take: (...args: A) => void) =>
    (...args: A) => {
      if (!taking) throw new Error(`pi.${member} is taken only while a factory of chats.extend runs, in a server half in a process of its own`);
      take(...args);
    };
  /** What a registration gives pi that is not data, beyond what it is for, cannot cross: refused by its name. */
  const data = (fields: Record<string, unknown>, what: string, allowed: string[]) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value !== "function") out[key] = value;
      else if (!allowed.includes(key)) throw new TypeError(`${what}'s ${key} is a function, which a server half in a process of its own cannot give pi`);
    }
    return out;
  };
  const members: Record<string, (...args: any[]) => unknown> = {
    registerTool: only("registerTool", (tool: any) => {
      // pi lets a tool of an extension take the place of its own of that name, in every chat this factory runs for.
      if (PI_BUILT_IN_TOOLS.includes(tool?.name)) throw new TypeError(`"${tool.name}" is one of pi's own tools: give the tool another name`);
      // How a tool is drawn in the terminal is pi's own, and not here.
      const def = data(tool ?? {}, "A tool", ["execute", "renderCall", "renderResult"]);
      delete def.renderCall;
      delete def.renderResult;
      tools.push({ def, handle: keep((...args) => tool.execute(...args), load) });
    }),
    on: only("on", (event: string, handler: (...args: unknown[]) => unknown) => void handlers.push({ event, handle: keep((...args) => handler(...args), load) })),
    registerCommand: only("registerCommand", (command: string, options: any) => {
      const rest = data(options ?? {}, "A command", ["handler"]);
      // One with no handler is left to pi to refuse.
      commands.push({ name: command, options: rest, ...(typeof options?.handler === "function" ? { handle: keep((...args) => options.handler(...args), load) } : {}) });
    }),
    sendMessage: (...args) => post({ t: "pi", load, method: "sendMessage", args }),
    sendUserMessage: (...args) => post({ t: "pi", load, method: "sendUserMessage", args }),
  };
  const pi = new Proxy(members, {
    get(target, key) {
      if (typeof key === "symbol" || Object.hasOwn(target, key)) return target[key as string];
      throw new Error(`pi.${key} is not available to a server half in a process of its own`);
    },
  });
  try {
    for (const factory of factories) await factory(pi, chat);
  } catch (e) {
    drop(load);
    throw e;
  } finally {
    taking = false;
  }
  return { tools, handlers, commands };
}

function drop(load: number): void {
  for (const handle of loads.get(load) ?? []) fns.delete(handle);
  loads.delete(load);
}

/** What the portal asks the half, each answered when it is done. */
const aborts = new Map<number, AbortController>();
let stopper: unknown;
const asked: Record<string, (message: any) => unknown> = {
  extend: ({ chat, load }) => extend(chat, load),
  async execute({ id, handle, toolCallId, params }) {
    const controller = new AbortController();
    aborts.set(id, controller);
    try {
      // What it says as it goes goes to the portal; pi's ctx is not here.
      return await fnOf(handle)(toolCallId, params, controller.signal, (update: unknown) => post({ t: "update", id, value: update }), undefined);
    } finally {
      aborts.delete(id);
    }
  },
  call: ({ handle, args }) => fnOf(handle)(...args),
  // What a page is told first is said at once: a promise is nothing, as for a half in the portal's process.
  open({ handle, chatId }) {
    const data = fnOf(handle)(chatId);
    return data instanceof Promise ? undefined : data;
  },
  stop: async () => (typeof stopper === "function" ? void (await stopper()) : undefined),
};

async function answer(message: { id: number; kind: string }): Promise<void> {
  let reply: Record<string, unknown>;
  try {
    reply = { t: "answer", id: message.id, value: await asked[message.kind](message) };
  } catch (e) {
    reply = { t: "answer", id: message.id, error: errorOut(e) };
  }
  try {
    post(reply);
  } catch (e) {
    // An answer that cannot be cloned (a function in it, say) is that call's error.
    post({ t: "answer", id: message.id, error: errorOut(e) });
  }
}

/** A function the portal tells the half to run, a listener: what it throws, now or later, is said, as for a half in the portal's process. */
function run(handle: number, args: unknown[]): void {
  const failed = (e: unknown) => console.error(`[extension ${name}] its handler failed:`, e);
  try {
    const result = fns.get(handle)?.(...args);
    if (result instanceof Promise) result.catch(failed);
  } catch (e) {
    failed(e);
  }
}

/** What the portal asks synchronously of the half (`tools.offer`, `memory.hold`'s `on`), worked out here and told when it changes. */
let mirrored = "";
function mirror(): void {
  const now: { offers?: unknown; memory?: boolean } = {};
  const failures: string[] = [];
  if (offers) {
    try {
      now.offers = offers();
    } catch (e) {
      failures.push(`saying which tools it offers failed: ${String(e)}`);
    }
  }
  if (holdsMemory) {
    try {
      now.memory = holdsMemory() === true;
    } catch (e) {
      now.memory = false;
      failures.push(`saying whether it holds the agent's memory failed: ${String(e)}`);
    }
  }
  let text: string;
  try {
    text = JSON.stringify([now, failures]);
  } catch (e) {
    delete now.offers;
    failures.push(`saying which tools it offers failed: ${String(e)}`);
    text = JSON.stringify([now, failures]);
  }
  if (text === mirrored) return;
  mirrored = text;
  for (const failure of failures) console.error(`[extension ${name}] ${failure}`);
  post({ t: "mirror", ...now });
}

/** Its routes, served on the portal's socket for it: the portal hands each request of /api/x/<package>/… on to it. */
function serve(socket: string, router: express.Router): Promise<void> {
  const app = express();
  app.disable("x-powered-by");
  app.use(router);
  app.use((_req: Request, res: Response) => void res.status(404).json({ error: "Not found" }));
  // As the portal says what a route did not catch: in JSON, with its message.
  app.use((err: { status?: number; statusCode?: number; type?: string; message?: string }, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const status = Number(err?.status ?? err?.statusCode) || 500;
    const error =
      err?.type === "entity.too.large" ? "That is more than the server takes in one request" : err?.type === "entity.parse.failed" ? "The request was not valid JSON" : err?.message || "Something went wrong on the server";
    if (status >= 500) console.error(`[extension ${name}] ${req.method} ${req.path} failed:`, err);
    res.status(status).json({ error });
  });
  const server = createServer(app);
  server.on("upgrade", (req, stream, head) => {
    if (!upgrade) return void stream.destroy();
    try {
      upgrade(req, stream, head);
    } catch (e) {
      console.error(`[extension ${name}] an upgrade failed:`, e);
      stream.destroy();
    }
  });
  return new Promise((resolve, reject) => server.once("error", reject).listen(socket, () => resolve()));
}

async function start(init: { name: string; executor: string; file: string; socket: string }): Promise<void> {
  name = init.name;
  // The first the kernel ends should memory run out: this process, and what it starts, rather than the portal.
  if (existsSync("/proc/self/oom_score_adj")) writeFileSync("/proc/self/oom_score_adj", "1000");
  const portal = portalOf(init);
  await serve(init.socket, portal.router);
  try {
    const module = await import(pathToFileURL(init.file).href);
    if (typeof module.default !== "function") throw new Error("Its module has no default export to call");
    stopper = await module.default(portal);
  } catch (e) {
    // It did not start: said, and this process ends once the portal has it.
    process.send!({ t: "failed", error: errorOut(e) }, () => process.exit(1));
    return;
  }
  mirror();
  post({ t: "started", stops: typeof stopper === "function" });
  setInterval(mirror, MIRROR_MS).unref();
}

/** Its crash: told on fd 4, which is read whole before the portal handles the end of this process, and then the end. */
function crash(error: unknown): void {
  try {
    writeLine(REQUESTS, { crash: errorOut(error) });
  } finally {
    process.exit(1);
  }
}
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);
// The portal let go of it, or is gone without ending it: it ends.
process.on("disconnect", () => process.exit(0));

process.on("message", (message: any) => {
  switch (message.t) {
    case "init":
      void start(message);
      return;
    case "ask":
      void answer(message);
      break;
    case "abort":
      aborts.get(message.id)?.abort();
      break;
    case "run":
      run(message.handle, message.args);
      break;
    case "drop":
      drop(message.load);
      break;
    case "release":
      for (const handle of message.handles) fns.delete(handle);
      break;
    case "ping":
      post({ t: "pong" });
      return;
    case "result": {
      const waiting = answers.get(message.id);
      answers.delete(message.id);
      if (message.error) waiting?.reject(errorIn(message.error));
      else waiting?.resolve(taken(message.value));
      break;
    }
  }
  mirror();
});
