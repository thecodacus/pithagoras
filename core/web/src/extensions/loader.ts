import * as React from "react";
import { createContext, useContext, useSyncExternalStore } from "react";
import * as ReactDOM from "react-dom";
import * as jsxRuntime from "react/jsx-runtime";
import { api, ApiError, EXTENSIONS_CHANGED, json, type ExtensionUi, type ServerCrash } from "../api";
import { formatDate, formatDateTime, formatNumber, formatTime, useLanguage } from "../i18n";
import type { Portal } from "@pithagoras/extension-api";
import { onChatFeed, useChatFeed } from "./chat-feed";
import { hasCommand, registerCommand, runCommand } from "./commands";
import { ui } from "./kit";
import { panels } from "./panels";
import { chatOnScreen, extensionGone, extensionHere, onlyWaitFor, onServerPush, serverPush } from "./server-feed";
import { rankExtensions } from "./rank";
import { register } from "./slots";
import { addStrings, forgetStrings, translate, translateCount, translateInContext, translateWithParts } from "./strings";
import { registerShortcut } from "./shortcuts";
import { choose, registerTheme, themes, themesSettled } from "./themes";
import { chosenPalette, usePalette, useResolvedTheme } from "../theme";

/**
 * Loads the browser halves of the installed extensions into the page, and
 * takes one out again when its package is removed, switched off or changed.
 *
 * A browser half is a JavaScript module whose default export is called with
 * the portal, as it is for that extension:
 *
 *   export default function (portal) {
 *     const { React } = portal;
 *     portal.slots.register("chat.panel", { id: "notes", title: "Notes", component: Notes });
 *   }
 *
 * It may return a function, called when the extension is taken out. What it
 * registered goes with it either way.
 */
// What a browser half is called with is the public contract, @pithagoras/extension-api: the portal builds exactly that below.
export type { Portal } from "@pithagoras/extension-api";

/**
 * What an extension bundled with @pithagoras/extension-api/build imports as
 * `react`, `react/jsx-runtime` and `react-dom`: the portal's own, put where
 * its module finds them before any extension's module is loaded. One built
 * without it has `portal.React`, which is the same React.
 */
(globalThis as { __pithagoras?: unknown }).__pithagoras = { React, ReactDOM, jsxRuntime };

/** `leave` takes what of an extension is in the page out again, and says whether all of it went without an error. */
type Loaded = { stamp: string; leave: () => boolean };

const loaded = new Map<string, Loaded>();
/**
 * Each extension's browser half as the page last loaded it, by its name, from before its module is called: what it
 * draws can fail before that call has returned. A failure of it is told to the portal under its revision, and one
 * nothing in the page caught is told apart as its own by the folder its files come from.
 */
const inPage = new Map<string, ExtensionUi>();
/** What is installed, as the portal said it with the list this page last went through: see followInstalled. */
let seen: string | undefined;
/** Why an extension's browser half is not in the page, by its package's name. */
let failures: Readonly<Record<string, string>> = {};
/** Why an extension's server half is not running, as the portal says. */
let serverFailures: Readonly<Record<string, string>> = {};
/** The crash an extension's server half is held off for, as the portal says. */
let serverCrashes: Readonly<Record<string, ServerCrash>> = {};
/** Why an extension's browser half failed in a page, this one or another, to load or to draw, as the portal was told. */
let clientFailures: Readonly<Record<string, string>> = {};
/**
 * The extensions whose old version this page could not take out cleanly as what is installed changed: something it had
 * put into the page threw as it was undone. What it left may still be at work beside what is installed now, until a reload.
 */
let leftBehind: readonly string[] = [];
/** Whether the list has been gone through once: before that, an entry not there may only not be there yet. */
let settled = false;
const watchers = new Set<() => void>();
const changed = () => { for (const watcher of [...watchers]) watcher(); };

let go: (path: string, options?: { replace?: boolean }) => void = () => {};
/** How `portal.navigate` goes somewhere: the app's own router, once it is there. */
export function setNavigate(navigate: (path: string, options?: { replace?: boolean }) => void): void {
  go = navigate;
}

/**
 * The page's address as the app's router has it, which the app gives everything it draws: what `portal.useLocation`
 * gives. Read from React, not from the browser's address bar: a part drawn first at a new address has that address
 * from its first draw, and a page still on screen while the next one is fetched keeps its own until it goes.
 */
export const Here = createContext<{ path: string; search: string } | null>(null);
/** The hook behind `portal.useLocation`. Where nothing gives it (a test page of an extension's, outside the app), the browser's address. */
function useHere(): { path: string; search: string } {
  return useContext(Here) ?? { path: window.location.pathname, search: window.location.search };
}

/** Runs `fn`, and says whether it went without an error: one it threw is said in the console. */
const quietly = (fn: () => void): boolean => {
  try {
    fn();
    return true;
  } catch (e) {
    console.error("[extensions]", e);
    return false;
  }
};

/** The hook behind `portal.theme.use`. */
function useThemeNow(): { mode: "light" | "dark"; theme: string | null } {
  return { mode: useResolvedTheme(), theme: usePalette()?.id ?? null };
}

/** What of an extension the page holds: by these it is known whether what is installed is what is loaded. */
const stamp = (ext: ExtensionUi) => JSON.stringify([ext.entry ?? null, ext.server ?? null, ext.themes ?? null]);

/** How long an extension's module may take to be fetched and called: one that hangs must not keep the others, or the page, waiting. */
const LOAD_MS = 15_000;

function within<T>(ms: number, work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`It had not finished ${what} after ${ms / 1000} seconds`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * Brings one extension into the page. Resolves once what its module registered is there. The telling of
 * its module where its server half stands is a round trip to the server, which is no reason to hold
 * back a page: it is handed to `told` to be waited for by whoever wants it done, not here.
 */
async function activate(ext: ExtensionUi, told: Promise<void>[]): Promise<void> {
  // What its module put into the page, to take out again; and its themes, which need no module and are kept whatever becomes of it.
  const undo: (() => void)[] = [];
  const themesOff: (() => void)[] = [];
  let gone = false;
  /**
   * Something the module registered: undone when the extension goes, and
   * forgotten once it has undone it itself, so that a component that listens
   * and stops many times leaves nothing behind. Asked for after the extension
   * has gone (a module still at work when it was given up on), it is undone at once.
   */
  const kept = (off: () => void): (() => void) => {
    if (gone) return quietly(off), () => {};
    const once = () => {
      const at = undo.indexOf(once);
      if (at === -1) return;
      undo.splice(at, 1);
      off();
    };
    undo.push(once);
    return once;
  };
  const leaveModule = () => {
    gone = true;
    // Every one, whichever throws.
    const clean = [...undo].reverse().map(quietly).every(Boolean);
    undo.length = 0;
    return clean;
  };
  const leave = () => {
    const clean = leaveModule();
    return themesOff.map(quietly).every(Boolean) && clean;
  };
  const entry = ext.entry;
  const load = async (entry: string) => {
    if (ext.style) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = ext.style;
      link.dataset.extension = ext.name;
      document.head.append(link);
      kept(() => link.remove());
    }
    // What the module imports is asked for now, not once the module has been read and has said so level by level.
    for (const href of [entry, ...(ext.preload ?? [])]) {
      hint(href, ext.name);
      kept(() => hinted(href).forEach((link) => link.remove()));
    }
    const module = await import(/* @vite-ignore */ entry);
    if (typeof module.default !== "function") throw new Error("Its module has no default export to call");
    const portal: Portal = {
      version: 1,
      extension: ext.name,
      React,
      slots: { register: (slot, entry) => kept(register(ext.name, slot, entry)) },
      navigate: (path, options) => go(path, options),
      useLocation: useHere,
      ui,
      api: {
        json,
        url: (path) => {
          if (!ext.server) throw new Error(`${ext.name} has no server half running`);
          return `${ext.server}${path.startsWith("/") ? "" : "/"}${path}`;
        },
        ApiError,
      },
      t: (text, vars) => translate(ext.name, text, vars),
      tp: (n, one, other, vars) => translateCount(ext.name, n, one, other, vars),
      tc: (text, context, vars) => translateInContext(ext.name, text, context, vars),
      tx: (text, vars) => translateWithParts(ext.name, text, vars),
      format: { number: formatNumber, date: formatDate, dateTime: formatDateTime, time: formatTime },
      locale: { add: (code, strings) => addStrings(ext.name, code, strings), use: useLanguage },
      commands: { register: (name, run) => kept(registerCommand(name, run, ext.name)), run: runCommand, has: hasCommand },
      panels,
      chats: { use: useChatFeed, on: (chatId, handler) => kept(onChatFeed(chatId, handler)) },
      shortcuts: { register: (shortcut) => kept(registerShortcut(ext.name, shortcut)) },
      server: { on: (handler) => kept(onServerPush(ext.name, handler)) },
      theme: {
        register: (theme) => kept(registerTheme(ext.name, theme)),
        list: () => themes().map((theme) => ({ id: theme.id, name: theme.name, extension: theme.extension })),
        current: () => chosenPalette()?.id ?? null,
        set: choose,
        use: useThemeNow,
      },
    };
    kept(() => {
      extensionGone(ext.name);
      forgetStrings(ext.name);
    });
    const left = await module.default(portal);
    if (typeof left === "function") kept(left);
  };
  try {
    // The themes its package.json names need no module: a package may be nothing but themes.
    for (const theme of ext.themes ?? []) themesOff.push(registerTheme(ext.name, theme));
    inPage.set(ext.name, ext);
    if (entry) await within(LOAD_MS, load(entry), "loading");
    loaded.set(ext.name, { stamp: stamp(ext), leave });
    if (!entry) return;
    // What its server half said before it was here is handed over now.
    extensionHere(ext.name);
    if (ext.server) told.push(catchUp(ext.name));
  } catch (e) {
    // What its module managed to register before it failed is taken out: half an extension is not shown.
    leaveModule();
    failures = { ...failures, [ext.name]: (e as Error)?.message || String(e) };
    console.error(`[extensions] ${ext.name} could not be loaded:`, e);
    tell(ext.name, ext.rev, failures[ext.name]!, (e as Error)?.stack);
    // Held as failed, under a stamp nothing has: its themes are still there to choose, and it is tried again the next time what is installed is gone through.
    loaded.set(ext.name, { stamp: "", leave });
  }
}

/**
 * A module that came into the page after the chat's stream had opened was not
 * there to be told where things stand: it is told now, as its server half
 * would say it now. Not on the page's first load, when what the stream said
 * waited for it.
 */
async function catchUp(name: string): Promise<void> {
  const chatId = chatOnScreen();
  if (!settled || !chatId) return;
  try {
    // A server that does not answer is no reason to hold every later change of what is installed.
    const { pushes } = await within(LOAD_MS, api.extensionOpening(chatId, name), "being asked where its server half stands");
    for (const data of pushes) serverPush(chatId, name, data);
  } catch (e) {
    console.error(`[extensions] ${name} could not be told where its server half stands:`, e);
  }
}

/**
 * The list of extensions, asked for before the page has finished starting: it does not depend on who is
 * signed in being known yet, so it goes out with the question of who that is. Used once, by the first
 * load; an answer that is not a list (not signed in yet, say) is simply asked for again then.
 */
let early: Promise<{ extensions: ExtensionUi[]; revision: string } | undefined> | undefined;
export function askForExtensions(): void {
  if (extensionsOff()) return;
  early ??= api.extensionUi().catch(() => undefined);
  // The modules are fetched, not yet called, while the question of who is signed in is still out: they are there to call when it is
  // answered. For somebody who is not signed in the fetch is refused, and nothing was called.
  void early.then((answer) => {
    for (const ext of answer?.extensions ?? []) for (const href of [ext.entry, ...(ext.preload ?? [])]) if (href) hint(href, ext.name);
  });
}

const hinted = (href: string) => [...document.head.querySelectorAll("link[rel=modulepreload]")].filter((l) => l.getAttribute("href") === href);

/** Ask the browser to fetch a module, to have it when it is imported. */
function hint(href: string, extension: string): void {
  if (hinted(href).length) return;
  const link = document.createElement("link");
  link.rel = "modulepreload";
  link.href = href;
  link.dataset.extensionModule = extension;
  document.head.append(link);
}

async function list(): Promise<{ extensions: ExtensionUi[]; revision: string }> {
  const asked = early;
  early = undefined;
  return (await asked) ?? api.extensionUi();
}

async function sync(): Promise<void> {
  const told: Promise<void>[] = [];
  try {
    const { extensions, revision } = await list();
    seen = revision;
    // Gone, or its module changed: the address of a module carries its revision.
    // Or its server half came or went, or its themes changed: the module is told where its routes are as it is called.
    // Or it failed last time: it is tried again.
    for (const [name, was] of [...loaded]) {
      if (extensions.some((ext) => ext.name === name && stamp(ext) === was.stamp)) continue;
      if (!was.leave() && !leftBehind.includes(name)) leftBehind = [...leftBehind, name];
      loaded.delete(name);
    }
    failures = {};
    serverFailures = Object.fromEntries(extensions.filter((ext) => ext.serverError).map((ext) => [ext.name, ext.serverError!]));
    serverCrashes = Object.fromEntries(extensions.filter((ext) => ext.crash).map((ext) => [ext.name, ext.crash!]));
    clientFailures = Object.fromEntries(extensions.filter((ext) => ext.clientError).map((ext) => [ext.name, ext.clientError!]));
    onlyWaitFor(extensions.filter((ext) => ext.entry).map((ext) => ext.name));
    rankExtensions(extensions.map((ext) => ext.name));
    // All at once: one that is slow, or has files of its own to fetch, holds up none of the others.
    // Each says for itself why it failed, and none waits longer than LOAD_MS.
    await Promise.all(extensions.filter((ext) => !loaded.has(ext.name)).map((ext) => activate(ext, told)));
    // Only now is it known which themes there are: one chosen that is gone gives way. Not one whose
    // extension is installed and failed to load just now: that is not the person's choice undone.
    themesSettled(Object.keys(failures));
  } catch (e) {
    // The list could not be read: what is loaded stays, and the next change asks again.
    console.error("[extensions] could not read which extensions have an interface:", e);
  } finally {
    settled = true;
    changed();
  }
  // Not before the page has been told: a module learns where its server half stands after it is in the page.
  await Promise.all(told);
}

let queue: Promise<void> = Promise.resolve();
/** Bring what is in the page in line with what is installed. One at a time: a second ask waits for the first. */
export function loadExtensions(): Promise<void> {
  return (queue = queue.then(sync));
}

/**
 * What is installed, as the portal says it with the list of chats (GET /api/sessions): when it is not what the list
 * this page last went through was said with, it was changed since, here or elsewhere (another tab, the API, an agent),
 * or a server half crashed, and the page goes through it again. Fired once for each change, whatever becomes of that.
 */
export function followInstalled(revision: string): void {
  if (revision === seen) return;
  seen = revision;
  window.dispatchEvent(new Event(EXTENSIONS_CHANGED));
}

/**
 * What this page has told the portal had failed, of which extension and revision: a part that is drawn many times
 * over (a call's card, in a long conversation) and fails each time is told once.
 */
const toldOf = new Set<string>();

/**
 * Tell the portal that the browser half of `name`, at revision `rev`, failed in this page, and where: for Settings →
 * Extensions, and for whatever else asks the portal how the extension stands.
 */
function tell(name: string, rev: string | undefined, error: string, stack: string | undefined): void {
  const failure = `${name}\n${rev}\n${error}`;
  if (!rev || toldOf.has(failure)) return;
  toldOf.add(failure);
  api.extensionFailed(name, rev, error, stack).catch((e) => console.error(`[extensions] could not tell the portal that ${name} failed:`, e));
}

/**
 * What the portal does when the browser half of `name` fails where the portal called it: to draw (an error boundary,
 * which gives the components it was drawn in), in a handler of its (what its server half or its channel said, a
 * shortcut), or in what it runs of its own (see startExtensions). Says so here at once, and tells the portal.
 */
export const failedIn = (name: string) => (e: unknown, drawn?: { componentStack?: string | null }) => {
  const error = (e as Error)?.message || String(e);
  clientFailures = { ...clientFailures, [name]: error };
  changed();
  tell(name, inPage.get(name)?.rev, error, `${(e as Error)?.stack ?? ""}${drawn?.componentStack ?? ""}` || undefined);
};

/**
 * The extension, of those in the page, that an error came from, by the folder its files are fetched from, as `where`
 * (the file it was thrown in, and its stack) names it: the first named, which is where it was thrown.
 */
function thrownBy(where: string): string | undefined {
  let found: { name: string; at: number } | undefined;
  for (const [name, ext] of inPage) {
    if (!ext.entry) continue;
    const at = where.indexOf(new URL(".", new URL(ext.entry, window.location.href)).href);
    if (at !== -1 && (!found || at < found.at)) found = { name, at };
  }
  return found?.name;
}

/**
 * `?extensions=off` in the address the page was opened at: no extension's browser half is loaded into it, for a way
 * into a page that one of them breaks, to switch that one off in Settings → Extensions. Read once, the first time it
 * is asked (as the page starts, by askForExtensions), before anything in the page changes the address.
 */
let off: boolean | undefined;
export const extensionsOff = () => (off ??= new URLSearchParams(window.location.search).get("extensions") === "off");

let started = false;
/**
 * Load them, and from then on follow what is installed. Once per page load:
 * the app's shell is drawn again on every route. Not at all with `?extensions=off`.
 */
export function startExtensions(): void {
  if (started || extensionsOff()) return;
  started = true;
  void loadExtensions();
  const again = () => void loadExtensions();
  window.addEventListener(EXTENSIONS_CHANGED, again);
  // What an extension's module runs of its own (a timer, a fetch, a handler of its) and nothing caught: told as its
  // failure, as one the portal caught is. What came from no extension is left as it is.
  window.addEventListener("error", (event) => {
    const name = thrownBy(`${event.filename}\n${event.error?.stack ?? ""}`);
    if (name) failedIn(name)(event.error ?? event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const name = thrownBy(String(event.reason?.stack ?? ""));
    if (name) failedIn(name)(event.reason);
  });
}

function watch(watcher: () => void) {
  watchers.add(watcher);
  return () => void watchers.delete(watcher);
}

/**
 * Whether the installed extensions have been gone through, why any of them is not in the page, why any failed in a
 * page, this one or another, why its server half is not running, and those whose old version this page could not take
 * out cleanly.
 */
export function useExtensions(): {
  settled: boolean;
  failures: Readonly<Record<string, string>>;
  serverFailures: Readonly<Record<string, string>>;
  serverCrashes: Readonly<Record<string, ServerCrash>>;
  clientFailures: Readonly<Record<string, string>>;
  leftBehind: readonly string[];
} {
  return {
    settled: useSyncExternalStore(watch, () => settled),
    failures: useSyncExternalStore(watch, () => failures),
    serverFailures: useSyncExternalStore(watch, () => serverFailures),
    serverCrashes: useSyncExternalStore(watch, () => serverCrashes),
    clientFailures: useSyncExternalStore(watch, () => clientFailures),
    leftBehind: useSyncExternalStore(watch, () => leftBehind),
  };
}
