/**
 * A portal to test an extension's server half against, without the portal's own
 * code in the test: `import { mockPortal } from "@pithagoras/extension-api/testing"`.
 *
 *   const mock = await mockPortal({ extension: "my-notes", chats: { a: folder } });
 *   const stop = await mock.start(serverHalf);        // the module's default export, called with the mock's portal
 *   const web = await mock.serve();                    // its routes, on a port of their own
 *   const { status, body } = await web.call("GET", "/chats/a/notes");
 *   const page = mock.page();                          // a page of the portal that listens to topics
 *   await page.listen("notes");
 *   await mock.stop();
 *
 * What an extension relies on for its safety is the portal's, not made up here: `portal.files` is the portal's
 * own (`core/server/src/folder-files.ts`, checks and all), and so is the hub that
 * carries `portal.push` to the pages (`extension-push.ts`), found beside this package in a checkout of the portal
 * (its TypeScript source when tests run under tsx, its build otherwise). So this entry works where this package is
 * the one in a checkout (the extensions that come with the portal); with the package from npm there is no portal
 * beside it, and `mockPortal()` says so. Pass `files` to stand on another. What the portal does with the agent is faked in the smallest way the extensions need:
 * a chat's pi (`mock.pi(chat)`) is an object that keeps the tools and the messages it is given.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";

/** The portal's own module `name` of core/server, from its source under tsx, else from its build. */
async function core(name) {
  const base = new URL("../../core/server/", import.meta.url);
  let failure;
  for (const candidate of [`src/${name}.ts`, `dist/${name}.js`]) {
    try {
      return await import(new URL(candidate, base).href);
    } catch (e) {
      failure ??= e;
    }
  }
  throw new Error(`The portal's ${name} is needed by @pithagoras/extension-api/testing, and is not beside it (a checkout of the portal, built or run with tsx): ${failure?.message}`);
}

/** The portal's own `portal.files` (workspace-files.ts), for a test that calls a server half by hand and needs no more of a portal than that. */
export async function portalFiles() {
  return (await core("folder-files")).folderFiles;
}

/** The portal's own `portal.proc` (proc-stat.ts), for a test that calls a server half by hand. */
export async function portalProc() {
  const { statOf, signalSession } = await core("proc-stat");
  return { stat: (pid) => statOf(pid), signalSession };
}

/** A package of the portal's server (its express, its better-sqlite3), found from there: beside this package in a checkout. */
async function fromPortal(name) {
  const { createRequire } = await import("node:module");
  return createRequire(new URL("../../core/server/package.json", import.meta.url))(name);
}

/** The portal's own `portal.sqlite` (the better-sqlite3 the portal runs on), for a test that calls a server half by hand. */
export async function portalSqlite() {
  return fromPortal("better-sqlite3");
}

const scratches = [];
process.on("exit", () => {
  for (const folder of scratches) rmSync(folder, { recursive: true, force: true });
});

/** A new folder (its real path) in the system's temp directory, removed when the process ends: for a test that needs to put things in one. */
export function scratch(prefix = "pithagoras-test-") {
  const folder = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  scratches.push(folder);
  return folder;
}

/** The bus channel a page, or the server half, reaches the package's pi extension on (the portal's extension-ui). */
const UI_RECEIVE = "pithagoras:v1:ui:receive";

/** A chat's pi as far as an extension uses it: its tools, its bus, what it was told to say. */
function fakePi(extension, chat, factories, mock) {
  const tools = new Map();
  const handlers = new Map();
  const shutdown = [];
  const sent = mock.said(chat.id);
  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    events: {
      on(channel, handler) {
        if (!handlers.has(channel)) handlers.set(channel, new Set());
        handlers.get(channel).add(handler);
        return () => void handlers.get(channel)?.delete(handler);
      },
      emit: (channel, data) => handlers.get(channel)?.forEach((handler) => handler(data)),
    },
    on: (event, handler) => void (event === "session_shutdown" && shutdown.push(handler)),
    sendMessage(message, options) {
      if (mock.options.sendThrows) throw new Error(mock.options.sendThrows);
      sent.push({ message, options });
    },
  };
  for (const factory of factories) factory(pi, { id: chat.id, title: chat.title, workspace: chat.folder, status: "idle" });
  return {
    pi,
    /** The tools registered in it, by name. */
    tools,
    /** What it was given to say: `{ message, options }`. */
    sent,
    /** How many handlers listen on a channel of its bus. */
    handlers: (channel) => handlers.get(channel)?.size ?? 0,
    /** Rings the bell a page or the server half rings (`portal.chats.tell`): what the package's pi extension hears. */
    tell: (data) => pi.events.emit(UI_RECEIVE, { extension, data }),
    /** A tool called as pi calls it: its text, or the error it threw. */
    async call(name, params) {
      try {
        const result = await tools.get(name).execute("call-1", params, undefined, undefined, {});
        return { text: result.content?.[0]?.text, details: result.details, error: null };
      } catch (e) {
        return { text: "", error: e.message };
      }
    },
    stop: () => shutdown.forEach((handler) => handler()),
  };
}

/**
 * @param {object} [options]
 * @param {string} [options.extension]   the package's name, `portal.extension`
 * @param {string} [options.executor]    `portal.executor`: "host" (the default) is where tools and pis run in the portal
 * @param {Record<string, string | { folder: string, title?: string }>} [options.chats]   chats by id, with the folder each works in
 * @param {string} [options.dataDir]     `portal.dataDir()`; a folder of the mock's own by default
 * @param {boolean} [options.sandbox]    `portal.sandbox.on()`
 * @param {object} [options.files]       `portal.files`, the portal's own by default
 * @param {object} [options.extensions]  what `portal.extensions.use(name)` gives, by name
 * @param {(chat: string, data: unknown) => Promise<boolean | void> | boolean | void} [options.tell]   called before `chats.tell` starts the chat's pi and rings its bell: false says the chat cannot be reached, a throw fails, anything else goes on; it may hold the answer
 * @param {Record<string, string>} [options.kinds]   what kind of session a chat is, by id, read as it is asked ("task" unless said; `chats.list` gives the tasks alone, `chats.inFolder` every kind)
 * @param {(chat: string) => string} [options.folderOf]   where a chat's folder leads now, for a test that makes it lead somewhere else
 * @param {(chat: string, message: object) => Promise<boolean | void> | boolean | void} [options.followUp]   the same for `chats.followUp`, which starts the chat's pi and has it say the message
 */
export async function mockPortal(options = {}) {
  // The portal's hub first: where there is no portal beside this package, that is what the failure says, not a package missing.
  const hub = await core("extension-push");
  const express = await fromPortal("express");
  const { folderFiles } = options.files ? { folderFiles: options.files } : await core("folder-files");
  const proc = await portalProc();
  const sqlite = options.sqlite ?? (await portalSqlite());
  const git = options.git === false ? undefined : (await core("git")).gitAt;
  const extension = options.extension ?? "pithagoras-test";

  const mock = { options, logged: [], sent: [], told: [], followedUp: [] };
  const temps = [];
  const closers = [];
  const chats = new Map();
  const factories = [];
  const pis = new Map();
  const opens = [];
  const life = { started: [], stopped: [], deleted: [] };
  const eventHandlers = [];
  const holds = new Map();
  const logins = new Set();
  let upgrade;
  let provider;
  let halfStop;
  // As the portal's route turns a page away while the extension's server half is not running.
  let running = false;

  /** A new folder of the mock's own, removed when it stops: for what a test needs to put things in. */
  mock.temp = (prefix = "pithagoras-mock-") => {
    const folder = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
    temps.push(folder);
    return folder;
  };

  // As given, a link included: what a half does with a data folder that is not what it expects is its own to test.
  const dataFolder = () => (options.dataDir ? (mkdirSync(options.dataDir, { recursive: true }), options.dataDir) : (mock.dataFolder ??= mock.temp("pithagoras-mock-data-")));
  const chatOf = (id) => {
    const chat = chats.get(id);
    return chat && { id, title: chat.title, workspace: chat.folder, status: "idle" };
  };
  /** Where a chat's folder leads now: the folder it was made for, or what `options.folderOf` says. Throws when the chat is gone. */
  const folderOf = (id) => {
    const chat = chats.get(id);
    if (!chat) throw new Error("No such chat");
    return options.folderOf ? options.folderOf(id) : realpathSync(chat.folder);
  };
  mock.addChat = (id, folder, title = `Chat ${id}`) => void chats.set(id, { id, folder, title });
  for (const [id, given] of Object.entries(options.chats ?? {})) mock.addChat(id, typeof given === "string" ? given : given.folder, typeof given === "string" ? undefined : given.title);
  /** The chat is deleted: the server half hears so. */
  mock.removeChat = (id) => {
    chats.delete(id);
    life.deleted.forEach((handler) => handler(id));
    pis.get(id)?.stop();
    pis.delete(id);
  };

  /** What a chat's pi was given to say (`pi.sendMessage`), also before its pi is started: `{ message, options }`. */
  const saids = new Map();
  mock.said = (id) => saids.get(id) ?? saids.set(id, []).get(id);
  /**
   * Which chats `chats.list()` gives, and in what order (by default all of them, as they were added). A chat that is left out is
   * gone from the list, and still has its folder.
   */
  let listed;
  mock.order = (ids) => void (listed = ids);
  /** The chats whose pi is started now, by id. */
  mock.running = pis;

  /** A chat's pi, started the first time it is asked for: the server half's tool factories are run for it. */
  mock.pi = (id) => {
    if (!chats.has(id)) throw new Error("No such chat");
    let pi = pis.get(id);
    if (!pi) {
      pi = fakePi(extension, chats.get(id), factories, mock);
      pis.set(id, pi);
      life.started.forEach((handler) => handler(id));
    }
    return pi;
  };

  const portal = {
    version: 1,
    extension,
    executor: options.executor ?? "host",
    log: (text) => void mock.logged.push(text),
    provide: (factory) => void (provider = factory),
    extensions: { use: (name) => options.extensions?.[name] },
    router: express.Router(),
    http: {
      json: express.json,
      raw: express.raw,
      text: express.text,
      upgrade: (handler) => void (upgrade = handler),
      endWithLogin: (end) => (logins.add(end), () => void logins.delete(end)),
    },
    push: (topic, data) => {
      if (!hub.validTopic(topic)) throw new TypeError("A topic is a name of at most 200 characters, with no control characters in it");
      hub.pushToPages(extension, topic, data);
    },
    onListen: (handler) => {
      if (typeof handler !== "function") throw new TypeError("onListen takes a function");
      hub.addGate(extension, handler);
    },
    chats: {
      get: chatOf,
      // The tasks, as the portal lists them: a session of another kind (`kinds`) works in its folder all the same.
      list: () => (listed ?? [...chats.keys()]).filter((id) => chats.has(id) && (options.kinds?.[id] ?? "task") === "task").map(chatOf),
      // The sessions of every kind whose folder, resolved now as `folder` does, is `where`.
      inFolder: (where) =>
        [...chats.keys()]
          .filter((id) => {
            try {
              return folderOf(id) === where;
            } catch {
              return false;
            }
          })
          .map(chatOf),
      folder: (id) => folderOf(id),
      send: (chat, data) => void mock.sent.push({ chat, data }),
      onOpen: (handler) => void opens.push(handler),
      on: (event, handler) => void life[event].push(handler),
      onEvent: (handler) => void eventHandlers.push(handler),
      async tell(chat, data) {
        mock.told.push({ chat, data });
        // The hook may hold the answer, throw, or say false: the chat cannot be reached. Without a word the bell is rung.
        if ((await options.tell?.(chat, data)) === false) return false;
        mock.pi(chat).tell(data);
        return true;
      },
      async followUp(chat, message) {
        if (typeof message?.text !== "string" || !message.text.trim()) throw new TypeError("A follow-up needs text");
        if (!chats.has(chat)) throw new Error("No such chat");
        mock.followedUp.push({ chat, ...message });
        // As the portal answers where its executor does not run pi in its own process: the agent cannot be reached.
        if (portal.executor !== "host") return false;
        // The hook may hold the answer, throw, or say false: the agent cannot be reached. Without a word the message is said.
        if ((await options.followUp?.(chat, message)) === false) return false;
        const pi = mock.pi(chat);
        // As the portal puts it in the conversation: a message of the package's, seen by the person, run after the turn that is going on.
        // It is handed over and not waited for, so a pi that refuses it is no failure of the call: the chat's events say so
        // (`portal_failed`, which `chats.onEvent` hears).
        try {
          pi.pi.sendMessage(
            { customType: message.type ? `${extension}:${message.type}` : extension, content: message.text, display: true, details: message.details },
            { deliverAs: "followUp", triggerTurn: true },
          );
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          queueMicrotask(() => mock.event(chat, { type: "portal_failed", error: `A message from ${extension} could not be delivered: ${reason}` }));
        }
        return true;
      },
      offers: () => "direct",
      extend: (factory) => void factories.push(factory),
      hold(chat) {
        holds.set(chat, (holds.get(chat) ?? 0) + 1);
        let held = true;
        return () => {
          if (!held) return;
          held = false;
          holds.set(chat, holds.get(chat) - 1);
        };
      },
    },
    sandbox: {
      on: () => options.sandbox === true,
      spawnAs: () => ({ argv: [], env: { ...process.env } }),
      async run(chat, argv, runOptions = {}) {
        const child = spawn(argv[0], argv.slice(1), { cwd: runOptions.cwd ?? portal.chats.folder(chat), stdio: [runOptions.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
        const out = [];
        let err = "";
        child.stdout.on("data", (d) => out.push(d));
        child.stderr.on("data", (d) => (err += d));
        if (child.stdin) child.stdin.end(runOptions.input);
        const [code] = await once(child, "close");
        return { code, stdout: Buffer.concat(out), stderr: err.trim() };
      },
      personEnv: () => ({ ...process.env }),
    },
    files: folderFiles,
    proc,
    sqlite,
    git: { at: (folder) => (git ? git(folder) : (() => { throw new Error("The mock was made without git"); })()) },
    dataDir: dataFolder,
  };
  mock.portal = portal;
  /** The pi extensions the server half asked to add to every chat's pi (`chats.extend`). */
  mock.factories = factories;
  /** What the server half gave the extensions that build on it, once one asked (`provide`). */
  mock.provided = (consumer = "a-consumer") => provider?.({ name: consumer });
  mock.upgrade = (req, socket, head) => upgrade?.(req, socket, head);
  /** Ends what the server half asked to be ended with the login (a stream), as a change of the password does. */
  mock.endLogins = () => [...logins].forEach((end) => end());
  /** How many `chats.hold`s a chat has now. */
  mock.holds = (chat) => holds.get(chat) ?? 0;
  /** What the server half tells a page that opens the chat, as `chats.onOpen` says it. */
  mock.opening = (chat) => opens.map((handler) => handler(chat)).filter((data) => data !== undefined);
  /** Something a chat's pi said, as `chats.onEvent` hears it. */
  mock.event = (chat, event) => eventHandlers.forEach((handler) => handler(chat, event));

  /**
   * Calls the server half (a module's default export) with the mock's portal and whatever else it takes, and
   * resolves with what stops it. `mock.stop()` stops it too.
   */
  mock.start = async (half, ...rest) => {
    const stopper = await half(portal, ...rest);
    halfStop = typeof stopper === "function" ? stopper : undefined;
    running = true;
    return async () => {
      const stop = halfStop;
      halfStop = undefined;
      running = false;
      await stop?.();
      hub.dropExtension(extension);
    };
  };

  /** The package's routes in a server of their own, at `/x`: `call(method, url, body)` answers `{ status, body }`. */
  mock.serve = async () => {
    const app = express();
    app.use("/x", portal.router);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    closers.push(() => new Promise((resolve) => (server.closeAllConnections?.(), server.close(resolve))));
    const base = `http://127.0.0.1:${server.address().port}/x`;
    return {
      base,
      call: async (method, url, body) => {
        const res = await fetch(base + url, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        try {
          return { status: res.status, body: JSON.parse(text) };
        } catch {
          throw new Error(`${method} ${url} ${res.status}: ${text.slice(0, 300)}`);
        }
      },
    };
  };

  /**
   * A page of the portal that listens to the package's topics, through the portal's own hub: `listen(topic)` asks as the
   * page does and answers "listening", "refused", "too-many" or "lost"; what it hears is `heard()`, as `[topic, data]`.
   */
  mock.page = () => {
    const events = [];
    const waiting = [];
    const opened = hub.openStream((text) => {
      const name = /^event: (.+)$/m.exec(text)?.[1];
      const data = /^data: (.+)$/m.exec(text)?.[1];
      if (name) events.push({ name, data: data ? JSON.parse(data) : null });
      for (const wake of waiting.splice(0)) wake();
    });
    closers.push(() => opened?.close());
    const page = {
      events,
      /** What it has heard of pushes, in order, as `[topic, data]` (of other extensions' topics: `[extension:topic, data]`). */
      heard: () => events.filter((e) => e.name === "push").map((e) => [e.data.extension === extension ? e.data.topic : `${e.data.extension}:${e.data.topic}`, e.data.data]),
      /** The topics it was told it lost (the server half stopped). */
      lost: () => events.filter((e) => e.name === "lost").map((e) => e.data.topic),
      listen: async (topic, of = extension) => (of === extension && !running ? "lost" : hub.listen(opened.id, of, topic)),
      leave: (topic, of = extension) => hub.leave(opened.id, of, topic),
      /** Waits until `done()`, up to `ms` (two seconds by default). */
      async until(done, what = "what was waited for", ms = 2000) {
        for (const end = Date.now() + ms; Date.now() < end && !done(); ) await Promise.race([new Promise((resolve) => waiting.push(resolve)), new Promise((resolve) => setTimeout(resolve, 25))]);
        if (!done()) throw new Error(`Not seen: ${what}; heard ${JSON.stringify(events)}`);
      },
      close: () => opened.close(),
    };
    return page;
  };

  /** Stops the server half, if `start` has one running, closes the servers and pages, and removes the folders made with `temp`. */
  mock.stop = async () => {
    running = false;
    const stop = halfStop;
    halfStop = undefined;
    await stop?.();
    hub.dropExtension(extension);
    for (const close of closers.splice(0)) await close();
    for (const pi of pis.values()) pi.stop();
    pis.clear();
    for (const folder of temps.splice(0)) rmSync(folder, { recursive: true, force: true });
  };
  return mock;
}
