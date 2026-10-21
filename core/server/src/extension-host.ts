import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import semver from "semver";
import express, { type NextFunction, type Request, type RequestHandler, type Response, type Router } from "express";
import { agentOf, defaultAgent, listAgents } from "./agents.js";
import { DATA_DIR } from "./data-dir.js";
import { getSession, getSetting, listSessions, putSetting, sessionsByWorkspace, setServerHalfOffers, toolExceptions, type SessionRow } from "./db.js";
import { EXECUTOR_KIND } from "./executor-kind.js";
import { takes, type ServerHalf } from "./extension-ui.js";
import { asAgent, runAsAgent, sandboxEnv } from "./sandbox/exec.js";
import { identityOf } from "./sandbox/identity.js";
import { sandboxOn, sandboxSupport } from "./sandbox/policy.js";
import { folderFiles } from "./folder-files.js";
import { baseDir, setAgentAccess, type AgentAccess } from "./workspace-files.js";
import { sendFile } from "./api/files.js";
import { watchStream } from "./login-streams.js";
import { personsEnv } from "./background.js";
import { gitAt } from "./git.js";
import { folderAllowed, folderLabel, listFolders } from "./agent-folders.js";
import { handoffDone, takeHandoff } from "./handoff.js";
import type { Chat, ChatLife as Life, Ran, ServerPortal, Upgrade, VoiceProvider } from "@pithagoras/extension-api/server";

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
setAgentAccess((chats, ids) => {
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
});

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
  /** Where it offers voice mode to listen and speak (`voice.provide`). */
  voice?: VoiceProvider;
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
    for (const handler of ext.removed) guarded(ext.half.name, "hearing of a folder that was removed", () => handler(folder));
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
  for (const { folder } of missed) for (const handler of ext.removed) guarded(ext.half.name, "hearing of a folder that was removed", () => handler(folder));
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
    const said = guarded(ext.half.name, "saying which tools it offers", () => ext.offers!());
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
let toolOffered: (chatId: string, tool: string) => "direct" | "lazy" | undefined = () => undefined;
let reloadChats: () => Promise<{ reloaded: number; waiting: number }> = async () => ({ reloaded: 0, waiting: 0 });
export function setChatBridge(bridge: { tell: typeof tellChat; offers: typeof toolOffered; reload: typeof reloadChats }): void {
  tellChat = bridge.tell;
  toolOffered = bridge.offers;
  reloadChats = bridge.reload;
}
/** How a server half makes itself voice mode's source (`voice.choose`): the voice settings are the voice routes', which import the host. */
let chooseVoice: (name: string, chosen: boolean) => void = () => {};
export function setVoiceChooser(choose: typeof chooseVoice): void {
  chooseVoice = choose;
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
  const dataDir = () => {
    // One folder for each package, by its name written as one part of a path (a scoped name has a slash, and a dot name is no step up).
    const dir = join(resolvePath(DATA_DIR), "extension-data", encodeURIComponent(name).replace(/^\./, "%2E"));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Where it really is, as `files` take a base: the data folder can be reached through a link.
    return realpathSync(dir);
  };
  return {
    version: 1,
    extension: name,
    executor: EXECUTOR_KIND,
    log: (text) => say(name, text),
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
        const { name, home } = folderLabel(folder);
        return { name, ...(home ? { home: true as const } : {}) };
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
        if (typeof provider?.label !== "string" || typeof provider.where !== "function" || (provider.use !== undefined && typeof provider.use !== "function")) {
          throw new TypeError("provide takes { label, where, use? }: what it is called, where it listens and speaks now, and what it is told as voice mode is used");
        }
        ext.voice = provider;
      },
      choose(chosen) {
        if (typeof chosen !== "boolean") throw new TypeError("choose takes true, to be voice mode's source, or false, to give it back");
        chooseVoice(name, chosen);
      },
    },
    extensions: {
      use(of) {
        if (ext.half.requires?.[of] === undefined && ext.half.optional?.[of] === undefined) {
          throw new Error(`${of} is not one ${name} builds on: name it in "requires" or "optional" under "pithagoras" in its package.json`);
        }
        const provider = running.get(of);
        // An optional one that is not there, or not in a version this one takes: nothing. A required one is there, or this would not be running.
        if (!ext.uses.has(of) || !provider?.provider) return undefined;
        if (!ext.apis.has(of)) ext.apis.set(of, provider.provider({ name }));
        return ext.apis.get(of) as never;
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
      send: (chatId, data) => {
        const text = wire(name, data);
        if (text) pagePushes.emit(chatId, text);
      },
      onOpen: (handler) => void ext.opens.push(handler),
      on: (event, handler) => void ext.life.on(event, handler),
      onEvent: (handler) => void ext.events.push(handler),
      tell: (chatId, data) => tellChat(chatId, name, data),
      reload: () => reloadChats(),
      offers: (chatId, tool) => toolOffered(chatId, tool),
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
  for (const fn of ext.stops.reverse()) await guarded(ext.half.name, "stopping", () => within(STOP_MS, Promise.resolve().then(fn), "stopping"));
  ext.life.removeAllListeners();
}

async function start(half: ServerHalf, sig: string, uses: Set<string>): Promise<void> {
  const ext: Running = { half, router: express.Router(), stops: [], opens: [], life: new EventEmitter(), events: [], factories: [], holds: new Map(), apis: new Map(), uses, sig, removed: [] };
  // Read before it starts: a folder deleted while it does is one it missed.
  const since = toldUpTo(half.name);
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
    tellMissed(ext, since);
  } catch (e) {
    for (const fn of ext.stops.reverse()) await guarded(half.name, "stopping", () => within(STOP_MS, Promise.resolve().then(fn), "stopping"));
    failures.set(half.name, (e as Error)?.message || String(e));
    console.error(`[extension ${half.name}] its server half could not be started:`, e);
  }
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
      else if (!visit(provider)) why ??= `It needs ${dep}, which cannot start: ${blocked.get(dep) ?? "it builds on itself"}`;
      else using.add(dep);
    }
    for (const [dep, range] of Object.entries(half.optional ?? {})) {
      const provider = byName.get(dep);
      if (provider && takes(range, provider.version) && visit(provider)) using.add(dep);
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
 * An extension's signature as things are now: its revision, and for each it builds on that one's signature, or that it
 * is not running. One whose signature is no longer the one it started with holds what a provider that changed, came or
 * went gave it, or nothing where there is something now, and is started anew.
 */
function signature(half: ServerHalf, uses: Set<string>): string {
  const of = (dep: string) => `${dep}=${(uses.has(dep) && running.get(dep)?.sig) || "-"}`;
  return [half.rev, ...Object.keys(half.requires ?? {}).map(of), ...Object.keys(half.optional ?? {}).map(of)].join(" ");
}

/** Stops an extension, and before it those that build on it, theirs first. */
async function stopWithDependents(ext: Running): Promise<void> {
  if (running.get(ext.half.name) !== ext) return;
  for (const other of [...running.values()].reverse()) {
    if (other !== ext && (other.half.requires?.[ext.half.name] !== undefined || other.half.optional?.[ext.half.name] !== undefined)) await stopWithDependents(other);
  }
  await stop(ext);
}

let queue: Promise<void> = Promise.resolve();
/**
 * Bring what is running in line with `halves`: the installed packages that are
 * switched on and have a server half. One gone or changed is stopped, one new
 * or changed is started, and so is one that builds on another that was (see
 * signature): those that build on another are stopped before it, and started
 * after it. One at a time: a second ask waits for the first.
 */
export function syncServerHalves(halves: ServerHalf[]): Promise<void> {
  const run = async () => {
    const { order, blocked, uses } = plan(halves);
    const wanted = new Map(order.map((half) => [half.name, half]));
    // What is not wanted any more, or changed, goes, with what builds on it: the latest started first.
    for (const ext of [...running.values()].reverse()) {
      const half = wanted.get(ext.half.name);
      if (!half || ext.sig !== signature(half, uses.get(half.name)!)) await stopWithDependents(ext);
    }
    for (const name of [...failures.keys()]) if (!halves.some((half) => half.name === name)) failures.delete(name);
    for (const [name, why] of blocked) failures.set(name, why);
    // Started in order, what each builds on before it; then again for any whose provider has only now started (one
    // that failed before, say), until nothing more changes.
    for (let round = 0; round <= order.length; round++) {
      for (const half of order) {
        if (running.has(half.name)) continue;
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

/** A chat's pi started or stopped, the chat was deleted, or the run it was started for is over (finished). */
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
        for (const factory of ext.factories) guarded(ext.half.name, "adding to a chat's pi", () => factory(pi, chatOf(row)));
      },
    }));
}
